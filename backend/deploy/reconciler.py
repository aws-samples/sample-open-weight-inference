"""Independent expiry and orphan reconciliation.

OPS-02. Nothing billable may be created until this exists, because a deadline that
nothing enforces is not a bound -- it is a note in a database.

What makes it *independent*:

* It does not run inside the deployment job. A job that dies holding a GPU cannot be
  the thing that releases it.
* It does not depend on the browser. Closing a tab is not a cleanup signal, and a
  disconnect must not extend a lifetime.
* It does not depend on the advisor. An LLM failure has no bearing on whether an
  endpoint should still exist.
* It does not use DynamoDB TTL for shutdown. TTL deletes a *row* on a best-effort
  schedule -- AWS documents expired items as typically deleted within a few days -- so
  it is not a timely compute shutdown mechanism. Worse, deleting the record of a
  running endpoint removes the only evidence of what needs deleting.
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html

What it will not do:

* It never deletes by name pattern. Only resources whose ledger entry EDDIE owns are
  touched. This account contains EC2 instances and SageMaker models EDDIE did not
  create, and a substring sweep would destroy them.
* It never treats an accepted delete as a completed one. A resource moves to DELETED
  only after its absence is confirmed, because an accepted `DeleteEndpoint` does not
  prove billing stopped.
* It never closes a failed cleanup. `CLEANUP_INCOMPLETE` stays open and owned, with
  its residual charges named.

The adapters that actually call AWS are supplied by the caller, so this module is pure
and testable: killing the worker mid-sweep, a delete that fails, and a resource that
has already vanished are all exercised without AWS.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Protocol

from .models import (
    Job,
    JobState,
    LedgerEntry,
    ResourceState,
    with_step,
)

log = logging.getLogger("eddie.reconciler")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _past(timestamp: Optional[str]) -> bool:
    if not timestamp:
        return False
    try:
        return _now() > datetime.fromisoformat(timestamp)
    except ValueError:
        # An unparseable timestamp is treated as *not* expired, and reported. Guessing
        # "expired" would delete a live resource on a formatting bug.
        log.warning("unparseable expiry timestamp %r; treating as not expired", timestamp)
        return False


class ResourceAdapter(Protocol):
    """What the reconciler needs from a target to clean up after it."""

    kinds: tuple[str, ...]

    def delete(self, entry: LedgerEntry) -> None:
        """Request deletion. Idempotent: deleting an absent resource is success."""

    def exists(self, entry: LedgerEntry) -> bool:
        """Whether the resource is still present. Used to *confirm* deletion."""


@dataclass
class ReconcileOutcome:
    """What one sweep did, in enough detail to alert on."""

    swept_jobs: int = 0
    swept_resources: int = 0
    expired_jobs: list[str] = field(default_factory=list)
    deadline_exceeded_jobs: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    delete_unconfirmed: list[str] = field(default_factory=list)
    orphans_adopted: list[str] = field(default_factory=list)
    cleanup_incomplete: list[str] = field(default_factory=list)
    unowned_kinds: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: _iso(_now()))
    finished_at: Optional[str] = None

    @property
    def needs_attention(self) -> bool:
        """Whether an operator has to look. Drives OPS-03 alerting."""
        return bool(
            self.cleanup_incomplete
            or self.delete_unconfirmed
            or self.errors
            or self.unowned_kinds
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "sweptJobs": self.swept_jobs,
            "sweptResources": self.swept_resources,
            "expiredJobs": list(self.expired_jobs),
            "deadlineExceededJobs": list(self.deadline_exceeded_jobs),
            "deleted": list(self.deleted),
            "deleteUnconfirmed": list(self.delete_unconfirmed),
            "orphansAdopted": list(self.orphans_adopted),
            "cleanupIncomplete": list(self.cleanup_incomplete),
            "unownedKinds": list(self.unowned_kinds),
            "errors": list(self.errors),
            "needsAttention": self.needs_attention,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
        }


class Reconciler:
    """Sweeps open jobs and billable resources, enforcing deadlines and cleanup.

    `heartbeat` is called on every completed sweep. OPS-03 requires detecting the loss
    of the reconciler itself: an alarm on a missing heartbeat is the only way to notice
    that the thing enforcing every deadline has stopped. Monitoring that dies with the
    application it watches is not monitoring.
    """

    def __init__(
        self,
        store: Any,
        adapters: tuple[ResourceAdapter, ...] = (),
        *,
        heartbeat: Optional[Callable[[ReconcileOutcome], None]] = None,
        max_resources_per_sweep: int = 200,
    ) -> None:
        self.store = store
        self.adapters = adapters
        self.heartbeat = heartbeat
        self.max_resources_per_sweep = max_resources_per_sweep

    def adapter_for(self, kind: str) -> Optional[ResourceAdapter]:
        for adapter in self.adapters:
            if kind in adapter.kinds:
                return adapter
        return None

    # ---- the sweep -----------------------------------------------------

    def sweep(self) -> ReconcileOutcome:
        """One pass. Safe to run concurrently with itself and to interrupt."""
        outcome = ReconcileOutcome()
        try:
            self._sweep_jobs(outcome)
            self._sweep_resources(outcome)
        except Exception as exc:  # noqa: BLE001
            # A sweep that throws must still record what it managed and still beat, or
            # a transient error would look identical to the reconciler being dead.
            log.exception("reconciler sweep failed")
            outcome.errors.append(f"{type(exc).__name__}: {exc}")
        outcome.finished_at = _iso(_now())
        if self.heartbeat is not None:
            try:
                self.heartbeat(outcome)
            except Exception:  # noqa: BLE001
                log.exception("reconciler heartbeat failed")
        return outcome

    def _sweep_jobs(self, outcome: ReconcileOutcome) -> None:
        jobs = self.store.open_jobs()
        outcome.swept_jobs = len(jobs)
        for snapshot in jobs:
            # A worker may be staging or creating when this schedule fires. The
            # shared lease outlasts that Lambda's hard timeout, so cleanup cannot
            # confirm an intent absent while a live worker can still create it.
            with self.store.lease_job(snapshot.job_id) as acquired:
                if not acquired:
                    continue
                job = self.store.get_job(snapshot.project_id, snapshot.job_id)
                if job.state is JobState.DELETED:
                    continue
                if job.state in (JobState.DELETING, JobState.FAILED, JobState.CLEANUP_INCOMPLETE):
                    self._begin_cleanup(job, outcome, reason=job.failure_reason or "removal requested")
                elif _past(job.resource_expires_at) or any(
                    _past(entry.expires_at) for entry in self.store.list_resources(job.job_id)
                    if entry.state not in (ResourceState.DELETED, ResourceState.RETAINED)
                ):
                    outcome.expired_jobs.append(job.job_id)
                    self._begin_cleanup(job, outcome, reason="lifetime expired")
                elif _past(job.deadline_at) and job.state in (JobState.PENDING, JobState.RUNNING):
                    outcome.deadline_exceeded_jobs.append(job.job_id)
                    self._begin_cleanup(job, outcome, reason="execution deadline exceeded")

    def _begin_cleanup(self, job: Job, outcome: ReconcileOutcome, *, reason: str) -> None:
        # Earlier sweeps appended progress to failure_reason. Keep the original
        # cause without repeatedly nesting that progress or reporting it as current
        # after AWS has confirmed removal.
        reason = reason.partition(". Cleanup incomplete: ")[0]
        priority = {"sagemaker-endpoint": 0, "sagemaker-endpoint-config": 1,
                    "sagemaker-model": 2, "s3-model-artifacts": 3, "sagemaker-log-group": 4}
        entries = sorted(self.store.list_resources(job.job_id), key=lambda e: priority.get(e.kind, 0))
        remaining: list[LedgerEntry] = []
        for entry in entries:
            if entry.state in (ResourceState.DELETED, ResourceState.RETAINED):
                continue
            if remaining and job.target.value == "SAGEMAKER_REALTIME":
                # Keep the configuration, staged files and logs until the endpoint is
                # confirmed gone. Dependencies must not disappear underneath it.
                remaining.append(entry)
            elif not self._delete_entry(entry, outcome):
                remaining.append(entry)

        if remaining:
            # Stays owned and open. The next sweep tries again; it does not silently
            # become someone else's problem or disappear from the inventory.
            updated = replace(
                with_step(job, "cleanup", "FAILED", f"{reason}; {len(remaining)} left"),
                state=JobState.CLEANUP_INCOMPLETE,
                failure_reason=(
                    f"{reason}. Cleanup incomplete: "
                    f"{', '.join(sorted(e.kind for e in remaining))} still present."
                ),
            )
            outcome.cleanup_incomplete.append(job.job_id)
        else:
            updated = replace(
                with_step(job, "cleanup", "DONE",
                          "AWS confirmed removal of every recorded resource."),
                state=JobState.DELETED,
                published_route=None,
                failure_reason=None if reason in ("removal requested", "lifetime expired") else reason,
            )
            # Release the admission slot only once nothing is left, so a stuck cleanup
            # does not free capacity that is still being paid for -- and exactly once
            # per job, so a second sweep cannot release a slot belonging to a different
            # deployment that is still running.
            try:
                if self.store.release_for_job(updated):
                    updated = replace(updated, admission_released=True)
            except Exception as exc:  # noqa: BLE001
                outcome.errors.append(f"release {job.project_id}: {exc}")
                updated = replace(updated, state=JobState.CLEANUP_INCOMPLETE,
                                  failure_reason="Resources removed; deployment slot release needs a retry.")
        self.store.put_job(updated)

    def _delete_entry(self, entry: LedgerEntry, outcome: ReconcileOutcome) -> bool:
        """Delete one resource and confirm it. True when confirmed gone."""
        adapter = self.adapter_for(entry.kind)
        if adapter is None:
            # No owner for this kind. Recorded as needing attention rather than
            # assumed harmless: an unowned billable resource is the exact thing a
            # ledger exists to prevent.
            if entry.kind not in outcome.unowned_kinds:
                outcome.unowned_kinds.append(entry.kind)
            self.store.put_resource(
                replace(
                    entry,
                    residual_cost_note=(
                        f"No cleanup adapter is registered for {entry.kind}, so EDDIE "
                        f"cannot remove it. It may still be charging."
                    ),
                    updated_at=_iso(_now()),
                )
            )
            return False

        if entry.state is ResourceState.DELETING:
            try:
                if adapter.exists(entry):
                    return False
            except Exception as exc:
                outcome.errors.append(f"confirm {entry.entry_id}: {exc}")
                return False
            self.store.put_resource(replace(entry, state=ResourceState.DELETED, updated_at=_iso(_now())))
            outcome.deleted.append(entry.entry_id)
            return True

        if entry.state is ResourceState.INTENDED and entry.physical_id is None:
            # An intent recorded before a create that never completed -- or whose
            # response was lost. The adapter is asked whether anything exists under the
            # recoverable creation identity: the planned name, or the client token for a
            # resource AWS names itself.
            #
            # A missing identity is NOT absence. Previously an entry with no physical id
            # was marked DELETED without any AWS call, so a real endpoint created by a
            # lost response kept billing while the ledger said it was gone.
            try:
                still_there = adapter.exists(entry)
            except Exception as exc:  # noqa: BLE001
                outcome.errors.append(f"exists {entry.entry_id}: {exc}")
                self.store.put_resource(
                    replace(
                        entry,
                        state=ResourceState.DELETE_UNCONFIRMED,
                        residual_cost_note=(
                            f"Could not determine whether this was created: "
                            f"{type(exc).__name__}. It may exist and be charging."
                        ),
                        updated_at=_iso(_now()),
                    )
                )
                if entry.entry_id not in outcome.delete_unconfirmed:
                    outcome.delete_unconfirmed.append(entry.entry_id)
                return False
            if not still_there:
                self.store.put_resource(
                    replace(entry, state=ResourceState.DELETED, updated_at=_iso(_now()))
                )
                outcome.deleted.append(entry.entry_id)
                return True
            outcome.orphans_adopted.append(entry.entry_id)

        self.store.put_resource(
            replace(entry, state=ResourceState.DELETING, updated_at=_iso(_now()))
        )
        try:
            adapter.delete(entry)
        except Exception as exc:  # noqa: BLE001
            outcome.errors.append(f"delete {entry.entry_id}: {exc}")
            self.store.put_resource(
                replace(
                    entry,
                    state=ResourceState.DELETE_UNCONFIRMED,
                    residual_cost_note=f"Deletion failed: {type(exc).__name__}.",
                    updated_at=_iso(_now()),
                )
            )
            outcome.delete_unconfirmed.append(entry.entry_id)
            return False

        # Confirm. An accepted delete call is not proof, so absence is checked.
        try:
            still_there = adapter.exists(entry)
        except Exception as exc:  # noqa: BLE001
            outcome.errors.append(f"confirm {entry.entry_id}: {exc}")
            self.store.put_resource(
                replace(
                    entry,
                    state=ResourceState.DELETE_UNCONFIRMED,
                    residual_cost_note=(
                        "Deletion was accepted but could not be confirmed, so this may "
                        "still be charging."
                    ),
                    updated_at=_iso(_now()),
                )
            )
            outcome.delete_unconfirmed.append(entry.entry_id)
            return False

        if still_there:
            # Normal for an endpoint that takes minutes to tear down. Left in DELETING
            # so the next sweep confirms; not counted as done.
            self.store.put_resource(
                replace(entry, state=ResourceState.DELETING, updated_at=_iso(_now()))
            )
            return False

        self.store.put_resource(
            replace(entry, state=ResourceState.DELETED, updated_at=_iso(_now()))
        )
        outcome.deleted.append(entry.entry_id)
        return True

    def _sweep_resources(self, outcome: ReconcileOutcome) -> None:
        """Resources whose own expiry has passed, or that no job still owns.

        Bounded per sweep: an unbounded pass over a large inventory would make the
        reconciler itself the thing that times out.
        """
        entries = self.store.all_billable_resources()[: self.max_resources_per_sweep]
        outcome.swept_resources = len(entries)
        # Job-owned entries are handled in dependency order by _sweep_jobs. Orphan
        # entries still need a way out, but must acquire the same lease first.
        from .store import NotFound
        for snapshot in entries:
            with self.store.lease_job(snapshot.job_id) as acquired:
                if not acquired:
                    continue
                try:
                    self.store.get_job(snapshot.project_id, snapshot.job_id)
                    continue
                except NotFound:
                    pass
                current = next((e for e in self.store.list_resources(snapshot.job_id)
                                if e.entry_id == snapshot.entry_id), None)
                if current is None or current.state in (ResourceState.DELETED, ResourceState.RETAINED):
                    continue
                if current.state is ResourceState.DELETING or _past(current.expires_at):
                    self._delete_entry(current, outcome)


def residual_report(store: Any, project_id: str | None = None) -> dict[str, Any]:
    """Everything that may still be charging, for the operator view and status doc.

    Separates what EDDIE owns from what it merely knows about. The distinction matters:
    this account contains resources EDDIE did not create, and a report that blurred
    them would invite exactly the sweep OPS-02 forbids.
    """
    entries = [e for e in store.all_billable_resources()
               if project_id is None or e.project_id == project_id]
    by_kind: dict[str, int] = {}
    hourly = 0.0
    for entry in entries:
        by_kind[entry.kind] = by_kind.get(entry.kind, 0) + 1
        if entry.hourly_usd is not None:
            hourly += float(entry.hourly_usd)
    return {
        "ownedBillableCount": len(entries),
        "byKind": by_kind,
        "estimatedHourlyUsd": round(hourly, 4),
        "entries": [e.to_json() for e in entries],
        "note": (
            "Only resources EDDIE created and owns in its ledger. Resources created "
            "outside EDDIE are never listed here and are never deleted by cleanup."
        ),
    }

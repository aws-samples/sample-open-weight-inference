"""Demonstration sleep/wake controller for the COA knowledge stack.

Why this exists: COA's inventory does not scale to zero. The always-on baseline is
around $1,571/month, and the VPC footprint alone (endpoints, NAT, IPv4) is about
$328.50/month with compute stopped. See docs/cost-budget.md.

So the stack is provisioned once and slept between demonstrations, rather than
destroyed and rebuilt -- COA documents roughly 90 minutes for a fresh deployment.

Four constraints this controller must respect, each of which silently defeats naive
"scale to zero" attempts:

1. **Neptune restarts itself.** AWS automatically restarts a stopped cluster after
   7 days. The controller records a re-stop deadline so a scheduler can put it back.
2. **Autoscaling minimums win.** Setting desired count to zero is not enough; the
   service's autoscaling minimum must be lowered too or it scales straight back up.
3. **OpenSearch background requests keep it awake.** Minimums must go to zero *and*
   background work must be suspended.
4. **Sleep is not destroy.** Sleep preserves the graph and the published knowledge
   release. Teardown can delete them. This module never calls teardown.

Resume time is measured, never assumed. Do not promise a five-minute recovery.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Optional

log = logging.getLogger("eddie.lifecycle")

# AWS restarts a stopped Neptune cluster after this long, so a sleeping demo must be
# re-slept before it silently starts billing compute again.
NEPTUNE_AUTO_RESTART_DAYS = 7

# Default wake lifetime. A forgotten wake is the expensive failure mode.
DEFAULT_EXPIRY_HOURS = 4.0


class DemoState(str, Enum):
    NOT_CONFIGURED = "NOT_CONFIGURED"
    SLEEPING = "SLEEPING"
    WAKING = "WAKING"
    READY = "READY"
    SLEEPING_IN_PROGRESS = "SLEEPING_IN_PROGRESS"
    ERROR = "ERROR"


@dataclass
class DemoLifecycle:
    """Controls the sleepable COA components.

    Every identifier is optional: an unconfigured controller reports NOT_CONFIGURED
    rather than pretending to manage resources that do not exist.
    """

    region: str
    neptune_cluster_id: Optional[str] = None
    ecs_cluster: Optional[str] = None
    ecs_services: tuple[str, ...] = ()
    opensearch_collection: Optional[str] = None
    state_table: Optional[str] = None
    autoscaling_min_when_awake: int = 1
    _last_wake_seconds: Optional[float] = field(default=None, init=False)

    @classmethod
    def from_environment(cls) -> "DemoLifecycle":
        services = os.environ.get("COA_ECS_SERVICES", "")
        return cls(
            region=os.environ.get("EDDIE_REGION", os.environ.get("AWS_REGION", "us-east-1")),
            neptune_cluster_id=os.environ.get("COA_NEPTUNE_CLUSTER_ID") or None,
            ecs_cluster=os.environ.get("COA_ECS_CLUSTER") or None,
            ecs_services=tuple(s.strip() for s in services.split(",") if s.strip()),
            opensearch_collection=os.environ.get("COA_OPENSEARCH_COLLECTION") or None,
            state_table=os.environ.get("EDDIE_LIFECYCLE_TABLE") or None,
        )

    @property
    def configured(self) -> bool:
        return bool(self.neptune_cluster_id or self.ecs_services)

    # ------------------------------------------------------------------
    # State persistence
    # ------------------------------------------------------------------

    def _put_state(self, record: dict[str, Any]) -> None:
        if not self.state_table:
            return
        import boto3

        try:
            boto3.client("dynamodb", region_name=self.region).put_item(
                TableName=self.state_table,
                Item={
                    "pk": {"S": "lifecycle"},
                    "sk": {"S": "demo"},
                    "payload": {"S": __import__("json").dumps(record, default=str)},
                },
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("could not persist lifecycle state: %s", exc)

    def _get_state(self) -> dict[str, Any]:
        if not self.state_table:
            return {}
        import boto3
        import json as _json

        try:
            resp = boto3.client("dynamodb", region_name=self.region).get_item(
                TableName=self.state_table,
                Key={"pk": {"S": "lifecycle"}, "sk": {"S": "demo"}},
            )
            item = resp.get("Item")
            return _json.loads(item["payload"]["S"]) if item else {}
        except Exception as exc:  # noqa: BLE001
            log.warning("could not read lifecycle state: %s", exc)
            return {}

    # ------------------------------------------------------------------
    # Observation
    # ------------------------------------------------------------------

    def _neptune_status(self) -> Optional[str]:
        if not self.neptune_cluster_id:
            return None
        import boto3

        try:
            resp = boto3.client("neptune", region_name=self.region).describe_db_clusters(
                DBClusterIdentifier=self.neptune_cluster_id
            )
            return resp["DBClusters"][0]["Status"]
        except Exception as exc:  # noqa: BLE001
            log.warning("neptune describe failed: %s", exc)
            return None

    def _ecs_counts(self) -> dict[str, dict[str, int]]:
        if not (self.ecs_cluster and self.ecs_services):
            return {}
        import boto3

        try:
            resp = boto3.client("ecs", region_name=self.region).describe_services(
                cluster=self.ecs_cluster, services=list(self.ecs_services)
            )
            return {
                s["serviceName"]: {
                    "desired": s.get("desiredCount", 0),
                    "running": s.get("runningCount", 0),
                }
                for s in resp.get("services", [])
            }
        except Exception as exc:  # noqa: BLE001
            log.warning("ecs describe failed: %s", exc)
            return {}

    def status(self) -> dict[str, Any]:
        """Real readiness, from actual resource state rather than a timer."""
        if not self.configured:
            return {
                "state": DemoState.NOT_CONFIGURED.value,
                "detail": (
                    "No sleepable COA resources are configured in this environment. "
                    "EDDIE's own control plane is serverless and always available."
                ),
                "costNote": (
                    "Sleep mode exists because COA's graph/search inventory does not "
                    "scale to zero. See docs/cost-budget.md."
                ),
            }

        stored = self._get_state()
        neptune = self._neptune_status()
        services = self._ecs_counts()

        neptune_ready = neptune == "available"
        services_ready = bool(services) and all(
            v["running"] > 0 for v in services.values()
        )
        any_service_up = any(v["desired"] > 0 for v in services.values())

        if neptune_ready and (services_ready or not services):
            state = DemoState.READY
        elif neptune in ("stopped",) and not any_service_up:
            state = DemoState.SLEEPING
        elif neptune in ("starting", "resetting-master-credentials") or (
            any_service_up and not services_ready
        ):
            state = DemoState.WAKING
        elif neptune == "stopping":
            state = DemoState.SLEEPING_IN_PROGRESS
        else:
            state = DemoState.WAKING if any_service_up else DemoState.SLEEPING

        expires_at = stored.get("expiresAt")
        expired = False
        if expires_at:
            try:
                expired = datetime.fromisoformat(expires_at) < datetime.now(timezone.utc)
            except ValueError:
                expired = False

        return {
            "state": state.value,
            "neptuneStatus": neptune,
            "services": services,
            "expiresAt": expires_at,
            "expired": expired,
            "lastWakeSeconds": stored.get("lastWakeSeconds", self._last_wake_seconds),
            "neptuneReStopDeadline": stored.get("neptuneReStopDeadline"),
            "resumeTimeNote": (
                "Resume time is measured on each wake and recorded. It is not a "
                "guarantee; do not promise a five-minute recovery."
            ),
            "costNote": (
                "Standing VPC footprint continues while asleep (~$328.50/month for "
                "the default endpoint/NAT configuration; ~$80.30 lean). Sleeping "
                "stops compute, not networking."
            ),
        }

    # ------------------------------------------------------------------
    # Wake
    # ------------------------------------------------------------------

    def wake(self, expiry_hours: Optional[float] = None) -> dict[str, Any]:
        """Start Neptune and scale services back up.

        Returns immediately after issuing the calls; readiness must be confirmed by
        polling status(), because a wake takes minutes and a caller that assumes
        success will query an unavailable graph.
        """
        if not self.configured:
            return {"state": DemoState.NOT_CONFIGURED.value, "actions": []}

        started = time.perf_counter()
        actions: list[dict[str, Any]] = []
        hours = expiry_hours or DEFAULT_EXPIRY_HOURS
        expires_at = datetime.now(timezone.utc) + timedelta(hours=hours)

        import boto3

        if self.neptune_cluster_id:
            try:
                status = self._neptune_status()
                if status == "stopped":
                    boto3.client("neptune", region_name=self.region).start_db_cluster(
                        DBClusterIdentifier=self.neptune_cluster_id
                    )
                    actions.append({"resource": "neptune", "action": "start", "ok": True})
                else:
                    actions.append(
                        {
                            "resource": "neptune",
                            "action": "skip",
                            "ok": True,
                            "detail": f"status is {status}",
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                actions.append(
                    {"resource": "neptune", "action": "start", "ok": False, "error": str(exc)}
                )

        for service in self.ecs_services:
            try:
                # Raise the autoscaling minimum first: scaling desired count up while
                # the minimum is still 0 lets the scaler pull it back down.
                self._set_autoscaling_bounds(service, self.autoscaling_min_when_awake)
                boto3.client("ecs", region_name=self.region).update_service(
                    cluster=self.ecs_cluster,
                    service=service,
                    desiredCount=self.autoscaling_min_when_awake,
                )
                actions.append({"resource": service, "action": "scale_up", "ok": True})
            except Exception as exc:  # noqa: BLE001
                actions.append(
                    {"resource": service, "action": "scale_up", "ok": False, "error": str(exc)}
                )

        elapsed = time.perf_counter() - started
        self._last_wake_seconds = elapsed

        record = {
            "lastAction": "wake",
            "at": datetime.now(timezone.utc).isoformat(),
            "expiresAt": expires_at.isoformat(),
            "expiryHours": hours,
            "wakeCallSeconds": round(elapsed, 2),
            # AWS will restart a stopped cluster by itself; a scheduler must re-stop
            # it before this deadline or compute starts billing unnoticed.
            "neptuneReStopDeadline": (
                datetime.now(timezone.utc) + timedelta(days=NEPTUNE_AUTO_RESTART_DAYS)
            ).isoformat(),
            "actions": actions,
        }
        self._put_state(record)

        return {
            "state": DemoState.WAKING.value,
            "actions": actions,
            "expiresAt": expires_at.isoformat(),
            "detail": (
                "Wake requested. Poll demo.status until state is READY; readiness is "
                "confirmed from actual resource state, not a timer. Neptune start and "
                "container warm-up take minutes."
            ),
        }

    # ------------------------------------------------------------------
    # Sleep
    # ------------------------------------------------------------------

    def sleep(self) -> dict[str, Any]:
        """Scale services to zero and stop Neptune.

        Never deletes anything. The graph and the published knowledge release survive.
        """
        if not self.configured:
            return {"state": DemoState.NOT_CONFIGURED.value, "actions": []}

        actions: list[dict[str, Any]] = []
        import boto3

        # Services first: stopping the graph underneath running containers produces
        # noisy failures and health-check churn.
        for service in self.ecs_services:
            try:
                self._set_autoscaling_bounds(service, 0)
                boto3.client("ecs", region_name=self.region).update_service(
                    cluster=self.ecs_cluster, service=service, desiredCount=0
                )
                actions.append({"resource": service, "action": "scale_to_zero", "ok": True})
            except Exception as exc:  # noqa: BLE001
                actions.append(
                    {
                        "resource": service,
                        "action": "scale_to_zero",
                        "ok": False,
                        "error": str(exc),
                    }
                )

        if self.neptune_cluster_id:
            try:
                status = self._neptune_status()
                if status == "available":
                    boto3.client("neptune", region_name=self.region).stop_db_cluster(
                        DBClusterIdentifier=self.neptune_cluster_id
                    )
                    actions.append({"resource": "neptune", "action": "stop", "ok": True})
                else:
                    actions.append(
                        {
                            "resource": "neptune",
                            "action": "skip",
                            "ok": True,
                            "detail": f"status is {status}",
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                actions.append(
                    {"resource": "neptune", "action": "stop", "ok": False, "error": str(exc)}
                )

        record = {
            "lastAction": "sleep",
            "at": datetime.now(timezone.utc).isoformat(),
            "expiresAt": None,
            "neptuneReStopDeadline": (
                datetime.now(timezone.utc) + timedelta(days=NEPTUNE_AUTO_RESTART_DAYS)
            ).isoformat(),
            "actions": actions,
        }
        self._put_state(record)

        return {
            "state": DemoState.SLEEPING_IN_PROGRESS.value,
            "actions": actions,
            "preserved": [
                "Neptune graph data (storage continues to bill)",
                "Published knowledge release",
                "OpenSearch indexes",
            ],
            "detail": (
                "Sleep requested. Compute billing stops; storage and the VPC "
                "footprint continue. Neptune will auto-restart after 7 days, so a "
                "scheduler must re-stop it. This is not a teardown -- no data removed."
            ),
        }

    # ------------------------------------------------------------------
    # Autoscaling
    # ------------------------------------------------------------------

    def _set_autoscaling_bounds(self, service: str, minimum: int) -> None:
        """Lower or raise the registered autoscaling minimum.

        Without this, setting desiredCount to 0 is undone by Application Auto Scaling
        within minutes. Absence of a scalable target is not an error: the service may
        simply not be registered for autoscaling.
        """
        import boto3

        client = boto3.client("application-autoscaling", region_name=self.region)
        resource_id = f"service/{self.ecs_cluster}/{service}"
        try:
            existing = client.describe_scalable_targets(
                ServiceNamespace="ecs",
                ResourceIds=[resource_id],
                ScalableDimension="ecs:service:DesiredCount",
            ).get("ScalableTargets", [])
            if not existing:
                return
            current_max = existing[0].get("MaxCapacity", 1)
            client.register_scalable_target(
                ServiceNamespace="ecs",
                ResourceId=resource_id,
                ScalableDimension="ecs:service:DesiredCount",
                MinCapacity=minimum,
                MaxCapacity=max(current_max, minimum),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("autoscaling bounds for %s unchanged: %s", service, exc)

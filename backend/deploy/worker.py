"""The scheduled reconciliation worker.

This is the process that makes a lifetime a bound rather than a note. It runs on an
EventBridge schedule in its own Lambda function, with its own role, and it is
deliberately *not* the coordinator:

* The coordinator serves requests. A request-driven process only runs when someone asks,
  and the whole point is enforcement when nobody is asking.
* The coordinator's role can read evidence and invoke the advisor. This worker's role can
  delete inference resources and nothing else. Separating them means an advisor
  compromise cannot delete a customer's endpoint, and a cleanup bug cannot read the case
  table's contents beyond what it needs.
* If the coordinator is broken or being redeployed, expiry still happens.

Every invocation publishes a heartbeat metric whether or not it found work, because the
alarm that matters most is the one for *no* heartbeat: a reconciler that has silently
stopped looks exactly like a reconciler with nothing to do, and only the absence of a
beat distinguishes them.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("eddie.worker")

#: CloudWatch namespace for the reconciler's own health. Kept separate from application
#: metrics so an alarm on the reconciler cannot be muted by application dashboards.
METRIC_NAMESPACE = "EDDIE/Reconciler"


def _metrics_client(region: str) -> Optional[Any]:
    try:
        import boto3

        return boto3.client("cloudwatch", region_name=region)
    except Exception:  # noqa: BLE001
        log.exception("could not create a CloudWatch client")
        return None


def publish_heartbeat(outcome: Any, *, region: str, environment: str) -> None:
    """Publish the sweep's outcome as metrics.

    `SweepCompleted` is the heartbeat: an alarm on `< 1` over a few periods with
    `treatMissingData: breaching` fires when the worker stops running at all, which no
    error-count alarm can detect.

    Failure to publish is logged and swallowed. A telemetry outage must not stop the
    cleanup that already happened from being recorded in the ledger.
    """
    client = _metrics_client(region)
    if client is None:
        return
    dimensions = [{"Name": "Environment", "Value": environment}]
    data = [
        {"MetricName": "SweepCompleted", "Value": 1, "Unit": "Count",
         "Dimensions": dimensions},
        {"MetricName": "SweptJobs", "Value": outcome.swept_jobs, "Unit": "Count",
         "Dimensions": dimensions},
        {"MetricName": "SweptResources", "Value": outcome.swept_resources,
         "Unit": "Count", "Dimensions": dimensions},
        {"MetricName": "ResourcesDeleted", "Value": len(outcome.deleted),
         "Unit": "Count", "Dimensions": dimensions},
        # The three that need a human.
        {"MetricName": "CleanupIncomplete", "Value": len(outcome.cleanup_incomplete),
         "Unit": "Count", "Dimensions": dimensions},
        {"MetricName": "DeleteUnconfirmed", "Value": len(outcome.delete_unconfirmed),
         "Unit": "Count", "Dimensions": dimensions},
        {"MetricName": "SweepErrors", "Value": len(outcome.errors), "Unit": "Count",
         "Dimensions": dimensions},
        {"MetricName": "UnownedResourceKinds", "Value": len(outcome.unowned_kinds),
         "Unit": "Count", "Dimensions": dimensions},
    ]
    try:
        client.put_metric_data(Namespace=METRIC_NAMESPACE, MetricData=data)
    except Exception:  # noqa: BLE001
        log.exception("could not publish reconciler heartbeat")


def build_reconciler(
    *,
    region: str,
    table_name: str,
    environment: str,
    account_id: str = "",
    permitted_regions: tuple[str, ...] = (),
):
    """Wire the store, the real AWS adapters and the heartbeat together.

    The account and permitted Regions are passed to the adapters so an entry outside
    them is refused rather than checked in the wrong place. A not-found from the wrong
    Region is not evidence about the right one.
    """
    from .adapters.aws_cleanup import default_adapters
    from .adapters.artifact_cleanup import ModelArtifactsAdapter, EndpointLogsAdapter
    from .reconciler import Reconciler
    from .store import DynamoStore

    return Reconciler(
        DynamoStore(table_name, region),
        default_adapters(
            region, account_id=account_id, permitted_regions=permitted_regions
        ) + (ModelArtifactsAdapter(account_id=account_id, permitted_regions=permitted_regions),
             EndpointLogsAdapter(account_id=account_id, permitted_regions=permitted_regions)),
        heartbeat=lambda outcome: publish_heartbeat(
            outcome, region=region, environment=environment
        ),
    )


def _caller_account(region: str) -> str:
    """The account the worker is actually running in, for scope validation."""
    try:
        import boto3

        return str(boto3.client("sts", region_name=region).get_caller_identity()["Account"])
    except Exception:  # noqa: BLE001
        log.exception("could not determine the caller account")
        return ""


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    """Lambda entry point. Invoked by EventBridge on a fixed schedule.

    Returns the sweep outcome so a manual invocation is inspectable, and logs a
    structured line so CloudWatch Logs Insights can query sweeps without metrics.

    Never raises. An exception would make Lambda retry the whole sweep, and a sweep is
    already idempotent but the retry would double the log noise while the underlying
    problem -- usually a throttle -- is better handled by the next scheduled run. The
    error count is published instead, which is what the alarm reads.
    """
    region = os.environ.get("EDDIE_REGION", os.environ.get("AWS_REGION", "us-east-1"))
    table_name = os.environ.get("CASE_TABLE", "")
    environment = os.environ.get("EDDIE_ENVIRONMENT", "dev")

    if not table_name:
        # Cannot reconcile without the ledger. Reported as an error metric, not a
        # silent success, because a worker that beats while doing nothing is worse
        # than one that does not beat.
        log.error("CASE_TABLE is not configured; cannot reconcile")
        client = _metrics_client(region)
        if client is not None:
            try:
                client.put_metric_data(
                    Namespace=METRIC_NAMESPACE,
                    MetricData=[
                        {
                            "MetricName": "SweepErrors",
                            "Value": 1,
                            "Unit": "Count",
                            "Dimensions": [
                                {"Name": "Environment", "Value": environment}
                            ],
                        }
                    ],
                )
            except Exception:  # noqa: BLE001
                log.exception("could not publish configuration-error metric")
        return {"ok": False, "error": "CASE_TABLE is not configured"}

    permitted = tuple(
        r.strip()
        for r in os.environ.get("EDDIE_CLEANUP_REGIONS", region).split(",")
        if r.strip()
    )
    try:
        reconciler = build_reconciler(
            region=region,
            table_name=table_name,
            environment=environment,
            account_id=_caller_account(region),
            permitted_regions=permitted,
        )
        # Publish one aggregate heartbeat only after both ledgers were inspected.
        reconciler.heartbeat = None
        outcome = reconciler.sweep()
        legacy_table = os.environ.get("EDDIE_LEGACY_CLEANUP_TABLE", "")
        if legacy_table and legacy_table != table_name:
            legacy = build_reconciler(region=region, table_name=legacy_table, environment=environment,
                account_id=_caller_account(region), permitted_regions=permitted)
            legacy.heartbeat = None
            historical = legacy.sweep()
            outcome.errors.extend(historical.errors)
            outcome.cleanup_incomplete.extend(historical.cleanup_incomplete)
            outcome.delete_unconfirmed.extend(historical.delete_unconfirmed)
            outcome.unowned_kinds.extend(historical.unowned_kinds)
            outcome.swept_jobs += historical.swept_jobs
            outcome.swept_resources += historical.swept_resources
            outcome.deleted.extend(historical.deleted)
        publish_heartbeat(outcome, region=region, environment=environment)
    except Exception as exc:  # noqa: BLE001
        log.exception("reconciliation worker failed before sweeping")
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    payload = outcome.to_json()
    log.info("reconcile %s", json.dumps(payload))
    if outcome.needs_attention:
        # A distinct, greppable line for the runbook. The alarm fires on the metric;
        # this is what an operator reads afterwards.
        log.warning(
            "reconciler needs attention: cleanupIncomplete=%s deleteUnconfirmed=%s "
            "unownedKinds=%s errors=%s",
            outcome.cleanup_incomplete,
            outcome.delete_unconfirmed,
            outcome.unowned_kinds,
            outcome.errors,
        )
    return {"ok": True, "result": payload}

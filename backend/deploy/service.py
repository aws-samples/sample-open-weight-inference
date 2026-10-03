"""Authenticated deployment control. No SageMaker create or inference permissions.

Only this service can prepare/approve plans and admit jobs. The independent worker
acts on the persisted approval, not an LLM-generated AWS request. It runs again from
EventBridge if the initial notification is lost.
"""
from __future__ import annotations

import json
import re
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

import boto3
from botocore.config import Config

from runtime.principal import Authenticator, authorize_action, authorize_project, strip_identity_fields
from .models import (
    ApprovalError, Artifact, Check, CheckStatus, Job, Lifecycle, Plan, PlanKind,
    ResourceEnvelope, Target, approve, new_job, new_plan, _iso, _now,
)
from .recipes import Settings, RECIPE_ID, RECIPE_VERSION, INSTANCE_TYPE, QUOTA_CODE, digest, inspect_recipe_model
from .checkpoints import (
    CHECKPOINT_RECIPE_ID, CHECKPOINT_RECIPE_VERSION, inspect_checkpoint,
    inspection_result, list_checkpoints,
)
from .speech import (
    SPEECH_INSTANCE_TYPE, SPEECH_QUOTA_CODE, SPEECH_RECIPE_ID, SPEECH_RECIPE_VERSION,
)
from .store import DynamoStore

CLIENT_CONFIG = Config(connect_timeout=3, read_timeout=20, retries={"mode": "standard", "max_attempts": 2})
SETTINGS = Settings.from_environment()
AUTH = Authenticator.from_environment()


def client(service: str, region: str):
    return boto3.client(service, region_name=region, config=CLIENT_CONFIG)


def check(name: str, passed: bool, expected: str, observed: str, *, required: bool = True) -> Check:
    return Check(name, CheckStatus.PASS if passed else CheckStatus.FAIL,
                 Lifecycle.PRE_CREATION, expected, observed, required=required)


def verify_network(settings: Settings) -> list[Check]:
    ec2 = client("ec2", settings.region)
    subnets = ec2.describe_subnets(SubnetIds=list(settings.subnets))["Subnets"]
    groups = ec2.describe_security_groups(GroupIds=[settings.security_group])["SecurityGroups"]
    vpcs = {s["VpcId"] for s in subnets}
    isolated = len(vpcs) == 1 and len(subnets) >= 2 and len({s["AvailabilityZone"] for s in subnets}) >= 2
    isolated = isolated and all(not s.get("MapPublicIpOnLaunch") for s in subnets)
    isolated = isolated and len(groups) == 1 and groups[0]["VpcId"] in vpcs and not groups[0].get("IpPermissions")
    # A subnet may inherit the main route table. Inspect all tables in the VPC and
    # explicitly choose the association or main table; absence is not proof.
    if isolated:
        tables = ec2.describe_route_tables(Filters=[{"Name": "vpc-id", "Values": list(vpcs)}])["RouteTables"]
        main = next((t for t in tables if any(a.get("Main") for a in t.get("Associations", []))), None)
        for subnet in subnets:
            table = next((t for t in tables if any(a.get("SubnetId") == subnet["SubnetId"] for a in t.get("Associations", []))), main)
            if not table:
                isolated = False
                break
            # No IGW, NAT, peering, transit gateway, VPN or egress-only gateway path.
            for route in table.get("Routes", []):
                gateway = route.get("GatewayId")
                if any(route.get(k) for k in ("NatGatewayId", "TransitGatewayId", "VpcPeeringConnectionId", "EgressOnlyInternetGatewayId", "NetworkInterfaceId")):
                    isolated = False
                if gateway and gateway != "local" and not gateway.startswith("vpce-"):
                    isolated = False
    return [check("network.private", isolated, "Two private subnets without internet routes; no inbound rules",
                  "Private serving network verified." if isolated else "The serving network does not match the private profile.")]


def recipe_profile(settings: Settings, recipe_id: str) -> dict[str, str]:
    """Instance, quota and image are properties of the reviewed recipe, never the request."""
    if recipe_id == SPEECH_RECIPE_ID:
        return {"instance": SPEECH_INSTANCE_TYPE, "quota": SPEECH_QUOTA_CODE, "image": settings.speech_image}
    if recipe_id in (RECIPE_ID, CHECKPOINT_RECIPE_ID):
        return {"instance": INSTANCE_TYPE, "quota": QUOTA_CODE, "image": settings.image}
    raise ValueError("The deployment recipe is not supported.")


def verify_image(settings: Settings, image: str | None = None) -> Check:
    repo, sha = (image or settings.image).split("/", 1)[1].split("@", 1)
    evidence = client("ecr", settings.region).describe_image_scan_findings(
        repositoryName=repo, imageId={"imageDigest": sha},
    )
    findings = evidence.get("imageScanFindings", {})
    counts = findings.get("findingSeverityCounts", {})
    scanned = findings.get("imageScanCompletedAt")
    fresh = bool(scanned and datetime.now(timezone.utc) - scanned < timedelta(days=30))
    passed = evidence.get("imageScanStatus", {}).get("status") == "COMPLETE" and fresh and not (counts.get("CRITICAL", 0) or counts.get("HIGH", 0))
    return check("image.scan", passed, "Pinned image with a completed recent ECR scan and no high/critical findings",
                 f"ECR basic scan at {scanned}; high={counts.get('HIGH', 0)}, critical={counts.get('CRITICAL', 0)}. This is not a complete application security review.")


def verify_cleanup(settings: Settings) -> Check:
    """A saved class or an enabled rule alone is not proof of unattended cleanup."""
    events = client("events", settings.region)
    rule_name = f"eddie-{settings.environment}-reconcile"
    rule = events.describe_rule(Name=rule_name)
    targets = events.list_targets_by_rule(Rule=rule_name).get("Targets", [])
    configuration = client("lambda", settings.region).get_function_configuration(FunctionName=settings.reconciler_function)
    expected_alarms = [f"eddie-{settings.environment}-{suffix}" for suffix in (
        "reconciler-stopped", "cleanup-incomplete", "delete-unconfirmed", "reconciler-errors",
    )]
    cw = client("cloudwatch", settings.region)
    alarms = cw.describe_alarms(AlarmNames=expected_alarms).get("MetricAlarms", [])
    now = _now()
    evidence = cw.get_metric_data(
        MetricDataQueries=[{"Id": "completed", "MetricStat": {"Metric": {
            "Namespace": "EDDIE/Reconciler", "MetricName": "SweepCompleted",
            "Dimensions": [{"Name": "Environment", "Value": settings.environment}],
        }, "Period": 60, "Stat": "Sum"}, "ReturnData": True}],
        StartTime=now - timedelta(minutes=12), EndTime=now, ScanBy="TimestampDescending", MaxDatapoints=20,
    )
    sweeps = [stamp for series in evidence.get("MetricDataResults", []) if series.get("StatusCode") == "Complete"
              for stamp, value in zip(series.get("Timestamps", []), series.get("Values", [])) if value >= 1]
    passed = (
        rule.get("State") == "ENABLED" and rule.get("ScheduleExpression") == "rate(5 minutes)"
        and any(t.get("Arn") == settings.reconciler_function for t in targets)
        and configuration.get("State") == "Active" and configuration.get("LastUpdateStatus") == "Successful"
        and len(alarms) == len(expected_alarms)
        and all(a.get("StateValue") == "OK" and a.get("ActionsEnabled") and a.get("AlarmActions") for a in alarms)
        and bool(sweeps)
    )
    latest = max(sweeps).isoformat() if sweeps else "no completed sweep within 12 minutes"
    return check("cleanup.automation", passed, "Scheduled cleanup active, recent heartbeat, and configured alarms healthy",
                 f"Cleanup last completed: {latest}." if passed else
                 "Automatic cleanup is not currently verified as healthy. Wait for the next sweep or ask the installation operator to check its schedule and alarms.")


def safety_checks(settings: Settings, recipe_id: str = RECIPE_ID) -> list[Check]:
    profile = recipe_profile(settings, recipe_id)
    checks = verify_network(settings)
    checks.append(verify_image(settings, profile["image"]))
    checks.append(verify_cleanup(settings))
    quota = client("service-quotas", settings.region).get_service_quota(
        ServiceCode="sagemaker", QuotaCode=profile["quota"],
    )["Quota"]
    checks.append(check("quota.applied", Decimal(str(quota["Value"])) >= 1,
                        f"Applied {profile['instance']} endpoint quota at least one",
                        f"Applied quota {quota['Value']}. Existing usage and capacity are checked by allocation; quota is not a reservation."))
    return checks


class DeploymentService:
    def __init__(self, settings: Settings, store: Any):
        self.settings, self.store = settings, store

    def prepare(self, payload: dict[str, Any], principal: Any, project: str) -> dict[str, Any]:
        if not self.settings.any_ready:
            raise ValueError("Test deployments are not configured in this installation.")
        region = payload.get("region") or self.settings.region
        if region != self.settings.region:
            raise ValueError(f"This installation can deploy only in {self.settings.region}. Your selected Region was not changed.")
        try:
            minutes = int(str(payload.get("lifetimeMinutes", "45")))
            ceiling = Decimal(str(payload.get("maxSpendUsd", "5")))
        except (ValueError, InvalidOperation):
            raise ValueError("Choose a whole number of minutes and a dollar limit.") from None
        if minutes < 30 or minutes > 60 or not ceiling.is_finite() or ceiling < Decimal("0.01") or ceiling > Decimal("10"):
            raise ValueError("Tests must last 30–60 minutes with a test budget between $0.01 and $10.")
        case_identity = payload.get("caseFingerprint")
        if not isinstance(case_identity, str) or not re.fullmatch(r"[0-9a-f]{64}", case_identity):
            raise ValueError("The project changed or its identity is missing. Prepare the review again.")
        is_checkpoint = str(payload.get("source") or "").startswith("s3://")
        metadata = (inspect_checkpoint(payload["source"], self.settings, project,
                                       client("s3", region), payload.get("revision"))
                    if is_checkpoint else inspect_recipe_model(payload.get("source"), payload.get("revision")))
        speech = metadata.get("recipeId") == SPEECH_RECIPE_ID
        recipe_id = SPEECH_RECIPE_ID if speech else CHECKPOINT_RECIPE_ID if is_checkpoint else RECIPE_ID
        recipe_version = (SPEECH_RECIPE_VERSION if speech else
                          CHECKPOINT_RECIPE_VERSION if is_checkpoint else RECIPE_VERSION)
        if not (self.settings.speech_ready if speech else self.settings.ready):
            raise ValueError("This model's reviewed deployment recipe is not configured in this installation. "
                             "No plan was created.")
        target = payload.get("target", "SAGEMAKER_REALTIME")
        if target != "SAGEMAKER_REALTIME":
            raise ValueError("This installation has no executable recipe for that hosting target. The selected target was not changed.")
        profile = recipe_profile(self.settings, recipe_id)
        from catalog.pricing import sagemaker_hosting_rate
        rate = sagemaker_hosting_rate(profile["instance"], region)
        if rate is None:
            raise ValueError("A current SageMaker hosting price could not be obtained. No plan was created.")
        checks = safety_checks(self.settings, recipe_id)
        # This is a disclosed allowance, not an invented service price. The only
        # quoted rate is the live SageMaker Hosting SKU. No fixed monthly costs are
        # assigned to a short test.
        allowance = Decimal("0.50")
        expected = (rate.amount * Decimal(minutes) / 60).quantize(Decimal("0.01"))
        with_buffer = (rate.amount * Decimal(minutes + 15) / 60 + allowance).quantize(Decimal("0.01"))
        checks.append(check("budget.guard", with_buffer <= ceiling,
                            "Hosting duration plus 15-minute cleanup buffer and $0.50 allowance fits the test budget",
                            f"${with_buffer} allowance-inclusive admission estimate against ${ceiling}."))
        price_evidence = {"amount": str(rate.amount), "unit": rate.unit, "currency": rate.currency,
                          "region": rate.region, "sku": rate.sku, "effectiveDate": rate.effective_date,
                          "source": rate.source, "retrievedAt": _iso(_now())}
        plan = new_plan(
            kind=PlanKind.TRIAL, target=Target.SAGEMAKER_REALTIME, project_id=project,
            account_id=self.settings.account, region=region, created_by=principal.subject,
            recipe_id=recipe_id, recipe_version=recipe_version, model_ref=metadata["source"],
            artifacts=(
                Artifact("weights", metadata["source"] if is_checkpoint else f"hf://{metadata['source']}", digest=metadata["revision"]),
                Artifact("manifest", "eddie://model-files", digest=digest(metadata)),
                Artifact("image", profile["image"], digest=profile["image"].split("@")[1], scan_status="COMPLETE"),
                Artifact("config", "eddie://private-sagemaker-profile",
                         digest=self.settings.recipe_fingerprint(recipe_id, target)),
                Artifact("price", "aws-price-list://sagemaker-hosting", digest=digest(price_evidence)),
            ),
            envelope=ResourceEnvelope(
                instance_type=profile["instance"], max_instance_count=1, max_concurrent_jobs=1,
                max_spend_usd=ceiling, max_lifetime_minutes=minutes,
                execution_deadline_minutes=25, max_storage_gb=500, max_retries=2,
                permitted_regions=(region,),
            ),
            evaluated_request_hash=case_identity,
            estimated_setup_usd=allowance, estimated_hourly_usd=rate.amount,
            checks=tuple(checks),
            notes=(
                ("Trial only. It checks that the model loads and returns valid audio; speech quality, "
                 "throughput and concurrency remain unmeasured." if speech else
                 "Trial only. Answer quality, throughput and p99 performance remain unqualified."),
                "The lifetime starts when you approve and start, including model preparation.",
                "Expiry requests removal. Billing continues until AWS confirms removal; it is not a financial hard cap.",
                (f"One fixed CPU instance ({SPEECH_INSTANCE_TYPE}, Graviton); one request at a time. "
                 "No autoscaling, reservations, public IP or SSH access." if speech else
                 "One fixed GPU instance; no autoscaling, reservations, public IP or SSH access."),
                ("The reviewed Magpie bundle is used unchanged: model, codec and tokenizer files are verified "
                 "against the approved S3 versions and SHA-256 digests. Audio is returned to you, not stored."
                 if speech else
                 "The exact fine-tuned checkpoint is used; its base model is never substituted. "
                 "Files are capped at 18 GiB and verified against the approved S3 versions and SHA-256 digests."
                 if is_checkpoint else "Model files are capped at 4 GiB.") +
                " The 500 GB storage envelope includes the instance's managed local disk.",
            ),
            expires_at=_iso(_now() + timedelta(minutes=20)),
        )
        review = {
            "model": metadata,
            "cost": {"hostingEstimateUsd": str(expected), "hourlyUsd": str(rate.amount),
                     "admissionEstimateUsd": str(with_buffer), "additionalAllowanceUsd": str(allowance),
                     "cleanupBufferMinutes": 15, "priceEvidence": price_evidence},
        }
        self.store.put_plan(plan, review)
        return {**review, "plan": plan.to_json()}

    def approve_and_start(self, payload: dict[str, Any], principal: Any, project: str) -> dict[str, Any]:
        # One deliberate UI action. The stored approval is a separate durable record;
        # the launch transaction consumes it exactly once. Lost replies are recovered
        # with the same plan and approval reference, never by a duplicate create.
        plan = self.store.get_plan(project, str(payload.get("planId", "")))
        if payload.get("planHash") != plan.plan_hash:
            raise ApprovalError("This review no longer matches the plan. Review it again.", "plan_modified")
        if payload.get("acknowledgeCost") is not True or payload.get("modelTermsReviewed") is not True:
            raise ValueError("Review the model terms and confirm the displayed cost and removal time before starting.")
        if plan.expired or not plan.approvable:
            raise ApprovalError("This plan has expired or needs attention. Prepare a fresh plan.", "plan_not_current")
        config = next(a.digest for a in plan.artifacts if a.kind == "config")
        if config != self.settings.recipe_fingerprint(plan.recipe_id, plan.target.value):
            raise ApprovalError("The deployment configuration changed. Prepare a fresh plan.", "profile_changed")
        fresh_checks = safety_checks(self.settings, plan.recipe_id)
        if any(c.status is not CheckStatus.PASS for c in fresh_checks if c.required):
            raise ApprovalError("A deployment check changed. Prepare a fresh plan to see what needs attention.", "checks_changed")
        # The reference is a deterministic idempotency identity for this actor + plan.
        # It is NOT accepted from the client as proof of authorization.
        approval_ref = "approval-" + digest([plan.plan_id, plan.plan_hash, principal.subject])[:32]
        from .store import NotFound
        try:
            approval = self.store.get_approval(project, approval_ref)
        except NotFound:
            approval = replace(approve(plan, subject=principal.subject, username=principal.username,
                                       capability="approve"), approval_id=approval_ref)
            self.store.put_approval(approval)
            approval = self.store.get_approval(project, approval_ref)
        if approval.approved_by_subject != principal.subject:
            raise ApprovalError("The approval belongs to a different actor.", "approval_actor_mismatch")
        job = new_job(plan, approval, subject=principal.subject)
        job, created = self.store.launch(plan, approval, job, limit=1, account_limit=2)
        # This notification is only an acceleration. A schedule independently polls
        # admitted jobs, so a crash between commit and invoke cannot strand the job.
        if created:
            self.notify(self.settings.worker_function, {"projectId": project, "jobId": job.job_id})
        return {"deployment": self.view(job), "created": created, "approval": approval.to_json()}

    def notify(self, function: str, payload: dict[str, Any]) -> None:
        try:
            client("lambda", self.settings.region).invoke(
                FunctionName=function, InvocationType="Event",
                Payload=json.dumps(payload).encode(),
            )
        except Exception:
            # The durable schedule recovers the committed action; the API must not
            # invite a second allocation by presenting the committed start as failed.
            pass

    def view(self, job: Job) -> dict[str, Any]:
        plan = self.store.get_plan(job.project_id, job.plan_id)
        resources = tuple(self.store.list_resources(job.job_id))
        return {**replace(job, resources=resources).to_json(), "modelRef": plan.model_ref,
                "region": plan.region, "hourlyUsd": str(plan.estimated_hourly_usd),
                "modelRevision": next(a.digest for a in plan.artifacts if a.kind == "weights"),
                "kind": plan.kind.value, "performanceQualified": False,
                "recipeId": plan.recipe_id, "instanceType": plan.envelope.instance_type}

    def list(self, project: str) -> dict[str, Any]:
        from .reconciler import residual_report
        jobs = self.store.list_jobs(project)
        return {"deployments": [self.view(self.store.get_job(project, j.job_id)) for j in jobs],
                "residual": residual_report(self.store, project_id=project),
                "capability": self.settings.capability(), "storeConfigured": True}


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    """Only IAM-authorized Lambda invocation plus an independently verified user JWT.

    No event, token, prompt, or full exception object is logged.
    """
    from .store import NotFound, ConcurrencyLimitExceeded
    from runtime.principal import AuthenticationError, AuthorizationError
    try:
        principal = AUTH.authenticate(event.get("authorization"))
        action = str(event.get("action", ""))
        authorize_action(principal, action)
        payload, _ = strip_identity_fields(event.get("payload") or {})
        project = authorize_project(principal, payload.get("projectId"))
        store = DynamoStore(SETTINGS.table, SETTINGS.region)
        service = DeploymentService(SETTINGS, store)
        if action == "deployment.list":
            result = service.list(project)
        elif action == "deployment.get":
            job = store.get_job(project, str(payload.get("jobId", "")))
            result = {"deployment": service.view(job), "resources": [r.to_json() for r in store.list_resources(job.job_id)]}
        elif action == "plan.create":
            result = service.prepare(payload, principal, project)
        elif action == "checkpoint.list":
            result = list_checkpoints(SETTINGS, project, client("s3", SETTINGS.region))
        elif action == "checkpoint.inspect":
            result = inspection_result(inspect_checkpoint(
                payload.get("source"), SETTINGS, project, client("s3", SETTINGS.region),
                payload.get("revision"),
            ))
        elif action == "plan.get":
            result = store.get_plan_review(project, str(payload.get("planId", "")))
        elif action == "plan.list":
            started = {job.plan_id: job.job_id for job in store.list_jobs(project)}
            result = {"plans": [{**p.to_json(), "startedJobId": started.get(p.plan_id)} for p in store.list_plans(project)],
                      "capability": SETTINGS.capability()}
        elif action == "plan.approve":
            authorize_action(principal, "deployment.start")
            result = service.approve_and_start(payload, principal, project)
        elif action == "deployment.delete":
            job = store.request_deletion(project, str(payload.get("jobId", "")))
            service.notify(SETTINGS.reconciler_function, {})
            result = {"deployment": service.view(job)}
        else:
            raise ValueError("This deployment action is not available.")
        return {"ok": True, "result": result}
    except (ValueError, ApprovalError, NotFound, ConcurrencyLimitExceeded, AuthenticationError, AuthorizationError) as exc:
        return {"ok": False, "error": getattr(exc, "code", "invalid_request"), "detail": str(exc)}
    except Exception:
        return {"ok": False, "error": "deployment_service_unavailable",
                "detail": "The deployment service could not complete this request. No approval should be assumed; refresh deployments before retrying."}

"""Durable, bounded SageMaker execution. Invoked by a schedule and start notifications.

Each pass advances an admitted job. Long artifact downloads run under a different
identity. All creates have an intent in the ledger first and a deterministic name.
No runtime supplied AWS parameters are forwarded.
"""
from __future__ import annotations

import json
import logging
from dataclasses import replace
from decimal import Decimal
from typing import Any

from .adapters.aws_cleanup import is_not_found
from .failures import DeploymentFailure, endpoint_failure
from .models import Job, JobState, LedgerEntry, ResourceState, intent_key, with_step, _now, _iso
from .recipes import Settings, RECIPE_ID, RECIPE_VERSION, INSTANCE_TYPE, INFERENCE_AMI, serving_environment
from .checkpoints import CHECKPOINT_RECIPE_ID, CHECKPOINT_RECIPE_VERSION
from .speech import SPEECH_INSTANCE_TYPE, SPEECH_RECIPE_ID, SPEECH_RECIPE_VERSION, speech_environment
from .service import client
from .store import DynamoStore

SETTINGS = Settings.from_environment()
NO_RESOURCE = ("could not find", "does not exist")
log = logging.getLogger("eddie.deployment")


def job_name(settings: Settings, job: Job) -> str:
    return f"eddie-{settings.environment}-{job.job_id}"


def model_prefix(settings: Settings, job: Job) -> str:
    return f"models/eddie-{settings.environment}/{job.job_id}/"


def step_done(job: Job, name: str) -> bool:
    return any(s.name == name and s.state == "DONE" for s in job.steps)


def admitted_plan(store: Any, settings: Settings, job: Job):
    plan = store.get_plan(job.project_id, job.plan_id)
    approval = store.get_approval(job.project_id, job.approval_id)
    if (plan.plan_hash != job.plan_hash or approval.plan_hash != job.plan_hash
            or approval.consumed_by_job != job.job_id or approval.plan_id != plan.plan_id
            or approval.project_id != job.project_id or approval.policy_version != plan.policy_version
            or approval.approved_by_subject != job.started_by_subject):
        raise DeploymentFailure("approval_mismatch", "The persisted plan, admission and approval do not agree.")
    recipes = {RECIPE_ID: RECIPE_VERSION, CHECKPOINT_RECIPE_ID: CHECKPOINT_RECIPE_VERSION,
               SPEECH_RECIPE_ID: SPEECH_RECIPE_VERSION}
    instance = SPEECH_INSTANCE_TYPE if plan.recipe_id == SPEECH_RECIPE_ID else INSTANCE_TYPE
    if (recipes.get(plan.recipe_id) != plan.recipe_version
            or plan.target.value != "SAGEMAKER_REALTIME"
            or plan.account_id != settings.account or plan.region != settings.region
            or plan.envelope.instance_type != instance or plan.envelope.max_instance_count != 1):
        raise DeploymentFailure("recipe_mismatch", "The admitted plan does not match this worker's reviewed recipe.")
    config = next(a.digest for a in plan.artifacts if a.kind == "config")
    if config != settings.recipe_fingerprint(plan.recipe_id, plan.target.value):
        raise DeploymentFailure("profile_changed", "The reviewed deployment profile changed after approval.")
    return plan


def still_creating(store: Any, job: Job) -> Job:
    current = store.get_job(job.project_id, job.job_id)
    if current.state not in (JobState.PENDING, JobState.RUNNING):
        raise DeploymentFailure("creation_stopped", "This deployment is no longer accepting creation steps.")
    if current.past_deadline or current.resources_expired:
        raise DeploymentFailure("execution_expired", "The permitted execution time has ended.")
    return current


def intent(store: Any, settings: Settings, job: Job, kind: str, identity: str,
           *, hourly: Decimal | None = None) -> LedgerEntry:
    key = intent_key(job.job_id, kind, identity)
    existing = next((r for r in store.list_resources(job.job_id) if r.intent_key == key), None)
    if existing:
        if existing.state in (ResourceState.DELETED, ResourceState.DELETING, ResourceState.DELETE_UNCONFIRMED):
            raise DeploymentFailure("resource_removal_started", "A resource scheduled for deletion cannot be recreated.")
        return existing
    entry = LedgerEntry(
        entry_id=key, job_id=job.job_id, project_id=job.project_id, kind=kind,
        intent_key=key, state=ResourceState.INTENDED, account_id=settings.account,
        region=settings.region, planned_name=identity, expires_at=job.resource_expires_at,
        hourly_usd=hourly, tags={
            "eddie:environment": settings.environment, "eddie:job": job.job_id,
            "eddie:plan-hash": job.plan_hash,
        },
    )
    store.put_resource(entry)
    return entry


def created(store: Any, entry: LedgerEntry, arn: str | None = None) -> None:
    store.put_resource(replace(entry, state=ResourceState.CREATED, physical_id=entry.planned_name,
                               arn=arn, updated_at=_iso(_now())))


class SageMakerExecutor:
    def __init__(self, settings: Settings, store: Any):
        self.settings, self.store = settings, store
        self.sm = client("sagemaker", settings.region)

    def _get(self, operation: str, key: str, name: str) -> dict[str, Any] | None:
        try:
            return getattr(self.sm, operation)(**{key: name})
        except Exception as exc:
            if is_not_found(exc, codes=("ValidationException",), require_message=NO_RESOURCE):
                return None
            raise

    def _owned(self, document: dict[str, Any], arn_key: str, job: Job) -> None:
        tags = self.sm.list_tags(ResourceArn=document[arn_key]).get("Tags", [])
        values = {t["Key"]: t["Value"] for t in tags}
        if values.get("eddie:job") != job.job_id or values.get("eddie:plan-hash") != job.plan_hash:
            raise DeploymentFailure("resource_not_owned", "A resource with the planned name is not owned by this approved job.")

    def advance(self, job: Job) -> bool:
        plan = admitted_plan(self.store, self.settings, job)
        job = still_creating(self.store, job)
        if not step_done(job, "prepare-model"):
            # The artifact worker takes the same lease after this invocation leaves.
            # Duplicate schedule deliveries cannot produce parallel downloads.
            self.store.put_job(replace(with_step(job, "prepare-model", "RUNNING",
                "Downloading only pinned model and tokenizer files; checking every file's digest."),
                state=JobState.RUNNING))
            return True
        name = job_name(self.settings, job)
        tags = [{"Key": "eddie:environment", "Value": self.settings.environment},
                {"Key": "eddie:job", "Value": job.job_id},
                {"Key": "eddie:plan-hash", "Value": job.plan_hash}]
        job = still_creating(self.store, job)
        # Logs are a chargeable artifact too. Own them before SageMaker could create
        # the log group implicitly, and remove them only after the endpoint is gone.
        log_name = f"/aws/sagemaker/Endpoints/{name}"
        log_entry = intent(self.store, self.settings, job, "sagemaker-log-group", log_name)
        logs = client("logs", self.settings.region)
        try:
            logs.create_log_group(logGroupName=log_name, kmsKeyId=self.settings.kms_key,
                                  tags={"eddie:job": job.job_id, "eddie:environment": self.settings.environment})
        except logs.exceptions.ResourceAlreadyExistsException:
            actual_tags = logs.list_tags_log_group(logGroupName=log_name).get("tags", {})
            if actual_tags.get("eddie:job") != job.job_id:
                raise DeploymentFailure("logs_not_owned", "The endpoint log group is not owned by this job.")
        logs.put_retention_policy(logGroupName=log_name, retentionInDays=7)
        created(self.store, log_entry)

        speech = plan.recipe_id == SPEECH_RECIPE_ID
        container = {
            "Image": self.settings.speech_image if speech else self.settings.image,
            "ModelDataSource": {"S3DataSource": {
                "S3Uri": f"s3://{self.settings.bucket}/{model_prefix(self.settings, job)}files/",
                "S3DataType": "S3Prefix", "CompressionType": "None",
            }},
            "Environment": (speech_environment() if speech else
                            serving_environment(checkpoint=plan.recipe_id == CHECKPOINT_RECIPE_ID)),
        }
        model_entry = intent(self.store, self.settings, job, "sagemaker-model", name)
        model = self._get("describe_model", "ModelName", name)
        if model:
            self._owned(model, "ModelArn", job)
            actual = model.get("PrimaryContainer", {})
            actual_source = actual.get("ModelDataSource", {}).get("S3DataSource", {})
            expected_source = container["ModelDataSource"]["S3DataSource"]
            if (actual.get("Image") != container["Image"] or actual.get("Environment") != container["Environment"]
                    or any(actual_source.get(k) != v for k, v in expected_source.items())
                    or not model.get("EnableNetworkIsolation")
                    or model.get("ExecutionRoleArn") != self.settings.execution_role
                    or set(model.get("VpcConfig", {}).get("Subnets", [])) != set(self.settings.subnets)
                    or model.get("VpcConfig", {}).get("SecurityGroupIds") != [self.settings.security_group]):
                raise DeploymentFailure("model_configuration_changed", "The existing model does not match the approved private configuration.")
        else:
            still_creating(self.store, job)
            model = self.sm.create_model(
                ModelName=name, ExecutionRoleArn=self.settings.execution_role,
                PrimaryContainer=container, EnableNetworkIsolation=True,
                VpcConfig={"Subnets": list(self.settings.subnets), "SecurityGroupIds": [self.settings.security_group]},
                Tags=tags,
            )
        created(self.store, model_entry, model["ModelArn"])
        job = still_creating(self.store, job)
        config_entry = intent(self.store, self.settings, job, "sagemaker-endpoint-config", name)
        config = self._get("describe_endpoint_config", "EndpointConfigName", name)
        # The CPU speech recipe uses SageMaker's default CPU host image; the GPU
        # inference AMI and its extended GPU start-up timeouts apply only to vLLM.
        variant = ({
            "VariantName": "primary", "ModelName": name,
            "InstanceType": SPEECH_INSTANCE_TYPE, "InitialInstanceCount": 1,
            "InitialVariantWeight": 1.0, "EnableSSMAccess": False,
        } if speech else {
            "VariantName": "primary", "ModelName": name,
            "InstanceType": INSTANCE_TYPE, "InitialInstanceCount": 1,
            "InitialVariantWeight": 1.0, "InferenceAmiVersion": INFERENCE_AMI,
            "ModelDataDownloadTimeoutInSeconds": 600,
            "ContainerStartupHealthCheckTimeoutInSeconds": 600,
            "EnableSSMAccess": False,
        })
        if config:
            self._owned(config, "EndpointConfigArn", job)
            variants = config.get("ProductionVariants", [])
            if len(variants) != 1 or any(variants[0].get(k) != v for k, v in variant.items()):
                raise DeploymentFailure("endpoint_configuration_changed", "The endpoint configuration does not match the reviewed size.")
            if config.get("DataCaptureConfig", {}).get("EnableCapture"):
                raise DeploymentFailure("unexpected_data_capture", "Unexpected prompt capture is enabled.")
        else:
            still_creating(self.store, job)
            config = self.sm.create_endpoint_config(
                EndpointConfigName=name, ProductionVariants=[variant], Tags=tags,
            )
        created(self.store, config_entry, config["EndpointConfigArn"])
        job = still_creating(self.store, job)
        endpoint_entry = intent(self.store, self.settings, job, "sagemaker-endpoint", name,
                                hourly=plan.estimated_hourly_usd)
        endpoint = self._get("describe_endpoint", "EndpointName", name)
        if endpoint:
            self._owned(endpoint, "EndpointArn", job)
            if endpoint.get("EndpointConfigName") != name:
                raise DeploymentFailure("endpoint_configuration_changed", "The endpoint is using a different configuration.")
        else:
            still_creating(self.store, job)
            endpoint = self.sm.create_endpoint(EndpointName=name, EndpointConfigName=name, Tags=tags)
        created(self.store, endpoint_entry, endpoint["EndpointArn"])
        job = still_creating(self.store, job)
        status = endpoint.get("EndpointStatus", "Creating")
        if status == "InService":
            self.store.put_job(replace(with_step(job, "create-endpoint", "DONE",
                "Private SageMaker endpoint is in service. Try it with a signed-in request."),
                state=JobState.EXPERIMENTAL))
        elif status in ("Creating", "SystemUpdating"):
            self.store.put_job(replace(with_step(job, "create-endpoint", "RUNNING",
                "AWS is allocating capacity and starting the model. Closing this page does not cancel the job."),
                state=JobState.RUNNING))
        else:
            raise endpoint_failure(status, endpoint.get("FailureReason"))
        return False


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    store = DynamoStore(SETTINGS.table, SETTINGS.region)
    if not SETTINGS.any_ready:
        return {"ok": False, "error": "deployment_not_configured"}
    if event.get("jobId") and event.get("projectId"):
        jobs = [store.get_job(str(event["projectId"]), str(event["jobId"]))]
    else:
        jobs = store.open_jobs()
    processed = []
    for snapshot in jobs[:10]:
        # Never start a new 600s lease near the Lambda hard deadline.
        if context and context.get_remaining_time_in_millis() < 90_000:
            break
        needs_staging = False
        with store.lease_job(snapshot.job_id) as acquired:
            if not acquired:
                continue
            job = store.get_job(snapshot.project_id, snapshot.job_id)
            if job.state not in (JobState.PENDING, JobState.RUNNING):
                continue
            try:
                needs_staging = SageMakerExecutor(SETTINGS, store).advance(job)
                processed.append(job.job_id)
            except Exception as exc:
                # No prompt, presigned URL or AWS credentials in a failure receipt.
                response = getattr(exc, "response", {})
                code = (exc.code if isinstance(exc, DeploymentFailure) else
                        response.get("Error", {}).get("Code", type(exc).__name__))
                explanation = (exc.explanation if isinstance(exc, DeploymentFailure)
                               else f"Deployment stopped ({code}).")
                log.error(json.dumps({
                    "event": "deployment_failed", "jobId": job.job_id, "code": code,
                    "requestId": response.get("ResponseMetadata", {}).get("RequestId"),
                    "diagnostic": exc.diagnostic if isinstance(exc, DeploymentFailure) else "",
                }))
                current = store.get_job(job.project_id, job.job_id)
                if current.state not in (JobState.DELETED, JobState.DELETING):
                    store.put_job(replace(with_step(current, "create-endpoint", "FAILED",
                        f"{explanation} Owned resources are queued for removal."),
                        state=JobState.FAILED, failure_reason=f"{explanation} Reference: {code}. Cleanup requested."))
        if needs_staging:
            # Send only after releasing the lease, so a warm artifact worker cannot
            # race with its parent's lock and repeatedly skip the download.
            client("lambda", SETTINGS.region).invoke(
                FunctionName=SETTINGS.staging_function, InvocationType="Event",
                Payload=json.dumps({"projectId": snapshot.project_id, "jobId": snapshot.job_id}).encode())
    return {"ok": True, "processed": processed}

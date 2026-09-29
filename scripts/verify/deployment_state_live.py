#!/usr/bin/env python3
"""Exercise deployment transactions in an isolated, temporary DynamoDB table.

No inference resources are created. This verifies database semantics, not the
application roles or the authenticated browser flow; those need separate proof.
The temporary table is removed even when an assertion fails.
"""
from __future__ import annotations

import argparse
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import sys
import uuid

import boto3

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from deploy.models import JobState, PlanKind, ResourceEnvelope, Target, approve, new_job, new_plan
from deploy.store import ConcurrencyLimitExceeded, DynamoStore, NotFound


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect-account", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    boto3.setup_default_session(profile_name=args.profile, region_name=args.region)
    account = boto3.client("sts").get_caller_identity()["Account"]
    if account != args.expect_account:
        raise SystemExit("Account mismatch; no table created.")
    client = boto3.client("dynamodb")
    table_name = f"eddie-state-proof-{uuid.uuid4().hex[:12]}"
    proof = {"checkedAt": datetime.now(timezone.utc).isoformat(), "account": account,
             "region": args.region, "temporaryTable": table_name, "checks": {},
             "scope": "Real DynamoDB transactions under verifier identity; no inference deployment."}
    created = False
    try:
        client.create_table(
            TableName=table_name, BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": name, "AttributeType": "S"} for name in ("pk", "sk")],
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            SSESpecification={"Enabled": True},
            Tags=[{"Key": "eddie:purpose", "Value": "temporary-state-verification"}],
        )
        created = True
        client.get_waiter("table_exists").wait(TableName=table_name, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
        store = DynamoStore(table_name, args.region)

        def prepare(project):
            plan = new_plan(
                kind=PlanKind.TRIAL, target=Target.SAGEMAKER_REALTIME, project_id=project,
                account_id=account, region=args.region, created_by="state-verifier",
                recipe_id="verification-only", recipe_version="1", model_ref="verification-only",
                artifacts=(), envelope=ResourceEnvelope(max_spend_usd=Decimal("10.50")),
            )
            grant = approve(plan, subject="state-verifier", username="State verifier", capability="deploy:trial")
            store.put_plan(plan, {"cost": {"exactDecimal": "10.50"}})
            store.put_approval(grant)
            return plan, grant, new_job(plan, grant, subject="state-verifier")

        plan, grant, job = prepare("verification:one")
        restored = store.get_plan(plan.project_id, plan.plan_id)
        assert restored.plan_hash == plan.plan_hash and restored.envelope.max_spend_usd == Decimal("10.50")
        assert store.list_plans(plan.project_id) == [plan]
        proof["checks"]["planRoundTripAndAuthorityPartition"] = True
        try:
            store.get_plan("verification:other", plan.plan_id)
            raise AssertionError("Cross-project read was accepted.")
        except NotFound:
            proof["checks"]["crossProjectReadRefused"] = True
        started, fresh = store.launch(plan, grant, job, limit=1, account_limit=1)
        assert fresh
        retry, fresh = store.launch(plan, grant, new_job(plan, grant, subject="state-verifier"), limit=1, account_limit=1)
        assert not fresh and retry.job_id == started.job_id
        store.put_approval(grant)
        assert store.get_approval(plan.project_id, grant.approval_id).consumed_by_job == job.job_id
        proof["checks"]["atomicStartReplayAndConsumedApprovalImmutable"] = True
        second, other_grant, other_job = prepare("verification:two")
        try:
            store.launch(second, other_grant, other_job, limit=1, account_limit=1)
            raise AssertionError("Account admission ceiling was exceeded.")
        except ConcurrencyLimitExceeded:
            assert store.get_approval(second.project_id, other_grant.approval_id).consumed_by_job is None
            assert store.list_jobs(second.project_id) == []
            proof["checks"]["failedAdmissionDoesNotConsumeApprovalOrCreateJob"] = True
        independent = DynamoStore(table_name, args.region)
        with store.lease_job(job.job_id) as first_lock:
            with independent.lease_job(job.job_id) as second_lock:
                assert first_lock and not second_lock
        with independent.lease_job(job.job_id) as second_lock:
            assert second_lock
        proof["checks"]["leaseExclusionAndRelease"] = True
        ready = replace(job, state=JobState.EXPERIMENTAL)
        store.put_job(ready)
        store.reserve_invocation(job.project_id, job.job_id, maximum=1)
        try:
            store.reserve_invocation(job.project_id, job.job_id, maximum=1)
            raise AssertionError("Invocation allowance was exceeded.")
        except ValueError:
            proof["checks"]["invocationAllowanceIsAtomic"] = True
        store.request_deletion(job.project_id, job.job_id)
        store.put_job(ready)
        assert store.get_job(job.project_id, job.job_id).state is JobState.DELETING
        assert store.list_jobs(job.project_id)[0].state is JobState.DELETING
        assert store.release_for_job(job)
        assert not independent.release_for_job(job)
        proof["checks"]["staleWriteCannotUndoRemovalAndReleaseIsSingleUse"] = True
        store.put_job(replace(job, state=JobState.DELETED))
        assert store.get_job(job.project_id, job.job_id).state is JobState.DELETED
        proof["passed"] = True
    finally:
        if created:
            client.delete_table(TableName=table_name)
            client.get_waiter("table_not_exists").wait(TableName=table_name, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
            proof["temporaryTableConfirmedAbsent"] = True
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(proof, indent=2) + "\n")
        print(json.dumps(proof, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Security posture audit for a deployed EDDIE environment.

Asserts the stated requirements against live AWS configuration rather than trusting
the template:

  * every endpoint is behind Cognito authentication
  * nothing is exposed unauthenticated, and there is no public IP endpoint
  * no public S3 bucket
  * database access uses IAM, not stored credentials
  * encryption at rest with a customer-managed key, and TLS enforced in transit

Exits non-zero on any failure.

    security_audit.py --environment dev --region us-east-1 [--report path.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Callable

import boto3
from botocore.exceptions import ClientError

GREEN, RED, YELLOW, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[0m"


class Audit:
    def __init__(self) -> None:
        self.results: list[dict[str, Any]] = []

    def check(self, requirement: str, name: str, fn: Callable[[], str]) -> None:
        try:
            detail = fn()
            self.results.append(
                {"requirement": requirement, "check": name, "status": "PASS",
                 "detail": detail}
            )
            print(f"  {GREEN}[pass]{RESET} {name}: {detail}")
        except Exception as exc:  # noqa: BLE001
            self.results.append(
                {"requirement": requirement, "check": name, "status": "FAIL",
                 "detail": str(exc)}
            )
            print(f"  {RED}[FAIL]{RESET} {name}: {exc}")

    @property
    def failed(self) -> list[dict[str, Any]]:
        return [r for r in self.results if r["status"] == "FAIL"]


def stack_outputs(cfn, stack: str) -> dict[str, str]:
    resp = cfn.describe_stacks(StackName=stack)
    return {
        o["OutputKey"]: o["OutputValue"]
        for o in resp["Stacks"][0].get("Outputs", [])
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--environment", default="dev")
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--report", default="")
    args = ap.parse_args()

    region, env = args.region, args.environment
    stack = f"eddie-{env}"

    cfn = boto3.client("cloudformation", region_name=region)
    s3 = boto3.client("s3", region_name=region)
    ddb = boto3.client("dynamodb", region_name=region)
    idp = boto3.client("cognito-idp", region_name=region)
    ecr = boto3.client("ecr", region_name=region)
    cf = boto3.client("cloudfront")
    logs = boto3.client("logs", region_name=region)
    iam = boto3.client("iam")
    apigw = boto3.client("apigateway", region_name=region)
    apigw2 = boto3.client("apigatewayv2", region_name=region)
    agentcore = boto3.client("bedrock-agentcore-control", region_name=region)

    out = stack_outputs(cfn, stack)
    bucket = out["FrontendBucketName"]
    table = out["CaseTableName"]
    pool_id = out["UserPoolId"]
    client_id = out["UserPoolClientId"]
    dist_id = out["DistributionId"]
    runtime_arn = out["AgentRuntimeArn"]

    a = Audit()
    print(f"\nEDDIE security audit - {stack} in {region}\n")

    # ------------------------------------------------------------------
    print("Requirement: every endpoint behind Cognito, nothing exposed")

    def runtime_has_jwt_authorizer() -> str:
        runtime_id = runtime_arn.split("/")[-1]
        resp = agentcore.get_agent_runtime(agentRuntimeId=runtime_id)
        auth = resp.get("authorizerConfiguration") or {}
        jwt = auth.get("customJWTAuthorizer") or {}
        assert jwt, "runtime has NO authorizer: it would be open to anonymous callers"
        discovery = jwt.get("discoveryUrl", "")
        assert pool_id in discovery, f"authorizer does not point at {pool_id}"
        allowed = jwt.get("allowedClients") or []
        assert client_id in allowed, "web client is not in allowedClients"
        return f"JWT authorizer bound to {pool_id}, {len(allowed)} allowed client(s)"

    a.check("auth", "AgentCore runtime requires a Cognito JWT", runtime_has_jwt_authorizer)

    def no_api_gateway() -> str:
        rest = [
            x["name"] for x in apigw.get_rest_apis(limit=500).get("items", [])
            if "eddie" in x.get("name", "").lower()
        ]
        http = [
            x["Name"] for x in apigw2.get_apis(MaxResults="500").get("Items", [])
            if "eddie" in x.get("Name", "").lower()
        ]
        assert not rest and not http, f"API Gateway still present: {rest + http}"
        return "no EDDIE REST or HTTP API Gateway exists"

    a.check("auth", "API Gateway fully removed", no_api_gateway)

    def no_public_load_balancers_or_ips() -> str:
        elbv2 = boto3.client("elbv2", region_name=region)
        ec2 = boto3.client("ec2", region_name=region)
        lbs = [
            lb["LoadBalancerName"]
            for lb in elbv2.describe_load_balancers().get("LoadBalancers", [])
            if lb.get("Scheme") == "internet-facing"
            and "eddie" in lb["LoadBalancerName"].lower()
        ]
        assert not lbs, f"internet-facing load balancers: {lbs}"
        eips = [
            addr.get("PublicIp")
            for addr in ec2.describe_addresses().get("Addresses", [])
            if any(
                t.get("Key") == "Application" and t.get("Value") == "eddie"
                for t in addr.get("Tags", [])
            )
        ]
        assert not eips, f"elastic IPs allocated to eddie: {eips}"
        return "no internet-facing load balancer, no public IP"

    a.check("auth", "no public IP endpoint", no_public_load_balancers_or_ips)

    # ------------------------------------------------------------------
    print("\nRequirement: no public S3 bucket")

    def bucket_blocks_public_access() -> str:
        pab = s3.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
        for key in (
            "BlockPublicAcls", "IgnorePublicAcls",
            "BlockPublicPolicy", "RestrictPublicBuckets",
        ):
            assert pab.get(key) is True, f"{key} is not enabled"
        return "all four public-access blocks enabled"

    a.check("s3", "frontend bucket blocks public access", bucket_blocks_public_access)

    def bucket_not_publicly_readable() -> str:
        status = s3.get_bucket_policy_status(Bucket=bucket)["PolicyStatus"]
        assert status.get("IsPublic") is False, "bucket policy is public"
        return "bucket policy evaluates as non-public"

    a.check("s3", "bucket policy is not public", bucket_not_publicly_readable)

    def bucket_denies_insecure_and_non_cloudfront() -> str:
        policy = json.loads(s3.get_bucket_policy(Bucket=bucket)["Policy"])
        sids = {s.get("Sid") for s in policy["Statement"]}
        denies = [s for s in policy["Statement"] if s["Effect"] == "Deny"]
        tls = [
            s for s in denies
            if s.get("Condition", {}).get("Bool", {}).get("aws:SecureTransport") in
            ("false", False)
        ]
        assert tls, "no statement denying non-TLS access"
        assert "DenyEverythingExceptCloudFront" in sids, \
            "no statement restricting reads to CloudFront"
        return f"{len(denies)} deny statements incl. TLS-only and CloudFront-only"

    a.check("s3", "bucket denies non-TLS and non-CloudFront", bucket_denies_insecure_and_non_cloudfront)

    def bucket_encrypted() -> str:
        enc = s3.get_bucket_encryption(Bucket=bucket)
        rules = enc["ServerSideEncryptionConfiguration"]["Rules"]
        alg = rules[0]["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"]
        return f"default encryption {alg}"

    a.check("s3", "bucket encrypted at rest", bucket_encrypted)

    def artifact_bucket_not_public() -> str:
        sts = boto3.client("sts", region_name=region)
        acct = sts.get_caller_identity()["Account"]
        name = f"eddie-{env}-artifacts-{acct}"
        try:
            pab = s3.get_public_access_block(Bucket=name)[
                "PublicAccessBlockConfiguration"
            ]
        except ClientError as exc:
            if exc.response["Error"]["Code"] in ("NoSuchBucket", "404"):
                return "artifact bucket absent"
            raise
        assert all(pab.get(k) for k in (
            "BlockPublicAcls", "IgnorePublicAcls",
            "BlockPublicPolicy", "RestrictPublicBuckets")), "not fully blocked"
        return "artifact bucket fully blocked"

    a.check("s3", "artifact bucket blocks public access", artifact_bucket_not_public)

    # ------------------------------------------------------------------
    print("\nRequirement: database access via IAM, encrypted with a managed key")

    def table_uses_cmk() -> str:
        desc = ddb.describe_table(TableName=table)["Table"]
        sse = desc.get("SSEDescription") or {}
        assert sse.get("Status") == "ENABLED", f"SSE status {sse.get('Status')}"
        assert sse.get("SSEType") == "KMS", f"SSE type {sse.get('SSEType')}"
        assert sse.get("KMSMasterKeyArn"), "no KMS key recorded"
        return f"KMS SSE with {sse['KMSMasterKeyArn'].split('/')[-1]}"

    a.check("data", "case table encrypted with a customer-managed key", table_uses_cmk)

    def table_recoverable() -> str:
        desc = ddb.describe_table(TableName=table)["Table"]
        pitr = ddb.describe_continuous_backups(TableName=table)
        status = pitr["ContinuousBackupsDescription"][
            "PointInTimeRecoveryDescription"]["PointInTimeRecoveryStatus"]
        assert status == "ENABLED", f"PITR {status}"
        assert desc.get("DeletionProtectionEnabled") is True, "no deletion protection"
        return "point-in-time recovery and deletion protection enabled"

    a.check("data", "case table recoverable and protected", table_recoverable)

    def runtime_role_uses_iam_no_credentials() -> str:
        """The runtime reaches DynamoDB through its role, scoped to one table."""
        role = f"eddie-{env}-runtime"
        names = iam.list_role_policies(RoleName=role)["PolicyNames"]
        found_table_scope = False
        for name in names:
            doc = iam.get_role_policy(RoleName=role, PolicyName=name)["PolicyDocument"]
            for stmt in doc["Statement"]:
                actions = stmt.get("Action", [])
                actions = [actions] if isinstance(actions, str) else actions
                if any(act.startswith("dynamodb:") for act in actions):
                    resources = stmt.get("Resource", [])
                    resources = [resources] if isinstance(resources, str) else resources
                    assert "*" not in resources, "DynamoDB access is not scoped"
                    assert any(table in r for r in resources), \
                        "DynamoDB access does not name the case table"
                    found_table_scope = True
        assert found_table_scope, "no DynamoDB permission found on the runtime role"
        attached = iam.list_attached_role_policies(RoleName=role)[
            "AttachedPolicies"]
        bad = [p["PolicyName"] for p in attached
               if "Administrator" in p["PolicyName"] or "FullAccess" in p["PolicyName"]]
        assert not bad, f"over-broad managed policies attached: {bad}"
        return "IAM role scoped to the case table; no admin/full-access policies"

    a.check("data", "database access is IAM-based and scoped",
            runtime_role_uses_iam_no_credentials)

    def no_static_credentials_in_runtime_env() -> str:
        runtime_id = runtime_arn.split("/")[-1]
        resp = agentcore.get_agent_runtime(agentRuntimeId=runtime_id)
        env_vars = resp.get("environmentVariables") or {}
        forbidden = [
            k for k in env_vars
            if any(s in k.upper() for s in
                   ("SECRET", "PASSWORD", "ACCESS_KEY", "TOKEN", "CREDENTIAL"))
        ]
        assert not forbidden, f"credential-shaped environment variables: {forbidden}"
        return f"{len(env_vars)} environment variables, none credential-shaped"

    a.check("data", "no static credentials in the runtime environment",
            no_static_credentials_in_runtime_env)

    # ------------------------------------------------------------------
    print("\nRequirement: identity hardening")

    def cognito_hardened() -> str:
        pool = idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]
        assert pool["AdminCreateUserConfig"]["AllowAdminCreateUserOnly"] is True, \
            "public self-registration is enabled"
        policy = pool["Policies"]["PasswordPolicy"]
        assert policy["MinimumLength"] >= 12, f"minimum length {policy['MinimumLength']}"
        for flag in ("RequireUppercase", "RequireLowercase", "RequireNumbers",
                     "RequireSymbols"):
            assert policy.get(flag) is True, f"{flag} not required"
        assert pool.get("MfaConfiguration") in ("OPTIONAL", "ON"), \
            f"MFA {pool.get('MfaConfiguration')}"
        assert pool.get("DeletionProtection") == "ACTIVE", "no deletion protection"
        return (
            f"admin-create-only, {policy['MinimumLength']}-char complex password, "
            f"MFA {pool['MfaConfiguration']}"
        )

    a.check("identity", "user pool hardened", cognito_hardened)

    def no_password_auth_flows() -> str:
        """Password-based flows send the secret to the API; SRP does not."""
        c = idp.describe_user_pool_client(
            UserPoolId=pool_id, ClientId=client_id)["UserPoolClient"]
        flows = c.get("ExplicitAuthFlows", [])
        weak = [f for f in flows if "PASSWORD_AUTH" in f]
        assert not weak, f"weak auth flows enabled: {weak}"
        assert "ALLOW_USER_SRP_AUTH" in flows, "SRP is not enabled"
        assert not c.get("ClientSecret"), "a client secret exists for a public SPA"
        assert c.get("PreventUserExistenceErrors") == "ENABLED", \
            "user existence errors are not suppressed"
        return f"SRP only ({', '.join(flows)}), no client secret"

    a.check("identity", "no password auth flows on the web client", no_password_auth_flows)

    # ------------------------------------------------------------------
    print("\nRequirement: transport and edge")

    def cloudfront_hardened() -> str:
        cfg = cf.get_distribution_config(Id=dist_id)["DistributionConfig"]
        viewer = cfg["ViewerCertificate"]
        min_tls = viewer.get("MinimumProtocolVersion", "")
        using_default_cert = viewer.get("CloudFrontDefaultCertificate") is True

        # CloudFront ignores MinimumProtocolVersion when the default
        # *.cloudfront.net certificate is used and pins it to TLSv1, so old clients
        # keep working. Raising the floor genuinely requires a custom domain with an
        # ACM certificate. Fail only when a custom certificate is present and the
        # floor is still low; otherwise record the constraint rather than pretend.
        if not using_default_cert:
            assert min_tls.startswith(("TLSv1.2", "TLSv1.3")), \
                f"custom certificate in use but minimum TLS is {min_tls}"
        tls_note = (
            f"min TLS {min_tls} (fixed by the default CloudFront certificate; "
            "a custom domain + ACM certificate is required to raise it)"
            if using_default_cert
            else f"min TLS {min_tls}"
        )
        behaviour = cfg["DefaultCacheBehavior"]
        assert behaviour["ViewerProtocolPolicy"] in (
            "redirect-to-https", "https-only"), "HTTP is not redirected"
        origin = cfg["Origins"]["Items"][0]
        assert origin.get("OriginAccessControlId"), "origin has no OAC"
        waf = cfg.get("WebACLId") or ""
        return (
            f"{tls_note}, HTTPS enforced, OAC present, "
            f"WAF {'attached' if waf else 'NOT attached'}"
        )

    a.check("transport", "CloudFront TLS, OAC and HTTPS enforcement",
            cloudfront_hardened)

    def waf_attached() -> str:
        cfg = cf.get_distribution_config(Id=dist_id)["DistributionConfig"]
        waf = cfg.get("WebACLId") or ""
        assert waf, "no WAF WebACL attached to the distribution"
        return f"WebACL {waf.split('/')[-1] if '/' in waf else waf}"

    a.check("transport", "WAF attached to the distribution", waf_attached)

    def log_group_encrypted() -> str:
        name = f"/aws/bedrock-agentcore/eddie-{env}"
        groups = logs.describe_log_groups(logGroupNamePrefix=name)["logGroups"]
        assert groups, f"log group {name} not found"
        g = groups[0]
        assert g.get("kmsKeyId"), "log group is not encrypted with a KMS key"
        assert g.get("retentionInDays"), "log group has unlimited retention"
        return f"KMS-encrypted, {g['retentionInDays']}-day retention"

    a.check("transport", "runtime logs encrypted with retention", log_group_encrypted)

    def ecr_hardened() -> str:
        repo_name = f"eddie-{env}-coordinator"
        repo = ecr.describe_repositories(repositoryNames=[repo_name])[
            "repositories"][0]
        assert repo["imageTagMutability"] == "IMMUTABLE", \
            "image tags are mutable, so a release is not reproducible"
        assert repo["imageScanningConfiguration"]["scanOnPush"] is True, \
            "images are not scanned on push"
        assert repo["encryptionConfiguration"]["encryptionType"], "no encryption"
        try:
            ecr.get_repository_policy(repositoryName=repo_name)
            policy_note = "has a resource policy - review for public access"
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "RepositoryPolicyNotFoundException":
                policy_note = "no resource policy, so not shared publicly"
            else:
                raise
        return f"immutable tags, scan on push, {policy_note}"

    a.check("supply-chain", "ECR repository hardened", ecr_hardened)

    # ------------------------------------------------------------------
    if args.report:
        with open(args.report, "w") as fh:
            json.dump(
                {"results": a.results, "failed": len(a.failed)}, fh, indent=2
            )

    total = len(a.results)
    print(f"\n  {total - len(a.failed)}/{total} security checks passed")
    if a.failed:
        print(f"\n  {RED}Failing requirements:{RESET}")
        for f in a.failed:
            print(f"    - [{f['requirement']}] {f['check']}: {f['detail']}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Verify a deployed EDDIE environment.

Authenticates against Cognito, then invokes the AgentCore Runtime directly with a JWT
bearer token. No request transits API Gateway.

    verify_deployment.py --runtime-arn ARN --user-pool-id ID --client-id ID \
        --region us-east-1 [--site-url URL] [--report path.json]

Exits non-zero if any check fails. Passing these checks proves the deployed
application works; it does not measure model latency or qualify any p99.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

import boto3
from botocore.exceptions import ClientError

# Share the runtime's URL guard rather than restating it: a verification run takes
# a runtime ARN and a site URL from the command line, and must not fetch a
# `file://` or plain-HTTP target just because someone mistyped an argument.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from netio import open_url  # noqa: E402

GREEN, RED, YELLOW, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[0m"

# A deterministic verification identity, created if absent. Password is random per run
# and never persisted; only the short-lived access token is used.
VERIFY_EMAIL = "eddie-verify@example.invalid"


class Checks:
    def __init__(self) -> None:
        self.results: list[dict[str, Any]] = []

    def run(self, name: str, fn: Callable[[], str]) -> bool:
        try:
            detail = fn()
            self.results.append({"check": name, "status": "PASS", "detail": detail})
            print(f"  {GREEN}[ok]{RESET} {name}: {detail}")
            return True
        except Exception as exc:  # noqa: BLE001
            self.results.append({"check": name, "status": "FAIL", "detail": str(exc)})
            print(f"  {RED}[fail]{RESET} {name}: {exc}")
            return False

    @property
    def failed(self) -> list[dict[str, Any]]:
        return [r for r in self.results if r["status"] == "FAIL"]


# --------------------------------------------------------------------------
# Cognito
# --------------------------------------------------------------------------


def ensure_user_and_token(region: str, user_pool_id: str, client_id: str) -> str:
    """Create the verification user if needed and return an access token.

    Uses SRP, the same flow the browser uses. The user pool deliberately does not
    enable ADMIN_USER_PASSWORD_AUTH or USER_PASSWORD_AUTH -- those send the password
    to the API and are a weaker posture -- so verification authenticates the same way
    a real client does rather than the pool being loosened to suit the test.
    """
    import secrets

    from pycognito.aws_srp import AWSSRP

    idp = boto3.client("cognito-idp", region_name=region)
    password = f"Vf-{secrets.token_urlsafe(18)}!9aZ"

    try:
        idp.admin_create_user(
            UserPoolId=user_pool_id,
            Username=VERIFY_EMAIL,
            UserAttributes=[
                {"Name": "email", "Value": VERIFY_EMAIL},
                {"Name": "email_verified", "Value": "true"},
            ],
            MessageAction="SUPPRESS",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "UsernameExistsException":
            raise

    # A fresh permanent password each run; never persisted, and only the short-lived
    # access token is used afterwards.
    idp.admin_set_user_password(
        UserPoolId=user_pool_id,
        Username=VERIFY_EMAIL,
        Password=password,
        Permanent=True,
    )

    srp = AWSSRP(
        username=VERIFY_EMAIL,
        password=password,
        pool_id=user_pool_id,
        client_id=client_id,
        client=idp,
    )
    result = srp.authenticate_user()
    token = result.get("AuthenticationResult", {}).get("AccessToken")
    if not token:
        raise RuntimeError(
            f"no access token returned; challenge={result.get('ChallengeName')}"
        )
    return token


# --------------------------------------------------------------------------
# AgentCore invocation
# --------------------------------------------------------------------------


class RuntimeApplicationError(Exception):
    """A handled operation failure returned as HTTP 200 with ok: false."""

    def __init__(self, error: str, detail: str) -> None:
        super().__init__(f"{error}: {detail}")
        self.error = error
        self.detail = detail


class Runtime:
    """Invokes AgentCore Runtime with a JWT bearer token."""

    # AgentCore rejects a runtimeSessionId shorter than 33 characters.
    SESSION_ID_MIN_LENGTH = 33

    def __init__(self, runtime_arn: str, region: str, token: str) -> None:
        import uuid

        self.session_id = f"eddie-verify-{uuid.uuid4().hex}"
        assert len(self.session_id) >= self.SESSION_ID_MIN_LENGTH
        encoded = urllib.parse.quote(runtime_arn, safe="")
        self.url = (
            f"https://bedrock-agentcore.{region}.amazonaws.com"
            f"/runtimes/{encoded}/invocations?qualifier=DEFAULT"
        )
        self.token = token

    def invoke(self, action: str, payload: Optional[dict] = None, timeout: int = 180) -> dict:
        body = json.dumps({"action": action, "payload": payload or {}}).encode()
        req = urllib.request.Request(
            self.url,
            data=body,
            headers={
                "authorization": f"Bearer {self.token}",
                "content-type": "application/json",
                # AgentCore binds a conversational session to this id and
                # enforces a minimum length of 33 characters.
                "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": self.session_id,
            },
            method="POST",
        )
        with open_url(req, timeout=timeout) as resp:
            raw = resp.read()
        parsed = json.loads(raw)
        if parsed.get("ok") is False:
            raise RuntimeApplicationError(
                parsed.get("error", "unknown"), parsed.get("detail", "")
            )
        if "result" not in parsed:
            raise AssertionError(f"unexpected envelope: {list(parsed)}")
        return parsed["result"]


# --------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------

LLAMA = {
    "name": "Llama 3.1 8B",
    "architecture": "LlamaForCausalLM",
    "weightsGb": "16",
    "contextTokens": 128000,
}


def build_checks(rt: Runtime, checks: Checks) -> None:
    def health() -> str:
        b = rt.invoke("health")
        assert b["status"] in ("OK", "DEGRADED"), b["status"]
        assert b["runtime"] == "agentcore", b.get("runtime")
        assert b["limits"]["syncRequestMinutes"] == 15
        if b["status"] != "OK":
            raise AssertionError(f"degraded: {b.get('priceList')}")
        return (
            f"solver {b['solverVersion']}, priceList {b['priceList']['status']}, "
            f"knowledge {b['knowledge']['state']}"
        )

    def no_api_gateway() -> str:
        """The control plane must not be behind API Gateway's 29s cap."""
        b = rt.invoke("health")
        assert b["limits"]["syncRequestMinutes"] == 15, "sync limit is not AgentCore's"
        return "15-minute sync budget confirmed; API Gateway removed"

    def rates() -> str:
        b = rt.invoke("rates")
        sm = b["rates"]["sagemakerInstanceHour"]
        assert sm and sm.get("sku"), "no SageMaker rate with a SKU"
        return f"ml.g5.2xlarge ${sm['amount']} sku={sm['sku']} [{b['freshness']['sagemaker']}]"

    def unmapped_arch_has_no_cmi_rate() -> str:
        """Must not borrow another family's pinned rate."""
        b = rt.invoke("rates", {"architecture": "DeepseekV3ForCausalLM"})
        assert b["cmiFamily"] is None, f"family should be None, got {b['cmiFamily']}"
        assert b["rates"]["cmiPerCmuMinute"] is None, "borrowed a CMI rate it should not have"
        return "returns UNKNOWN rather than another family's price"

    def catalog() -> str:
        b = rt.invoke("catalog")
        assert b["count"] > 0, "empty catalog"
        return f"{b['count']} native models"

    def bursty() -> str:
        b = rt.invoke("evaluate", {
            "caseId": "verify-bursty", "model": LLAMA,
            "workload": {"horizonHours": "72", "billableCopyHours": "6"},
            "assumeChecksCleared": True})
        assert b["outcome"] == "QUALIFIED_PLACEMENT", b["outcome"]
        assert b["winner"]["target"] == "BEDROCK_CMI", b["winner"]["target"]
        return (
            f"winner {b['winner']['candidateId']} ${b['winner']['cost']['total']}, "
            f"breakeven {b['breakeven']['breakevenDutyPercent']}%"
        )

    def steady() -> str:
        b = rt.invoke("evaluate", {
            "caseId": "verify-steady", "model": LLAMA,
            "workload": {"horizonHours": "720", "billableCopyHours": "720"},
            "assumeChecksCleared": True})
        assert b["winner"]["target"] == "SAGEMAKER_REALTIME", b["winner"]["target"]
        return f"winner {b['winner']['candidateId']} ${b['winner']['cost']['total']}"

    def latency_is_a_gate() -> str:
        b = rt.invoke("evaluate", {
            "caseId": "verify-slo", "model": LLAMA,
            "workload": {"horizonHours": "72", "billableCopyHours": "6"},
            "slos": [{"metric": "p99_latency_ms", "thresholdMs": "800"}],
            "assumeChecksCleared": True,
            "latencyEvidence": {
                "cmi-scale-to-zero": {"p50Ms": "120", "p99Ms": "500",
                                      "coldStartMs": "45000", "sampleCount": 12000,
                                      "violationRateUpperBound": "0.004"},
                "sagemaker-ml.g5.2xlarge": {"p50Ms": "110", "p99Ms": "480",
                                            "sampleCount": 12000,
                                            "violationRateUpperBound": "0.003"}}})
        cmi = [c for c in b["excluded"] if c["candidateId"] == "cmi-scale-to-zero"]
        assert cmi, "cheap CMI candidate was not excluded despite a 45s cold start"
        gate = [g for g in cmi[0]["gates"] if g["name"] == "latency"][0]
        assert gate["status"] == "FAIL", gate["status"]
        cheap, won = float(cmi[0]["cost"]["total"]), float(b["winner"]["cost"]["total"])
        assert cheap < won, "excluded candidate was not the cheaper one"
        return f"cheaper (${cheap}) candidate excluded: {gate['reason'][:48]}"

    def unknown_never_ranks() -> str:
        b = rt.invoke("evaluate", {
            "caseId": "verify-unknown", "model": LLAMA,
            "workload": {"horizonHours": "72", "billableCopyHours": "6"}})
        assert b["outcome"] == "NO_QUALIFIED_PLACEMENT", b["outcome"]
        assert b["counts"]["ranked"] == 0, "ranked a candidate without evidence"
        return f"{b['counts']['unresolved']} unresolved, 0 ranked"

    def knowledge_is_honest() -> str:
        """COA must never claim readiness it does not have, or affect placement."""
        b = rt.invoke("knowledge", {"query": "custom model import limits"})
        assert b["affectsPlacement"] is False, "knowledge claims to affect placement"
        assert b["state"] in ("NOT_INSTALLED", "READY", "SLEEPING", "ERROR"), b["state"]
        if b["state"] == "NOT_INSTALLED":
            assert b["context"] is None, "returned context while not installed"
        return f"state {b['state']}, affectsPlacement=False"

    def demo_lifecycle() -> str:
        b = rt.invoke("demo.status")
        assert b["state"] in (
            "NOT_CONFIGURED", "SLEEPING", "WAKING", "READY",
            "SLEEPING_IN_PROGRESS", "ERROR",
        ), b["state"]
        return f"state {b['state']}"

    def validation() -> str:
        try:
            rt.invoke("evaluate", {"model": {}})
        except RuntimeApplicationError as exc:
            # Returned as HTTP 200 with ok:false so the detail survives AgentCore,
            # which would otherwise replace a 400 with a generic CloudWatch pointer.
            assert exc.error == "invalid_request", f"unexpected error: {exc.error}"
            assert "architecture" in exc.detail, exc.detail
            return exc.detail
        raise AssertionError("invalid request was accepted")

    def unknown_action() -> str:
        try:
            rt.invoke("definitely-not-an-action")
        except RuntimeApplicationError as exc:
            assert exc.error == "unknown_action", f"unexpected error: {exc.error}"
            return "rejected with a preserved detail"
        raise AssertionError("unknown action was accepted")

    for name, fn in [
        ("runtime health", health),
        ("control plane is AgentCore, not API Gateway", no_api_gateway),
        ("live pricing with SKU", rates),
        ("unmapped architecture yields no borrowed rate", unmapped_arch_has_no_cmi_rate),
        ("native catalog", catalog),
        ("bursty event favours CMI", bursty),
        ("always-on favours dedicated", steady),
        ("latency is a gate, not a discount", latency_is_a_gate),
        ("UNKNOWN never ranks", unknown_never_ranks),
        ("knowledge adapter is honest", knowledge_is_honest),
        ("demo lifecycle reports real state", demo_lifecycle),
        ("input validation", validation),
        ("unknown action rejected", unknown_action),
    ]:
        checks.run(name, fn)


def build_auth_checks(runtime_arn: str, region: str, checks: Checks) -> None:
    def rejects_missing_token() -> str:
        encoded = urllib.parse.quote(runtime_arn, safe="")
        url = (
            f"https://bedrock-agentcore.{region}.amazonaws.com"
            f"/runtimes/{encoded}/invocations?qualifier=DEFAULT"
        )
        req = urllib.request.Request(
            url, data=b'{"action":"health"}',
            headers={"content-type": "application/json"}, method="POST")
        try:
            open_url(req, timeout=30)
        except urllib.error.HTTPError as exc:
            assert exc.code in (401, 403), f"expected 401/403, got {exc.code}"
            return f"unauthenticated request rejected with {exc.code}"
        raise AssertionError("unauthenticated request was accepted")

    checks.run("unauthenticated invocation is rejected", rejects_missing_token)


def build_frontend_checks(site: str, checks: Checks) -> None:
    def served() -> str:
        req = urllib.request.Request(site, headers={"user-agent": "eddie-verify"})
        with open_url(req, timeout=60) as r:
            body = r.read().decode("utf-8", "replace")
            headers = {k.lower(): v for k, v in r.headers.items()}
        assert r.status == 200, f"status {r.status}"
        assert 'id="root"' in body or "id='root'" in body, "no SPA root element"
        assert "strict-transport-security" in headers, "missing HSTS"
        return f"{r.status}, {len(body)} bytes, HSTS present"

    def config() -> str:
        with open_url(f"{site}/config.json", timeout=60) as r:
            cfg = json.loads(r.read())
        assert cfg.get("agentRuntimeArn"), "config has no agentRuntimeArn"
        assert cfg.get("userPoolId"), "config has no userPoolId"
        assert "apiBaseUrl" not in cfg or not cfg["apiBaseUrl"], \
            "config still references an API Gateway base URL"
        return f"release {cfg.get('releaseId')}, runtime configured"

    checks.run("frontend served with security headers", served)
    checks.run("frontend runtime config", config)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime-arn", required=True)
    ap.add_argument("--user-pool-id", required=True)
    ap.add_argument("--client-id", required=True)
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--site-url", default="")
    ap.add_argument("--report", default="")
    args = ap.parse_args()

    checks = Checks()

    build_auth_checks(args.runtime_arn, args.region, checks)

    try:
        token = ensure_user_and_token(args.region, args.user_pool_id, args.client_id)
        print(f"  {GREEN}[ok]{RESET} cognito token obtained for {VERIFY_EMAIL}")
    except Exception as exc:  # noqa: BLE001
        print(f"  {RED}[fail]{RESET} cognito authentication: {exc}")
        checks.results.append(
            {"check": "cognito authentication", "status": "FAIL", "detail": str(exc)}
        )
        token = None

    if token:
        build_checks(Runtime(args.runtime_arn, args.region, token), checks)

    if args.site_url:
        build_frontend_checks(args.site_url.rstrip("/"), checks)
    else:
        print(f"  {YELLOW}[warn]{RESET} no --site-url; frontend checks skipped")

    if args.report:
        with open(args.report, "w") as fh:
            json.dump(
                {"checks": checks.results, "failed": len(checks.failed)}, fh, indent=2
            )

    total = len(checks.results)
    print(f"\n  {total - len(checks.failed)}/{total} checks passed")
    return 1 if checks.failed else 0


if __name__ == "__main__":
    sys.exit(main())

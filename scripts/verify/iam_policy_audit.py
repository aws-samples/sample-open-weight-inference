#!/usr/bin/env python3
"""Static IAM audit of the rendered CloudFormation template.

SEC-03. Runs in CI and in `./deploy.sh` *before* the stack is created, because a
policy that grants too much has already granted it by the time the stack exists.

Four rules, in decreasing bluntness:

1.  An unbounded principal in an **Allow**, `Action: "*"`, or an administrative
    managed policy is rejected. S3 gateway endpoints have a structural AWS rule:
    Principal must be "*", with an exact aws:PrincipalArn condition restricting
    the caller. Only a single explicit role and bounded S3 read access are accepted.
2.  A `Resource: "*"` in an Allow must match a record in
    `infra/policy/global-action-capabilities.yaml` by role, policy, Sid and exact
    action set. An unrecorded global grant fails; a record whose actions have drifted
    from the template also fails, in both directions.
3.  Explicit **Deny** statements are left alone. A `Principal: "*"` deny is the
    correct shape for TLS-only and origin-restriction policies, and "tightening" it
    would remove a protection.
4.  A KMS **key policy** may use `Resource: "*"`: AWS defines it as the attached key.
    Its principals and actions are still checked.

Enforcement is by explicit `if` and a structured result, never `assert`: `python -O`
disables assertions, and a verifier that evaporates under an optimisation flag is not
a control. Exit status is non-zero on any FAIL or unexplained UNKNOWN.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    import yaml
except ImportError:  # pragma: no cover
    print("PyYAML is required: pip install pyyaml", file=sys.stderr)
    raise SystemExit(2)

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = REPO / "infra" / "cloudformation" / "application" / "eddie-app.yaml"
CAPABILITIES = REPO / "infra" / "policy" / "global-action-capabilities.yaml"

VERIFIER_VERSION = "iam-policy-audit/1.1.0"

#: Managed policies that must never be attached to an EDDIE role.
FORBIDDEN_MANAGED = re.compile(
    r"(AdministratorAccess|PowerUserAccess|.*FullAccess|IAMFullAccess)$"
)

#: Service-wide action grants. `iam:*` and `sagemaker:*` are the explicit examples in
#: the contract; the pattern catches the whole class.
SERVICE_WIDE_ACTION = re.compile(r"^[a-z0-9-]+:\*$")

#: Actions that let a principal grant itself more authority. Rejected on any role
#: that is not the installer, regardless of resource scoping.
PRIVILEGE_ESCALATION_ACTIONS = {
    "iam:CreatePolicy",
    "iam:CreatePolicyVersion",
    "iam:PutRolePolicy",
    "iam:AttachRolePolicy",
    "iam:CreateRole",
    "iam:UpdateAssumeRolePolicy",
    "iam:DeleteRolePermissionsBoundary",
    "iam:PutRolePermissionsBoundary",
    "iam:CreateUser",
    "iam:CreateAccessKey",
}


# --------------------------------------------------------------------------
# Result recording
# --------------------------------------------------------------------------


@dataclass
class Finding:
    check_id: str
    status: str  # PASS | FAIL | UNKNOWN | NOT_APPLICABLE
    requirement: str
    expected: str
    observed: str
    location: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "checkId": self.check_id,
            "status": self.status,
            "requirement": self.requirement,
            "expectedControl": self.expected,
            "observedResult": self.observed,
            "location": self.location,
        }


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    policy_version: str = ""
    template_digest: str = ""

    def add(self, finding: Finding) -> None:
        self.findings.append(finding)

    @property
    def failed(self) -> list[Finding]:
        return [f for f in self.findings if f.status in ("FAIL", "UNKNOWN")]

    def to_json(self) -> dict[str, Any]:
        counts: dict[str, int] = {}
        for f in self.findings:
            counts[f.status] = counts.get(f.status, 0) + 1
        return {
            "verifierVersion": VERIFIER_VERSION,
            "policyVersion": self.policy_version,
            "lifecycleBoundary": "build-and-installation",
            "templateDigest": self.template_digest,
            "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "counts": counts,
            "failed": len(self.failed),
            "results": [f.to_json() for f in self.findings],
        }


# --------------------------------------------------------------------------
# CloudFormation loading
# --------------------------------------------------------------------------


class CfnLoader(yaml.SafeLoader):
    """Loader that tolerates CloudFormation short-form intrinsics.

    `!Sub`, `!Ref`, `!GetAtt` and `!If` are not YAML tags SafeLoader knows. They are
    represented as marker dicts so policy structure stays inspectable: a resource
    written as `!Sub "arn:...:${AWS::AccountId}:table/x"` must be seen as a scoped
    ARN, not skipped because it could not be parsed.
    """


def _intrinsic(loader: yaml.Loader, suffix: str, node: yaml.Node) -> Any:
    name = f"Fn::{suffix}" if suffix != "Ref" else "Ref"
    if isinstance(node, yaml.ScalarNode):
        return {name: loader.construct_scalar(node)}
    if isinstance(node, yaml.SequenceNode):
        return {name: loader.construct_sequence(node, deep=True)}
    return {name: loader.construct_mapping(node, deep=True)}


for tag in (
    "Ref", "Sub", "GetAtt", "If", "Join", "Select", "Split", "ImportValue",
    "Equals", "Not", "And", "Or", "FindInMap", "Base64", "Cidr", "GetAZs",
    "Condition",
):
    CfnLoader.add_constructor(f"!{tag}", lambda l, n, s=tag: _intrinsic(l, s, n))


def resolved_text(value: Any) -> str:
    """Flatten an intrinsic to inspectable text.

    A resource is only "global" if it is literally `*`. `!Sub` of an ARN containing
    `*` as a path suffix is a scoped grant under an owned prefix, which SEC-03
    distinguishes explicitly.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("Fn::Sub", "Ref", "Fn::GetAtt", "Fn::ImportValue"):
            if key in value:
                inner = value[key]
                if isinstance(inner, list):
                    return resolved_text(inner[0])
                return resolved_text(inner)
        if "Fn::If" in value:
            branches = value["Fn::If"]
            return " | ".join(resolved_text(b) for b in branches[1:])
        return json.dumps(value, sort_keys=True)
    if isinstance(value, list):
        return " ".join(resolved_text(v) for v in value)
    return str(value)


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def is_global_resource(resource: Any) -> bool:
    """True only for a literal `*`.

    `arn:aws:logs:...:log-group:/eddie/dev*` is a prefix under an owned log group,
    not a global grant, and treating it as one would train people to ignore the
    check.
    """
    for item in as_list(resource):
        text = resolved_text(item)
        if text.strip() == "*":
            return True
    return False


def wildcard_principal(principal: Any) -> bool:
    if principal is None:
        return False
    if isinstance(principal, str):
        return principal.strip() == "*"
    if isinstance(principal, dict):
        for value in principal.values():
            for item in as_list(value):
                if resolved_text(item).strip() == "*":
                    return True
    return False


# --------------------------------------------------------------------------
# Statement walking
# --------------------------------------------------------------------------


@dataclass
class Statement:
    role: str
    policy: str
    sid: str
    raw: dict[str, Any]
    kind: str  # identity | trust | key-policy | resource-policy

    @property
    def effect(self) -> str:
        return str(self.raw.get("Effect", "Allow"))

    @property
    def actions(self) -> list[str]:
        actions = self.raw.get("Action") or self.raw.get("NotAction") or []
        return [resolved_text(a) for a in as_list(actions)]

    @property
    def where(self) -> str:
        return f"{self.role}/{self.policy}" + (f"#{self.sid}" if self.sid else "")


def walk_statements(template: dict[str, Any]) -> list[Statement]:
    """Every policy statement in the template, with where it came from.

    Covers inline role policies, assume-role trust policies, KMS key policies and
    bucket policies. `!If` branches are walked so a conditionally attached policy is
    still inspected -- otherwise wrapping a bad grant in a condition would hide it.
    """
    out: list[Statement] = []
    resources = template.get("Resources") or {}

    def add_document(role: str, policy: str, doc: Any, kind: str) -> None:
        if not isinstance(doc, dict):
            return
        for stmt in as_list(doc.get("Statement")):
            if isinstance(stmt, dict):
                out.append(
                    Statement(role, policy, str(stmt.get("Sid", "")), stmt, kind)
                )

    def unwrap_if(value: Any) -> list[Any]:
        """Both branches of an Fn::If, minus AWS::NoValue."""
        if isinstance(value, dict) and "Fn::If" in value:
            found: list[Any] = []
            for branch in value["Fn::If"][1:]:
                if isinstance(branch, dict) and branch.get("Ref") == "AWS::NoValue":
                    continue
                found.extend(unwrap_if(branch))
            return found
        return [value]

    for name, resource in resources.items():
        if not isinstance(resource, dict):
            continue
        rtype = resource.get("Type", "")
        props = resource.get("Properties") or {}

        if rtype == "AWS::IAM::Role":
            add_document(
                name, "AssumeRolePolicy", props.get("AssumeRolePolicyDocument"), "trust"
            )
            for entry in as_list(props.get("Policies")):
                for policy in unwrap_if(entry):
                    if not isinstance(policy, dict):
                        continue
                    add_document(
                        name,
                        resolved_text(policy.get("PolicyName", "inline")),
                        policy.get("PolicyDocument"),
                        "identity",
                    )
        elif rtype == "AWS::IAM::Policy":
            add_document(
                name,
                resolved_text(props.get("PolicyName", name)),
                props.get("PolicyDocument"),
                "identity",
            )
        elif rtype == "AWS::KMS::Key":
            add_document(name, "KeyPolicy", props.get("KeyPolicy"), "key-policy")
        elif rtype == "AWS::EC2::VPCEndpoint":
            gateway = (props.get("VpcEndpointType") == "Gateway"
                       and resolved_text(props.get("ServiceName", "")).endswith(".s3"))
            add_document(name, "EndpointPolicy", props.get("PolicyDocument"),
                         "s3-gateway-endpoint-policy" if gateway else "resource-policy")
        elif rtype in (
            "AWS::S3::BucketPolicy",
            "AWS::ECR::RegistryPolicy",
            "AWS::ECR::Repository",
        ):
            doc = props.get("PolicyDocument") or props.get("RepositoryPolicyText")
            add_document(name, "ResourcePolicy", doc, "resource-policy")

    return out


def managed_policy_arns(template: dict[str, Any]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for name, resource in (template.get("Resources") or {}).items():
        if not isinstance(resource, dict) or resource.get("Type") != "AWS::IAM::Role":
            continue
        for arn in as_list((resource.get("Properties") or {}).get("ManagedPolicyArns")):
            out.append((name, resolved_text(arn)))
    return out


# --------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------


def check_statements(
    statements: list[Statement], records: list[dict[str, Any]], report: Report,
    resources: Optional[dict[str, Any]] = None,
) -> None:
    by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    for record in records:
        key = (
            str(record.get("role", "")),
            str(record.get("policy", "")),
            str(record.get("sid", "")),
        )
        by_key[key] = record
    matched: set[tuple[str, str, str]] = set()

    for stmt in statements:
        # --- rule 3: denies are protections, left intact -------------------
        if stmt.effect.lower() == "deny":
            report.add(
                Finding(
                    "SEC-03.deny-preserved",
                    "PASS",
                    "SEC-03",
                    "Explicit Deny statements are preserved, including Principal '*'",
                    f"deny retained: {', '.join(stmt.actions) or '(none)'}",
                    stmt.where,
                )
            )
            continue

        # Gateway endpoint policies are filters, not resource grants. AWS requires
        # "*" in Principal; an exact PrincipalArn condition is the supported way
        # to restrict them. Never extend this allowance to role/bucket policies.
        bounded_gateway = (
            stmt.kind == "s3-gateway-endpoint-policy"
            and _bounded_gateway_principal(stmt, resources or {})
        )
        if stmt.kind == "s3-gateway-endpoint-policy":
            report.add(Finding(
                "SEC-03.gateway-principal",
                "PASS" if bounded_gateway else "FAIL",
                "SEC-03",
                "S3 gateway reads restricted to one exact role through aws:PrincipalArn",
                "Exact role condition and bounded S3 reads" if bounded_gateway
                else "Gateway policy lacks the supported exact-role/read-only form",
                stmt.where,
            ))
        # --- rule 1: unbounded principal in an Allow -----------------------
        if wildcard_principal(stmt.raw.get("Principal")) and not bounded_gateway:
            report.add(
                Finding(
                    "SEC-03.wildcard-principal",
                    "FAIL",
                    "SEC-03",
                    "No wildcard principal in an Allow statement or role trust",
                    "Allow with Principal '*'",
                    stmt.where,
                )
            )
            continue

        # --- rule 1: Action '*' or service-wide ---------------------------
        for action in stmt.actions:
            if action.strip() == "*":
                report.add(
                    Finding(
                        "SEC-03.wildcard-action",
                        "FAIL",
                        "SEC-03",
                        "No Action '*' on any EDDIE role",
                        "Action '*'",
                        stmt.where,
                    )
                )
            elif SERVICE_WIDE_ACTION.match(action.strip()):
                # A KMS key policy's account-root administration statement is the
                # documented lockout-avoidance path; see structuralExemptions.
                if stmt.kind == "key-policy" and _is_account_root(stmt):
                    report.add(
                        Finding(
                            "SEC-03.kms-root-administration",
                            "PASS",
                            "SEC-03",
                            "Key administration path preserved to avoid key lockout",
                            f"{action} retained for the account root in a key policy",
                            stmt.where,
                        )
                    )
                else:
                    report.add(
                        Finding(
                            "SEC-03.service-wide-action",
                            "FAIL",
                            "SEC-03",
                            "Enumerate actions; no service-wide grant",
                            f"service-wide action {action}",
                            stmt.where,
                        )
                    )

        escalation = sorted(set(stmt.actions) & PRIVILEGE_ESCALATION_ACTIONS)
        if escalation:
            report.add(
                Finding(
                    "SEC-03.privilege-escalation",
                    "FAIL",
                    "SEC-03",
                    "Runtime roles cannot create or alter policies, roles or keys",
                    f"escalation actions granted: {', '.join(escalation)}",
                    stmt.where,
                )
            )

        # --- PassRole and AssumeRole scoping -------------------------------
        for action in stmt.actions:
            lowered = action.strip().lower()
            if lowered == "iam:passrole":
                _check_pass_role(stmt, report)
            if lowered == "sts:assumerole" and stmt.kind == "identity":
                if is_global_resource(stmt.raw.get("Resource")):
                    report.add(
                        Finding(
                            "SEC-03.assume-role-scope",
                            "FAIL",
                            "SEC-03",
                            "sts:AssumeRole restricted to registered target roles",
                            "sts:AssumeRole with Resource '*'",
                            stmt.where,
                        )
                    )

        # --- rule 2 and 4: global resource --------------------------------
        if not is_global_resource(stmt.raw.get("Resource")):
            continue

        if stmt.kind == "key-policy":
            report.add(
                Finding(
                    "SEC-03.kms-key-policy-resource",
                    "PASS",
                    "SEC-03",
                    "In a key policy, Resource '*' means the attached key",
                    "structural exemption kms-key-policy applied",
                    stmt.where,
                )
            )
            continue

        key = (stmt.role, stmt.policy, stmt.sid)
        record = by_key.get(key)
        if record is None:
            report.add(
                Finding(
                    "SEC-03.unrecorded-global-resource",
                    "FAIL",
                    "SEC-03",
                    "Every global Allow has a checked capability record",
                    "Resource '*' with no record in global-action-capabilities.yaml"
                    + ("" if stmt.sid else " (statement also has no Sid to record)"),
                    stmt.where,
                )
            )
            continue

        matched.add(key)
        recorded = {str(a) for a in as_list(record.get("actions"))}
        actual = {a.strip() for a in stmt.actions}
        if recorded != actual:
            report.add(
                Finding(
                    "SEC-03.capability-record-drift",
                    "FAIL",
                    "SEC-03",
                    "Recorded actions match the template exactly",
                    f"record {record.get('id')}: template has "
                    f"{sorted(actual - recorded) or '[]'} not recorded, "
                    f"{sorted(recorded - actual) or '[]'} recorded but absent",
                    stmt.where,
                )
            )
            continue

        if _record_expired(record):
            report.add(
                Finding(
                    "SEC-03.capability-record-expired",
                    "FAIL",
                    "SEC-03",
                    "Capability records are reviewed before their deadline",
                    f"record {record.get('id')} reviewBy {record.get('reviewBy')} has passed",
                    stmt.where,
                )
            )
            continue

        report.add(
            Finding(
                "SEC-03.recorded-global-resource",
                "PASS",
                "SEC-03",
                "Global action carries a checked capability record",
                f"{record.get('id')}: {len(actual)} action(s), mutates="
                f"{bool(record.get('mutates'))}",
                stmt.where,
            )
        )

    # A record that matches nothing is stale and must not linger as apparent
    # justification for a grant that no longer exists.
    for key, record in by_key.items():
        if key in matched:
            continue
        report.add(
            Finding(
                "SEC-03.orphan-capability-record",
                "FAIL",
                "SEC-03",
                "Every capability record corresponds to a live statement",
                f"record {record.get('id')} matches no statement "
                f"({key[0]}/{key[1]}#{key[2]})",
                "infra/policy/global-action-capabilities.yaml",
            )
        )


def _is_account_root(stmt: Statement) -> bool:
    principal = stmt.raw.get("Principal")
    if not isinstance(principal, dict):
        return False
    for item in as_list(principal.get("AWS")):
        if ":root" in resolved_text(item):
            return True
    return False


def _bounded_gateway_principal(stmt: Statement, resources: dict[str, Any]) -> bool:
    """Recognize only the documented role-bound S3 gateway form, fail closed."""
    if stmt.raw.get("Principal") != "*" or "NotAction" in stmt.raw or "NotPrincipal" in stmt.raw:
        return False
    if not stmt.actions or not set(stmt.actions) <= {"s3:GetObject", "s3:ListBucket"}:
        return False
    targets = [resolved_text(item) for item in as_list(stmt.raw.get("Resource"))]
    if not targets:
        return False
    for target in targets:
        if not target.startswith("arn:aws:s3:::"):
            return False
        bucket = target.removeprefix("arn:aws:s3:::").split("/", 1)[0]
        if not bucket or "*" in bucket or "?" in bucket:
            return False
    condition = stmt.raw.get("Condition") or {}
    for operator in ("ArnEquals", "StringEquals"):
        identity = (condition.get(operator) or {}).get("aws:PrincipalArn")
        if isinstance(identity, str):
            return bool(re.fullmatch(r"arn:aws:iam::\d{12}:role/[A-Za-z0-9+=,.@_/-]+", identity))
        if isinstance(identity, dict) and set(identity) == {"Fn::GetAtt"}:
            reference = identity["Fn::GetAtt"]
            parts = reference.split(".") if isinstance(reference, str) else reference
            return bool(isinstance(parts, list) and len(parts) == 2 and parts[1] == "Arn"
                        and (resources.get(parts[0]) or {}).get("Type") == "AWS::IAM::Role")
    return False


def _check_pass_role(stmt: Statement, report: Report) -> None:
    """PassRole must name exact roles and, ideally, a PassedToService condition."""
    if is_global_resource(stmt.raw.get("Resource")):
        report.add(
            Finding(
                "SEC-03.pass-role-scope",
                "FAIL",
                "SEC-03",
                "iam:PassRole restricted to exact preapproved role ARNs",
                "iam:PassRole with Resource '*'",
                stmt.where,
            )
        )
        return
    condition = stmt.raw.get("Condition") or {}
    flattened = json.dumps(condition)
    if "iam:PassedToService" not in flattened:
        report.add(
            Finding(
                "SEC-03.pass-role-service-condition",
                "FAIL",
                "SEC-03",
                "iam:PassRole carries an iam:PassedToService condition",
                "scoped to specific roles but no PassedToService condition",
                stmt.where,
            )
        )
        return
    report.add(
        Finding(
            "SEC-03.pass-role-scoped",
            "PASS",
            "SEC-03",
            "iam:PassRole scoped to exact roles with a service condition",
            f"resources: {resolved_text(stmt.raw.get('Resource'))}",
            stmt.where,
        )
    )


def _record_expired(record: dict[str, Any]) -> bool:
    raw = record.get("reviewBy")
    if not raw:
        return True
    try:
        return date.fromisoformat(str(raw)) < date.today()
    except ValueError:
        return True


def check_managed_policies(template: dict[str, Any], report: Report) -> None:
    attached = managed_policy_arns(template)
    if not attached:
        report.add(
            Finding(
                "SEC-03.no-managed-policies",
                "PASS",
                "SEC-03",
                "No administrative or FullAccess managed policies attached",
                "no managed policy ARNs in the template",
                str(TEMPLATE.relative_to(REPO)),
            )
        )
        return
    for role, arn in attached:
        if FORBIDDEN_MANAGED.search(arn):
            report.add(
                Finding(
                    "SEC-03.forbidden-managed-policy",
                    "FAIL",
                    "SEC-03",
                    "No administrative or FullAccess managed policies",
                    f"{arn} attached",
                    role,
                )
            )
        else:
            report.add(
                Finding(
                    "SEC-03.managed-policy-reviewed",
                    "PASS",
                    "SEC-03",
                    "Attached managed policies are not administrative",
                    arn,
                    role,
                )
            )


def check_inventory_not_empty(statements: list[Statement], report: Report) -> None:
    """An empty inventory is UNKNOWN, never a pass.

    If the loader silently failed to parse the template, every other check would
    trivially pass with nothing to inspect. That is exactly the "green summary from
    an empty inventory" the contract forbids.
    """
    identity = [s for s in statements if s.kind == "identity"]
    trust = [s for s in statements if s.kind == "trust"]
    if not identity or not trust:
        report.add(
            Finding(
                "SEC-03.inventory",
                "UNKNOWN",
                "verification-contract",
                "Policy inventory is non-empty before any statement check runs",
                f"parsed {len(identity)} identity and {len(trust)} trust statements; "
                "the template may not have been understood",
                str(TEMPLATE.relative_to(REPO)),
            )
        )
        return
    report.add(
        Finding(
            "SEC-03.inventory",
            "PASS",
            "verification-contract",
            "Policy inventory is non-empty",
            f"{len(statements)} statements: {len(identity)} identity, {len(trust)} trust",
            str(TEMPLATE.relative_to(REPO)),
        )
    )


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def audit(template_path: Path, capabilities_path: Path) -> Report:
    import hashlib

    report = Report()
    raw = template_path.read_bytes()
    report.template_digest = "sha256:" + hashlib.sha256(raw).hexdigest()[:16]

    # CfnLoader subclasses yaml.SafeLoader and only adds CloudFormation intrinsic
    # constructors, so no Python object can be instantiated from the document.
    template = yaml.load(raw.decode(), Loader=CfnLoader)  # nosec B506
    if not isinstance(template, dict):
        report.add(
            Finding(
                "SEC-03.template-parse",
                "FAIL",
                "verification-contract",
                "Template parses as a mapping",
                "template did not parse",
                str(template_path),
            )
        )
        return report

    capabilities: dict[str, Any] = {}
    if capabilities_path.exists():
        capabilities = yaml.safe_load(capabilities_path.read_text()) or {}
    else:
        report.add(
            Finding(
                "SEC-03.capability-file",
                "FAIL",
                "SEC-03",
                "Capability record file exists",
                f"{capabilities_path} not found; global grants cannot be justified",
                str(capabilities_path),
            )
        )
    report.policy_version = str(capabilities.get("policyVersion", "unset"))

    statements = walk_statements(template)
    check_inventory_not_empty(statements, report)
    check_managed_policies(template, report)
    check_statements(statements, list(capabilities.get("records") or []), report,
                     template.get("Resources") or {})
    return report


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", type=Path, default=TEMPLATE)
    parser.add_argument("--capabilities", type=Path, default=CAPABILITIES)
    parser.add_argument("--json", type=Path, help="write the structured report here")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    report = audit(args.template, args.capabilities)
    payload = report.to_json()

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(payload, indent=2))

    if not args.quiet:
        for finding in report.findings:
            if finding.status == "PASS":
                continue
            print(
                f"[{finding.status}] {finding.check_id} at {finding.location}\n"
                f"        expected: {finding.expected}\n"
                f"        observed: {finding.observed}"
            )
        counts = payload["counts"]
        summary = ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))
        print(f"IAM policy audit: {summary} (policy {report.policy_version})")

    # Explicit return, not an assertion: `python -O` strips asserts and a verifier
    # that disappears under an optimisation flag is not an enforcement boundary.
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

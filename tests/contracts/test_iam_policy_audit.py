"""The IAM auditor actually rejects what it claims to reject.

A verifier that passes is worthless evidence until it has been shown to fail on the
thing it is supposed to catch. The previous security audit reported 18/18 while
checking, for example, that a KMS ARN existed rather than that the key was
customer-managed -- a green result from a check that could not go red.

So: negative fixtures for each rejection, and positive fixtures for the two patterns
that look like violations and are not -- a protective `Deny` with `Principal: "*"`,
and `Resource: "*"` inside a KMS key policy, which AWS defines as the attached key.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

import sys

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts" / "verify"
sys.path.insert(0, str(SCRIPTS))

import iam_policy_audit as audit  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
REAL_TEMPLATE = REPO / "infra" / "cloudformation" / "application" / "eddie-app.yaml"
REAL_CAPABILITIES = REPO / "infra" / "policy" / "global-action-capabilities.yaml"


def write(tmp_path: Path, template: str, capabilities: str = "") -> audit.Report:
    template_path = tmp_path / "template.yaml"
    template_path.write_text(textwrap.dedent(template))
    capabilities_path = tmp_path / "capabilities.yaml"
    capabilities_path.write_text(
        textwrap.dedent(capabilities)
        if capabilities
        else 'policyVersion: "test"\nrecords: []\nstructuralExemptions: []\n'
    )
    return audit.audit(template_path, capabilities_path)


def statuses(report: audit.Report, check_id: str) -> list[str]:
    return [f.status for f in report.findings if f.check_id == check_id]


def failed_ids(report: audit.Report) -> set[str]:
    return {f.check_id for f in report.failed}


#: A role with one benign scoped statement, so the inventory check is satisfied and a
#: fixture fails for the reason under test rather than for having nothing in it.
BASE_ROLE = """
    Resources:
      GoodRole:
        Type: AWS::IAM::Role
        Properties:
          AssumeRolePolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Principal: { Service: bedrock-agentcore.amazonaws.com }
                Action: sts:AssumeRole
          Policies:
            - PolicyName: Scoped
              PolicyDocument:
                Version: "2012-10-17"
                Statement:
                  - Sid: ReadOneTable
                    Effect: Allow
                    Action: dynamodb:GetItem
                    Resource: arn:aws:dynamodb:us-east-1:1234:table/eddie
"""


# --------------------------------------------------------------------------
# Negative fixtures: each must FAIL
# --------------------------------------------------------------------------


def test_a_wildcard_principal_in_an_allow_is_rejected(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      BadBucketPolicy:
        Type: AWS::S3::BucketPolicy
        Properties:
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: AnyoneMayRead
                Effect: Allow
                Principal: "*"
                Action: s3:GetObject
                Resource: arn:aws:s3:::eddie/*
""",
    )
    assert "SEC-03.wildcard-principal" in failed_ids(report)


def test_a_wildcard_principal_in_role_trust_is_rejected(tmp_path):
    report = write(
        tmp_path,
        """
    Resources:
      AnyoneRole:
        Type: AWS::IAM::Role
        Properties:
          AssumeRolePolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Principal: "*"
                Action: sts:AssumeRole
          Policies:
            - PolicyName: Scoped
              PolicyDocument:
                Version: "2012-10-17"
                Statement:
                  - Sid: X
                    Effect: Allow
                    Action: dynamodb:GetItem
                    Resource: arn:aws:dynamodb:us-east-1:1234:table/eddie
""",
    )
    assert "SEC-03.wildcard-principal" in failed_ids(report)


def test_action_star_is_rejected(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE.replace(
            "                    Action: dynamodb:GetItem",
            '                    Action: "*"',
        ),
    )
    assert "SEC-03.wildcard-action" in failed_ids(report)


@pytest.mark.parametrize("action", ["iam:*", "sagemaker:*", "s3:*", "ec2:*"])
def test_service_wide_grants_are_rejected(tmp_path, action):
    report = write(
        tmp_path,
        BASE_ROLE.replace(
            "                    Action: dynamodb:GetItem",
            f"                    Action: {action}",
        ),
    )
    assert "SEC-03.service-wide-action" in failed_ids(report)


def test_an_administrative_managed_policy_is_rejected(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE.replace(
            "        Properties:\n          AssumeRolePolicyDocument:",
            "        Properties:\n"
            "          ManagedPolicyArns:\n"
            "            - arn:aws:iam::aws:policy/AdministratorAccess\n"
            "          AssumeRolePolicyDocument:",
            1,
        ),
    )
    assert "SEC-03.forbidden-managed-policy" in failed_ids(report)


@pytest.mark.parametrize(
    "arn",
    [
        "arn:aws:iam::aws:policy/AmazonSageMakerFullAccess",
        "arn:aws:iam::aws:policy/IAMFullAccess",
        "arn:aws:iam::aws:policy/PowerUserAccess",
    ],
)
def test_full_access_policies_are_rejected(tmp_path, arn):
    report = write(
        tmp_path,
        BASE_ROLE.replace(
            "        Properties:\n          AssumeRolePolicyDocument:",
            f"        Properties:\n          ManagedPolicyArns:\n            - {arn}\n"
            "          AssumeRolePolicyDocument:",
            1,
        ),
    )
    assert "SEC-03.forbidden-managed-policy" in failed_ids(report)


def test_privilege_escalation_actions_are_rejected(tmp_path):
    """A runtime role that can write policies can grant itself anything."""
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Escalator:
        Type: AWS::IAM::Policy
        Properties:
          PolicyName: Escalate
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: WriteOwnPolicy
                Effect: Allow
                Action: iam:PutRolePolicy
                Resource: arn:aws:iam::1234:role/eddie-runtime
""",
    )
    assert "SEC-03.privilege-escalation" in failed_ids(report)


def test_an_unrecorded_global_resource_is_rejected(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Sneaky:
        Type: AWS::IAM::Policy
        Properties:
          PolicyName: Sneaky
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: ReadEverything
                Effect: Allow
                Action: s3:GetObject
                Resource: "*"
""",
    )
    assert "SEC-03.unrecorded-global-resource" in failed_ids(report)


def test_a_capability_record_whose_actions_drifted_is_rejected(tmp_path):
    """Adding an action to a recorded statement must not inherit its justification."""
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Recorded:
        Type: AWS::IAM::Policy
        Properties:
          PolicyName: Global
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: Listing
                Effect: Allow
                Action:
                  - bedrock:ListFoundationModels
                  - s3:DeleteObject
                Resource: "*"
""",
        capabilities="""
        policyVersion: "test"
        records:
          - id: TEST-001
            role: Recorded
            policy: Global
            sid: Listing
            actions:
              - bedrock:ListFoundationModels
            reason: listing has no resource authorization
            reviewBy: "2099-01-01"
        structuralExemptions: []
        """,
    )
    assert "SEC-03.capability-record-drift" in failed_ids(report)


def test_an_expired_capability_record_is_rejected(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Recorded:
        Type: AWS::IAM::Policy
        Properties:
          PolicyName: Global
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: Listing
                Effect: Allow
                Action: bedrock:ListFoundationModels
                Resource: "*"
""",
        capabilities="""
        policyVersion: "test"
        records:
          - id: TEST-001
            role: Recorded
            policy: Global
            sid: Listing
            actions: [bedrock:ListFoundationModels]
            reason: listing has no resource authorization
            reviewBy: "2020-01-01"
        structuralExemptions: []
        """,
    )
    assert "SEC-03.capability-record-expired" in failed_ids(report)


def test_a_record_for_a_statement_that_no_longer_exists_is_rejected(tmp_path):
    """A stale record must not sit there looking like justification."""
    report = write(
        tmp_path,
        BASE_ROLE,
        capabilities="""
        policyVersion: "test"
        records:
          - id: TEST-STALE
            role: Gone
            policy: Removed
            sid: Vanished
            actions: [s3:GetObject]
            reason: no longer present
            reviewBy: "2099-01-01"
        structuralExemptions: []
        """,
    )
    assert "SEC-03.orphan-capability-record" in failed_ids(report)


def test_unscoped_pass_role_is_rejected(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Passer:
        Type: AWS::IAM::Policy
        Properties:
          PolicyName: Pass
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: PassAnything
                Effect: Allow
                Action: iam:PassRole
                Resource: "*"
""",
    )
    assert "SEC-03.pass-role-scope" in failed_ids(report)


def test_pass_role_without_a_service_condition_is_rejected(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Passer:
        Type: AWS::IAM::Policy
        Properties:
          PolicyName: Pass
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: PassOne
                Effect: Allow
                Action: iam:PassRole
                Resource: arn:aws:iam::1234:role/eddie-sagemaker-execution
""",
    )
    assert "SEC-03.pass-role-service-condition" in failed_ids(report)


def test_unscoped_assume_role_is_rejected(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Assumer:
        Type: AWS::IAM::Policy
        Properties:
          PolicyName: Assume
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: AssumeAnything
                Effect: Allow
                Action: sts:AssumeRole
                Resource: "*"
""",
    )
    assert "SEC-03.assume-role-scope" in failed_ids(report)


def test_a_bad_grant_hidden_in_an_if_branch_is_still_found(tmp_path):
    """Wrapping a statement in a condition must not hide it from the audit."""
    report = write(
        tmp_path,
        """
    Conditions:
      Never: !Equals ["a", "b"]
    Resources:
      GoodRole:
        Type: AWS::IAM::Role
        Properties:
          AssumeRolePolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Principal: { Service: x.amazonaws.com }
                Action: sts:AssumeRole
          Policies:
            - !If
              - Never
              - PolicyName: Hidden
                PolicyDocument:
                  Version: "2012-10-17"
                  Statement:
                    - Sid: HiddenAdmin
                      Effect: Allow
                      Action: "*"
                      Resource: "*"
              - !Ref AWS::NoValue
            - PolicyName: Scoped
              PolicyDocument:
                Version: "2012-10-17"
                Statement:
                  - Sid: X
                    Effect: Allow
                    Action: dynamodb:GetItem
                    Resource: arn:aws:dynamodb:us-east-1:1234:table/eddie
""",
    )
    assert "SEC-03.wildcard-action" in failed_ids(report)


def test_an_unparseable_template_is_not_a_pass(tmp_path):
    report = write(tmp_path, "just a string, not a template\n")
    assert report.failed, "a template that did not parse must not report clean"


def test_an_empty_template_is_unknown_not_clean(tmp_path):
    """The 'green summary from an empty inventory' failure mode."""
    report = write(tmp_path, "Resources: {}\n")
    assert "SEC-03.inventory" in failed_ids(report)
    assert "UNKNOWN" in statuses(report, "SEC-03.inventory")


# --------------------------------------------------------------------------
# Positive fixtures: valid patterns that must NOT be flagged
# --------------------------------------------------------------------------


def test_a_protective_deny_with_a_wildcard_principal_is_preserved(tmp_path):
    """TLS-only and origin-restriction denies are the correct shape.

    Flagging these would push someone to remove a protection in order to get a green
    report -- strictly worse than leaving it alone.
    """
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      TlsOnly:
        Type: AWS::S3::BucketPolicy
        Properties:
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: DenyInsecureTransport
                Effect: Deny
                Principal: "*"
                Action: "s3:*"
                Resource: arn:aws:s3:::eddie/*
                Condition:
                  Bool: { "aws:SecureTransport": "false" }
""",
    )
    assert not report.failed, [f.to_json() for f in report.failed]
    assert "PASS" in statuses(report, "SEC-03.deny-preserved")


def test_resource_star_in_a_kms_key_policy_is_accepted(tmp_path):
    """AWS defines it as the attached key, not every key in the account."""
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Key:
        Type: AWS::KMS::Key
        Properties:
          KeyPolicy:
            Version: "2012-10-17"
            Statement:
              - Sid: LogsUse
                Effect: Allow
                Principal: { Service: logs.us-east-1.amazonaws.com }
                Action:
                  - kms:Encrypt
                  - kms:DescribeKey
                Resource: "*"
""",
    )
    assert not report.failed, [f.to_json() for f in report.failed]
    assert "PASS" in statuses(report, "SEC-03.kms-key-policy-resource")


def test_the_account_root_key_administration_path_is_preserved(tmp_path):
    """Removing this can make a customer-managed key permanently unmanageable."""
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Key:
        Type: AWS::KMS::Key
        Properties:
          KeyPolicy:
            Version: "2012-10-17"
            Statement:
              - Sid: AccountRootAdministration
                Effect: Allow
                Principal: { AWS: arn:aws:iam::123456789012:root }
                Action: kms:*
                Resource: "*"
""",
    )
    assert not report.failed, [f.to_json() for f in report.failed]
    assert "PASS" in statuses(report, "SEC-03.kms-root-administration")


def test_an_arn_suffix_under_an_owned_prefix_is_not_a_global_grant(tmp_path):
    """`log-group:/eddie/dev*` is a prefix, not `*`."""
    report = write(
        tmp_path,
        BASE_ROLE.replace(
            "                    Resource: arn:aws:dynamodb:us-east-1:1234:table/eddie",
            '                    Resource: !Sub "arn:aws:logs:us-east-1:1234:log-group:/eddie/dev*"',
        ),
    )
    assert not report.failed, [f.to_json() for f in report.failed]


def test_scoped_pass_role_with_a_service_condition_passes(tmp_path):
    report = write(
        tmp_path,
        BASE_ROLE
        + """
      Passer:
        Type: AWS::IAM::Policy
        Properties:
          PolicyName: Pass
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: PassExecutionRole
                Effect: Allow
                Action: iam:PassRole
                Resource: arn:aws:iam::1234:role/eddie-dev-sagemaker-execution
                Condition:
                  StringEquals:
                    iam:PassedToService: sagemaker.amazonaws.com
""",
    )
    assert not report.failed, [f.to_json() for f in report.failed]
    assert "PASS" in statuses(report, "SEC-03.pass-role-scoped")


# --------------------------------------------------------------------------
# The real template
# --------------------------------------------------------------------------


def test_the_shipped_template_passes_its_own_audit():
    report = audit.audit(REAL_TEMPLATE, REAL_CAPABILITIES)
    assert not report.failed, [f.to_json() for f in report.failed]


def test_serving_role_cannot_recreate_deleted_log_groups():
    """A real draining CWAgent recreated an untagged group after endpoint removal."""
    from fnmatch import fnmatchcase
    import yaml
    template = yaml.load(REAL_TEMPLATE.read_text(), Loader=audit.CfnLoader)  # nosec B506
    role = template["Resources"]["SageMakerExecutionRole"]["Properties"]
    allowed = []
    for policy in role["Policies"]:
        for statement in policy["PolicyDocument"]["Statement"]:
            if statement["Effect"] == "Allow":
                actions = statement["Action"]
                allowed.extend(actions if isinstance(actions, list) else [actions])
    assert not any(fnmatchcase("logs:CreateLogGroup", action) for action in allowed)
    assert "logs:CreateLogStream" in allowed
    assert "logs:PutLogEvents" in allowed


def test_the_shipped_template_actually_has_statements_to_check():
    """Guards against the audit passing because it parsed nothing."""
    report = audit.audit(REAL_TEMPLATE, REAL_CAPABILITIES)
    assert "PASS" in statuses(report, "SEC-03.inventory")
    assert len(report.findings) > 8


def test_every_global_grant_in_the_real_template_is_recorded():
    report = audit.audit(REAL_TEMPLATE, REAL_CAPABILITIES)
    recorded = statuses(report, "SEC-03.recorded-global-resource")
    assert recorded, "expected at least one recorded global action"
    assert all(status == "PASS" for status in recorded)


def test_enforcement_does_not_depend_on_assertions():
    """`python -O` strips asserts; the module must not rely on them.

    A verifier whose enforcement disappears under an optimisation flag is not a
    control, and this is called out explicitly in the verification contract.
    """
    source = (SCRIPTS / "iam_policy_audit.py").read_text()
    lines = [
        line.strip()
        for line in source.splitlines()
        if line.strip().startswith("assert ")
    ]
    assert not lines, f"enforcement must not use assert: {lines}"


@pytest.mark.parametrize("role", [
    "DeploymentRole", "ArtifactStagerRole", "InferenceRole", "ReconcilerRole",
])
def test_execution_identities_cannot_write_plan_or_approval_authority(role):
    """A worker that may update a job must not be able to mint its authorization."""
    from fnmatch import fnmatchcase
    import yaml
    template = yaml.load(REAL_TEMPLATE.read_text(), Loader=audit.CfnLoader)  # nosec B506
    statements = audit.walk_statements(template)
    resources = template["Resources"]
    identities = {role}
    for name, resource in resources.items():
        if resource.get("Type") == "AWS::IAM::Policy" and {"Ref": role} in resource["Properties"].get("Roles", []):
            identities.add(name)
    writes = []
    for stmt in statements:
        if stmt.role not in identities or stmt.effect != "Allow":
            continue
        if not any(action in stmt.actions for action in (
            "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem",
        )):
            continue
        writes.append(stmt)
        keys = stmt.raw.get("Condition", {}).get("ForAllValues:StringLike", {}).get("dynamodb:LeadingKeys", [])
        assert keys, f"{stmt.where} permits unbounded state writes"
        for authority in ("authority-plan#user:alice", "authority-approval#user:alice"):
            assert not any(fnmatchcase(authority, key) for key in keys), stmt.where
    assert writes, "The test must inspect actual worker write permissions."


def test_template_mapping_keys_survive_yaml_parsing():
    """An unquoted IAM Null condition becomes a null key and fails CloudFormation."""
    import yaml
    template = yaml.load(REAL_TEMPLATE.read_text(), Loader=audit.CfnLoader)  # nosec B506
    def visit(node):
        if isinstance(node, dict):
            assert all(isinstance(key, str) for key in node), node
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for value in node:
                visit(value)
    visit(template)


def gateway_template():
    template = audit.yaml.safe_load(BASE_ROLE)
    template["Resources"]["Endpoint"] = {
        "Type": "AWS::EC2::VPCEndpoint",
        "Properties": {
            "VpcEndpointType": "Gateway",
            "ServiceName": "com.amazonaws.us-east-1.s3",
            "PolicyDocument": {"Statement": [{
                "Effect": "Allow", "Principal": "*",
                "Action": ["s3:GetObject", "s3:ListBucket"],
                "Resource": ["arn:aws:s3:::eddie-artifacts", "arn:aws:s3:::eddie-artifacts/models/*"],
                "Condition": {"ArnEquals": {"aws:PrincipalArn": {"Fn::GetAtt": "GoodRole.Arn"}}},
            }]},
        },
    }
    return template


def test_s3_gateway_uses_exact_role_condition_required_by_aws(tmp_path):
    report = write(tmp_path, audit.yaml.safe_dump(gateway_template()))
    assert not report.failed
    assert statuses(report, "SEC-03.gateway-principal") == ["PASS"]


@pytest.mark.parametrize("change", [
    {"Condition": {}},
    {"Condition": {"ArnLike": {"aws:PrincipalArn": "arn:aws:iam::123456789012:role/*"}}},
    {"Condition": {"ArnEqualsIfExists": {"aws:PrincipalArn": "arn:aws:iam::123456789012:role/serving"}}},
    {"Condition": {"ArnEquals": {"aws:PrincipalArn": {"Fn::GetAtt": "UnknownRole.Arn"}}}},
    {"Action": ["s3:PutObject"]},
    {"Resource": ["arn:aws:s3:::*/*"]},
    # Reproduces the deployed startup bug: gateway endpoints require "*" plus
    # the condition, not a direct role in Principal.
    {"Principal": {"AWS": "arn:aws:iam::123456789012:role/serving"}},
])
def test_s3_gateway_does_not_allow_weak_identity_or_broad_access(tmp_path, change):
    template = gateway_template()
    template["Resources"]["Endpoint"]["Properties"]["PolicyDocument"]["Statement"][0].update(change)
    report = write(tmp_path, audit.yaml.safe_dump(template))
    assert "SEC-03.gateway-principal" in failed_ids(report)


def test_gateway_structural_rule_cannot_enable_a_bucket_policy_principal(tmp_path):
    template = gateway_template()
    template["Resources"]["Endpoint"]["Type"] = "AWS::S3::BucketPolicy"
    report = write(tmp_path, audit.yaml.safe_dump(template))
    assert "SEC-03.wildcard-principal" in failed_ids(report)

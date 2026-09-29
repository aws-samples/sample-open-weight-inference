"""Controls the threat model claims, which had no test until the document was written.

These contract tests cover the network, authority and supply-chain controls
documented in docs/security-posture.md:

  M15  the created endpoint is forced into network isolation and private subnets by an IAM
       CONDITION, not by application code
  M19  the advisor holds no capability: no tool of its own creates, approves, deletes or spends
  M20  the agent loop is bounded
  M32  the image supply chain is pinned and the scan gates the deploy

They are contract tests rather than unit tests because what they assert lives in
CloudFormation and in the installer, and the thing worth protecting is the CONDITION and
the GATE, not a Python return value.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = REPO / "infra/cloudformation/application/eddie-app.yaml"
INSTALLER = REPO / "deploy.sh"


# --------------------------------------------------------------------------
# Loading CloudFormation without evaluating its intrinsics
# --------------------------------------------------------------------------


class _CfnLoader(yaml.SafeLoader):
    """Parse the template without resolving `!Ref`/`!GetAtt`/`!Sub`.

    SafeLoader rejects the short-form intrinsic tags outright. Resolving them is not
    needed here and would require a stack: these tests ask whether a CONDITION is present
    and how it is shaped, not what a parameter evaluates to.
    """


def _passthrough(loader, tag_suffix, node):  # noqa: ANN001
    if isinstance(node, yaml.ScalarNode):
        return {f"Fn::{tag_suffix}": loader.construct_scalar(node)}
    if isinstance(node, yaml.SequenceNode):
        return {f"Fn::{tag_suffix}": loader.construct_sequence(node, deep=True)}
    return {f"Fn::{tag_suffix}": loader.construct_mapping(node, deep=True)}


_CfnLoader.add_multi_constructor("!", _passthrough)


@pytest.fixture(scope="module")
def template() -> dict:
    # SafeLoader subclass only preserves CloudFormation intrinsic tags.
    return yaml.load(TEMPLATE.read_text(), Loader=_CfnLoader)  # nosec B506


@pytest.fixture(scope="module")
def installer() -> str:
    return INSTALLER.read_text()


def _statements(role: dict) -> list[dict]:
    out = []
    for policy in role.get("Properties", {}).get("Policies", []) or []:
        out.extend(policy.get("PolicyDocument", {}).get("Statement", []) or [])
    return out


def _by_action(role: dict, action: str) -> list[dict]:
    found = []
    for statement in _statements(role):
        actions = statement.get("Action")
        actions = [actions] if isinstance(actions, str) else (actions or [])
        if any(action == a for a in actions):
            found.append(statement)
    return found


# --------------------------------------------------------------------------
# M15 — network isolation is an IAM condition, not a code path
# --------------------------------------------------------------------------


def test_creating_a_model_requires_network_isolation(template):
    """The control is that a defect in EDDIE's code cannot produce a reachable endpoint.

    If isolation were only set in the CreateModel call, any bug or future edit that dropped
    the field would silently create an endpoint that can egress. As an IAM condition, the
    request is refused by AWS instead.
    """
    role = template["Resources"]["DeploymentRole"]
    creates = _by_action(role, "sagemaker:CreateModel")
    assert creates, "DeploymentRole must be the only thing that can create a model"
    for statement in creates:
        condition = statement.get("Condition", {})
        assert condition.get("Bool", {}).get("sagemaker:NetworkIsolation") == "true", (
            "sagemaker:CreateModel must be conditional on network isolation"
        )
        # Absent VPC keys would otherwise satisfy ForAllValues trivially, which is the
        # classic way an allow-list condition on a multi-valued key does nothing.
        nulls = condition.get("Null", {})
        assert nulls.get("sagemaker:VpcSubnets") == "false"
        assert nulls.get("sagemaker:VpcSecurityGroupIds") == "false"
        allowed = condition.get("ForAllValues:StringEquals", {})
        assert allowed.get("sagemaker:VpcSubnets"), "subnets must be enumerated"
        assert allowed.get("sagemaker:VpcSecurityGroupIds"), "security group must be pinned"


def test_the_serving_network_has_no_route_off_the_account(template):
    resources = template["Resources"]
    kinds = {name: r["Type"] for name, r in resources.items()}
    assert "AWS::EC2::InternetGateway" not in kinds.values(), (
        "the serving VPC must have no internet gateway"
    )
    assert "AWS::EC2::NatGateway" not in kinds.values(), "no NAT gateway"
    group = resources["ServingSecurityGroup"]["Properties"]
    assert not group.get("SecurityGroupIngress"), (
        "the serving security group must have no inbound rule at all"
    )


def test_the_instance_type_ceiling_is_an_iam_condition_too(template):
    """A bounded trial is only bounded if the bound is not EDDIE's own to raise."""
    role = template["Resources"]["DeploymentRole"]
    configs = _by_action(role, "sagemaker:CreateEndpointConfig")
    assert configs
    for statement in configs:
        condition = statement.get("Condition", {})
        allowed = condition.get("ForAllValues:StringEquals", {}).get("sagemaker:InstanceTypes")
        assert allowed == ["ml.g5.2xlarge"], f"unexpected instance allow-list: {allowed}"
        assert condition.get("Null", {}).get("sagemaker:InstanceTypes") == "false", (
            "without the Null check, a request omitting the key satisfies ForAllValues"
        )


# --------------------------------------------------------------------------
# M19 / M20 — the advisor holds no capability, and its loop is bounded
# --------------------------------------------------------------------------

#: Capabilities that let a principal change the world or spend money. The advisor must
#: hold none of them, and no tool it can call may require one.
WRITE_CAPABILITIES = {"deploy", "approve", "delete", "operate"}


def test_no_advisor_tool_can_create_approve_delete_or_spend():
    """The load-bearing claim of the GenAI section, asserted rather than described.

    Checked by name against the action table: if a tool were ever wired to a deployment
    action, that action's required capability would be one of WRITE_CAPABILITIES, and this
    fails. A new tool called `start_deployment` would fail it on the same grounds.
    """
    from agent.advisor import TOOL_SPECS
    from runtime.principal import ACTION_CAPABILITY

    names = {spec["toolSpec"]["name"] for spec in TOOL_SPECS}
    for name in names:
        required = ACTION_CAPABILITY.get(name)
        assert required not in WRITE_CAPABILITIES, (
            f"advisor tool {name!r} maps to an action requiring {required!r}"
        )

    dangerous = {action for action, cap in ACTION_CAPABILITY.items()
                 if cap in WRITE_CAPABILITIES}
    assert not (names & dangerous), (
        f"advisor tools overlap privileged actions: {sorted(names & dangerous)}"
    )
    # Stated positively too, so that renaming an action cannot quietly pass the check above.
    assert names == {
        "propose_case_patch", "evaluate_placement", "get_rates",
        "get_catalog", "inspect_model", "calculate_usage", "estimate_inference",
        # Bundled guidance only: bounded queries, catalogue IDs, no network or
        # project/solver/deployment writes. Runtime authorization stays READ.
        "find_runbooks", "read_runbooks",
        # Public documentation only: fixed topic queries, turn-local source IDs,
        # pinned unauthenticated MCP endpoint. The boundary is exercised by
        # test_aws_docs.py; neither tool has account-write or deployment authority.
        "lookup_aws_documentation", "read_aws_documentation",
    }, f"the advisor's tool surface changed: {sorted(names)}. Re-review before widening it."
    # Reviewed collector: public model metadata + Price List reads + pure arithmetic.
    # It cannot invoke a model, provision compute, or qualify a deployment.
    assert ACTION_CAPABILITY["sizing.estimate"] == "read"


def test_the_agent_loop_is_bounded():
    from agent.advisor import MAX_TOOL_ROUNDS

    assert 1 <= MAX_TOOL_ROUNDS <= 10, (
        f"MAX_TOOL_ROUNDS={MAX_TOOL_ROUNDS}; an unbounded advisor loop iterates on the "
        f"customer's spend and the conversation's latency budget"
    )


def test_advisor_telemetry_redacts_prompts_and_tool_payloads():
    """Timing and token counts are wanted; prompts and tool results are not."""
    import agent.advisor  # noqa: F401  (import sets the environment default)
    import os

    opt_in = os.environ.get("OTEL_SEMCONV_STABILITY_OPT_IN", "")
    assert "gen_ai_latest_experimental" in opt_in
    assert "gen_ai_unredacted_attributes=" in opt_in, (
        "unredacted attributes must be set to empty, or prompts and tool results are exported"
    )


# --------------------------------------------------------------------------
# M32 — the image supply chain is pinned and the scan gates the deploy
# --------------------------------------------------------------------------


def test_the_registry_is_immutable_and_scans_on_push(installer):
    assert "--image-tag-mutability IMMUTABLE" in installer
    assert "--image-scanning-configuration scanOnPush=true" in installer


def test_the_deploy_fails_rather_than_proceeding_on_an_unscanned_image(installer):
    """A missing or incomplete scan must not read as a clean one.

    The gate is the `die` on each failure path; a scan that is merely *requested* and then
    ignored is the failure mode this protects against.
    """
    assert "aws ecr wait image-scan-complete" in installer
    window = installer[installer.index("aws ecr wait image-scan-complete"):][:2000]
    assert "die " in window, "the wait must be a gate, not a best-effort step"
    assert "Runtime image scan is not complete." in window
    # The findings must describe THIS image, or a stale clean scan would pass a new build.
    assert "imageDigest" in window and "Runtime scan does not describe this image digest." in window


def test_a_dirty_tree_cannot_reuse_an_existing_immutable_tag(installer):
    """Immutable tags plus a HEAD-only tag meant uncommitted code silently kept the old image."""
    assert "dirty" in installer
    assert "working tree is dirty" in installer

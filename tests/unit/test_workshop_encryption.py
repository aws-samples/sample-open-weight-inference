"""Keep workshop password encryption usable, account-scoped and removable."""
from pathlib import Path

import pytest
import yaml

TEMPLATE = Path(__file__).resolve().parents[2] / "infra/cloudformation/workshop/eddie-sandbox.yaml"


@pytest.fixture
def template():
    class CfnLoader(yaml.SafeLoader):
        pass

    def intrinsic(loader, tag, node):
        if isinstance(node, yaml.ScalarNode):
            value = loader.construct_scalar(node)
        elif isinstance(node, yaml.SequenceNode):
            value = loader.construct_sequence(node)
        else:
            value = loader.construct_mapping(node)
        return {tag: value}

    CfnLoader.add_multi_constructor("!", intrinsic)
    # This SafeLoader subclass only records intrinsic values; it executes no tags.
    return yaml.load(TEMPLATE.read_text(), Loader=CfnLoader)  # nosec B506


def test_password_uses_the_dedicated_rotating_encryption_key(template):
    resources = template["Resources"]
    secret = resources["ParticipantSecret"]
    assert secret["Type"] == "AWS::SecretsManager::Secret"
    assert secret["Properties"]["KmsKeyId"] == {"GetAtt": "ParticipantSecretKey.Arn"}
    key = resources["ParticipantSecretKey"]
    assert key["Type"] == "AWS::KMS::Key"
    assert key["Properties"]["EnableKeyRotation"] is True
    assert key["Properties"]["KeySpec"] == "SYMMETRIC_DEFAULT"
    assert key["Properties"]["KeyUsage"] == "ENCRYPT_DECRYPT"


def test_key_delegates_permissions_only_to_the_lab_account(template):
    key = template["Resources"]["ParticipantSecretKey"]["Properties"]
    statements = key["KeyPolicy"]["Statement"]
    assert len(statements) == 1
    statement = statements[0]
    # Preserve the account administration path without public/cross-account grants.
    assert statement["Principal"] == {
        "AWS": {"Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:root"},
    }
    assert statement["Effect"] == "Allow"
    assert statement["Action"] == "kms:*"
    assert statement["Resource"] == "*"
    assert key.get("BypassPolicyLockoutSafetyCheck", False) is False
    installer = template["Resources"]["InstallerRole"]["Properties"]
    assert {"Sub": "arn:${AWS::Partition}:iam::aws:policy/AdministratorAccess"} in (
        installer["ManagedPolicyArns"]
    )


def test_cleanup_and_password_handoff_preserve_the_secret_boundary(template):
    resources = template["Resources"]
    for resource in ("ParticipantSecret", "ParticipantSecretKey"):
        assert resources[resource]["DeletionPolicy"] == "Delete"
        assert resources[resource]["UpdateReplacePolicy"] == "Delete"
    assert resources["ParticipantSecretKey"]["Properties"]["PendingWindowInDays"] == 7
    assert template["Outputs"]["ParticipantPasswordSecret"]["Value"] == {"Ref": "ParticipantSecret"}
    env = resources["Installer"]["Properties"]["Environment"]["EnvironmentVariables"]
    handoff = next(item for item in env if item["Name"] == "PARTICIPANT_SECRET_ARN")
    assert handoff["Value"] == {"Ref": "ParticipantSecret"}

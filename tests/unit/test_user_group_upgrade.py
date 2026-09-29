"""Updating the app must not recreate legacy groups or delete managed groups."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "resolve_user_groups", Path(__file__).resolve().parents[2] / "scripts/resolve_user_groups.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_new_pool_provisions_all_groups():
    assert module.provision_groups([], set()) is True


def test_legacy_groups_and_other_groups_are_preserved():
    assert module.provision_groups([], set(module.GROUPS.values()) | {"another-application"}) is False


def test_owned_groups_always_stay_managed_even_when_a_group_has_drifted():
    resources = [
        {"LogicalResourceId": key, "ResourceType": "AWS::Cognito::UserPoolGroup", "ResourceStatus": "CREATE_COMPLETE"}
        for key in module.GROUPS
    ]
    assert module.provision_groups(resources, set()) is True


def test_partial_legacy_groups_require_reconciliation():
    with pytest.raises(ValueError, match="some legacy"):
        module.provision_groups([], {"eddie-users"})


def test_mixed_ownership_cannot_switch_all_resources_off():
    with pytest.raises(ValueError, match="mixed stack ownership"):
        module.provision_groups([{"LogicalResourceId": "UsersGroup", "ResourceType": "AWS::Cognito::UserPoolGroup"}],
                                set(module.GROUPS.values()))

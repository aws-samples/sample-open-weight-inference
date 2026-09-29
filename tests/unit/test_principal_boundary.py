"""The principal cannot be supplied, and capability decides the action.

SEC-01 and SEC-02. The dispatch previously copied the bearer token into the payload
and authorized nothing: any authenticated caller could invoke any action, and the
credential sat in the dict the advisor composes.

These tests are local and cryptographic, using a throwaway RSA key to mint tokens.
They establish the logic. Negative requests against the deployed runtime are a
separate obligation and are recorded separately -- a passing unit test here is not
evidence that the live endpoint refuses an anonymous call.
"""

from __future__ import annotations

import json
import time
from typing import Any

import pytest

jwt = pytest.importorskip("jwt")
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402

from runtime.principal import (
    ACTION_CAPABILITY,
    AuthenticationError,
    Authenticator,
    AuthorizationError,
    Capability,
    GROUP_CAPABILITIES,
    MODEL_WRITABLE_IDENTITY_KEYS,
    PUBLIC_ACTIONS,
    Principal,
    authorize_action,
    authorize_project,
    capabilities_for,
    strip_identity_fields,
)

POOL = "us-east-1_TESTPOOL"
CLIENT = "testclient1234567890"
REGION = "us-east-1"
ISSUER = f"https://cognito-idp.{REGION}.amazonaws.com/{POOL}"


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def jwk(signing_key):
    from jwt.algorithms import RSAAlgorithm

    public = json.loads(RSAAlgorithm.to_jwk(signing_key.public_key()))
    public["kid"] = "test-key-1"
    public["alg"] = "RS256"
    public["use"] = "sig"
    return public


@pytest.fixture
def authenticator(jwk, monkeypatch):
    auth = Authenticator(
        user_pool_id=POOL, allowed_client_ids=(CLIENT,), region=REGION
    )

    class FixedJwks:
        def __init__(self) -> None:
            self.fetches = 0

        def key_for(self, kid: str, allow_refresh: bool = True):  # noqa: ARG002
            self.fetches += 1
            if kid != jwk["kid"]:
                raise AuthenticationError("unknown key", "unknown_signing_key")
            return jwk

    auth._jwks = FixedJwks()  # type: ignore[assignment]
    return auth


def mint(signing_key, **overrides: Any) -> str:
    claims = {
        "sub": "user-1",
        "iss": ISSUER,
        "client_id": CLIENT,
        "token_use": "access",
        "username": "alice",
        "exp": int(time.time()) + 600,
        "iat": int(time.time()),
    }
    claims.update(overrides)
    headers = {"kid": overrides.pop("_kid", "test-key-1")}
    return jwt.encode(claims, signing_key, algorithm="RS256", headers=headers)


# --------------------------------------------------------------------------
# Authentication: every rejection the contract enumerates
# --------------------------------------------------------------------------


def test_a_valid_access_token_authenticates(authenticator, signing_key):
    principal = authenticator.authenticate(mint(signing_key))
    assert principal.subject == "user-1"
    assert principal.username == "alice"
    assert principal.client_id == CLIENT


def test_no_token_is_refused(authenticator):
    with pytest.raises(AuthenticationError):
        authenticator.authenticate(None)
    with pytest.raises(AuthenticationError):
        authenticator.authenticate("")


def test_a_malformed_token_is_refused(authenticator):
    with pytest.raises(AuthenticationError):
        authenticator.authenticate("not-a-jwt")


def test_an_expired_token_is_refused(authenticator, signing_key):
    with pytest.raises(AuthenticationError) as caught:
        authenticator.authenticate(mint(signing_key, exp=int(time.time()) - 10))
    assert caught.value.code == "expired"


def test_a_token_from_another_issuer_is_refused(authenticator, signing_key):
    with pytest.raises(AuthenticationError) as caught:
        authenticator.authenticate(
            mint(signing_key, iss="https://cognito-idp.us-east-1.amazonaws.com/other")
        )
    assert caught.value.code == "wrong_issuer"


def test_a_token_for_another_client_is_refused(authenticator, signing_key):
    with pytest.raises(AuthenticationError) as caught:
        authenticator.authenticate(mint(signing_key, client_id="someone-elses-client"))
    assert caught.value.code == "wrong_client"


def test_an_id_token_is_refused_where_an_access_token_is_required(
    authenticator, signing_key
):
    """Cognito ID and access tokens carry different claims and are not equivalent."""
    with pytest.raises(AuthenticationError) as caught:
        authenticator.authenticate(mint(signing_key, token_use="id"))
    assert caught.value.code == "wrong_token_type"


def test_a_token_with_no_subject_is_refused(authenticator, signing_key):
    with pytest.raises(AuthenticationError):
        authenticator.authenticate(mint(signing_key, sub=""))


def test_an_unsigned_token_is_refused(authenticator):
    """`alg: none` must never be accepted."""
    # Deliberately forge an unsigned token to verify that the boundary rejects it.
    # nosemgrep: python.jwt.security.jwt-none-alg.jwt-python-none-alg
    forged = jwt.encode(
        {
            "sub": "attacker",
            "iss": ISSUER,
            "client_id": CLIENT,
            "token_use": "access",
            "exp": int(time.time()) + 600,
        },
        key="",
        algorithm="none",
    )
    with pytest.raises(AuthenticationError) as caught:
        authenticator.authenticate(forged)
    assert caught.value.code == "bad_algorithm"


def test_a_token_signed_with_the_wrong_key_is_refused(authenticator, jwk):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = jwt.encode(
        {
            "sub": "attacker",
            "iss": ISSUER,
            "client_id": CLIENT,
            "token_use": "access",
            "exp": int(time.time()) + 600,
        },
        other,
        algorithm="RS256",
        headers={"kid": jwk["kid"]},
    )
    with pytest.raises(AuthenticationError):
        authenticator.authenticate(token)


def test_an_unknown_signing_key_is_refused(authenticator, signing_key):
    token = jwt.encode(
        {
            "sub": "x",
            "iss": ISSUER,
            "client_id": CLIENT,
            "token_use": "access",
            "exp": int(time.time()) + 600,
        },
        signing_key,
        algorithm="RS256",
        headers={"kid": "some-other-kid"},
    )
    with pytest.raises(AuthenticationError):
        authenticator.authenticate(token)


def test_an_unconfigured_verifier_refuses_rather_than_deferring(signing_key):
    """The specific finding: missing configuration must not mean "trust the front".

    An authorizer in front of the container is not evidence the container is
    protected, so a runtime that cannot verify refuses everything.
    """
    auth = Authenticator(user_pool_id="", allowed_client_ids=(), region=REGION)
    assert not auth.configured
    with pytest.raises(AuthenticationError) as caught:
        auth.authenticate(mint(signing_key))
    assert caught.value.code == "verifier_unconfigured"


def test_a_jwks_fetch_failure_fails_closed(monkeypatch, signing_key):
    """A key rotation we cannot follow denies; it does not fall back."""
    auth = Authenticator(
        user_pool_id=POOL, allowed_client_ids=(CLIENT,), region=REGION
    )

    def explode(*_args, **_kwargs):
        raise OSError("network down")

    monkeypatch.setattr("urllib.request.urlopen", explode)
    with pytest.raises(AuthenticationError) as caught:
        auth.authenticate(mint(signing_key))
    assert caught.value.code == "verifier_failed"


def test_the_token_is_not_in_the_loggable_form(authenticator, signing_key):
    principal = authenticator.authenticate(mint(signing_key))
    rendered = json.dumps(principal.to_json())
    assert principal.token is not None
    assert principal.token not in rendered
    # And not in the repr, which is what lands in an exception trace.
    assert principal.token not in repr(principal)


# --------------------------------------------------------------------------
# Capabilities and action authorization
# --------------------------------------------------------------------------


def principal(*groups: str) -> Principal:
    return Principal(
        subject="user-1",
        username="alice",
        capabilities=capabilities_for(groups),
        groups=groups,
    )


def test_a_reader_cannot_deploy():
    """The explicit SEC-02 proof obligation."""
    reader = principal("eddie-readers")
    authorize_action(reader, "evaluate")  # allowed
    for action in ("plan.create", "deployment.start", "deployment.delete"):
        with pytest.raises(AuthorizationError) as caught:
            authorize_action(reader, action)
        assert caught.value.code == "insufficient_permission"


def test_a_reader_cannot_even_chat():
    with pytest.raises(AuthorizationError):
        authorize_action(principal("eddie-readers"), "chat")


def test_a_deployer_cannot_approve():
    """Deploying and authorising are separate capabilities."""
    deployer = principal("eddie-deployers")
    authorize_action(deployer, "plan.create")
    authorize_action(deployer, "deployment.start")
    with pytest.raises(AuthorizationError):
        authorize_action(deployer, "plan.approve")


def test_only_an_operator_can_wake_or_sleep_infrastructure():
    for group in ("eddie-users", "eddie-deployers", "eddie-approvers"):
        with pytest.raises(AuthorizationError):
            authorize_action(principal(group), "demo.wake")
        with pytest.raises(AuthorizationError):
            authorize_action(principal(group), "demo.sleep")
    authorize_action(principal("eddie-operators"), "demo.wake")


def test_a_user_in_no_group_cannot_deploy():
    """An account exists because an operator created it. That is not spend authority."""
    plain = principal()
    authorize_action(plain, "chat")
    authorize_action(plain, "evaluate")
    with pytest.raises(AuthorizationError):
        authorize_action(plain, "deployment.start")


def test_an_unrecognised_group_grants_nothing_extra():
    """A group called `eddie-admins` that nobody wired up is not authority."""
    assert capabilities_for(("eddie-admins",)) == capabilities_for(())
    with pytest.raises(AuthorizationError):
        authorize_action(principal("eddie-admins"), "deployment.start")


def test_an_action_with_no_rule_is_refused():
    """Adding a handler is not the same as deciding who may call it."""
    with pytest.raises(AuthorizationError) as caught:
        authorize_action(principal("eddie-operators"), "some.new.action")
    assert caught.value.code == "action_not_authorized"


def test_every_dispatchable_action_has_an_authorization_rule():
    """The table and the dispatch map cannot drift apart."""
    from runtime import app

    missing = sorted(set(app.ACTIONS) - set(ACTION_CAPABILITY))
    assert not missing, f"actions with no authorization rule: {missing}"


def test_nothing_is_public():
    """SEC-01 permits a minimal public health response; EDDIE's reveals configuration.

    `health` reports region, solver version and dependency status, so it is
    authenticated. If that ever changes it must be a deliberate edit here.
    """
    assert PUBLIC_ACTIONS == frozenset()


def test_capability_sets_are_ordered_by_privilege():
    """Guards against a later edit accidentally giving readers more than users."""
    reader = GROUP_CAPABILITIES["eddie-readers"]
    user = GROUP_CAPABILITIES["eddie-users"]
    deployer = GROUP_CAPABILITIES["eddie-deployers"]
    operator = GROUP_CAPABILITIES["eddie-operators"]
    assert reader < user < deployer < operator
    assert Capability.OPERATE not in deployer


# --------------------------------------------------------------------------
# Project isolation
# --------------------------------------------------------------------------


def test_a_caller_gets_their_own_private_project_by_default():
    alice = principal()
    assert alice.default_project == "user:user-1"
    assert authorize_project(alice, None) == "user:user-1"


def test_another_users_project_is_refused():
    alice = principal()
    with pytest.raises(AuthorizationError) as caught:
        authorize_project(alice, "user:someone-else")
    assert caught.value.code == "project_forbidden"


def test_a_granted_project_is_allowed():
    granted = Principal(
        subject="user-1",
        username="alice",
        capabilities=capabilities_for(("eddie-deployers",)),
        groups=("eddie-deployers", "eddie-project-netflix"),
        project_ids=("netflix",),
    )
    assert authorize_project(granted, "netflix") == "netflix"
    assert granted.default_project == "netflix"


def test_a_guessed_project_identifier_is_refused():
    granted = Principal(
        subject="user-1",
        username="alice",
        capabilities=capabilities_for(("eddie-deployers",)),
        project_ids=("netflix",),
    )
    with pytest.raises(AuthorizationError):
        authorize_project(granted, "acme-competitor")


def test_the_refusal_message_does_not_reveal_whether_a_project_exists():
    """Identifiers must not be probeable by comparing error text."""
    alice = principal()
    messages = set()
    for candidate in ("netflix", "does-not-exist-at-all", "user:bob"):
        with pytest.raises(AuthorizationError) as caught:
            authorize_project(alice, candidate)
        messages.add(caught.value.detail)
    assert len(messages) == 1, messages


# --------------------------------------------------------------------------
# Payload cannot carry authority
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field",
    ["subject", "approvedBy", "capabilities", "groups", "isOperator", "roleArn",
     "accountId", "_bearerToken", "accessToken"],
)
def test_identity_fields_are_stripped_from_the_payload(field):
    cleaned, removed = strip_identity_fields({field: "attacker", "source": "x/y"})
    assert field not in cleaned
    assert field in removed
    assert cleaned["source"] == "x/y"


def test_the_project_parameter_survives_because_it_is_authorized_not_trusted():
    """Naming a project is a parameter; asserting an identity is not.

    `projectId` deliberately stays so a caller can target a project they have a grant
    for; `authorize_project` is what makes that safe.
    """
    cleaned, removed = strip_identity_fields({"projectId": "netflix"})
    assert cleaned["projectId"] == "netflix"
    assert "projectId" not in removed


def test_the_bearer_token_is_not_an_accepted_payload_field():
    """The exact finding: the token used to be copied into the payload."""
    assert "_bearerToken" in MODEL_WRITABLE_IDENTITY_KEYS
    from runtime import app

    source = (
        __import__("pathlib").Path(app.__file__).read_text()
    )
    assert 'payload["_bearerToken"] = token' not in source
    assert 'payload.get("_bearerToken")' not in source


def test_stripping_leaves_an_ordinary_payload_untouched():
    payload = {"source": "mistralai/Mistral-7B-Instruct-v0.3", "revision": "abc"}
    cleaned, removed = strip_identity_fields(payload)
    assert cleaned is payload, "no copy when there is nothing to remove"
    assert removed == []

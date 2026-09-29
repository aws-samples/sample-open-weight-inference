"""Who is calling, and what they are allowed to do.

SEC-01 and SEC-02. Two properties matter, and the previous dispatch had neither.

**The principal is built here, not received.** It is derived from a cryptographically
verified token and from server-side project grants. Nothing in the request body can
influence it. The advisor writes into the case payload, so any identity field carried
there is model-writable by construction; a `subject`, `projectId`, `role` or
`approvedBy` in a payload is ignored.

**The token is verified by this service.** AgentCore's inbound JWT authorizer runs in
front, and the contract is explicit that its configuration alone is not sufficient
evidence: the runtime has published versions, `IAM` and `JWT` inbound modes, and a
misconfiguration upstream should not become anonymous access downstream. So the
signature, algorithm, issuer, `token_use`, `client_id` and expiry are checked again
here, against the pool's JWKS, and any verifier failure -- including a key-rotation
fetch failure -- denies the request rather than allowing it.

The raw token is no longer copied into the payload dict. It is carried in this object
and handed only to the one component that needs to act as the user (COA namespace
access), which keeps it out of the model's view and out of anything logged from the
payload.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import re
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

from netio import open_url

log = logging.getLogger("eddie.principal")

#: Only asymmetric RS256 is accepted. Allowing `none` or an HMAC algorithm would let a
#: caller sign their own token with a public value.
ACCEPTED_ALGORITHMS = ("RS256",)

#: Cognito access tokens carry `token_use: access` and `client_id`; ID tokens carry
#: `token_use: id` and `aud`. They are not interchangeable, and accepting an ID token
#: where an access token is required is a documented confusion.
REQUIRED_TOKEN_USE = "access"

JWKS_CACHE_SECONDS = 3600
JWKS_TIMEOUT_SECONDS = 5

#: Shapes for the two environment values interpolated into the issuer URL.
_AWS_REGION_RE = re.compile(r"[a-z]{2}(-[a-z]+)+-\d")
_USER_POOL_ID_RE = re.compile(r"[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+")


class AuthenticationError(Exception):
    """The caller could not be authenticated. Never leaks token contents."""

    def __init__(self, detail: str, code: str = "not_authenticated") -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code


class AuthorizationError(Exception):
    """Authenticated, but not permitted to do this to this object."""

    def __init__(self, detail: str, code: str = "not_authorized") -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code


# --------------------------------------------------------------------------
# Capabilities
# --------------------------------------------------------------------------


class Capability:
    """What a principal may do. Deliberately coarse and few.

    Separated from the action list so a new action cannot silently become available
    to everyone: `ACTION_CAPABILITY` must name one, and an action absent from that
    table is refused.
    """

    READ = "read"           # evidence, catalogue, prices, own cases
    CHAT = "chat"           # converse with the advisor
    DEPLOY = "deploy"       # create a plan, start execution
    APPROVE = "approve"     # authorise a plan for execution
    OPERATE = "operate"     # wake/sleep EDDIE's own infrastructure
    DELETE = "delete"       # tear down a deployment


#: Cognito group -> capabilities. Groups are resolved from the verified token, so a
#: caller cannot name their own group.
#:
#: `eddie-readers` deliberately cannot deploy: SEC-02's proof obligation is that a
#: reader cannot deploy, and that has to be a real configuration rather than a
#: hypothetical one.
GROUP_CAPABILITIES: dict[str, frozenset[str]] = {
    "eddie-readers": frozenset({Capability.READ}),
    "eddie-users": frozenset({Capability.READ, Capability.CHAT}),
    "eddie-deployers": frozenset(
        {Capability.READ, Capability.CHAT, Capability.DEPLOY, Capability.DELETE}
    ),
    "eddie-approvers": frozenset(
        {
            Capability.READ,
            Capability.CHAT,
            Capability.DEPLOY,
            Capability.APPROVE,
            Capability.DELETE,
        }
    ),
    "eddie-operators": frozenset(
        {
            Capability.READ,
            Capability.CHAT,
            Capability.DEPLOY,
            Capability.APPROVE,
            Capability.OPERATE,
            Capability.DELETE,
        }
    ),
}

#: Capabilities for a signed-in user in no group.
#:
#: Read and chat, never deploy. The pool is admin-create-only, so an account exists
#: because an operator made it -- but "an operator made you an account" is not "you
#: may spend money on GPUs". Deployment requires explicit group membership.
DEFAULT_CAPABILITIES = frozenset({Capability.READ, Capability.CHAT})

#: The capability each action requires. An action missing from this table is refused
#: by `authorize_action`, so adding an action without deciding its authorization
#: fails closed instead of inheriting whatever the last one had.
ACTION_CAPABILITY: dict[str, str] = {
    "health": Capability.READ,
    "rates": Capability.READ,
    "catalog": Capability.READ,
    "evaluate": Capability.READ,
    "inspect_model": Capability.READ,
    "sizing.estimate": Capability.READ,
    "checkpoint.list": Capability.READ,
    "checkpoint.inspect": Capability.READ,
    "connectors": Capability.READ,
    "evaluation.score": Capability.READ,
    "case.get": Capability.READ,
    "case.list": Capability.READ,
    # Editing a draft uses the same capability as the conversational editor.
    # Read-only users can inspect saved projects but cannot change them.
    "case.save": Capability.CHAT,
    "case.remove": Capability.CHAT,
    "knowledge": Capability.READ,
    "chat": Capability.CHAT,
    "chat.history": Capability.READ,
    "chat.cancel": Capability.CHAT,
    # EDDIE's own infrastructure. SEC-02: only installation operators.
    "demo.status": Capability.READ,
    "demo.wake": Capability.OPERATE,
    "demo.sleep": Capability.OPERATE,
    # Inference deployment lifecycle.
    "plan.create": Capability.DEPLOY,
    "plan.get": Capability.READ,
    "plan.list": Capability.READ,
    "plan.approve": Capability.APPROVE,
    "deployment.start": Capability.DEPLOY,
    "deployment.get": Capability.READ,
    "deployment.list": Capability.READ,
    "deployment.invoke": Capability.READ,
    "deployment.change.plan": Capability.DEPLOY,
    "deployment.delete.plan": Capability.DELETE,
    "deployment.delete": Capability.DELETE,
}

#: Actions that never require authentication. Deliberately minimal and inventoried:
#: SEC-01 allows public protocol metadata and a minimal health response only if it
#: reveals no configuration. EDDIE's `health` reports region, solver version and
#: dependency status, which is internal configuration, so it is *not* public.
PUBLIC_ACTIONS: frozenset[str] = frozenset()

#: Identity-shaped keys stripped from every payload before a handler sees it.
#:
#: The advisor composes payloads, so these are model-writable. Leaving them in place
#: would mean an LLM could propose `{"approvedBy": "someone-else"}` and have it read
#: as authority somewhere downstream.
MODEL_WRITABLE_IDENTITY_KEYS: frozenset[str] = frozenset(
    {
        "principal",
        "subject",
        "sub",
        "actor",
        "actorId",
        "username",
        "userId",
        "email",
        "groups",
        "capabilities",
        # `accountId` is stripped but `projectId` is not, and the difference is the
        # point. Naming *which* project an operation targets is a request parameter,
        # and `authorize_project` refuses one the caller has no grant for. Naming the
        # deployment *account* is not a parameter: it is resolved from server
        # configuration, because an account named by the caller is an account the
        # caller chose to spend money in.
        "accountId",
        "role",
        "roleArn",
        "approvedBy",
        "approvedAt",
        "approvalId",
        "authorized",
        "isOperator",
        "isAdmin",
        "_bearerToken",
        "bearerToken",
        "token",
        "accessToken",
        "idToken",
        "authorization",
    }
)


@dataclass(frozen=True)
class Principal:
    """A verified caller.

    Constructed only by `authenticate`. `token` is present so a handler can act as
    the user against a service that federates the same identity (COA), and is
    excluded from `to_json` so it cannot reach a log, a trace or the model.
    """

    subject: str
    username: str
    capabilities: frozenset[str]
    groups: tuple[str, ...] = ()
    email: Optional[str] = None
    client_id: Optional[str] = None
    project_ids: tuple[str, ...] = ()
    expires_at: int = 0
    token: Optional[str] = field(default=None, repr=False)

    def has(self, capability: str) -> bool:
        return capability in self.capabilities

    @property
    def default_project(self) -> str:
        """The project a new object belongs to.

        A user with no explicit grant gets a private project derived from their
        subject, so two users of the same installation cannot see each other's
        deployments by default. It is derived here, never taken from the request.
        """
        return self.project_ids[0] if self.project_ids else f"user:{self.subject}"

    def may_access_project(self, project_id: str) -> bool:
        if project_id == f"user:{self.subject}":
            return True
        return project_id in self.project_ids

    def to_json(self) -> dict[str, Any]:
        """Loggable form. No token, and no email unless it is already the username."""
        return {
            "subject": self.subject,
            "username": self.username,
            "groups": list(self.groups),
            "capabilities": sorted(self.capabilities),
            "projects": list(self.project_ids),
            "clientId": self.client_id,
        }

    def __repr__(self) -> str:  # pragma: no cover - defensive
        return (
            f"Principal(subject={self.subject!r}, groups={self.groups!r}, "
            f"capabilities={sorted(self.capabilities)!r})"
        )


# --------------------------------------------------------------------------
# JWKS
# --------------------------------------------------------------------------


class JwksCache:
    """Cached signing keys for one user pool.

    Fetch failure is *not* treated as "cannot verify, therefore allow". A rotation
    that we cannot follow denies requests until it can be followed, which is the
    fail-closed behaviour SEC-01 requires.
    """

    #: The pool id and region come from the environment, so the issuer URL they
    #: build is not trusted input. Pinning the host keeps a malformed or hostile
    #: region from redirecting key retrieval to a provider we do not control —
    #: which would let an attacker supply the signing keys.
    ALLOWED_HOSTS = ("amazonaws.com",)

    def __init__(self, url: str, ttl: int = JWKS_CACHE_SECONDS) -> None:
        self.url = url
        self.ttl = ttl
        self._keys: dict[str, Any] = {}
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    def _fetch(self) -> dict[str, Any]:
        request = urllib.request.Request(
            self.url, headers={"Accept": "application/json"}
        )
        with open_url(
            request, timeout=JWKS_TIMEOUT_SECONDS, allowed_hosts=self.ALLOWED_HOSTS
        ) as response:
            document = json.loads(response.read())
        keys = {k["kid"]: k for k in document.get("keys", []) if k.get("kid")}
        if not keys:
            raise AuthenticationError(
                "The identity provider returned no signing keys.", "verifier_failed"
            )
        return keys

    def key_for(self, kid: str, *, allow_refresh: bool = True) -> dict[str, Any]:
        with self._lock:
            stale = (time.time() - self._fetched_at) > self.ttl
            if self._keys and not stale and kid in self._keys:
                return self._keys[kid]
        try:
            keys = self._fetch()
        except AuthenticationError:
            raise
        except Exception as exc:  # noqa: BLE001
            # Deny rather than fall back to an unverified path.
            raise AuthenticationError(
                "Could not retrieve the identity provider's signing keys, so the "
                "request cannot be verified.",
                "verifier_failed",
            ) from exc
        with self._lock:
            self._keys = keys
            self._fetched_at = time.time()
        if kid in keys:
            return keys[kid]
        if allow_refresh:
            # One retry covers a key rotated between cache fill and this request.
            with self._lock:
                self._fetched_at = 0.0
            return self.key_for(kid, allow_refresh=False)
        raise AuthenticationError(
            "The token was signed with a key this pool does not publish.",
            "unknown_signing_key",
        )


@dataclass
class Authenticator:
    """Verifies a Cognito access token against a pool and allowed clients."""

    user_pool_id: str
    allowed_client_ids: tuple[str, ...]
    region: str
    _jwks: Optional[JwksCache] = None

    @classmethod
    def from_environment(cls) -> "Authenticator":
        region = os.environ.get("EDDIE_REGION", os.environ.get("AWS_REGION", "us-east-1"))
        clients = tuple(
            c.strip()
            for c in os.environ.get("EDDIE_USER_POOL_CLIENT_IDS", "").split(",")
            if c.strip()
        )
        return cls(
            user_pool_id=os.environ.get("EDDIE_USER_POOL_ID", ""),
            allowed_client_ids=clients,
            region=region,
        )

    @property
    def configured(self) -> bool:
        return bool(self.user_pool_id and self.allowed_client_ids)

    @property
    def issuer(self) -> str:
        """The Cognito issuer for the configured pool.

        Both components are interpolated into a URL, so both are shape-checked
        first: a region or pool id carrying `/`, `@`, `#` or `?` would otherwise
        move the authority or path of the issuer and of the JWKS URL derived
        from it.
        """
        if not _AWS_REGION_RE.fullmatch(self.region):
            raise AuthenticationError(
                "The deployment region is not configured correctly.", "verifier_failed"
            )
        if not _USER_POOL_ID_RE.fullmatch(self.user_pool_id):
            raise AuthenticationError(
                "The user pool is not configured correctly.", "verifier_failed"
            )
        return (
            f"https://cognito-idp.{self.region}.amazonaws.com/{self.user_pool_id}"
        )

    @property
    def jwks(self) -> JwksCache:
        if self._jwks is None:
            self._jwks = JwksCache(f"{self.issuer}/.well-known/jwks.json")
        return self._jwks

    def authenticate(self, token: Optional[str]) -> Principal:
        """Verify a token and build the principal, or raise.

        Raises rather than returning None so a caller cannot accidentally treat a
        falsy result as an anonymous-but-permitted request.
        """
        if not self.configured:
            # Refusing here is deliberate. An unconfigured verifier previously meant
            # "trust the authorizer in front", which is the assumption the contract
            # says is not evidence.
            raise AuthenticationError(
                "This runtime is not configured to verify credentials, so no request "
                "can be authorized.",
                "verifier_unconfigured",
            )
        if not token:
            raise AuthenticationError("No bearer token was presented.")

        import jwt  # imported here so a missing dependency fails loudly at call time

        try:
            header = jwt.get_unverified_header(token)
        except Exception as exc:  # noqa: BLE001
            raise AuthenticationError("The token is malformed.") from exc

        algorithm = header.get("alg")
        if algorithm not in ACCEPTED_ALGORITHMS:
            raise AuthenticationError(
                f"Token algorithm {algorithm!r} is not accepted.", "bad_algorithm"
            )
        kid = header.get("kid")
        if not kid:
            raise AuthenticationError("The token names no signing key.")

        jwk = self.jwks.key_for(kid)
        try:
            key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwk))
        except Exception as exc:  # noqa: BLE001
            raise AuthenticationError(
                "The published signing key could not be read.", "verifier_failed"
            ) from exc

        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=list(ACCEPTED_ALGORITHMS),
                issuer=self.issuer,
                # Cognito access tokens have no `aud`; the client is in `client_id`,
                # which is checked below. Verifying an absent audience would fail
                # every valid access token.
                options={"require": ["exp", "iss", "sub"], "verify_aud": False},
                leeway=0,
            )
        except jwt.ExpiredSignatureError as exc:
            raise AuthenticationError("The session has expired.", "expired") from exc
        except jwt.InvalidIssuerError as exc:
            raise AuthenticationError(
                "The token was issued by a different provider.", "wrong_issuer"
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise AuthenticationError("The token could not be verified.") from exc

        if claims.get("token_use") != REQUIRED_TOKEN_USE:
            raise AuthenticationError(
                f"An access token is required; this is a "
                f"{claims.get('token_use')!r} token.",
                "wrong_token_type",
            )

        client_id = claims.get("client_id")
        if client_id not in self.allowed_client_ids:
            raise AuthenticationError(
                "The token was issued to a client this runtime does not accept.",
                "wrong_client",
            )

        subject = str(claims.get("sub") or "")
        if not subject:
            raise AuthenticationError("The token carries no subject.")

        groups = tuple(str(g) for g in (claims.get("cognito:groups") or []))
        capabilities = capabilities_for(groups)
        return Principal(
            subject=subject,
            username=str(claims.get("username") or claims.get("cognito:username") or subject),
            capabilities=capabilities,
            groups=groups,
            client_id=client_id,
            project_ids=projects_for(groups),
            expires_at=int(claims.get("exp") or 0),
            token=token,
        )


def capabilities_for(groups: tuple[str, ...]) -> frozenset[str]:
    """Union of the capabilities of every recognised group.

    An unrecognised group contributes nothing: a group named `eddie-admins` that
    nobody wired up must not grant anything by virtue of its name.
    """
    granted: set[str] = set()
    recognised = False
    for group in groups:
        if group in GROUP_CAPABILITIES:
            recognised = True
            granted |= GROUP_CAPABILITIES[group]
    if not recognised:
        return DEFAULT_CAPABILITIES
    return frozenset(granted)


def projects_for(groups: tuple[str, ...]) -> tuple[str, ...]:
    """Projects granted by group membership.

    Convention: a group `eddie-project-<id>` grants access to project `<id>`. The
    mapping lives on the server; a caller cannot assert a project.
    """
    prefix = "eddie-project-"
    return tuple(g[len(prefix):] for g in groups if g.startswith(prefix) and len(g) > len(prefix))


# --------------------------------------------------------------------------
# Authorization
# --------------------------------------------------------------------------


def authorize_action(principal: Principal, action: str) -> None:
    """Refuse an action the principal lacks the capability for.

    An action with no entry in `ACTION_CAPABILITY` is refused. Failing closed on an
    unmapped action is the whole reason the table is separate from the dispatch map:
    adding a handler is not the same as deciding who may call it.
    """
    required = ACTION_CAPABILITY.get(action)
    if required is None:
        raise AuthorizationError(
            f"Action {action!r} has no authorization rule, so it is refused.",
            "action_not_authorized",
        )
    if not principal.has(required):
        raise AuthorizationError(
            f"This action needs the {required!r} permission, which your account does "
            f"not have. Ask an EDDIE operator to grant it.",
            "insufficient_permission",
        )


def authorize_project(principal: Principal, project_id: Optional[str]) -> str:
    """Resolve and authorize the project an operation targets.

    Absent means the caller's own project. A named project the caller has no grant
    for is refused with the same message whether or not it exists, so identifiers
    cannot be probed by comparing error text.
    """
    if not project_id:
        return principal.default_project
    if not principal.may_access_project(project_id):
        raise AuthorizationError(
            "Access restricted to your project.", "project_forbidden"
        )
    return project_id


def strip_identity_fields(payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Remove model-writable identity claims from a payload.

    Returns the cleaned payload and the names removed, so an attempt to supply one is
    visible in the response and in logs rather than silently dropped.
    """
    removed = [k for k in payload if k in MODEL_WRITABLE_IDENTITY_KEYS]
    if not removed:
        return payload, []
    cleaned = {k: v for k, v in payload.items() if k not in MODEL_WRITABLE_IDENTITY_KEYS}
    return cleaned, sorted(removed)

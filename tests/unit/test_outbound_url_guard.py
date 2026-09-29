"""The outbound URL guard must fail closed on scheme, credentials and host.

Several fetch targets are operator configuration (COA endpoint, Cognito region and
pool id, a model reference). If any of those can carry a non-HTTPS scheme or a
foreign host through to `urlopen`, a metadata read becomes local file disclosure
or a request to a host we do not control — and for JWKS, a host that supplies the
signing keys. These tests pin that refusal.
"""

import urllib.request

import pytest

from netio import CheckedRedirects, UnsafeUrlError, open_url, permitted_url, require_https
from runtime.principal import Authenticator, AuthenticationError


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "http://huggingface.co/api/models/x",
    "ftp://huggingface.co/x",
    "https://user:secret@huggingface.co/x",
    "https://huggingface.co:8443/x",
    "https://",
    "https://huggingface.co:invalid/x",
])
def test_unsafe_urls_are_refused(url):
    assert permitted_url(url) is False
    with pytest.raises(UnsafeUrlError):
        require_https(url)


def test_plain_https_is_allowed_when_no_host_pin_is_given():
    assert permitted_url("https://example.com/a?b=c") is True


def test_host_pinning_admits_subdomains_but_not_suffix_lookalikes():
    hosts = ("huggingface.co",)
    assert permitted_url("https://huggingface.co/a", hosts) is True
    assert permitted_url("https://cdn-lfs.huggingface.co/a", hosts) is True
    assert permitted_url("https://huggingface.co.attacker.example/a", hosts) is False
    assert permitted_url("https://notinguggingface.co/a", hosts) is False


def test_an_off_host_url_is_refused_even_when_it_is_https():
    with pytest.raises(UnsafeUrlError):
        require_https("https://attacker.example/x", ("huggingface.co",))


def test_the_error_message_does_not_echo_the_url():
    """These URLs can carry a token in a query string; the message is logged."""
    with pytest.raises(UnsafeUrlError) as raised:
        require_https("https://attacker.example/x?access_token=shhh", ("huggingface.co",))
    assert "shhh" not in str(raised.value)
    assert "attacker.example" not in str(raised.value)


def test_a_prepared_request_cannot_smuggle_a_scheme_past_the_check():
    request = urllib.request.Request("file:///etc/passwd")
    with pytest.raises(UnsafeUrlError):
        open_url(request, timeout=1)


def test_open_url_never_reaches_the_network_for_a_refused_url(monkeypatch):
    def fail(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("urlopen was called for a refused URL")

    monkeypatch.setattr(urllib.request, "urlopen", fail)
    with pytest.raises(UnsafeUrlError):
        open_url("http://example.com", timeout=1)


@pytest.mark.parametrize("destination", [
    "http://huggingface.co/model", "https://huggingface.co.attacker.example/model",
    "file:///etc/passwd",
])
def test_redirect_hops_are_checked_before_opening(destination):
    handler = CheckedRedirects(("huggingface.co",))
    request = urllib.request.Request("https://huggingface.co/model")
    with pytest.raises(UnsafeUrlError):
        handler.redirect_request(request, None, 302, "Found", {}, destination)


def test_a_bearer_token_cannot_cross_hosts_even_inside_an_allowed_domain():
    handler = CheckedRedirects(("huggingface.co",))
    request = urllib.request.Request("https://huggingface.co/model", headers={"Authorization": "Bearer test-only"})
    with pytest.raises(UnsafeUrlError):
        handler.redirect_request(request, None, 302, "Found", {}, "https://cdn.huggingface.co/model")
    same = handler.redirect_request(request, None, 302, "Found", {}, "https://huggingface.co/renamed")
    assert same.get_header("Authorization") == "Bearer test-only"


def test_a_configured_coa_service_cannot_redirect_a_caller_token_to_another_host():
    handler = CheckedRedirects()
    request = urllib.request.Request("https://coa.example/mcp", headers={"Authorization": "Bearer test-only"})
    with pytest.raises(UnsafeUrlError):
        handler.redirect_request(request, None, 302, "Found", {}, "https://other.example/mcp")


# ----------------------------------------------------------------------
# Issuer construction
# ----------------------------------------------------------------------


def test_a_hostile_region_cannot_move_the_issuer_host():
    authenticator = Authenticator(
        user_pool_id="us-east-1_ABC123", allowed_client_ids=("c",),
        region="us-east-1.attacker.example/x",
    )
    with pytest.raises(AuthenticationError):
        authenticator.issuer


def test_a_hostile_pool_id_cannot_move_the_jwks_path():
    authenticator = Authenticator(
        user_pool_id="us-east-1_ABC/../../evil", allowed_client_ids=("c",),
        region="us-east-1",
    )
    with pytest.raises(AuthenticationError):
        authenticator.issuer


def test_a_well_formed_configuration_still_produces_the_cognito_issuer():
    authenticator = Authenticator(
        user_pool_id="us-east-1_TESTPOOL", allowed_client_ids=("c",), region="us-east-1",
    )
    assert authenticator.issuer == (
        "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL"
    )
    assert permitted_url(f"{authenticator.issuer}/.well-known/jwks.json",
                         ("amazonaws.com",)) is True

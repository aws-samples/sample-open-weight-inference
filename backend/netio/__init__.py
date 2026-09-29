"""Scheme- and host-checked outbound HTTP.

`urllib.request.urlopen` honours whatever scheme the URL carries, including
`file://`, `ftp://` and `data:`. Several of our fetch targets are operator
configuration (a COA MCP endpoint, a JWKS URL, a model registry base), so a
mistaken or hostile value reaching `urlopen` unchecked turns a metadata fetch
into local file disclosure or an unintended internal request.

Every outbound call therefore goes through :func:`open_url`, which refuses
anything that is not HTTPS on its default port, refuses credentials embedded in
the URL, and optionally pins the request to an allowlist of hosts. The check runs
against the URL that is about to be opened, so a `Request` object built elsewhere
cannot bypass it.
"""
from __future__ import annotations

import urllib.parse
import urllib.request
from typing import Iterable, Optional

__all__ = ["UnsafeUrlError", "permitted_url", "require_https", "open_url"]


class UnsafeUrlError(ValueError):
    """Raised when a URL is not an HTTPS URL we are willing to open."""


def permitted_url(url: str, allowed_hosts: Optional[Iterable[str]] = None) -> bool:
    """Return whether `url` is HTTPS, credential-free and (if pinned) in-host.

    A host in `allowed_hosts` matches itself and its subdomains, so
    `huggingface.co` also admits `cdn-lfs.huggingface.co` but never
    `huggingface.co.attacker.example`.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme != "https" or port not in (None, 443):
        return False
    if parsed.username or parsed.password:
        return False
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    if allowed_hosts is None:
        return True
    return any(host == allowed or host.endswith(f".{allowed}")
               for allowed in (a.lower().lstrip(".") for a in allowed_hosts))


def require_https(url: str, allowed_hosts: Optional[Iterable[str]] = None) -> str:
    """Return `url` unchanged, or raise :class:`UnsafeUrlError`.

    The message deliberately does not echo the URL: these values can carry a
    token in a query string, and this error is surfaced to callers and logs.
    """
    if not permitted_url(url, allowed_hosts):
        raise UnsafeUrlError(
            "Refusing to fetch a URL that is not credential-free HTTPS"
            + (f" on an approved host ({', '.join(sorted(allowed_hosts))})" if allowed_hosts else "")
            + "."
        )
    return url


class CheckedRedirects(urllib.request.HTTPRedirectHandler):
    """Revalidate every hop, before opening a socket or forwarding a header."""

    def __init__(self, allowed_hosts: Optional[Iterable[str]] = None):
        self.allowed_hosts = tuple(allowed_hosts) if allowed_hosts is not None else None

    def redirect_request(self, request, response, code, message, headers, newurl):
        require_https(newurl, self.allowed_hosts)
        old = urllib.parse.urlsplit(request.full_url)
        new = urllib.parse.urlsplit(newurl)
        cross_host = old.hostname != new.hostname
        sensitive = any(
            key.casefold() in {"authorization", "proxy-authorization", "cookie"}
            for key, _ in request.header_items()
        )
        # Unpinned configured services (COA) may redirect on their own host, but
        # cannot select a new destination. Even pinned hosts cannot receive a
        # different host's credentials. urllib otherwise copies those headers.
        if cross_host and (self.allowed_hosts is None or sensitive):
            raise UnsafeUrlError("Refusing a cross-host redirect for this request.")
        return super().redirect_request(request, response, code, message, headers, newurl)


def open_url(
    target: "str | urllib.request.Request",
    *,
    timeout: float,
    allowed_hosts: Optional[Iterable[str]] = None,
    opener: Optional[urllib.request.OpenerDirector] = None,
):
    """Open `target` after validating the URL it will actually request.

    `target` may be a URL string or a prepared `Request`; either way the URL is
    checked immediately before the socket is opened, which is the only point at
    which no further rewriting can happen.
    """
    url = target.full_url if isinstance(target, urllib.request.Request) else target
    require_https(url, allowed_hosts)
    if opener is not None:
        return opener.open(target, timeout=timeout)
    return urllib.request.build_opener(CheckedRedirects(allowed_hosts)).open(target, timeout=timeout)

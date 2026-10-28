"""Network policy for the media container.

Threat: a user submits a URL (or a page that redirects / embeds secondary requests) pointing at
internal services — localhost, the container host, cloud metadata, private ranges. yt-dlp follows
redirects and extractors make follow-up requests, so validating only the first URL is not enough.

Defence in depth:
1. `validate_url` — scheme/host/port checks on every URL we are handed.
2. `PolicyProxy` — a local forward proxy that yt-dlp and FFmpeg are forced through. It resolves the
   hostname itself, rejects every non-public address, and connects to the vetted IP. Because the
   check happens at connect time for every hop, redirects, DNS rebinding and extractor sub-requests
   are all covered.
3. `safe_env` — child processes (yt-dlp, ffmpeg) never receive bot tokens or API keys.

Residual risk is documented in docs/security.md (a compromised yt-dlp extractor could ignore the proxy
environment; Cloudflare-level egress controls and per-job containers limit the blast radius).
"""
from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
import os
import re
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

log = logging.getLogger("tvd.security")

MAX_URL_LENGTH = 2048

BLOCKED_PORTS = {
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
    111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 445, 465, 512, 513, 514, 515, 526, 530, 531,
    532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 2375, 2376, 3306, 3389,
    4045, 5432, 5900, 6000, 6379, 6665, 6666, 6667, 6668, 6669, 8081, 9200, 9300, 11211, 27017,
}
BLOCKED_HOSTS = {"localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes.default.svc"}
BLOCKED_SUFFIXES = (
    ".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa",
    ".in-addr.arpa", ".ip6.arpa",
)


class UnsafeUrlError(ValueError):
    """The URL (or an address it resolves to) is not allowed."""

    def __init__(self, reason: str, code: str = "blocked_url"):
        super().__init__(reason)
        self.code = code
        self.reason = reason


def is_public_ip(value: str, *, allow_private: bool = False) -> bool:
    """True if the address is globally routable. IPv4-mapped / NAT64 / 6to4 addresses are unwrapped."""
    if allow_private:
        return True
    try:
        ip = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return is_public_ip(str(ip.ipv4_mapped))
        if ip.sixtofour is not None:
            return is_public_ip(str(ip.sixtofour))
        packed = ip.packed
        if packed[:12] == bytes.fromhex("0064ff9b0000000000000000"):  # 64:ff9b::/96 NAT64
            return is_public_ip(str(ipaddress.IPv4Address(packed[12:])))
        if ip in ipaddress.ip_network("100::/64"):  # discard-only
            return False
    return ip.is_global and not ip.is_multicast


def validate_url(raw: str, *, allow_private: bool = False) -> str:
    """Return the URL if it is acceptable, otherwise raise UnsafeUrlError."""
    url = (raw or "").strip()
    if not url:
        raise UnsafeUrlError("empty URL", "invalid_url")
    if len(url) > MAX_URL_LENGTH:
        raise UnsafeUrlError("URL too long", "invalid_url")
    if re.search(r"[\x00-\x20\x7f]", url):
        raise UnsafeUrlError("whitespace or control characters in URL", "invalid_url")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise UnsafeUrlError("malformed URL", "invalid_url") from exc
    if parts.scheme not in ("http", "https"):
        raise UnsafeUrlError(f"unsupported scheme {parts.scheme!r}", "invalid_url")
    if parts.username or parts.password:
        raise UnsafeUrlError("credentials in URL are not allowed")
    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        raise UnsafeUrlError("missing host", "invalid_url")
    if port is not None and port in BLOCKED_PORTS and not allow_private:
        raise UnsafeUrlError(f"port {port} is not allowed")
    if allow_private:
        return url
    try:
        ipaddress.ip_address(host)
        is_literal = True
    except ValueError:
        is_literal = False
    if is_literal:
        if not is_public_ip(host):
            raise UnsafeUrlError("IP address is not publicly routable")
    else:
        if "." not in host or host in BLOCKED_HOSTS or host.endswith(BLOCKED_SUFFIXES):
            raise UnsafeUrlError("internal hostname")
        if re.fullmatch(r"[0-9.x]+", host):
            raise UnsafeUrlError("ambiguous numeric host")
    return url


async def resolve_public(host: str, port: int, *, allow_private: bool = False) -> list[str]:
    """Resolve `host` and return only if EVERY answer is public (a mixed answer is treated as hostile)."""
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"cannot resolve {host}", "network_error") from exc
    addresses: list[str] = []
    for _family, _type, _proto, _canon, sockaddr in infos:
        ip = str(sockaddr[0])
        if not is_public_ip(ip, allow_private=allow_private):
            raise UnsafeUrlError(f"{host} resolves to a non-public address")
        if ip not in addresses:
            addresses.append(ip)
    if not addresses:
        raise UnsafeUrlError(f"cannot resolve {host}", "network_error")
    return addresses


def safe_env(proxy_url: str | None = None, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Minimal environment for child processes: no secrets, traffic forced through the policy proxy."""
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),  # noqa: S108
        "LANG": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    for key in ("SYSTEMROOT", "TEMP", "TMP", "TMPDIR"):  # Windows needs these (tests)
        if key in os.environ:
            env[key] = os.environ[key]
    if proxy_url:
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            env[key] = proxy_url
        env["NO_PROXY"] = ""
        env["no_proxy"] = ""
    if extra:
        env.update(extra)
    return env


async def open_through_proxy(proxy_url: str, host: str, port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Open a TCP tunnel to host:port through a SOCKS5 (remote DNS) or HTTP-CONNECT proxy."""
    u = urlsplit(proxy_url)
    if not u.hostname or not u.port:
        raise ValueError(f"invalid proxy URL {proxy_url!r}")
    if u.scheme.lower() not in ("socks5", "socks5h", "http", "https"):
        raise ValueError(f"unsupported proxy scheme {u.scheme!r}")
    reader, writer = await asyncio.open_connection(u.hostname, u.port)
    try:
        if u.scheme.lower() in ("socks5", "socks5h"):
            writer.write(b"\x05\x01\x00")  # version 5, one method: no authentication
            await writer.drain()
            if await reader.readexactly(2) != b"\x05\x00":
                raise ConnectionError("SOCKS5 proxy requires authentication or refused the handshake")
            name = host.encode("idna")
            try:
                packed = ipaddress.ip_address(host).packed
                request = b"\x05\x01\x00" + (b"\x01" if len(packed) == 4 else b"\x04") + packed
            except ValueError:
                request = b"\x05\x01\x00\x03" + bytes([len(name)]) + name
            writer.write(request + port.to_bytes(2, "big"))
            await writer.drain()
            head = await reader.readexactly(4)
            if head[1] != 0:
                raise ConnectionError(f"SOCKS5 connect failed (code {head[1]})")
            atyp = head[3]
            skip = 4 if atyp == 1 else 16 if atyp == 4 else (await reader.readexactly(1))[0]
            await reader.readexactly(skip + 2)
        elif u.scheme.lower() in ("http", "https"):
            target = f"{host}:{port}" if ":" not in host else f"[{host}]:{port}"
            writer.write(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode("latin-1"))
            await writer.drain()
            response = await reader.readuntil(b"\r\n\r\n")
            status_line = response.split(b"\r\n", 1)[0]
            if b" 200" not in status_line:
                raise ConnectionError(f"HTTP proxy refused CONNECT: {status_line[:60]!r}")
        else:
            raise ValueError(f"unsupported proxy scheme {u.scheme!r}")
    except BaseException:
        with contextlib.suppress(Exception):
            writer.close()
        raise
    return reader, writer


@dataclass
class ProxyStats:
    allowed: int = 0
    blocked: int = 0
    active: int = 0


class PolicyProxy:
    """Minimal HTTP/HTTPS forward proxy that only connects to public IP addresses.

    Supports `CONNECT host:port` (HTTPS, tunnelled without interception) and absolute-form HTTP
    requests (`GET http://host/path`). Every connection re-resolves and re-validates the target.
    """

    MAX_CONNECTIONS = 256
    IDLE_TIMEOUT = 300.0

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 3128,
        *,
        allow_private: bool = False,
        upstream: str | None = None,
    ):
        """`upstream` (self-hosted engine only): chain every connection through this SOCKS5/HTTP proxy, e.g. when the
        sites you download from are blocked on your own network. The upstream proxy then resolves hostnames, so the
        resolve-and-vet step cannot run locally; hostname rules and literal-IP checks still apply, and because the
        traffic leaves through the remote proxy your local network is not reachable from it."""
        self.host = host
        self.port = port
        self.allow_private = allow_private
        self.upstream = upstream
        self.stats = ProxyStats()
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, self.host, self.port)
        self.port = self._server.sockets[0].getsockname()[1]
        log.info("policy proxy listening on %s:%s", self.host, self.port)
        return self.port

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    # -- connection handling -------------------------------------------------------------
    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self.stats.active >= self.MAX_CONNECTIONS:
            await self._reply(writer, 503, "proxy busy")
            return
        self.stats.active += 1
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=30)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            self.stats.active -= 1
            await self._close(writer)
            return
        try:
            await self._dispatch(head, reader, writer)
        except Exception:  # noqa: BLE001
            log.debug("proxy connection error", exc_info=True)
        finally:
            self.stats.active -= 1
            await self._close(writer)

    async def _dispatch(self, head: bytes, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        lines = head.split(b"\r\n")
        try:
            method, target, version = lines[0].decode("latin-1").split(" ", 2)
        except ValueError:
            await self._reply(writer, 400, "bad request")
            return

        if method.upper() == "CONNECT":
            host, _, port_s = target.rpartition(":")
            host = host.strip("[]")
            try:
                port = int(port_s)
            except ValueError:
                await self._reply(writer, 400, "bad port")
                return
            upstream = await self._open(host, port, writer)
            if upstream is None:
                return
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            await self._pipe(reader, writer, *upstream)
            return

        # absolute-form plain HTTP request
        try:
            parts = urlsplit(target)
            host = parts.hostname or ""
            port = parts.port or 80
        except ValueError:
            await self._reply(writer, 400, "bad target")
            return
        if parts.scheme != "http" or not host:
            await self._reply(writer, 400, "only absolute http:// targets or CONNECT are supported")
            return
        upstream = await self._open(host, port, writer)
        if upstream is None:
            return
        u_reader, u_writer = upstream
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        out = [f"{method} {path} {version}".encode("latin-1")]
        for line in lines[1:]:
            if not line:
                continue
            name = line.split(b":", 1)[0].strip().lower()
            if name in (b"proxy-connection", b"connection", b"proxy-authorization"):
                continue
            out.append(line)
        out.append(b"Connection: close")
        u_writer.write(b"\r\n".join(out) + b"\r\n\r\n")
        await u_writer.drain()
        await self._pipe(reader, writer, u_reader, u_writer)

    async def _open(self, host: str, port: int, client: asyncio.StreamWriter):
        if port in BLOCKED_PORTS and not self.allow_private:
            self.stats.blocked += 1
            log.warning("proxy blocked %s:%s (port)", host, port)
            await self._reply(client, 403, "port not allowed")
            return None
        if self.upstream:
            return await self._open_via_upstream(host, port, client)
        try:
            addresses = await resolve_public(host, port, allow_private=self.allow_private)
        except UnsafeUrlError as exc:
            self.stats.blocked += 1
            log.warning("proxy blocked %s:%s (%s)", host, port, exc.reason)
            await self._reply(client, 403 if exc.code == "blocked_url" else 502, exc.reason)
            return None
        last: Exception | None = None
        for ip in addresses:  # connect to the vetted IP, never re-resolve
            try:
                upstream = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout=20)
                self.stats.allowed += 1
                return upstream
            except (OSError, TimeoutError) as exc:
                last = exc
        log.info("proxy cannot connect to %s:%s: %s", host, port, last)
        await self._reply(client, 502, "cannot connect to upstream")
        return None

    async def _open_via_upstream(self, host: str, port: int, client: asyncio.StreamWriter):
        """Connect through the configured upstream proxy. Rules that do not need DNS still apply."""
        try:
            validate_url(f"http://{host if ':' not in host else f'[{host}]'}:{port}/", allow_private=self.allow_private)
        except UnsafeUrlError as exc:
            self.stats.blocked += 1
            log.warning("proxy blocked %s:%s (%s)", host, port, exc.reason)
            await self._reply(client, 403, exc.reason)
            return None
        try:
            upstream = await asyncio.wait_for(open_through_proxy(self.upstream or "", host, port), timeout=30)
        except (OSError, TimeoutError, ValueError, ConnectionError) as exc:
            log.info("upstream proxy cannot reach %s:%s: %s", host, port, exc)
            await self._reply(client, 502, "cannot connect through the upstream proxy")
            return None
        self.stats.allowed += 1
        return upstream

    async def _pipe(self, c_reader, c_writer, u_reader, u_writer) -> None:
        async def pump(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
            try:
                while True:
                    chunk = await asyncio.wait_for(src.read(65536), timeout=self.IDLE_TIMEOUT)
                    if not chunk:
                        break
                    dst.write(chunk)
                    await dst.drain()
            except (OSError, TimeoutError, asyncio.IncompleteReadError):
                pass
            finally:
                with contextlib.suppress(Exception):
                    dst.close()

        await asyncio.gather(pump(c_reader, u_writer), pump(u_reader, c_writer))

    @staticmethod
    async def _reply(writer: asyncio.StreamWriter, status: int, message: str) -> None:
        body = message.encode()
        reason = {400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway", 503: "Service Unavailable"}.get(status, "Error")
        with contextlib.suppress(Exception):
            writer.write(
                f"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\n"
                f"Connection: close\r\n\r\n".encode() + body
            )
            await writer.drain()

    @staticmethod
    async def _close(writer: asyncio.StreamWriter) -> None:
        with contextlib.suppress(Exception):
            writer.close()
            await writer.wait_closed()

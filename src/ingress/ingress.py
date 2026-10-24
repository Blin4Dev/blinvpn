"""
edge-ingress — единственная дверь из туннеля edge → панель (BlinVPN 3.0).

Слушает только адрес панели в WireGuard (по умолчанию 10.213.0.1:8443) и пропускает
строго заданный набор запросов от edge-сервера:

  мини-апп   /api/app/*, /api/support/file/*         → api-public (127.0.0.1:8001)
  вебхуки    /platega, /cispay, … (из payments_config) → сервис вебхуков (127.0.0.1:5000)
  подписка   /api/sub/*, метаданные и конфиги страницы → Remnawave (127.0.0.1:3000)

Что делает с каждым запросом:
  • проверяет, что он из туннеля и с правильным токеном edge;
  • отбрасывает всё, чего нет в белом списке (путь, метод), и любые трюки с путями;
  • оставляет только нужные заголовки, IP клиента передаёт одним доверенным заголовком;
  • для страницы подписки сам подставляет токен Remnawave (на edge его нет);
  • тело вебхуков передаёт байт-в-байт (подписи платёжек считаются по сырому телу);
  • проверяет каждый ответ: если в нём адрес панели — ответ не уходит, в форум тревога.

Edge считается недоверенным: даже взломав его, нельзя попасть в /api/panel, БД или Remnawave.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import binascii
import hmac
import ipaddress
import json
import os
import re
import sys
import time
from typing import Optional

import httpx
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

_CORE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "core"))
_API = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
for _p in (_CORE, _API):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

import deploy  # noqa: E402


def _env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env(key, str(default)))
    except ValueError:
        return default


API_PUBLIC = _env("INGRESS_API_UPSTREAM", f"http://127.0.0.1:{_env('API_PUBLIC_PORT', '8001')}").rstrip("/")
WEBHOOK_UP = _env("INGRESS_WEBHOOK_UPSTREAM", f"http://127.0.0.1:{_env('WEBHOOK_PORT', '5000')}").rstrip("/")
REMNAWAVE_UP = _env("INGRESS_REMNAWAVE_UPSTREAM", _env("REMWAVE_PANEL_URL", "http://127.0.0.1:3000")).rstrip("/")
ALLOW_NET = _env("INGRESS_ALLOW_NET", _env("WG_NET", "10.213.0.0/24"))
MAX_CONCURRENCY = _env_int("INGRESS_MAX_CONCURRENCY", 256)
SCAN_LIMIT = _env_int("INGRESS_SCAN_LIMIT", 6 * 1024 * 1024)

BODY_LIMIT_APP = 1 * 1024 * 1024
BODY_LIMIT_UPLOAD = 55 * 1024 * 1024
BODY_LIMIT_HOOK = 64 * 1024
BODY_LIMIT_SUBPAGE = 32 * 1024  # заголовки браузера для subpage-config

try:
    _ALLOWED_NETS = [ipaddress.ip_network(n.strip(), strict=False) for n in ALLOW_NET.split(",") if n.strip()]
except ValueError:
    _ALLOWED_NETS = [ipaddress.ip_network("10.213.0.0/24")]


def _tokens() -> list[bytes]:
    raw = _env("EDGE_TOKENS") or _env("EDGE_TOKEN")
    return [t.strip().encode() for t in raw.split(",") if len(t.strip()) >= 32]


def _remnawave_token() -> str:
    return _env("REMNAWAVE_SUBPAGE_TOKEN") or _env("REMWAVE_API_KEY") or _env("REMNAWAVE_API_TOKEN")


_HOOKS_FALLBACK = ["2328", "cispay", "heleket", "lava", "paypalych", "platega", "rollypay", "wata", "yookassa"]


def _hook_paths() -> list[str]:
    return deploy.hook_paths() or _HOOKS_FALLBACK


HOOK_PATHS = set(_hook_paths())

# заголовки подписи каждой платёжки (тело — байт-в-байт)
HOOK_HEADERS: dict[str, tuple[str, ...]] = {
    "platega": ("x-merchantid", "x-secret"),
    "cispay": ("x-signature",),
    "wata": ("x-signature",),
    "rollypay": ("x-signature", "x-timestamp"),
    "lava": ("authorization", "signature"),
}

COMMON_REQ = ("accept", "accept-language", "content-type", "user-agent", "if-none-match")
APP_REQ = COMMON_REQ + ("authorization", "x-telegram-init-data", "x-app-session")

# подписка: все «свои» заголовки клиента (HWID и т.п.), кроме служебных/опасных
SUB_BLOCK_PREFIX = ("x-forwarded", "x-real-ip", "x-edge", "x-blin", "x-remnawave", "x-original", "x-rewrite",
                    "x-http-method", "x-api-key", "x-client-ip", "x-cluster-client-ip", "x-host", "x-proxy")
SUB_EXTRA = ("accept", "accept-language", "user-agent", "if-none-match")

RESP_DROP = {"server", "x-powered-by", "via", "connection", "keep-alive", "transfer-encoding", "te", "trailer",
             "upgrade", "proxy-authenticate", "proxy-authorization", "content-length", "content-encoding",
             "alt-svc", "x-xss-protection", "access-control-allow-origin", "access-control-allow-credentials",
             "access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers",
             "strict-transport-security", "set-cookie"}
# ответу api-public можно ставить cookie? — нет: авторизация мини-аппа в заголовках
RESP_KEEP_X = {"x-content-type-options", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"}

_TOKEN_RE = r"[A-Za-z0-9_-]{4,128}"
_UUID_RE = r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"


class Rule:
    __slots__ = ("site", "rx", "methods", "upstream", "limit", "timeout", "stream", "auth", "get_body")

    def __init__(self, site: str, rx: str, methods: tuple[str, ...], upstream: str, limit: int,
                 timeout: float, stream: bool = False, auth: str = "", get_body: bool = False) -> None:
        self.site = site
        self.rx = re.compile(rx)
        self.methods = methods
        self.upstream = upstream
        self.limit = limit
        self.timeout = timeout
        self.stream = stream
        self.auth = auth  # sub: "strip" | "inject"
        # GET с JSON-телом (так устроен subpage-config в Remnawave 3.4: {"requestHeaders": {...}})
        self.get_body = get_body


def _rules() -> list[Rule]:
    hooks = "|".join(sorted(re.escape(h) for h in HOOK_PATHS))
    return [
        Rule("app", r"^/api/app/support/upload$", ("POST",), API_PUBLIC, BODY_LIMIT_UPLOAD, 300.0),
        Rule("app", r"^/api/app(?:/[A-Za-z0-9_-]+){1,6}$", ("GET", "POST", "PUT", "DELETE"), API_PUBLIC,
             BODY_LIMIT_APP, 60.0),
        Rule("file", r"^/api/support/file/[A-Za-z0-9_-]{1,128}$", ("GET",), API_PUBLIC, 0, 120.0, stream=True),
        Rule("hook", rf"^/(?:{hooks})$", ("POST",), WEBHOOK_UP, BODY_LIMIT_HOOK, 9.0),
        Rule("sub", rf"^/api/sub/{_TOKEN_RE}(?:/[A-Za-z0-9_-]{{1,32}})?$", ("GET",), REMNAWAVE_UP, 0, 25.0,
             auth="strip"),
        Rule("sub", r"^/api/system/metadata$", ("GET",), REMNAWAVE_UP, 0, 15.0, auth="inject"),
        Rule("sub", rf"^/api/subscription-page-configs(?:/|/{_UUID_RE})?$", ("GET",), REMNAWAVE_UP, 0, 15.0,
             auth="inject"),
        Rule("sub", rf"^/api/subscriptions/subpage-config/{_TOKEN_RE}$", ("GET",), REMNAWAVE_UP,
             BODY_LIMIT_SUBPAGE, 15.0, auth="inject", get_body=True),
    ]


RULES = _rules()
_BAD_PATH = re.compile(r"(?:\.\.|//|\\|%|;|\x00|[\x00-\x1f\x7f])")
_BAD_QUERY = re.compile(r"[\x00-\x1f\x7f]")

_client: Optional[httpx.AsyncClient] = None
_sem: Optional[asyncio.Semaphore] = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=5.0),
            limits=httpx.Limits(max_connections=MAX_CONCURRENCY, max_keepalive_connections=64,
                                keepalive_expiry=30.0),
            follow_redirects=False, trust_env=False, http2=False,
        )
    return _client


def _semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(MAX_CONCURRENCY)
    return _sem


def _log(msg: str) -> None:
    print(f"[ingress] {msg}", flush=True)


def _json(status: int, message: str, maintenance: str = "") -> JSONResponse:
    body: dict = {"detail": {"message": message}, "error": message}
    if maintenance:
        # метка для мини-аппа: панель недоступна → страница техработ
        body["maintenance"] = maintenance
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


def _peer_ok(request: Request) -> bool:
    peer = request.client.host if request.client else ""
    try:
        ip = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(ip in net for net in _ALLOWED_NETS)


def _token_ok(request: Request) -> bool:
    given = (request.headers.get("x-edge-token") or request.headers.get("x-api-key") or "").strip().encode()
    if not given:
        return False
    ok = False
    for t in _tokens():
        ok = hmac.compare_digest(given, t) or ok
    return ok


def _client_ip(request: Request) -> str:
    for key in ("x-blin-client-ip", "x-remnawave-real-ip", "x-real-ip"):
        v = (request.headers.get(key) or "").split(",")[0].strip()
        try:
            return str(ipaddress.ip_address(v))
        except ValueError:
            continue
    return request.client.host if request.client else ""


def _match(path: str, method: str) -> tuple[Optional[Rule], bool]:
    """(правило, путь известен). Путь известен, но метод не тот → 405."""
    known = False
    for r in RULES:
        if r.rx.fullmatch(path):
            known = True
            if method in r.methods:
                return r, True
    return None, known


def _req_headers(request: Request, rule: Rule, path: str, client_ip: str) -> dict[str, str]:
    h = request.headers
    out: dict[str, str] = {}
    if rule.site in ("app", "file"):
        for k in APP_REQ:
            v = h.get(k)
            if v is not None:
                out[k] = v
    elif rule.site == "hook":
        name = path.lstrip("/")
        for k in COMMON_REQ + HOOK_HEADERS.get(name, ()):
            v = h.get(k)
            if v is not None:
                out[k] = v
    else:  # sub
        for k, v in h.items():
            lk = k.lower()
            if lk in SUB_EXTRA or (lk.startswith("x-") and not lk.startswith(SUB_BLOCK_PREFIX)):
                out[lk] = v
        if rule.auth == "inject":
            tok = _remnawave_token()
            if tok:
                out["authorization"] = f"Bearer {tok}"
        sub_host = deploy.host_of(deploy.sub_url())
        if sub_host:
            out["host"] = sub_host
        out["x-forwarded-for"] = client_ip
        out["x-remnawave-real-ip"] = client_ip
    out["x-real-ip"] = client_ip
    out["x-forwarded-proto"] = "https"
    return out


def _looks_base64(body: bytes) -> bool:
    if len(body) < 16 or len(body) % 4 != 0 or len(body) > SCAN_LIMIT:
        return False
    return re.fullmatch(rb"[A-Za-z0-9+/=\r\n]+", body) is not None


def _scan(body: bytes, content_type: str) -> Optional[str]:
    ct = (content_type or "").lower()
    textual = (not ct or ct.startswith("text/") or "json" in ct or "yaml" in ct or "xml" in ct
               or "javascript" in ct or "x-www-form-urlencoded" in ct or "octet-stream" in ct)
    if not textual or len(body) > SCAN_LIMIT:
        return None
    found = deploy.contains_leak(body)
    if found:
        return found
    if _looks_base64(body.strip()):
        try:
            dec = base64.b64decode(body.strip(), validate=False)
        except (binascii.Error, ValueError):
            dec = b""
        if dec:
            return deploy.contains_leak(dec)
    return None


def _resp_headers(upstream: httpx.Headers, site: str = "app") -> tuple[list[tuple[str, str]], Optional[str]]:
    out: list[tuple[str, str]] = []
    for k, v in upstream.multi_items():
        lk = k.lower()
        if lk in RESP_DROP:
            continue
        if lk.startswith("x-") and lk not in RESP_KEEP_X:
            # подписке клиенты читают свои x-заголовки (HWID и т.п.) — их оставляем
            if site != "sub" or lk.startswith(("x-powered", "x-upstream", "x-backend", "x-server", "x-runtime",
                                                 "x-request-id", "x-amzn", "x-envoy", "x-forwarded")):
                continue
        found = deploy.contains_leak(v)
        if found:
            return [], found
        out.append((lk, v))
    return out, None


def _leak_blocked(path: str, found: str) -> JSONResponse:
    _log(f"УТЕЧКА ЗАБЛОКИРОВАНА: {path} содержит {deploy.mask(found)}")
    deploy.alert(f"leak:{path[:40]}", "🚨 Утечка адреса панели заблокирована",
                 f"Ответ на {path} содержал адрес панели ({deploy.mask(found)}) и не был отправлен пользователю. "
                 "Найдите, откуда он взялся (настройки Remnawave, тексты, хосты).", every=600)
    return _json(503, "Сервис временно недоступен. Попробуйте позже")


async def _read_body(request: Request, limit: int) -> Optional[bytes]:
    cl = request.headers.get("content-length")
    if cl:
        try:
            if int(cl) > limit:
                return None
        except ValueError:
            return None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


async def proxy(request: Request) -> Response:
    if not _peer_ok(request):
        return _json(403, "Forbidden")
    if not _token_ok(request):
        deploy.alert("edge_auth_fail", "edge-ingress: запрос с неверным токеном",
                     f"из туннеля пришёл запрос без правильного токена edge (peer {request.client.host if request.client else '?'})",
                     every=600)
        return _json(403, "Forbidden")

    raw = request.scope.get("raw_path") or b""
    raw_path = raw.decode("latin-1") if isinstance(raw, (bytes, bytearray)) else str(raw)
    raw_path = raw_path.split("?", 1)[0]
    path = request.url.path
    if raw_path != path or _BAD_PATH.search(raw_path) or len(raw_path) > 512:
        return _json(400, "Bad request")
    query = request.url.query or ""
    if len(query) > 4096 or _BAD_QUERY.search(query):
        return _json(400, "Bad request")

    method = request.method.upper()
    if method == "GET" and path.lstrip("/") in HOOK_PATHS:
        return JSONResponse({"ok": True})  # проба адреса платёжкой
    rule, known = _match(path, method)
    if rule is None:
        return _json(405 if known else 404, "Method not allowed" if known else "Not found")

    body = b""
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        got = await _read_body(request, rule.limit or BODY_LIMIT_APP)
        if got is None:
            return _json(413, "Слишком большой запрос")
        body = got
    elif rule.get_body:
        got = await _read_body(request, rule.limit)
        if got is None:
            return _json(413, "Слишком большой запрос")
        if got.strip():
            # пропускаем только JSON-объект — Remnawave всё равно проверит схему, но мусор до неё не дойдёт
            try:
                doc = json.loads(got)
            except ValueError:
                return _json(400, "Bad request")
            if not isinstance(doc, dict):
                return _json(400, "Bad request")
            body = got

    client_ip = _client_ip(request)
    headers = _req_headers(request, rule, path, client_ip)
    if body and rule.get_body:
        headers["content-type"] = "application/json"
    url = rule.upstream + path + (f"?{query}" if query else "")
    sem = _semaphore()
    try:
        await asyncio.wait_for(sem.acquire(), timeout=5.0)
    except asyncio.TimeoutError:
        return _json(503, "Сервер перегружен, попробуйте через минуту")
    released = False
    try:
        cli = _http()
        if rule.stream:
            req = cli.build_request(method, url, headers=headers, content=body or None,
                                    timeout=httpx.Timeout(rule.timeout, connect=5.0))
            up = await cli.send(req, stream=True)
            # семафор держим только до заголовков: скачивание файла не занимает слот
            released = True
            sem.release()
            hdrs, found = _resp_headers(up.headers, rule.site)
            if found:
                await up.aclose()
                return _leak_blocked(path, found)

            async def _iter():
                try:
                    async for chunk in up.aiter_raw():
                        yield chunk
                finally:
                    await up.aclose()

            ce = up.headers.get("content-encoding")
            if ce:
                hdrs.append(("content-encoding", ce))
            cl = up.headers.get("content-length")
            if cl and not ce:
                hdrs.append(("content-length", cl))
            resp = StreamingResponse(_iter(), status_code=up.status_code, background=BackgroundTask(up.aclose))
            resp.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in hdrs]
            return resp

        up = await cli.request(method, url, headers=headers, content=body or None,
                               timeout=httpx.Timeout(rule.timeout, connect=5.0))
        data = up.content
        hdrs, found = _resp_headers(up.headers, rule.site)
        if not found:
            found = _scan(data, up.headers.get("content-type", ""))
        if found:
            return _leak_blocked(path, found)
        resp = Response(content=data, status_code=up.status_code)
        resp.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in hdrs] + \
            [(b"content-length", str(len(data)).encode())]
        return resp
    except httpx.TimeoutException:
        return _json(504, "Сервис не ответил вовремя")
    except httpx.HTTPError as exc:
        _log(f"{method} {path}: {type(exc).__name__}")
        if rule.site == "app" and isinstance(exc, (httpx.ConnectError, httpx.RemoteProtocolError)):
            # api-public не запущен/перезапускается: для мини-аппа это техработы
            return _json(503, "Идут технические работы. Попробуйте позже", maintenance="down")
        return _json(502, "Сервис временно недоступен")
    finally:
        if not released:
            sem.release()


async def health(request: Request) -> Response:
    """для edge-agent: дверь жива (с токеном). Без адресов и версий апстримов."""
    if not _peer_ok(request) or not _token_ok(request):
        return _json(403, "Forbidden")
    return JSONResponse({"ok": True, "protocol": deploy.EDGE_PROTOCOL, "version": deploy.VERSION,
                         "time": int(time.time())})


async def leaktest(request: Request) -> Response:
    """самопроверка сканера: тело с адресом панели обязано превратиться в 503."""
    if not _peer_ok(request) or not _token_ok(request):
        return _json(403, "Forbidden")
    toks = deploy.leak_tokens()
    if not toks:
        return JSONResponse({"ok": False, "error": "чёрный список пуст (LEAK_GUARD_IPS / PANEL_DOMAIN)"}, status_code=500)
    probe = f'{{"probe": "{toks[0]}"}}'.encode()
    found = _scan(probe, "application/json")
    return JSONResponse({"ok": bool(found), "tokens": len(toks)})


@contextlib.asynccontextmanager
async def _lifespan(_app):
    yield
    if _client is not None:
        await _client.aclose()


app = Starlette(
    routes=[
        Route("/__ingress/health", health, methods=["GET"]),
        Route("/__ingress/leaktest", leaktest, methods=["GET"]),
        Route("/{path:path}", proxy, methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    ],
    lifespan=_lifespan,
)

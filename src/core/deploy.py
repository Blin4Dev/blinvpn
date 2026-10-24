"""
Разделённая установка BlinVPN 3.0 (панель + edge) — общие правила для всех сервисов панели.

  • режим и роль процесса API (panel / public);
  • публичные адреса (мини-апп, подписка, вебхуки) — только домены edge;
  • реальный IP клиента — только из доверенного заголовка от своего прокси;
  • leakguard — «чёрный список» адресов панели: они не должны попасть пользователю;
  • клиент edge-agent (команды панели на edge по туннелю, HMAC-подпись).

Модуль без зависимостей от core.py: его импортируют core, вебхуки, бот, ingress.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable, Optional

VERSION = "3.0.1"
EDGE_PROTOCOL = 1  # версия протокола panel ↔ edge (ingress, agent)


def _env(*keys: str, default: str = "") -> str:
    for k in keys:
        v = (os.getenv(k) or "").strip()
        if v:
            return v
    return default


# ── режим и роль ─────────────────────────────────────────────────

def is_split() -> bool:
    """панель и пользовательская часть на разных серверах (BlinVPN 3.0)."""
    return _env("DEPLOY_MODE").lower() == "split"


ROLES = ("panel", "public", "all")


def api_role() -> str:
    """
    роль процесса API:
      panel  — /api/panel/*, /api/internal/*, все фоновые задачи (сервер панели, 127.0.0.1:8000);
      public — только /api/app/* и вложения поддержки (за edge-ingress, 127.0.0.1:8001);
      all    — всё сразу (старая установка на одном сервере).
    неизвестное значение — ошибка (fail-closed), чтобы опечатка не открыла лишнее.
    """
    role = _env("API_ROLE", default="all").lower()
    if role not in ROLES:
        raise RuntimeError(f"API_ROLE={role!r}: допустимо panel, public или all")
    if is_split() and role == "all":
        raise RuntimeError("DEPLOY_MODE=split: задайте API_ROLE=panel или API_ROLE=public")
    return role


# ── публичные адреса ─────────────────────────────────────────────

def _norm_base(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if url and not re.match(r"^https?://", url):
        url = "https://" + url
    return url


def app_url() -> str:
    """мини-апп (https://app.example.com)."""
    return _norm_base(_env("MINIAPP_URL"))


def sub_url() -> str:
    """база ссылок подписки (https://sub.example.com) — то же, что SUB_PUBLIC_DOMAIN в Remnawave."""
    return _norm_base(_env("REMWAVE_SUB_PUBLIC_URL", "PUBLIC_SUB_URL"))


def webhook_url() -> str:
    """база вебхуков платёжек (https://hook.example.net)."""
    url = _env("WEBHOOK_URL", "PUBLIC_WEBHOOK_URL")
    if not url and not is_split():
        # старая установка: вебхуки на домене мини-аппа
        dom = _env("WEBHOOK_DOMAIN", "MINIAPP_DOMAIN")
        url = f"https://{dom}" if dom else ""
    return _norm_base(url)


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def public_sub_link(short_uuid: str, given: Optional[str] = None) -> Optional[str]:
    """
    ссылка подписки для пользователя. Готовую ссылку Remnawave берём, только если её хост —
    публичный домен подписки (edge). Иначе собираем сами из REMWAVE_SUB_PUBLIC_URL.
    Никогда не строим ссылку из адреса панели Remnawave.
    """
    base = sub_url()
    if given:
        g = str(given).strip()
        if base and host_of(g) == host_of(base) and g.lower().startswith("https://") and not contains_leak(g):
            return g
        if not base and not is_split() and not contains_leak(g):
            return g  # старая установка без REMWAVE_SUB_PUBLIC_URL: как раньше
        _warn_once("sub_host", "Ссылка подписки от Remnawave не на домене подписки",
                   f"Remnawave вернул ссылку с хостом «{host_of(g) or '?'}», ожидался «{host_of(base) or '—'}». "
                   "Проверьте SUB_PUBLIC_DOMAIN в .env Remnawave. Ссылка пересобрана из REMWAVE_SUB_PUBLIC_URL.")
    short = str(short_uuid or "").strip()
    if not base or not re.fullmatch(r"[A-Za-z0-9_-]{4,128}", short):
        return None
    return f"{base}/{short}"


def validate_public_urls() -> list[str]:
    """проблемы конфигурации публичных адресов (пустой список — всё в порядке)."""
    problems: list[str] = []
    panel_hosts = {h for h in (host_of(_norm_base(_env("PANEL_URL"))), _env("PANEL_DOMAIN").lower()) if h}
    items = {"MINIAPP_URL": app_url(), "REMWAVE_SUB_PUBLIC_URL": sub_url(), "WEBHOOK_URL": webhook_url()}
    for name, url in items.items():
        if not url:
            if is_split():
                problems.append(f"{name} не задан")
            continue
        h = host_of(url)
        if not url.startswith("https://"):
            problems.append(f"{name}: нужен https://")
        if not h:
            problems.append(f"{name}: неверный адрес")
            continue
        for ph in panel_hosts:
            if h == ph or h.endswith("." + ph) or ph.endswith("." + h):
                problems.append(f"{name} ({h}) совпадает с доменом панели или связан с ним")
        leak = contains_leak(url)
        if leak:
            problems.append(f"{name} содержит адрес панели ({mask(leak)})")
    if is_split():
        a, s = host_of(app_url()), host_of(sub_url())
        if a and s and a == s:
            problems.append("домен подписки должен отличаться от домена мини-аппа")
    return problems


# ── реальный IP клиента ──────────────────────────────────────────

def _valid_ip(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    try:
        return str(ipaddress.ip_address(v))
    except ValueError:
        return ""


def _is_loopback(peer: str) -> bool:
    try:
        return ipaddress.ip_address((peer or "").strip()).is_loopback
    except ValueError:
        return False


def trusted_client_ip(headers: Any, peer: str) -> str:
    """
    реальный IP клиента.
      • Верим ТОЛЬКО заголовку X-Real-IP и только если запрос пришёл от своего прокси
        с 127.0.0.1 (nginx панели или edge-ingress). Оба прокси перезаписывают X-Real-IP.
      • CF-Connecting-IP / True-Client-IP / X-Forwarded-For от клиента игнорируются:
        их может подделать кто угодно (обход лимитов, бана по IP, капчи).
      • TRUST_CLOUDFLARE=1 — только для старой установки за Cloudflare.
    """
    get = headers.get if hasattr(headers, "get") else (lambda *_: None)
    if _is_loopback(peer):
        if _env("TRUST_CLOUDFLARE") in ("1", "true", "yes") and not is_split():
            ip = _valid_ip(str(get("cf-connecting-ip") or ""))
            if ip:
                return ip
        ip = _valid_ip(str(get("x-real-ip") or ""))
        if ip:
            return ip
    return _valid_ip(peer) or (peer or "")


# ── leakguard ────────────────────────────────────────────────────

_leak_lock = threading.Lock()
_leak_cache: dict[str, Any] = {"at": 0.0, "tokens": (), "rx": None}


def _split_list(raw: str) -> list[str]:
    return [x.strip().lower() for x in re.split(r"[,\s]+", raw or "") if x.strip()]


def leak_tokens() -> tuple[str, ...]:
    """строки, которых не должно быть ни в одном ответе пользователю (адреса панели)."""
    now = time.time()
    with _leak_lock:
        if _leak_cache["rx"] is not None and now - _leak_cache["at"] < 60:
            return _leak_cache["tokens"]
        toks: set[str] = set()
        for v in _split_list(_env("LEAK_GUARD_IPS")) + _split_list(_env("LEAK_GUARD_EXTRA")):
            toks.add(v)
        for key in ("PANEL_DOMAIN", "REMNAWAVE_UI_DOMAIN"):
            v = _env(key).lower()
            if v:
                toks.add(v)
        ph = host_of(_norm_base(_env("PANEL_URL")))
        if ph:
            toks.add(ph)
        rw = _env("REMWAVE_PANEL_URL", "REMNAWAVE_PANEL_URL")
        rh = host_of(rw)
        # внутренний адрес Remnawave (localhost/127.0.0.1) тоже не должен уйти наружу —
        # но только вместе с портом, чтобы не ловить слово «localhost» в тексте
        if rw:
            p = urllib.parse.urlsplit(rw)
            if p.hostname and p.port:
                toks.add(f"{p.hostname.lower()}:{p.port}")
            elif rh and rh not in ("localhost", "127.0.0.1", "remnawave"):
                toks.add(rh)
        toks.discard("")
        # слишком короткие строки дадут ложные срабатывания
        toks = {t for t in toks if len(t) >= 4}
        ordered = tuple(sorted(toks, key=len, reverse=True))
        if ordered:
            # граница: адрес не должен быть частью более длинного имени/числа
            parts = [re.escape(t) for t in ordered]
            rx = re.compile(r"(?<![A-Za-z0-9.-])(?:" + "|".join(parts) + r")(?![A-Za-z0-9-]|\.[A-Za-z0-9])",
                            re.IGNORECASE)
        else:
            rx = re.compile(r"(?!x)x")  # ничего не совпадает
        _leak_cache.update(at=now, tokens=ordered, rx=rx)
        return ordered


def reset_leak_cache() -> None:
    with _leak_lock:
        _leak_cache.update(at=0.0, tokens=(), rx=None)


def contains_leak(text: Any) -> Optional[str]:
    """найденный адрес панели или None."""
    if text is None:
        return None
    if isinstance(text, (bytes, bytearray)):
        s = bytes(text).decode("utf-8", "replace")
    elif isinstance(text, str):
        s = text
    else:
        try:
            s = json.dumps(text, ensure_ascii=False)
        except (TypeError, ValueError):
            s = str(text)
    leak_tokens()
    rx = _leak_cache["rx"]
    if rx is None:
        return None
    m = rx.search(s)
    if m:
        return m.group(0)
    if "%" in s:
        try:
            dec = urllib.parse.unquote(s)
        except Exception:  # noqa: BLE001
            dec = s
        if dec != s:
            m = rx.search(dec)
            if m:
                return m.group(0)
    return None


def mask(v: str) -> str:
    v = str(v or "")
    if len(v) <= 4:
        return "***"
    return v[:2] + "…" + v[-2:]


class LeakError(ValueError):
    def __init__(self, field: str, found: str) -> None:
        super().__init__(f"{field}: адрес панели в тексте")
        self.field = field
        self.found = found


def assert_clean(field: str, *values: Any) -> None:
    """для контента, который увидят пользователи (рассылки, ответы поддержки, оферта)."""
    for v in values:
        found = contains_leak(v)
        if found:
            raise LeakError(field, found)


# ── тревоги без спама ────────────────────────────────────────────

_warned: dict[str, float] = {}


def _warn_once(key: str, title: str, details: str, every: float = 3600.0) -> None:
    now = time.time()
    if now - _warned.get(key, 0.0) < every:
        return
    _warned[key] = now
    print(f"[deploy] {title}: {details}", flush=True)
    try:
        try:
            from . import forum  # type: ignore
        except ImportError:
            import forum  # type: ignore
        forum.report_error(title, details)
    except Exception:  # noqa: BLE001
        pass


def alert(key: str, title: str, details: str, every: float = 3600.0) -> None:
    _warn_once(key, title, details, every)


# ── edge-agent (команды панели на edge через туннель) ───────────

class EdgeError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def agent_url() -> str:
    return _env("EDGE_AGENT_URL").rstrip("/")


def agent_key() -> str:
    return _env("EDGE_AGENT_KEY")


def edge_configured() -> bool:
    return bool(is_split() and agent_url() and agent_key())


def sign(key: str, method: str, path: str, ts: str, nonce: str, body: bytes) -> str:
    msg = "\n".join([method.upper(), path, ts, nonce, hashlib.sha256(body).hexdigest()]).encode()
    return hmac.new(key.encode(), msg, hashlib.sha256).hexdigest()


def agent_call(method: str, path: str, body: Optional[Any] = None, *, raw: Optional[bytes] = None,
               headers: Optional[dict[str, str]] = None, timeout: float = 15.0,
               expect_json: bool = True) -> Any:
    """подписанный запрос к edge-agent. Ответ JSON (или (status, headers, bytes) при expect_json=False)."""
    if not edge_configured():
        raise EdgeError("Edge-сервер не подключён (DEPLOY_MODE=split, EDGE_AGENT_URL, EDGE_AGENT_KEY)", 503)
    if raw is None:
        raw = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
    ts = str(int(time.time()))
    nonce = secrets.token_hex(12)
    sig = sign(agent_key(), method, path, ts, nonce, raw)
    h = {"X-Blin-Ts": ts, "X-Blin-Nonce": nonce, "X-Blin-Sig": sig, "X-Blin-Proto": str(EDGE_PROTOCOL)}
    if raw and "Content-Type" not in (headers or {}):
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(agent_url() + path, data=raw if method.upper() != "GET" else None,
                                 method=method.upper(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — адрес из .env (туннель)
            data = resp.read(8 * 1024 * 1024)
            if not expect_json:
                return resp.status, dict(resp.headers), data
            return json.loads(data.decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        data = e.read(65536) if e.fp else b""
        if not expect_json:
            return e.code, dict(e.headers or {}), data
        msg = ""
        try:
            msg = str((json.loads(data.decode("utf-8")) or {}).get("error") or "")
        except Exception:  # noqa: BLE001
            msg = data.decode("utf-8", "replace")[:200]
        raise EdgeError(msg or f"edge-agent ответил {e.code}", e.code if e.code < 500 else 502) from e
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as e:
        raise EdgeError(f"Edge-сервер недоступен по туннелю: {getattr(e, 'reason', e)}", 503) from e
    except ValueError as e:
        raise EdgeError("edge-agent вернул неверный ответ", 502) from e


def hook_paths() -> list[str]:
    """пути вебхуков платёжек (из payments_config.SPECS) — общий источник для ingress и nginx edge."""
    try:
        try:
            from . import payments_config  # type: ignore
        except ImportError:
            import payments_config  # type: ignore
        out = []
        for spec in payments_config.SPECS.values():
            p = str(spec.get("webhook") or "").strip()
            if re.fullmatch(r"/[A-Za-z0-9_-]{1,32}", p):
                out.append(p.lstrip("/"))
        return sorted(set(out))
    except Exception:  # noqa: BLE001
        return []


def iter_nonempty(values: Iterable[Any]) -> list[str]:
    return [str(v) for v in values if v not in (None, "")]

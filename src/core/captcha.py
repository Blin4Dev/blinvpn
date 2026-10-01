# капча входа в мини-приложение: yandex smartcaptcha / cloudflare turnstile
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

SETTINGS_KEY = "captcha_config"
MODES = ("auto", "yandex", "turnstile")
YANDEX_VALIDATE = "https://smartcaptcha.yandexcloud.net/validate"
TURNSTILE_VALIDATE = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
GEO_TTL = 3600
_geo_cache: dict[str, tuple[float, str]] = {}


class CaptchaError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _crypto():
    try:
        from . import monitoring  # type: ignore
    except ImportError:  # pragma: no cover
        import monitoring  # type: ignore
    return monitoring


def get_config(with_secrets: bool = False) -> dict[str, Any]:
    raw = db.get_setting(SETTINGS_KEY, "") or ""
    try:
        cfg = json.loads(raw) if raw else {}
    except ValueError:
        cfg = {}
    mode = str(cfg.get("mode") or "auto").strip().lower()
    if mode not in MODES:
        mode = "auto"
    out: dict[str, Any] = {
        "enabled": bool(cfg.get("enabled")),
        "mode": mode,
        "yandex_site_key": str(cfg.get("yandex_site_key") or ""),
        "turnstile_site_key": str(cfg.get("turnstile_site_key") or ""),
        "has_yandex_secret": bool(cfg.get("yandex_secret_enc")),
        "has_turnstile_secret": bool(cfg.get("turnstile_secret_enc")),
    }
    if with_secrets:
        out["yandex_secret"] = _crypto().decrypt(cfg.get("yandex_secret_enc")) or ""
        out["turnstile_secret"] = _crypto().decrypt(cfg.get("turnstile_secret_enc")) or ""
    return out


def save_config(data: dict[str, Any]) -> dict[str, Any]:
    raw = db.get_setting(SETTINGS_KEY, "") or ""
    try:
        cur = json.loads(raw) if raw else {}
    except ValueError:
        cur = {}
    mode = str(data.get("mode") or cur.get("mode") or "auto").strip().lower()
    if mode not in MODES:
        raise CaptchaError("Режим: auto, yandex или turnstile")
    new = {
        "enabled": bool(data.get("enabled", cur.get("enabled"))),
        "mode": mode,
        "yandex_site_key": str(
            data.get("yandex_site_key") if data.get("yandex_site_key") is not None
            else cur.get("yandex_site_key") or ""
        ).strip(),
        "turnstile_site_key": str(
            data.get("turnstile_site_key") if data.get("turnstile_site_key") is not None
            else cur.get("turnstile_site_key") or ""
        ).strip(),
        "yandex_secret_enc": cur.get("yandex_secret_enc"),
        "turnstile_secret_enc": cur.get("turnstile_secret_enc"),
    }
    if data.get("yandex_secret"):
        new["yandex_secret_enc"] = _crypto().encrypt(str(data["yandex_secret"]).strip())
    if data.get("turnstile_secret"):
        new["turnstile_secret_enc"] = _crypto().encrypt(str(data["turnstile_secret"]).strip())

    if new["enabled"]:
        yandex_ok = bool(new["yandex_site_key"] and new["yandex_secret_enc"])
        turnstile_ok = bool(new["turnstile_site_key"] and new["turnstile_secret_enc"])
        if mode == "yandex" and not yandex_ok:
            raise CaptchaError("Для Яндекса укажите site key и секретный ключ")
        if mode == "turnstile" and not turnstile_ok:
            raise CaptchaError("Для Cloudflare Turnstile укажите site key и секретный ключ")
        if mode == "auto" and not (yandex_ok or turnstile_ok):
            raise CaptchaError("В режиме «авто» настройте хотя бы одного провайдера")

    db.set_setting(SETTINGS_KEY, json.dumps(new, ensure_ascii=False))
    return get_config()


def enabled() -> bool:
    return bool(get_config().get("enabled"))


def country_from_headers(headers: Any) -> str:
    """страна из заголовков cdn/nginx (без внешнего запроса)."""
    get = headers.get if hasattr(headers, "get") else (lambda *_: None)
    for key in ("cf-ipcountry", "CF-IPCountry", "x-geo-country", "X-Geo-Country",
                "x-country-code", "X-Country-Code", "cloudfront-viewer-country"):
        v = str(get(key) or "").strip().upper()
        if v and v not in ("XX", "T1", "ZZ", "A1", "A2"):
            return v
    return ""


def lookup_country(ip: str) -> str:
    """страна по ip (кэш); для режима auto без cf-заголовка."""
    ip = (ip or "").strip()
    if not ip or ip in ("127.0.0.1", "::1", "unknown"):
        return ""
    try:
        import ipaddress
        obj = ipaddress.ip_address(ip)
        if obj.is_private or obj.is_loopback or obj.is_link_local or obj.is_reserved:
            return ""
    except ValueError:
        return ""
    now = time.time()
    hit = _geo_cache.get(ip)
    if hit and hit[0] > now:
        return hit[1]
    code = ""
    try:
        url = f"http://ip-api.com/json/{urllib.parse.quote(ip)}?fields=status,countryCode"
        req = urllib.request.Request(url, headers={"User-Agent": "blinvpn/1.0"})
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace") or "{}")
        if data.get("status") == "success":
            code = str(data.get("countryCode") or "").strip().upper()
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        code = ""
    _geo_cache[ip] = (now + GEO_TTL, code)
    if len(_geo_cache) > 5000:
        dead = [k for k, (exp, _) in _geo_cache.items() if exp <= now]
        for k in dead[:1000]:
            _geo_cache.pop(k, None)
    return code


def _accept_lang_ru(headers: Any) -> bool:
    get = headers.get if hasattr(headers, "get") else (lambda *_: None)
    al = str(get("accept-language") or get("Accept-Language") or "").lower()
    if not al:
        return False
    # ru, ru-RU, ru-ru;q=0.9 …
    primary = al.split(",")[0].split(";")[0].strip()
    return primary == "ru" or primary.startswith("ru-")


def resolve_provider(headers: Any, ip: str = "") -> Optional[str]:
    """какой провайдер показать/проверить: yandex | turnstile | None."""
    cfg = get_config(with_secrets=True)
    if not cfg["enabled"]:
        return None
    mode = cfg["mode"]
    yandex_ok = bool(cfg["yandex_site_key"] and cfg.get("yandex_secret"))
    turnstile_ok = bool(cfg["turnstile_site_key"] and cfg.get("turnstile_secret"))

    if mode == "yandex":
        return "yandex" if yandex_ok else None
    if mode == "turnstile":
        return "turnstile" if turnstile_ok else None

    # auto: рф → яндекс, остальные → turnstile; без гео — по языку браузера
    country = country_from_headers(headers) or lookup_country(ip)
    if country == "RU" or (not country and _accept_lang_ru(headers)):
        if yandex_ok:
            return "yandex"
        # turnstile в рф часто не грузится — только если яндекса нет
        return "turnstile" if turnstile_ok else None
    if country and country != "RU":
        if turnstile_ok:
            return "turnstile"
        return "yandex" if yandex_ok else None
    # страна неизвестна и язык не ru: предпочитаем яндекс (turnstile в рф часто пустой)
    if yandex_ok:
        return "yandex"
    return "turnstile" if turnstile_ok else None


def public_config(headers: Any, ip: str = "") -> dict[str, Any]:
    """поля для /api/app/config (без секретов)."""
    cfg = get_config()
    if not cfg["enabled"]:
        return {"enabled": False}
    provider = resolve_provider(headers, ip)
    if not provider:
        return {"enabled": False}
    site_key = cfg["yandex_site_key"] if provider == "yandex" else cfg["turnstile_site_key"]
    if not site_key:
        return {"enabled": False}
    return {"enabled": True, "provider": provider, "siteKey": site_key}


def _post_form(url: str, fields: dict[str, str], timeout: float = 8.0) -> dict[str, Any]:
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded",
                                          "User-Agent": "blinvpn/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace") or "{}")


def verify(token: str, headers: Any, ip: str = "") -> None:
    """проверка токена; no-op если капча выключена."""
    provider = resolve_provider(headers, ip)
    if not provider:
        return
    tok = (token or "").strip()
    if not tok:
        raise CaptchaError("Пройдите проверку «я не робот»", 400)
    cfg = get_config(with_secrets=True)
    try:
        if provider == "yandex":
            secret = cfg.get("yandex_secret") or ""
            if not secret:
                raise CaptchaError("Капча Яндекса не настроена", 503)
            data = _post_form(YANDEX_VALIDATE, {"secret": secret, "token": tok, "ip": ip or ""})
            if not data.get("status") == "ok":
                raise CaptchaError("Проверка не пройдена. Попробуйте ещё раз")
            return
        secret = cfg.get("turnstile_secret") or ""
        if not secret:
            raise CaptchaError("Cloudflare Turnstile не настроен", 503)
        data = _post_form(TURNSTILE_VALIDATE, {"secret": secret, "response": tok, "remoteip": ip or ""})
        if not data.get("success"):
            raise CaptchaError("Проверка не пройдена. Попробуйте ещё раз")
    except CaptchaError:
        raise
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        raise CaptchaError("Сервис проверки временно недоступен. Попробуйте позже", 503)

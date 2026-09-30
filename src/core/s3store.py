"""
Минимальный клиент S3 (AWS Signature V4) — для Timeweb Cloud S3 и любого
S3-совместимого хранилища. Без внешних зависимостей (только стандартная библиотека).

Настройки хранятся в БД (панель → Настройки → Хранилище S3); секретный ключ —
в зашифрованном виде. Адресация — path-style: https://s3.twcstorage.ru/<бакет>/<ключ>.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

DEFAULT_ENDPOINT = "https://s3.twcstorage.ru"
DEFAULT_REGION = "ru-1"
TIMEOUT = 120


class S3Error(Exception):
    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# ─────────────────────────────────────────────────────────────
# Настройки
# ─────────────────────────────────────────────────────────────

def _crypto():
    try:
        from . import monitoring  # type: ignore
    except ImportError:  # pragma: no cover
        import monitoring  # type: ignore
    return monitoring


def get_config(with_secret: bool = False) -> dict[str, Any]:
    raw = db.get_setting("s3_config", "") or ""
    try:
        cfg = json.loads(raw) if raw else {}
    except ValueError:
        cfg = {}
    out = {
        "enabled": bool(cfg.get("enabled")),
        "endpoint": cfg.get("endpoint") or DEFAULT_ENDPOINT,
        "region": cfg.get("region") or DEFAULT_REGION,
        "bucket": cfg.get("bucket") or "",
        "access_key": cfg.get("access_key") or "",
        "has_secret": bool(cfg.get("secret_enc")),
        "prefix": cfg.get("prefix") or "blinvpn/",
        "size_gb": float(cfg.get("size_gb") or 0),
    }
    if with_secret:
        out["secret_key"] = _crypto().decrypt(cfg.get("secret_enc")) or ""
    return out


def save_config(data: dict[str, Any]) -> dict[str, Any]:
    raw = db.get_setting("s3_config", "") or ""
    try:
        cur = json.loads(raw) if raw else {}
    except ValueError:
        cur = {}
    endpoint = str(data.get("endpoint") or cur.get("endpoint") or DEFAULT_ENDPOINT).strip().rstrip("/")
    p = urllib.parse.urlsplit(endpoint)
    if p.scheme != "https" or not p.netloc or p.path not in ("", "/"):
        raise S3Error("Адрес хранилища должен быть вида https://s3.twcstorage.ru")
    bucket = str(data.get("bucket") if data.get("bucket") is not None else cur.get("bucket") or "").strip()
    if bucket and not all(c.isalnum() or c in "-." for c in bucket):
        raise S3Error("Имя бакета: латиница, цифры, «-» и «.»")
    prefix = str(data.get("prefix") if data.get("prefix") is not None else cur.get("prefix") or "blinvpn/").strip().lstrip("/")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    new = {
        "enabled": bool(data.get("enabled", cur.get("enabled"))),
        "endpoint": endpoint,
        "region": str(data.get("region") or cur.get("region") or DEFAULT_REGION).strip(),
        "bucket": bucket,
        "access_key": str(data.get("access_key") if data.get("access_key") is not None else cur.get("access_key") or "").strip(),
        "secret_enc": cur.get("secret_enc"),
        "prefix": prefix,
        "size_gb": max(0.0, float(data.get("size_gb") if data.get("size_gb") is not None else cur.get("size_gb") or 0)),
    }
    secret = data.get("secret_key")
    if secret:
        new["secret_enc"] = _crypto().encrypt(str(secret).strip())
    if new["enabled"] and not (new["bucket"] and new["access_key"] and new["secret_enc"]):
        raise S3Error("Чтобы включить хранилище, укажите бакет, Access Key и Secret Key")
    db.set_setting("s3_config", json.dumps(new))
    return get_config()


def enabled() -> bool:
    c = get_config()
    return c["enabled"] and bool(c["bucket"] and c["access_key"] and c["has_secret"])


# ─────────────────────────────────────────────────────────────
# Подпись AWS Signature V4
# ─────────────────────────────────────────────────────────────

def _h(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _signing_key(secret: str, date: str, region: str) -> bytes:
    k = _h(("AWS4" + secret).encode(), date)
    k = _h(k, region)
    k = _h(k, "s3")
    return _h(k, "aws4_request")


def _q(s: str, safe: str = "-_.~") -> str:
    return urllib.parse.quote(s, safe=safe)


def _canonical_query(params: dict[str, str]) -> str:
    return "&".join(f"{_q(k)}={_q(str(v))}" for k, v in sorted(params.items()))


def _target(cfg: dict[str, Any], key: str) -> tuple[str, str, str]:
    """(host, canonical_uri, url_base) для path-style."""
    p = urllib.parse.urlsplit(cfg["endpoint"])
    uri = "/" + _q(cfg["bucket"]) + ("/" + _q(key, safe="-_.~/") if key else "")
    return p.netloc, uri, f"{p.scheme}://{p.netloc}{uri}"


def _sign(cfg: dict[str, Any], method: str, key: str, query: dict[str, str], headers: dict[str, str],
          payload_hash: str, now: Optional[datetime] = None) -> tuple[str, dict[str, str]]:
    now = now or datetime.now(timezone.utc)
    amz = now.strftime("%Y%m%dT%H%M%SZ")
    date = amz[:8]
    host, uri, base = _target(cfg, key)
    hdrs = {k.lower(): str(v).strip() for k, v in headers.items()}
    hdrs.update({"host": host, "x-amz-date": amz, "x-amz-content-sha256": payload_hash})
    signed = ";".join(sorted(hdrs))
    canon = "\n".join([method, uri, _canonical_query(query),
                       "".join(f"{k}:{hdrs[k]}\n" for k in sorted(hdrs)), signed, payload_hash])
    scope = f"{date}/{cfg['region']}/s3/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
    sig = hmac.new(_signing_key(cfg["secret_key"], date, cfg["region"]), sts.encode(), hashlib.sha256).hexdigest()
    hdrs["authorization"] = (f"AWS4-HMAC-SHA256 Credential={cfg['access_key']}/{scope}, "
                             f"SignedHeaders={signed}, Signature={sig}")
    url = base + (("?" + _canonical_query(query)) if query else "")
    return url, hdrs


def presign_get(key: str, expires: int = 3600, response: Optional[dict[str, str]] = None,
                cfg: Optional[dict[str, Any]] = None, now: Optional[datetime] = None) -> str:
    """Временная ссылка на скачивание (браузер пользователя идёт прямо в S3)."""
    cfg = cfg or get_config(with_secret=True)
    now = now or datetime.now(timezone.utc)
    amz = now.strftime("%Y%m%dT%H%M%SZ")
    date = amz[:8]
    scope = f"{date}/{cfg['region']}/s3/aws4_request"
    host, uri, base = _target(cfg, key)
    q = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": f"{cfg['access_key']}/{scope}",
         "X-Amz-Date": amz, "X-Amz-Expires": str(int(expires)), "X-Amz-SignedHeaders": "host"}
    q.update(response or {})
    canon = "\n".join(["GET", uri, _canonical_query(q), f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"])
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
    sig = hmac.new(_signing_key(cfg["secret_key"], date, cfg["region"]), sts.encode(), hashlib.sha256).hexdigest()
    return f"{base}?{_canonical_query(q)}&X-Amz-Signature={sig}"


# ─────────────────────────────────────────────────────────────
# Операции
# ─────────────────────────────────────────────────────────────

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # noqa: D401
        return None


_opener = urllib.request.build_opener(_NoRedirect())


def _request(method: str, key: str, *, body=None, length: int = 0, payload_hash: Optional[str] = None,
             headers: Optional[dict[str, str]] = None, query: Optional[dict[str, str]] = None,
             cfg: Optional[dict[str, Any]] = None) -> tuple[int, bytes]:
    cfg = cfg or get_config(with_secret=True)
    if not (cfg.get("bucket") and cfg.get("access_key") and cfg.get("secret_key")):
        raise S3Error("Хранилище S3 не настроено")
    ph = payload_hash or hashlib.sha256(b"").hexdigest()
    hdrs = dict(headers or {})
    if body is not None:
        hdrs["content-length"] = str(length)
    url, signed = _sign(cfg, method, key, query or {}, hdrs, ph)
    req = urllib.request.Request(url, data=body, method=method, headers=signed)
    try:
        with _opener.open(req, timeout=TIMEOUT) as r:
            return r.status, r.read(1024 * 1024)
    except urllib.error.HTTPError as e:
        text = e.read(2000).decode("utf-8", "replace") if e.fp else ""
        code = ""
        if "<Code>" in text:
            code = text.split("<Code>", 1)[1].split("</Code>", 1)[0]
        human = {"AccessDenied": "доступ запрещён — проверьте ключи", "SignatureDoesNotMatch": "неверный Secret Key",
                 "InvalidAccessKeyId": "неверный Access Key", "NoSuchBucket": "бакет не найден",
                 "QuotaExceeded": "в хранилище закончилось место"}.get(code, code or f"ошибка {e.code}")
        raise S3Error(f"S3: {human}", e.code)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise S3Error(f"S3 недоступно: {getattr(e, 'reason', e)}")


def put_file(key: str, path: str, sha256_hex: str, content_type: str, disposition: str) -> None:
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        _request("PUT", key, body=fh, length=size, payload_hash=sha256_hex,
                 headers={"content-type": content_type, "content-disposition": disposition})


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    _request("PUT", key, body=data, length=len(data), payload_hash=hashlib.sha256(data).hexdigest(),
             headers={"content-type": content_type})


def get_bytes(key: str) -> bytes:
    return _request("GET", key)[1]


def delete(key: str) -> None:
    try:
        _request("DELETE", key)
    except S3Error as e:
        if e.status != 404:
            raise


def check(cfg_override: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Проверка настроек: записать, прочитать и удалить тестовый объект."""
    cfg = cfg_override or get_config(with_secret=True)
    key = f"{cfg.get('prefix') or ''}.healthcheck"
    data = b"blinvpn s3 check"
    _request("PUT", key, body=data, length=len(data), payload_hash=hashlib.sha256(data).hexdigest(),
             headers={"content-type": "text/plain"}, cfg=cfg)
    got = _request("GET", key, cfg=cfg)[1]
    _request("DELETE", key, cfg=cfg)
    if got != data:
        raise S3Error("S3 вернул не тот файл, что был записан")
    return {"ok": True}

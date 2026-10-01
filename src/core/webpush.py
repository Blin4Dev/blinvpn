from __future__ import annotations

import base64
import json
import os
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

# push hosts (exact или subdomain)
ALLOWED_PUSH_HOSTS = (
    "fcm.googleapis.com", "android.googleapis.com",          # chrome/edge/opera/yandex
    "updates.push.services.mozilla.com",                     # firefox
    "web.push.apple.com",                                    # safari
    "notify.windows.com",                                    # edge win
)
MAX_SUBS_PER_ACTOR = 10
TTL = 12 * 3600


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64u(s: str) -> bytes:
    s = str(s or "").strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _crypto():
    try:
        from . import monitoring  # type: ignore
    except ImportError:  # pragma: no cover
        import monitoring  # type: ignore
    return monitoring


_key_lock = threading.Lock()


def _vapid_private() -> ec.EllipticCurvePrivateKey:
    with _key_lock:
        enc = db.get_setting("vapid_private", "")
        pem = _crypto().decrypt(enc) if enc else ""
        if pem:
            return serialization.load_pem_private_key(pem.encode(), password=None)  # type: ignore[return-value]
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode()
        db.set_setting("vapid_private", _crypto().encrypt(pem))
        return key


def public_key() -> str:
    """Открытый ключ сервера (applicationServerKey для браузера)."""
    pub = _vapid_private().public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return _b64u(pub)


def _subject() -> str:
    mail = (os.getenv("VAPID_SUBJECT") or os.getenv("SMTP_FROM") or "").strip()
    if mail.startswith("mailto:") or mail.startswith("https://"):
        return mail
    if "@" in mail and "<" not in mail:
        return "mailto:" + mail
    return "mailto:admin@example.com"


def vapid_header(endpoint: str, key: Optional[ec.EllipticCurvePrivateKey] = None, now: Optional[int] = None) -> str:
    key = key or _vapid_private()
    p = urllib.parse.urlsplit(endpoint)
    head = {"typ": "JWT", "alg": "ES256"}
    claims = {"aud": f"{p.scheme}://{p.netloc}", "exp": int(now or time.time()) + 12 * 3600, "sub": _subject()}
    signing = _b64u(json.dumps(head, separators=(",", ":")).encode()) + "." + \
        _b64u(json.dumps(claims, separators=(",", ":")).encode())
    der = key.sign(signing.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    jwt = signing + "." + _b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return f"vapid t={jwt}, k={_b64u(pub)}"


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(plaintext: bytes, ua_public_b64: str, auth_b64: str, *, salt: Optional[bytes] = None,
            as_private: Optional[ec.EllipticCurvePrivateKey] = None) -> bytes:
    ua_pub = _unb64u(ua_public_b64)
    auth = _unb64u(auth_b64)
    if len(ua_pub) != 65 or ua_pub[0] != 4 or len(auth) < 16:
        raise ValueError("bad subscription keys")
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub)
    as_key = as_private or ec.generate_private_key(ec.SECP256R1())
    as_pub = as_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = as_key.exchange(ec.ECDH(), ua_key)
    salt = salt or os.urandom(16)
    ikm = _hkdf(auth, shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    rs = 4096
    if len(plaintext) > rs - 17 - 86:
        raise ValueError("payload too large")
    ct = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)   # last record delimiter 0x02
    return salt + struct.pack("!I", rs) + bytes([len(as_pub)]) + as_pub + ct


class PushError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def endpoint_allowed(endpoint: str) -> bool:
    try:
        p = urllib.parse.urlsplit(str(endpoint or ""))
        port = p.port
    except ValueError:
        return False
    host = (p.hostname or "").lower().rstrip(".")
    if p.scheme != "https" or not host or p.username or p.password or port not in (None, 443):
        return False
    return any(host == h or host.endswith("." + h) for h in ALLOWED_PUSH_HOSTS)


def subscribe(actor: str, endpoint: str, p256dh: str, auth: str) -> None:
    endpoint = str(endpoint or "").strip()
    if len(endpoint) > 1000 or not endpoint_allowed(endpoint):
        raise PushError("Этот браузер не поддерживается для уведомлений")
    try:
        k, a = _unb64u(p256dh), _unb64u(auth)
    except (ValueError, TypeError):
        raise PushError("Неверные ключи подписки")
    if len(k) != 65 or k[0] != 4 or len(a) != 16:
        raise PushError("Неверные ключи подписки")
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), k)
    except ValueError:
        raise PushError("Неверные ключи подписки")
    now = datetime.now(timezone.utc).isoformat()
    # чужую подписку не перехватываем: браузер сам возьмёт новый endpoint
    cur = db.fetchone("SELECT actor FROM push_subs WHERE endpoint = ?", (endpoint,))
    if cur and cur["actor"] != actor:
        raise PushError("Это устройство подписано другим аккаунтом", 409)
    db.execute("INSERT INTO push_subs (actor, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) "
               "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, "
               "created_at = excluded.created_at WHERE push_subs.actor = excluded.actor",
               (actor, endpoint, p256dh.strip(), auth.strip(), now))
    # лимит подписок на actor, старые режем
    rows = db.fetchall("SELECT id FROM push_subs WHERE actor = ? ORDER BY id DESC", (actor,))
    for r in rows[MAX_SUBS_PER_ACTOR:]:
        db.execute("DELETE FROM push_subs WHERE id = ?", (r["id"],))


def unsubscribe(actor: str, endpoint: str) -> None:
    db.execute("DELETE FROM push_subs WHERE actor = ? AND endpoint = ?", (actor, str(endpoint or "")))


def drop_actor(actor: str) -> None:
    db.execute("DELETE FROM push_subs WHERE actor = ?", (actor,))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # noqa: D401
        return None


_opener = urllib.request.build_opener(_NoRedirect())


def _send_one(sub: dict[str, Any], payload: dict[str, Any], urgency: str = "normal") -> bool:
    if not endpoint_allowed(sub["endpoint"]):
        db.execute("DELETE FROM push_subs WHERE id = ?", (sub["id"],))
        return False
    body = encrypt(json.dumps(payload, ensure_ascii=False).encode()[:3000], sub["p256dh"], sub["auth"])
    req = urllib.request.Request(sub["endpoint"], data=body, method="POST", headers={
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": str(TTL),
        "Urgency": urgency, "Authorization": vapid_header(sub["endpoint"]),
    })
    try:
        with _opener.open(req, timeout=10) as r:
            ok = 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        if e.code in (404, 410):          # 404/410: подписки нет
            db.execute("DELETE FROM push_subs WHERE id = ?", (sub["id"],))
        return False
    except (urllib.error.URLError, OSError, ValueError):
        return False
    if ok:
        db.execute("UPDATE push_subs SET last_ok_at = ? WHERE id = ?", (datetime.now(timezone.utc).isoformat(), sub["id"]))
    return ok


def _actors_for(audience: str) -> list[str]:
    """all — владелец и все активные сотрудники; full — владелец и кураторы; owner — владелец."""
    out = ["owner"]
    if audience in ("all", "full"):
        q = "SELECT id FROM panel_staff WHERE is_active = 1" + (" AND role = 'curator'" if audience == "full" else "")
        out += [f"staff:{int(r['id'])}" for r in db.fetchall(q)]
    return out


def send(audience: str, title: str, body: str, url: str = "/", tag: str = "", sync: bool = False,
         exclude: Optional[str | list[str] | set[str] | tuple[str, ...]] = None,
         only: Optional[list[str]] = None) -> None:
    """Отправить push. По умолчанию — в фоне. exclude — кому не слать; only — явный список получателей."""
    payload = {"title": str(title)[:120], "body": str(body)[:400], "url": url if str(url).startswith("/") else "/",
               "tag": str(tag)[:60]}
    if exclude is None:
        excl: set[str] = set()
    elif isinstance(exclude, str):
        excl = {exclude}
    else:
        excl = {str(x) for x in exclude if x}

    def run() -> None:
        try:
            if only is not None:
                actors = [a for a in only if a and a not in excl]
            else:
                actors = [a for a in _actors_for(audience) if a not in excl]
            if not actors:
                return
            q = ",".join("?" * len(actors))
            for sub in db.fetchall(f"SELECT * FROM push_subs WHERE actor IN ({q})", tuple(actors)):
                try:
                    _send_one(sub, payload, "high" if audience != "owner" or only is not None else "normal")
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass

    if sync:
        run()
    else:
        threading.Thread(target=run, name="webpush", daemon=True).start()

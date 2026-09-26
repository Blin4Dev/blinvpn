"""
Генерация deep-link'ов подписки для VPN-приложений.

Поддерживаются:
  • incy  — incy://crypt1/<base64url(iv(12) || AES-256-GCM(ct) || tag(16))>
            Шифрование строго на самой машине (без внешних API).
            payload: компактный JSON с отсортированными ключами {"n":name,"url":url,"v":1}
            ключ AES-256 зашит в клиентах INCY (пакет @incy/link-encoder).
            Док: https://docs.incy.cc/deep-links/
  • happ  — happ://crypt5/... через внешний API согласно документации:
            POST https://crypto.happ.su/api-v2.php  body {"url": "<url>"}
            (на выходе — готовая зашифрованная ссылка happ://crypt5/...).
            Есть офлайн-fallback на локальный crypt4 (RSA-4096 PKCS#1 v1.5),
            если внешний сервис недоступен.
            Док: https://www.happ.su/main/ru/dev-docs/crypto-link
  • other — просто ссылка на подписку без шифрования.

Для incy (и happ-fallback) нужна библиотека `cryptography`.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.request

# ── INCY (AES-256-GCM, crypt1) ───────────────────────────────
# Итоговый 32-байтовый ключ, выведенный из keymat пакета @incy/link-encoder
# (SHA256(seed); отпечаток SHA256(K) = b6bf70...c08c совпадает с клиентами).
_INCY_KEY_HEX = "f6d40ea0c8a8899d7c682d09ba0d4165dfe2b3dd45e6bb3e25cb233cf00c2462"

# ── HAPP (crypt5, внешний API) ───────────────────────────────
_HAPP_CRYPT5_API = "https://crypto.happ.su/api-v2.php"
_HAPP_TIMEOUT = 10  # сек

# Офлайн-fallback: публичный ключ RSA-4096 для локального crypt4 —
# используется только если внешний сервис crypt5 недоступен.
_HAPP_PUBKEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAlBetA0wjbaj+h7oJ/d/h
pNrXvAcuhOdFGEFcfCxSWyLzWk4SAQ05gtaEGZyetTax2uqagi9HT6lapUSUe2S8
nMLJf5K+LEs9TYrhhBdx/B0BGahA+lPJa7nUwp7WfUmSF4hir+xka5ApHjzkAQn6
cdG6FKtSPgq1rYRPd1jRf2maEHwiP/e/jqdXLPP0SFBjWTMt/joUDgE7v/IGGB0L
Q7mGPAlgmxwUHVqP4bJnZ//5sNLxWMjtYHOYjaV+lixNSfhFM3MdBndjpkmgSfmg
D5uYQYDL29TDk6Eu+xetUEqry8ySPjUbNWdDXCglQWMxDGjaqYXMWgxBA1UKjUBW
wbgr5yKTJ7mTqhlYEC9D5V/LOnKd6pTSvaMxkHXwk8hBWvUNWAxzAf5JZ7EVE3jt
0j682+/hnmL/hymUE44yMG1gCcWvSpB3BTlKoMnl4yrTakmdkbASeFRkN3iMRewa
IenvMhzJh1fq7xwX94otdd5eLB2vRFavrnhOcN2JJAkKTnx9dwQwFpGEkg+8U613
+Tfm/f82l56fFeoFN98dD2mUFLFZoeJ5CG81ZeXrH83niI0joX7rtoAZIPWzq3Y1
Zb/Zq+kK2hSIhphY172Uvs8X2Qp2ac9UoTPM71tURsA9IvPNvUwSIo/aKlX5KE3I
VE0tje7twWXL5Gb1sfcXRzsCAwEAAQ==
-----END PUBLIC KEY-----"""


class AppLinkError(Exception):
    pass


def _sorted_compact_json(payload: dict) -> str:
    """Повторяет sortedCompactJson из @incy/link-encoder (ключи по алфавиту)."""
    keys = sorted(payload.keys())
    parts = [
        f"{json.dumps(k)}:{json.dumps(payload[k], ensure_ascii=False, separators=(',', ':'))}"
        for k in keys
    ]
    return "{" + ",".join(parts) + "}"


def incy_link(url: str, name: str | None = None) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not url:
        raise AppLinkError("empty url")
    payload = {"url": url, "v": 1}
    if name:
        payload["n"] = name[:128]
    plaintext = _sorted_compact_json(payload).encode("utf-8")
    key = bytes.fromhex(_INCY_KEY_HEX)
    iv = os.urandom(12)
    ct_and_tag = AESGCM(key).encrypt(iv, plaintext, None)  # tag(16) уже в конце
    wire = iv + ct_and_tag
    b64u = base64.urlsafe_b64encode(wire).decode().rstrip("=")
    return "incy://crypt1/" + b64u


def _happ_crypt5_api(url: str) -> str:
    """Внешний API happ: POST {"url": ...} → готовая ссылка happ://crypt5/..."""
    body = json.dumps({"url": url}).encode("utf-8")
    req = urllib.request.Request(
        _HAPP_CRYPT5_API,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_HAPP_TIMEOUT) as resp:
        raw = resp.read().decode("utf-8", "replace").strip()

    # Ответ может быть либо plain-text ссылкой, либо JSON с полем link/url/result.
    link = raw
    if raw[:1] in ("{", "["):
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if isinstance(data, dict):
            link = (
                data.get("link")
                or data.get("url")
                or data.get("result")
                or data.get("encrypted")
                or data.get("data")
                or ""
            )
        elif isinstance(data, list) and data:
            link = str(data[0])
    link = str(link).strip().strip('"')
    if not link.startswith("happ://"):
        raise AppLinkError(f"unexpected crypt5 response: {raw[:200]!r}")
    return link


def _happ_crypt4_local(url: str) -> str:
    """Офлайн-fallback: локальное crypt4 (RSA-4096 PKCS#1 v1.5)."""
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    pub = load_pem_public_key(_HAPP_PUBKEY_PEM)
    ct = pub.encrypt(url.encode("utf-8"), padding.PKCS1v15())
    return "happ://crypt4/" + base64.b64encode(ct).decode()


def happ_link(url: str) -> str:
    """
    HAPP_CRYPT_MODE (.env):
      remote (по умолчанию) — crypt5 через API Happ; ссылка на подписку при этом
                              уходит на сервер crypto.happ.su;
      local                 — crypt4 шифруется на нашем сервере, ссылка никуда не уходит.
    """
    if not url:
        raise AppLinkError("empty url")
    if (os.getenv("HAPP_CRYPT_MODE") or "remote").strip().lower() == "local":
        return _happ_crypt4_local(url)
    try:
        return _happ_crypt5_api(url)
    except Exception:
        # Внешний сервис недоступен — не роняем выдачу ссылки, отдаём crypt4.
        return _happ_crypt4_local(url)


def build_link(app: str, url: str, name: str | None = "BlinVPN") -> str:
    a = (app or "incy").lower()
    if a == "happ":
        return happ_link(url)
    if a in ("other", "plain", "link"):
        return url
    return incy_link(url, name=name)

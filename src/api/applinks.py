"""
Шифрование подписок для Happ и Incy
"""

from __future__ import annotations

import base64
import json
import os
import urllib.request

# incy hex для шифрование
_INCY_KEY_HEX = "f6d40ea0c8a8899d7c682d09ba0d4165dfe2b3dd45e6bb3e25cb233cf00c2462"

# happ шифрование через их api
_HAPP_CRYPT5_API = "https://crypto.happ.su/api-v2.php"
_HAPP_TIMEOUT = 10  # сек

# офлайн шифрование: используется только если внешний сервис crypt5 недоступен.
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


# открытый ключ Happ для crypt5
_HAPP_CRYPT5_PUBKEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA9+umWSxp8coKnMONnI4u
NvtPErJZt8VNgNb2XS+RrCMc9AFWZQH01ILr3Py/mviuqFgNLMEcPs3k6+ZPh6Sa
OCXHmjQicGPJAw6Co6GQwO/b4vspHgOM4HSvX5r6SY1EKIHUSLIyRV28DfwJKdFv
x2EKqypewlrAo4AV76uI/9U+1t40yHcVCj/OtFxsq+mMM6qySieTsA1q6C5raBrJ
u3l/RWMxFYvDInYDs1IaTFGDFwSdFDqhNU19gPGloT/GApy+U32R6AGSxJymS2nh
e6pm/M9bvsH0o0Oc1kyXsBpVN04n/a9gVVUoqODzrUyXDx7/jAzNJD43PWtblcz0
ZNBKN50wvpSD5UuAQydwMT7xWJIpPaZqTUj/sg8hIm57XGlUxRCge17nB0Ff7sKO
JAgaXVdbfqDdzx+PhSaZY9xfcAh/sHfE6hKaCQ9kIn5cjbx9bcYqZWnpuSOzSFg+
CgMSqvG6rV6d+96dNMHuE0tRIUJ83xrLcm9hZJmJ6WDm6hteZbnb1k3eQF9c+XCF
wSEvsWiXyduQmkVNJaCRXwy8tSaZp9JftALhRHMvd7Eq6ctAkvn7w0upynsAtLeL
N8xZ5q1gcRgboydr588D3m8KF7mVuX/XRp2AG7hzyYdkQov9bfEfXIaBVlwHMKhy
uPTxeM4Les6fvaHMSWJ+8EUCAwEAAQ==
-----END PUBLIC KEY-----"""
_HAPP_CRYPT5_FINGERPRINT = "22319c7b13647897bf5fd4f827ba92bf3946d738007a0054ccd931c31f221768"
_HAPP_CRYPT5_MARKER = "vdfzfoff"


class AppLinkError(Exception):
    pass


def _swap_pairs(data: bytes) -> bytes:
    b = bytearray(data)
    for i in range(0, len(b) - 1, 2):
        b[i], b[i + 1] = b[i + 1], b[i]
    return bytes(b)


def _rand_chars(n: int, alphabet: str) -> str:
    import secrets
    return "".join(secrets.choice(alphabet) for _ in range(n))


def _happ_crypt5_key(pem: bytes = _HAPP_CRYPT5_PUBKEY_PEM):
    import hashlib
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

    key = serialization.load_pem_public_key(pem)
    if not isinstance(key, RSAPublicKey) or key.key_size != 4096 or key.public_numbers().e != 65537:
        raise AppLinkError("bad happ key")
    spki = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    if pem is _HAPP_CRYPT5_PUBKEY_PEM and hashlib.sha256(spki).hexdigest() != _HAPP_CRYPT5_FINGERPRINT:
        raise AppLinkError("happ key fingerprint mismatch")
    return key


def happ_crypt5_local(url: str, key=None) -> str:
    from urllib.parse import urlsplit
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    if not url or len(url.encode("utf-8")) > 8192 or any(ord(c) < 32 or ord(c) == 127 for c in url):
        raise AppLinkError("bad url")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or "@" in parts.netloc:
        raise AppLinkError("bad url")
    key = key or _happ_crypt5_key()
    letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    alnum = letters + "0123456789"
    session = os.urandom(32)
    nonce = _rand_chars(12, alnum)
    tag = _rand_chars(2, letters)
    salt = _rand_chars(8, alnum)
    wrapped = bytes(session[i] ^ ord(salt[i % 8]) for i in range(32))
    rsa_plain = _swap_pairs(base64.b64encode(wrapped))
    rsa_ct = key.encrypt(rsa_plain, padding.PKCS1v15())
    plain = _swap_pairs(base64.b64encode(url.encode("utf-8")))
    cipher_b64 = base64.b64encode(ChaCha20Poly1305(session).encrypt(nonce.encode(), plain, None)).decode()
    body = nonce + tag + salt + str(len(cipher_b64)) + "V" + cipher_b64 + base64.b64encode(rsa_ct).decode()
    frame = bytearray((_HAPP_CRYPT5_MARKER[:4] + body + _HAPP_CRYPT5_MARKER[4:]).encode())
    for i in range(0, len(frame) - 3, 4):
        frame[i], frame[i + 2] = frame[i + 2], frame[i]
        frame[i + 1], frame[i + 3] = frame[i + 3], frame[i + 1]
    return "happ://crypt5/" + frame.decode()


def _sorted_compact_json(payload: dict) -> str:
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
    body = json.dumps({"url": url}).encode("utf-8")
    req = urllib.request.Request(
        _HAPP_CRYPT5_API,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Origin": "https://crypto.happ.su",
            "Referer": "https://crypto.happ.su/",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_HAPP_TIMEOUT) as resp:
        raw = resp.read().decode("utf-8", "replace").strip()

    def _find_link(obj: object) -> str:
        if isinstance(obj, str):
            return obj if obj.strip().strip('"').startswith("happ://") else ""
        if isinstance(obj, dict):
            for k in ("encrypted_link", "link", "url", "result", "encrypted", "data"):
                if k in obj:
                    found = _find_link(obj[k])
                    if found:
                        return found
            for v in obj.values():
                found = _find_link(v)
                if found:
                    return found
        if isinstance(obj, list):
            for v in obj:
                found = _find_link(v)
                if found:
                    return found
        return ""

    link = raw
    if raw[:1] in ("{", "["):
        try:
            link = _find_link(json.loads(raw))
        except ValueError:
            link = ""
    link = str(link).strip().strip('"')
    if not link.startswith("happ://"):
        raise AppLinkError(f"unexpected crypt5 response: {raw[:200]!r}")
    return link


def _happ_crypt4_local(url: str) -> str:
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    pub = load_pem_public_key(_HAPP_PUBKEY_PEM)
    ct = pub.encrypt(url.encode("utf-8"), padding.PKCS1v15())
    return "happ://crypt4/" + base64.b64encode(ct).decode()


def happ_link(url: str) -> str:
    global LAST_HAPP_ERROR
    if not url:
        raise AppLinkError("empty url")
    mode = (os.getenv("HAPP_CRYPT_MODE") or "local5").strip().lower()
    if mode in ("crypt4", "local"):
        return _happ_crypt4_local(url)
    order = (_happ_crypt5_api, happ_crypt5_local) if mode == "remote" else (happ_crypt5_local, _happ_crypt5_api)
    errors = []
    for fn in order:
        try:
            return fn(url)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{fn.__name__}: {type(exc).__name__}: {exc}")
    LAST_HAPP_ERROR = "; ".join(errors)
    return "happ://add/" + url


LAST_HAPP_ERROR: str | None = None


def build_link(app: str, url: str, name: str | None = "BlinVPN") -> str:
    a = (app or "incy").lower()
    if a == "happ":
        return happ_link(url)
    if a in ("other", "plain", "link"):
        return url
    return incy_link(url, name=name)

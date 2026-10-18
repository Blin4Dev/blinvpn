#!/usr/bin/env python3
"""
Коды сопряжения панели и edge (BlinVPN 3.0).

Код панели  BLINPAIR1.<base64url(json)>.<crc32>  — то, что edge должен знать:
  ключ WireGuard панели, адреса в туннеле, токен edge, ключ агента, домены edge, пути вебхуков.
  Адреса и домена панели в коде НЕТ: edge их не знает и не хранит.
Код edge    BLINEDGE1.<base64url(json)>.<crc32>  — ключ WireGuard edge и его адрес (IP:порт).

  pairing.py decode-pair <код>     → строки KEY='value' для bash (eval)
  pairing.py encode-reply <pubkey> <ip:port>
  (кодирование кода панели и разбор ответа — из panelctl.py)
"""
from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import re
import shlex
import sys
import zlib
from typing import Any

PAIR_PREFIX = "BLINPAIR1"
REPLY_PREFIX = "BLINEDGE1"
PROTOCOL = 1

WG_KEY_RE = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")
DOMAIN_RE = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9]{32,128}$")
HOOK_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


class PairingError(ValueError):
    pass


def _encode(prefix: str, data: dict[str, Any]) -> str:
    raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
    body = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    crc = format(zlib.crc32(raw) & 0xFFFFFFFF, "08x")
    return f"{prefix}.{body}.{crc}"


def _decode(prefix: str, code: str) -> dict[str, Any]:
    code = re.sub(r"\s+", "", code or "")
    parts = code.split(".")
    if len(parts) != 3 or parts[0] != prefix:
        raise PairingError(f"это не код {prefix} — скопируйте строку целиком")
    try:
        raw = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
    except (binascii.Error, ValueError):
        raise PairingError("код повреждён (base64)")
    if format(zlib.crc32(raw) & 0xFFFFFFFF, "08x") != parts[2].lower():
        raise PairingError("код повреждён или скопирован не полностью (контрольная сумма)")
    try:
        data = json.loads(raw.decode())
    except ValueError:
        raise PairingError("код повреждён (json)")
    if not isinstance(data, dict):
        raise PairingError("код повреждён")
    return data


def _ip(v: Any, name: str) -> str:
    try:
        return str(ipaddress.ip_address(str(v)))
    except ValueError:
        raise PairingError(f"{name}: неверный IP")


def _port(v: Any, name: str) -> int:
    try:
        p = int(v)
    except (TypeError, ValueError):
        raise PairingError(f"{name}: неверный порт")
    if not 1 <= p <= 65535:
        raise PairingError(f"{name}: неверный порт")
    return p


def validate_pair(d: dict[str, Any]) -> dict[str, Any]:
    if int(d.get("proto") or 0) != PROTOCOL:
        raise PairingError("версия кода не совпадает — обновите BlinVPN на обоих серверах")
    if not WG_KEY_RE.fullmatch(str(d.get("panel_pub") or "")):
        raise PairingError("неверный ключ WireGuard панели")
    out = {
        "panel_pub": d["panel_pub"],
        "panel_ip": _ip(d.get("panel_ip"), "адрес панели в туннеле"),
        "edge_ip": _ip(d.get("edge_ip"), "адрес edge в туннеле"),
        "net": str(d.get("net") or ""),
        "ingress_port": _port(d.get("ingress_port"), "порт ingress"),
        "agent_port": _port(d.get("agent_port"), "порт агента"),
        "edge_token": str(d.get("edge_token") or ""),
        "agent_key": str(d.get("agent_key") or ""),
        "app": str(d.get("app") or "").lower(),
        "sub": str(d.get("sub") or "").lower(),
        "hook": str(d.get("hook") or "").lower(),
        "hooks": [str(h) for h in (d.get("hooks") or []) if HOOK_RE.fullmatch(str(h))],
        "bot": str(d.get("bot") or ""),
        "email": str(d.get("email") or ""),
        "repo": str(d.get("repo") or ""),
        "branch": str(d.get("branch") or "main"),
    }
    try:
        net = ipaddress.ip_network(out["net"], strict=False)
    except ValueError:
        raise PairingError("неверная подсеть туннеля")
    if ipaddress.ip_address(out["panel_ip"]) not in net or ipaddress.ip_address(out["edge_ip"]) not in net:
        raise PairingError("адреса туннеля вне подсети")
    if not TOKEN_RE.fullmatch(out["edge_token"]) or not TOKEN_RE.fullmatch(out["agent_key"]):
        raise PairingError("неверные ключи в коде")
    for k in ("app", "sub", "hook"):
        if not DOMAIN_RE.fullmatch(out[k]):
            raise PairingError(f"неверный домен ({k})")
    if len({out["app"], out["sub"], out["hook"]}) != 3:
        raise PairingError("домены мини-аппа, подписки и вебхуков должны различаться")
    if not out["hooks"]:
        raise PairingError("в коде нет путей вебхуков")
    if out["repo"] and not re.fullmatch(r"https://[A-Za-z0-9._/-]+(\.git)?", out["repo"]):
        raise PairingError("неверный адрес репозитория")
    if not re.fullmatch(r"[A-Za-z0-9._/-]{1,64}", out["branch"]):
        raise PairingError("неверная ветка")
    return out


def encode_pair(d: dict[str, Any]) -> str:
    data = dict(d)
    data["proto"] = PROTOCOL
    validate_pair(data)
    return _encode(PAIR_PREFIX, data)


def decode_pair(code: str) -> dict[str, Any]:
    return validate_pair(_decode(PAIR_PREFIX, code))


def encode_reply(pub: str, endpoint: str) -> str:
    return _encode(REPLY_PREFIX, validate_reply({"proto": PROTOCOL, "edge_pub": pub, "endpoint": endpoint}))


def validate_reply(d: dict[str, Any]) -> dict[str, Any]:
    if int(d.get("proto") or 0) != PROTOCOL:
        raise PairingError("версия кода не совпадает — обновите BlinVPN на обоих серверах")
    pub = str(d.get("edge_pub") or "")
    if not WG_KEY_RE.fullmatch(pub):
        raise PairingError("неверный ключ WireGuard edge")
    ep = str(d.get("endpoint") or "")
    m = re.fullmatch(r"\[?([0-9a-fA-F:.]+)\]?:(\d{1,5})", ep)
    if not m:
        raise PairingError("неверный адрес edge (IP:порт)")
    ip = _ip(m.group(1), "IP edge")
    port = _port(m.group(2), "порт WireGuard edge")
    a = ipaddress.ip_address(ip)
    if a.is_private or a.is_loopback or a.is_unspecified:
        raise PairingError("адрес edge должен быть публичным IP")
    return {"proto": PROTOCOL, "edge_pub": pub, "endpoint": f"[{ip}]:{port}" if a.version == 6 else f"{ip}:{port}"}


def decode_reply(code: str) -> dict[str, Any]:
    return validate_reply(_decode(REPLY_PREFIX, code))


def main(argv: list[str]) -> int:
    try:
        if len(argv) >= 3 and argv[1] == "decode-pair":
            d = decode_pair(argv[2])
            names = {"panel_pub": "P_PANEL_PUB", "panel_ip": "P_PANEL_IP", "edge_ip": "P_EDGE_IP", "net": "P_NET",
                     "ingress_port": "P_INGRESS_PORT", "agent_port": "P_AGENT_PORT", "edge_token": "P_EDGE_TOKEN",
                     "agent_key": "P_AGENT_KEY", "app": "P_APP", "sub": "P_SUB", "hook": "P_HOOK", "bot": "P_BOT",
                     "email": "P_EMAIL", "repo": "P_REPO", "branch": "P_BRANCH"}
            for k, var in names.items():
                print(f"{var}={shlex.quote(str(d[k]))}")
            print(f"P_HOOKS={shlex.quote(','.join(d['hooks']))}")
            return 0
        if len(argv) >= 4 and argv[1] == "encode-reply":
            print(encode_reply(argv[2], argv[3]))
            return 0
    except PairingError as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        return 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

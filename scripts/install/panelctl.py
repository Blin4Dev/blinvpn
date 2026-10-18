#!/usr/bin/env python3
"""
Помощник панели BlinVPN 3.0 (вызывается из install.sh и команды `blinvpn`).

  panelctl.py pair-code                  код сопряжения для edge (из .env и ключа WireGuard панели)
  panelctl.py parse-reply <код>          ответ edge → строки KEY='value' для bash
  panelctl.py wait-agent [сек]           ждать, пока edge-agent ответит по туннелю
  panelctl.py status                     состояние edge (коротко, по-русски)
  panelctl.py apply-edge                 отправить на edge домены и пути вебхуков (сертификаты, nginx)
  panelctl.py update-edge [ветка]        обновить код на edge
  panelctl.py leaktest                   проверить, что сканер утечек в ingress работает
  panelctl.py check-urls                 проверить публичные адреса (.env)
"""
from __future__ import annotations

import json
import os
import shlex
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, "..", ".."))
ENV_FILE = os.environ.get("BLINVPN_ENV_FILE") or os.path.join(PROJECT, ".env")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(PROJECT, "src", "core"))
sys.path.insert(0, os.path.join(PROJECT, "src", "api"))

import envfile  # noqa: E402
import pairing  # noqa: E402

envfile.load_into_environ(ENV_FILE)
os.environ.setdefault("API_ROLE", "panel")
import deploy  # noqa: E402

WG_PUB = "/etc/wireguard/blinvpn.pub"


def env(k: str, d: str = "") -> str:
    return (os.environ.get(k) or d).strip()


def die(msg: str, code: int = 1) -> int:
    print(f"Ошибка: {msg}", file=sys.stderr)
    return code


def cmd_pair_code() -> int:
    try:
        with open(WG_PUB, encoding="utf-8") as f:
            pub = f.read().strip()
    except OSError:
        return die(f"нет {WG_PUB} — WireGuard панели не настроен")
    data = {
        "panel_pub": pub,
        "panel_ip": env("WG_PANEL_IP", "10.213.0.1"),
        "edge_ip": env("WG_EDGE_IP", "10.213.0.11"),
        "net": env("WG_NET", "10.213.0.0/24"),
        "ingress_port": int(env("INGRESS_PORT", "8443")),
        "agent_port": int(env("EDGE_AGENT_PORT", "9443")),
        "edge_token": env("EDGE_TOKEN"),
        "agent_key": env("EDGE_AGENT_KEY"),
        "app": deploy.host_of(deploy.app_url()),
        "sub": deploy.host_of(deploy.sub_url()),
        "hook": deploy.host_of(deploy.webhook_url()),
        "hooks": deploy.hook_paths(),
        "bot": env("BOT_USERNAME"),
        "email": env("SSL_EMAIL"),
        "repo": env("REPO_URL"),
        "branch": env("REPO_BRANCH", "main"),
    }
    try:
        print(pairing.encode_pair(data))
    except pairing.PairingError as e:
        return die(str(e))
    return 0


def cmd_parse_reply(code: str) -> int:
    try:
        d = pairing.decode_reply(code)
    except pairing.PairingError as e:
        return die(str(e))
    print(f"R_EDGE_PUB={shlex.quote(d['edge_pub'])}")
    print(f"R_ENDPOINT={shlex.quote(d['endpoint'])}")
    return 0


def _health() -> dict:
    return deploy.agent_call("GET", "/agent/health", timeout=8.0)


def cmd_wait_agent(seconds: int) -> int:
    deadline = time.time() + seconds
    last = ""
    while time.time() < deadline:
        try:
            h = _health()
            print(f"edge-agent отвечает (версия {h.get('version')})")
            return 0
        except deploy.EdgeError as e:
            if e.message != last:
                print(f"  ждём edge: {e.message}", flush=True)
                last = e.message
        time.sleep(3)
    return die("edge не ответил по туннелю")


def _yes(v: object) -> str:
    return "✔" if v else "✘"


def cmd_status() -> int:
    print(f"BlinVPN {deploy.VERSION}, панель")
    problems = deploy.validate_public_urls()
    print(f"  публичные адреса: {'✔' if not problems else '✘ ' + '; '.join(problems)}")
    print(f"  мини-апп:  {deploy.app_url()}")
    print(f"  подписка:  {deploy.sub_url()}")
    print(f"  вебхуки:   {deploy.webhook_url()}")
    try:
        h = _health()
    except deploy.EdgeError as e:
        print(f"  edge: ✘ {e.message}")
        return 1
    print(f"  edge: ✔ версия {h.get('version')}, IP {h.get('public_ip')}")
    print(f"    nginx {_yes((h.get('nginx') or {}).get('running'))}  "
          f"мини-апп {_yes((h.get('miniapp') or {}).get('running'))}  "
          f"XBM {_yes((h.get('xbm') or {}).get('running'))}  "
          f"страница подписки {_yes((h.get('subpage') or {}).get('running'))}  "
          f"дверь панели {_yes((h.get('ingress') or {}).get('ok'))}")
    d = h.get("domains") or {}
    want = {"app": deploy.host_of(deploy.app_url()), "sub": deploy.host_of(deploy.sub_url()),
            "hook": deploy.host_of(deploy.webhook_url())}
    if d != want:
        print(f"    ⚠ домены на edge {d} отличаются от панели {want} — выполните: sudo blinvpn domains")
    if int(h.get("protocol") or 0) != deploy.EDGE_PROTOCOL or h.get("version") != deploy.VERSION:
        print("    ⚠ версия edge отличается — выполните: sudo blinvpn update")
    try:
        if abs(int(h.get("time") or 0) - time.time()) > 45:
            print("    ⚠ часы edge и панели расходятся — включите синхронизацию времени (timedatectl set-ntp true)")
    except (TypeError, ValueError):
        pass
    return 0


def _wait_job(jid: str, timeout: int = 1800) -> bool:
    shown = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(2)
        try:
            j = deploy.agent_call("GET", f"/agent/jobs/{jid}", timeout=10.0)
        except deploy.EdgeError as e:
            print(f"  (нет ответа edge: {e.message})", flush=True)
            continue
        lines = j.get("log") or []
        for line in lines[shown:]:
            print(f"  edge: {line}", flush=True)
        shown = len(lines)
        if j.get("status") in ("ok", "error"):
            return j["status"] == "ok"
    print("  задача на edge не завершилась вовремя")
    return False


def cmd_apply_edge() -> int:
    body = {
        "domains": {"app": deploy.host_of(deploy.app_url()), "sub": deploy.host_of(deploy.sub_url()),
                    "hook": deploy.host_of(deploy.webhook_url())},
        "hook_paths": deploy.hook_paths(),
        "email": env("SSL_EMAIL"),
    }
    try:
        jid = deploy.agent_call("POST", "/agent/apply", body, timeout=20.0)["job"]
    except deploy.EdgeError as e:
        return die(e.message)
    return 0 if _wait_job(jid) else 1


def cmd_update_edge(branch: str) -> int:
    try:
        jid = deploy.agent_call("POST", "/agent/update", {"branch": branch}, timeout=20.0)["job"]
    except deploy.EdgeError as e:
        return die(e.message)
    return 0 if _wait_job(jid, timeout=3600) else 1


def cmd_leaktest() -> int:
    url = f"http://{env('WG_PANEL_IP', '10.213.0.1')}:{env('INGRESS_PORT', '8443')}/__ingress/leaktest"
    req = urllib.request.Request(url, headers={"X-Edge-Token": env("EDGE_TOKEN")})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310
            d = json.loads(r.read().decode())
    except (urllib.error.URLError, OSError, ValueError) as e:
        return die(f"ingress не отвечает: {e}")
    if not d.get("ok"):
        return die(f"сканер утечек не сработал: {d}")
    print(f"сканер утечек работает (адресов панели в списке: {d.get('tokens')})")
    return 0


def cmd_check_urls() -> int:
    problems = deploy.validate_public_urls()
    if problems:
        for p in problems:
            print(f"  ✘ {p}")
        return 1
    print("публичные адреса в порядке")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    c = argv[1]
    if c == "pair-code":
        return cmd_pair_code()
    if c == "parse-reply" and len(argv) >= 3:
        return cmd_parse_reply(argv[2])
    if c == "wait-agent":
        return cmd_wait_agent(int(argv[2]) if len(argv) >= 3 else 120)
    if c == "status":
        return cmd_status()
    if c == "apply-edge":
        return cmd_apply_edge()
    if c == "update-edge":
        return cmd_update_edge(argv[2] if len(argv) >= 3 else "")
    if c == "leaktest":
        return cmd_leaktest()
    if c == "check-urls":
        return cmd_check_urls()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""
edge-agent — помощник на edge-сервере BlinVPN 3.0.

Принимает команды ТОЛЬКО от панели и ТОЛЬКО по туннелю WireGuard:
  • слушает адрес edge в туннеле (по умолчанию 10.213.0.11:9443);
  • отправитель должен быть адресом панели в туннеле (10.213.0.1);
  • каждая команда подписана HMAC-SHA256 (время ±120 с, одноразовый nonce).

Команды:
  GET  /agent/health            состояние edge (nginx, XBM, страница подписки, мини-апп, туннель)
  GET  /agent/xbm/config        sha256 текущих настроек XBM
  PUT  /agent/xbm/config        новые настройки XBM (panel.json)
  GET  /agent/xbm/health        здоровье XBM
  GET  /agent/xbm/<shortUuid>   подписка через XBM (проверка из панели)
  POST /agent/mail/send         отправить готовое письмо (с IP edge, не панели)
  POST /agent/mail/smtp-test    проверить вход в почтовый ящик
  POST /agent/mail/port25       открыт ли исходящий порт 25
  POST /agent/apply             новые домены / пути вебхуков → сертификаты и nginx (задача)
  POST /agent/update            обновить код edge и перезапустить сервисы (задача)
  GET  /agent/jobs/<id>         ход задачи

CLI (для установщика и `blinvpn-edge`):
  agent.py serve | render-nginx | certs | status
Зависимости: только python3 (dnspython — по желанию, для MX).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import smtplib
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional

VERSION = "3.0.0"
PROTOCOL = 1

AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(AGENT_DIR, "..", ".."))
ENV_FILE = os.environ.get("BLINVPN_ENV_FILE") or os.path.join(PROJECT, ".env")
NGINX_CONF = "/etc/nginx/sites-available/blinvpn-edge.conf"
NGINX_LINK = "/etc/nginx/sites-enabled/blinvpn-edge.conf"
NGINX_ACME = "/etc/nginx/sites-enabled/blinvpn-acme.conf"
DUMMY_CRT = "/etc/nginx/blinvpn-dummy.crt"
DUMMY_KEY = "/etc/nginx/blinvpn-dummy.key"
TEMPLATE = os.path.join(PROJECT, "deploy", "edge", "nginx.conf.tpl")
XBM_STATE = os.path.join(PROJECT, "data", "xbm", "panel.json")
WEBROOT = "/var/www/html"

sys.path.insert(0, os.path.join(PROJECT, "scripts", "install"))
try:
    import render  # type: ignore  # noqa: E402
except Exception:  # noqa: BLE001
    render = None  # type: ignore

DOMAIN_RE = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$")
HOOK_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
SHORT_RE = re.compile(r"^[A-Za-z0-9_-]{4,128}$")
STARTED = time.time()


def log(msg: str) -> None:
    print(f"[agent] {msg}", flush=True)


# ── .env ──────────────────────────────────────────────────────────

_env_lock = threading.Lock()


def read_env(path: str = ENV_FILE) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[k.strip()] = v
    except OSError:
        pass
    return out


def write_env(updates: dict[str, str], path: str = ENV_FILE) -> None:
    """обновить ключи в .env, сохранив остальное (атомарно, права 600)."""
    for k, v in updates.items():
        if not re.fullmatch(r"[A-Z0-9_]+", k) or "\n" in str(v) or "\r" in str(v):
            raise ValueError(f"недопустимое значение для {k}")
    with _env_lock:
        lines: list[str] = []
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except OSError:
            pass
        done: set[str] = set()
        for i, line in enumerate(lines):
            m = re.match(r"^([A-Z0-9_]+)=", line)
            if m and m.group(1) in updates:
                lines[i] = f"{m.group(1)}={updates[m.group(1)]}"
                done.add(m.group(1))
        for k, v in updates.items():
            if k not in done:
                lines.append(f"{k}={v}")
        d = os.path.dirname(path) or "."
        fd, tmp = tempfile.mkstemp(prefix=".env-", dir=d)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


ENV: dict[str, str] = read_env()


def env(key: str, default: str = "") -> str:
    return (ENV.get(key) or os.environ.get(key) or default).strip()


def reload_env() -> None:
    global ENV
    ENV = read_env()


# ── утилиты ───────────────────────────────────────────────────────

def run(cmd: list[str], timeout: float = 600, cwd: Optional[str] = None,
        out: Optional[Callable[[str], None]] = None) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        if out:
            out(f"$ {' '.join(cmd)}: превышено время ожидания")
        return 124, "timeout"
    except FileNotFoundError:
        if out:
            out(f"$ {cmd[0]}: не найдено")
        return 127, "not found"
    text = (p.stdout + p.stderr).strip()
    if out and text:
        for line in text.splitlines()[-30:]:
            out(line[:400])
    return p.returncode, text


def http_get(url: str, headers: Optional[dict[str, str]] = None, timeout: float = 5.0,
             limit: int = 8 * 1024 * 1024) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — только локальные адреса
            return r.status, dict(r.headers), r.read(limit)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), (e.read(65536) if e.fp else b"")


def nginx_version() -> tuple[int, int, int]:
    code, text = run(["nginx", "-v"], timeout=10)
    m = re.search(r"nginx/(\d+)\.(\d+)\.(\d+)", text)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else (0, 0, 0)


def default_tls() -> str:
    """ssl_reject_handshake (nginx ≥ 1.19.4) или самоподписанный сертификат-заглушка."""
    if nginx_version() >= (1, 19, 4):
        return "ssl_reject_handshake on;"
    if not (os.path.exists(DUMMY_CRT) and os.path.exists(DUMMY_KEY)):
        run(["openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "3650",
             "-subj", "/CN=localhost", "-keyout", DUMMY_KEY, "-out", DUMMY_CRT], timeout=60)
        try:
            os.chmod(DUMMY_KEY, 0o600)
        except OSError:
            pass
    return f"ssl_certificate {DUMMY_CRT};\n    ssl_certificate_key {DUMMY_KEY};"


def domains() -> dict[str, str]:
    return {"app": env("APP_DOMAIN").lower(), "sub": env("SUB_DOMAIN").lower(), "hook": env("HOOK_DOMAIN").lower()}


def hook_paths() -> list[str]:
    return [h for h in (x.strip() for x in env("HOOK_PATHS").split(",")) if HOOK_RE.fullmatch(h)]


def nginx_values() -> dict[str, str]:
    d = domains()
    for k, v in d.items():
        if not DOMAIN_RE.fullmatch(v):
            raise ValueError(f"домен {k} не задан или неверный: {v!r}")
    hooks = hook_paths()
    if not hooks:
        raise ValueError("HOOK_PATHS пуст")
    tok = env("EDGE_TOKEN")
    if not re.fullmatch(r"[A-Za-z0-9]{32,128}", tok):
        raise ValueError("EDGE_TOKEN не задан или неверный")
    ingress = env("INGRESS_ADDR", "10.213.0.1:8443")
    if not re.fullmatch(r"[0-9.]+:\d{2,5}", ingress):
        raise ValueError("INGRESS_ADDR неверный")
    ports = {k: env(k, dv) for k, dv in (("MINIAPP_PORT", "9741"), ("XBM_PORT", "4100"), ("SUBPAGE_PORT", "3010"))}
    for k, v in ports.items():
        if not v.isdigit():
            raise ValueError(f"{k} неверный")
    return {
        "APP_DOMAIN": d["app"], "SUB_DOMAIN": d["sub"], "HOOK_DOMAIN": d["hook"],
        "HOOK_RX": "|".join(re.escape(h) for h in hooks), "EDGE_TOKEN": tok, "INGRESS": ingress,
        "DEFAULT_TLS": default_tls(), **ports,
    }


def render_nginx(out: Callable[[str], None] = log) -> bool:
    """сгенерировать nginx-конфиг edge, проверить и применить. При ошибке — вернуть прежний."""
    if render is None:
        out("нет scripts/install/render.py")
        return False
    vals = nginx_values()
    prev = None
    if os.path.exists(NGINX_CONF):
        with open(NGINX_CONF, encoding="utf-8") as f:
            prev = f.read()
    render.render_file(TEMPLATE, NGINX_CONF, vals, mode=0o600)  # в конфиге токен edge
    if not os.path.islink(NGINX_LINK):
        try:
            os.unlink(NGINX_LINK)
        except FileNotFoundError:
            pass
        os.symlink(NGINX_CONF, NGINX_LINK)
    for stale in ("/etc/nginx/sites-enabled/default",):
        if os.path.lexists(stale):
            os.unlink(stale)
    code, text = run(["nginx", "-t"], timeout=30)
    if code != 0:
        out("nginx -t не прошёл:")
        for line in text.splitlines()[-10:]:
            out("  " + line)
        if prev is not None:
            with open(NGINX_CONF, "w", encoding="utf-8") as f:
                f.write(prev)
            out("возвращён прежний конфиг nginx")
        return False
    run(["systemctl", "reload", "nginx"], timeout=60)
    out("nginx обновлён")
    return True


def ensure_certs(names: list[str], email: str, out: Callable[[str], None] = log) -> bool:
    """выпустить недостающие сертификаты (HTTP-01 через webroot). Отдельный сертификат на домен."""
    missing = [d for d in names if d and not os.path.isdir(f"/etc/letsencrypt/live/{d}")]
    if not missing:
        return True
    os.makedirs(os.path.join(WEBROOT, ".well-known", "acme-challenge"), exist_ok=True)
    l6 = "    listen [::]:80;\n" if (render is not None and render.ipv6_available()) else ""
    blocks = "".join(
        f"server {{\n    listen 80;\n{l6}    server_name {d};\n"
        f"    location /.well-known/acme-challenge/ {{ root {WEBROOT}; }}\n"
        f"    location / {{ return 404; }}\n}}\n" for d in missing)
    with open(NGINX_ACME, "w", encoding="utf-8") as f:
        f.write(blocks)
    ok = True
    try:
        code, text = run(["nginx", "-t"], timeout=30)
        if code != 0:
            out("nginx -t не прошёл перед выпуском сертификатов")
            for line in text.splitlines()[-5:]:
                out("  " + line)
            return False
        run(["systemctl", "reload", "nginx"], timeout=60)
        for d in missing:
            out(f"сертификат для {d}…")
            cmd = ["certbot", "certonly", "--webroot", "-w", WEBROOT, "-d", d, "--agree-tos", "--non-interactive",
                   "--keep-until-expiring"]
            cmd += ["--email", email] if email else ["--register-unsafely-without-email"]
            code, _ = run(cmd, timeout=300, out=out)
            if code != 0:
                out(f"не удалось выпустить сертификат для {d}: проверьте A-запись (должна указывать на этот сервер)")
                ok = False
    finally:
        try:
            os.unlink(NGINX_ACME)
        except FileNotFoundError:
            pass
        run(["systemctl", "reload", "nginx"], timeout=60)
    return ok


def compose(args: list[str], out: Callable[[str], None] = log, timeout: float = 1800) -> int:
    code, _ = run(["docker", "compose"] + args, cwd=PROJECT, timeout=timeout, out=out)
    return code


# ── задачи (долгие команды) ───────────────────────────────────────

_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()
_job_running = threading.Lock()


def start_job(name: str, fn: Callable[[Callable[[str], None]], bool]) -> str:
    if not _job_running.acquire(blocking=False):
        raise RuntimeError("на edge уже выполняется другая задача — дождитесь её окончания")
    jid = secrets.token_hex(8)
    job = {"id": jid, "name": name, "status": "running", "log": [], "started": time.time()}
    with _jobs_lock:
        _jobs[jid] = job
        for k in sorted(_jobs, key=lambda x: _jobs[x]["started"])[:-20]:
            _jobs.pop(k, None)

    def out(line: str) -> None:
        log(f"[{name}] {line}")
        job["log"].append(line)
        del job["log"][:-300]

    def runner() -> None:
        try:
            job["status"] = "ok" if fn(out) else "error"
        except Exception as exc:  # noqa: BLE001
            out(f"ошибка: {type(exc).__name__}: {exc}")
            job["status"] = "error"
        finally:
            job["finished"] = time.time()
            _job_running.release()

    threading.Thread(target=runner, name=f"job-{name}", daemon=True).start()
    return jid


def job_apply(cfg: dict[str, Any]) -> Callable[[Callable[[str], None]], bool]:
    """новые домены / пути вебхуков от панели."""
    upd: dict[str, str] = {}
    d = cfg.get("domains") or {}
    for key, envk in (("app", "APP_DOMAIN"), ("sub", "SUB_DOMAIN"), ("hook", "HOOK_DOMAIN")):
        v = str(d.get(key) or "").strip().lower()
        if v:
            if not DOMAIN_RE.fullmatch(v):
                raise ValueError(f"неверный домен {key}: {v}")
            upd[envk] = v
    names = [upd.get("APP_DOMAIN") or env("APP_DOMAIN"), upd.get("SUB_DOMAIN") or env("SUB_DOMAIN"),
             upd.get("HOOK_DOMAIN") or env("HOOK_DOMAIN")]
    if len(set(names)) != 3:
        raise ValueError("домены мини-аппа, подписки и вебхуков должны различаться")
    hooks = cfg.get("hook_paths")
    if hooks is not None:
        hooks = [str(h) for h in hooks if HOOK_RE.fullmatch(str(h))]
        if not hooks:
            raise ValueError("пустой список путей вебхуков")
        upd["HOOK_PATHS"] = ",".join(sorted(set(hooks)))
    email = str(cfg.get("email") or "").strip()
    if email and re.fullmatch(r"[^@\s]{1,64}@[^@\s]{3,190}", email):
        upd["SSL_EMAIL"] = email

    def fn(out: Callable[[str], None]) -> bool:
        old_sub = env("SUB_DOMAIN")
        if not ensure_certs(names, upd.get("SSL_EMAIL") or env("SSL_EMAIL"), out):
            out("домены не изменены: нет сертификатов")
            return False
        prev = dict(ENV)
        write_env(upd)
        reload_env()
        if not render_nginx(out):
            # вернуть прежние домены
            write_env({k: prev.get(k, "") for k in upd})
            reload_env()
            render_nginx(out)
            return False
        if env("SUB_DOMAIN") != old_sub:
            out("перезапуск XBM под новый домен подписки…")
            compose(["up", "-d", "xbm"], out, timeout=600)
        out("готово")
        return True

    return fn


def job_update(branch: str) -> Callable[[Callable[[str], None]], bool]:
    if branch and not re.fullmatch(r"[A-Za-z0-9._/-]{1,64}", branch):
        raise ValueError("неверная ветка")

    def fn(out: Callable[[str], None]) -> bool:
        br = branch or env("REPO_BRANCH", "main")
        for cmd in (["git", "fetch", "--depth", "50", "origin", br], ["git", "reset", "--hard", f"origin/{br}"]):
            code, _ = run(cmd, cwd=PROJECT, timeout=600, out=out)
            if code != 0:
                return False
        if compose(["build"], out) != 0:
            out("сборка не удалась — работающие контейнеры не тронуты")
            return False
        if compose(["up", "-d", "--remove-orphans"], out, timeout=600) != 0:
            return False
        reload_env()
        render_nginx(out)
        out("перезапуск агента через 2 секунды")
        threading.Timer(2.0, lambda: run(["systemctl", "restart", "blinvpn-agent"], timeout=60)).start()
        return True

    return fn


# ── почта (отправка с IP edge) ────────────────────────────────────

def _resolve_mx(dom: str) -> list[str]:
    try:
        import dns.resolver  # type: ignore
        answers = dns.resolver.resolve(dom, "MX")
        return [str(r.exchange).rstrip(".") for r in sorted(answers, key=lambda r: r.preference)]
    except Exception:  # noqa: BLE001
        return [dom]


def _public_ip(host: str) -> Optional[str]:
    try:
        infos = socket.getaddrinfo(host, 25, proto=socket.IPPROTO_TCP)
    except OSError:
        return None
    for info in infos:
        try:
            a = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if a.is_private or a.is_loopback or a.is_link_local or a.is_reserved or a.is_multicast:
            continue
        return str(a)
    return None


def mail_send(p: dict[str, Any]) -> dict[str, Any]:
    to = str(p.get("to") or "").strip()
    sender = str(p.get("from") or "").strip()
    if not re.fullmatch(r"[^@\s<>]{1,64}@[^@\s<>]{3,190}", to) or "@" not in sender:
        return {"ok": False, "error": "неверный адрес"}
    try:
        message = base64.b64decode(str(p.get("message_b64") or ""), validate=True)
    except (ValueError, TypeError):
        return {"ok": False, "error": "неверное письмо"}
    if not message or len(message) > 5 * 1024 * 1024:
        return {"ok": False, "error": "неверное письмо"}
    timeout = min(max(float(p.get("timeout") or 20), 5.0), 60.0)
    ehlo = str(p.get("ehlo") or "localhost")
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", ehlo):
        ehlo = "localhost"
    if p.get("mode") == "smtp":
        r = p.get("relay") or {}
        host, port = str(r.get("host") or ""), int(r.get("port") or 587)
        if not re.fullmatch(r"[A-Za-z0-9.-]{3,253}", host):
            return {"ok": False, "error": "неверный SMTP-сервер"}
        ctx = ssl.create_default_context()
        try:
            if port == 465:
                s = smtplib.SMTP_SSL(host, port, timeout=timeout, context=ctx, local_hostname=ehlo)
            else:
                s = smtplib.SMTP(host, port, timeout=timeout, local_hostname=ehlo)
                s.ehlo()
                s.starttls(context=ctx)
                s.ehlo()
            try:
                if r.get("user"):
                    s.login(str(r["user"]), str(r.get("password") or ""))
                s.sendmail(sender, [to], message)
            finally:
                try:
                    s.quit()
                except Exception:  # noqa: BLE001
                    pass
            return {"ok": True}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"SMTP {host}:{port}: {type(exc).__name__}: {exc}"[:300]}
    # напрямую на MX получателя
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last = "нет доступных MX"
    blocked = False
    for host in _resolve_mx(to.split("@")[-1]):
        ip = _public_ip(host)
        if not ip:
            last = f"{host}: не публичный/не резолвится"
            continue
        try:
            s = smtplib.SMTP(ip, 25, timeout=timeout, local_hostname=ehlo)
            try:
                s.ehlo(ehlo)
                try:
                    if s.has_extn("starttls"):
                        s.starttls(context=ctx)
                        s.ehlo(ehlo)
                except (smtplib.SMTPException, ssl.SSLError):
                    pass
                s.mail(sender)
                s.rcpt(to)
                code, _ = s.data(message)
                if 200 <= code < 300:
                    return {"ok": True}
                last = f"MX {host} ответил кодом {code}"
            finally:
                try:
                    s.quit()
                except Exception:  # noqa: BLE001
                    pass
        except Exception as exc:  # noqa: BLE001
            last = f"{host}: {type(exc).__name__}: {exc}"
            if isinstance(exc, OSError) and not isinstance(exc, smtplib.SMTPException):
                blocked = True
    if blocked:
        last += " — похоже, хостинг edge закрыл исходящий порт 25. Настройте отправку через почтовый ящик (Настройки → Почта)"
    return {"ok": False, "error": last[:400]}


def mail_smtp_test(p: dict[str, Any]) -> dict[str, Any]:
    host, port = str(p.get("host") or ""), int(p.get("port") or 465)
    if not re.fullmatch(r"[A-Za-z0-9.-]{3,253}", host):
        return {"ok": False, "error": "неверный сервер"}
    ctx = ssl.create_default_context()
    try:
        if port == 465:
            s = smtplib.SMTP_SSL(host, port, timeout=15, context=ctx)
        else:
            s = smtplib.SMTP(host, port, timeout=15)
            s.ehlo()
            s.starttls(context=ctx)
            s.ehlo()
        try:
            s.login(str(p.get("user") or ""), str(p.get("password") or ""))
        finally:
            try:
                s.quit()
            except Exception:  # noqa: BLE001
                pass
        return {"ok": True}
    except smtplib.SMTPAuthenticationError:
        return {"ok": False, "error": "Неверная почта или пароль. Нужен именно пароль приложения, а не обычный пароль"}
    except (socket.timeout, TimeoutError):
        return {"ok": False, "error": f"{host}:{port} не отвечает"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:200]}


def port25_open() -> bool:
    for host in ("gmail-smtp-in.l.google.com", "mx.yandex.ru"):
        try:
            with socket.create_connection((host, 25), timeout=6):
                return True
        except OSError:
            continue
    return False


# ── состояние ─────────────────────────────────────────────────────

def public_ip() -> str:
    ip = env("EDGE_PUBLIC_IP")
    if ip:
        return ip
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as so:
            so.connect(("1.1.1.1", 53))
            return so.getsockname()[0]
    except OSError:
        return ""


def _alive(url: str, ok_codes: Callable[[int], bool], headers: Optional[dict[str, str]] = None) -> bool:
    try:
        code, _h, _b = http_get(url, headers, timeout=3.0, limit=65536)
        return ok_codes(code)
    except Exception:  # noqa: BLE001
        return False


def xbm_config_sha() -> dict[str, Any]:
    try:
        with open(XBM_STATE, "rb") as f:
            data = f.read()
        return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    except OSError:
        return {"sha256": None, "size": 0}


def health() -> dict[str, Any]:
    nginx_ok = run(["systemctl", "is-active", "--quiet", "nginx"], timeout=10)[0] == 0
    ingress = env("INGRESS_ADDR", "10.213.0.1:8443")
    return {
        "ok": True, "version": VERSION, "protocol": PROTOCOL, "time": int(time.time()),
        "uptime": int(time.time() - STARTED), "public_ip": public_ip(), "domains": domains(),
        "nginx": {"running": nginx_ok},
        "xbm": {"running": _alive(f"http://127.0.0.1:{env('XBM_PORT', '4100')}/health", lambda c: c == 200)},
        "subpage": {"running": _alive(f"http://127.0.0.1:{env('SUBPAGE_PORT', '3010')}/", lambda c: c < 500,
                                      {"X-Forwarded-For": "127.0.0.1", "X-Forwarded-Proto": "https"})},
        "miniapp": {"running": _alive(f"http://127.0.0.1:{env('MINIAPP_PORT', '9741')}/", lambda c: c == 200)},
        "ingress": {"ok": _alive(f"http://{ingress}/__ingress/health", lambda c: c == 200,
                                 {"X-Edge-Token": env("EDGE_TOKEN")})},
        "xbm_config": xbm_config_sha(),
    }


# ── HTTP ──────────────────────────────────────────────────────────

_nonces: dict[str, float] = {}
_nonce_lock = threading.Lock()
MAX_BODY = 8 * 1024 * 1024


def verify(method: str, path: str, headers: Any, body: bytes) -> Optional[str]:
    key = env("EDGE_AGENT_KEY")
    if len(key) < 32:
        return "ключ агента не задан"
    ts, nonce, sig = headers.get("X-Blin-Ts") or "", headers.get("X-Blin-Nonce") or "", headers.get("X-Blin-Sig") or ""
    if not (ts.isdigit() and re.fullmatch(r"[0-9a-f]{16,64}", nonce) and re.fullmatch(r"[0-9a-f]{64}", sig)):
        return "нет подписи"
    if abs(time.time() - int(ts)) > 120:
        return "время запроса вне окна (проверьте синхронизацию часов)"
    msg = "\n".join([method.upper(), path, ts, nonce, hashlib.sha256(body).hexdigest()]).encode()
    want = hmac.new(key.encode(), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, sig):
        return "неверная подпись"
    now = time.time()
    with _nonce_lock:
        for k in [k for k, t in _nonces.items() if now - t > 300]:
            _nonces.pop(k, None)
        if nonce in _nonces:
            return "повтор запроса"
        _nonces[nonce] = now
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "blin"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # тише: только ошибки
        pass

    def _send(self, code: int, obj: Any = None, raw: Optional[bytes] = None,
              ctype: str = "application/json") -> None:
        data = raw if raw is not None else json.dumps(obj if obj is not None else {}, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _handle(self) -> None:
        peer = self.client_address[0]
        allowed = env("PANEL_WG_IP", "10.213.0.1")
        if peer != allowed:
            return self._send(403, {"error": "forbidden"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send(400, {"error": "bad length"})
        if length < 0 or length > MAX_BODY:
            return self._send(413, {"error": "too large"})
        body = self.rfile.read(length) if length else b""
        err = verify(self.command, self.path, self.headers, body)
        if err:
            log(f"отклонён запрос {self.command} {self.path}: {err}")
            return self._send(401, {"error": err})
        try:
            return self._route(self.command.upper(), self.path, body)
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except RuntimeError as e:
            return self._send(409, {"error": str(e)})
        except Exception as exc:  # noqa: BLE001
            log(f"ошибка {self.command} {self.path}: {type(exc).__name__}: {exc}")
            return self._send(500, {"error": f"{type(exc).__name__}"})

    def _json(self, body: bytes) -> dict[str, Any]:
        try:
            v = json.loads(body.decode("utf-8") or "{}")
        except ValueError:
            raise ValueError("неверный JSON")
        if not isinstance(v, dict):
            raise ValueError("ожидался объект")
        return v

    def _route(self, method: str, path: str, body: bytes) -> None:
        if method == "GET" and path == "/agent/health":
            return self._send(200, health())
        if method == "GET" and path == "/agent/version":
            return self._send(200, {"version": VERSION, "protocol": PROTOCOL})
        if path == "/agent/xbm/config":
            if method == "GET":
                return self._send(200, xbm_config_sha())
            if method == "PUT":
                if len(body) > 2 * 1024 * 1024:
                    raise ValueError("настройки XBM слишком большие")
                doc = json.loads(body.decode("utf-8"))
                if not isinstance(doc, dict):
                    raise ValueError("ожидался объект")
                os.makedirs(os.path.dirname(XBM_STATE), mode=0o755, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix=".panel-", dir=os.path.dirname(XBM_STATE))
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(body)
                        f.flush()
                        os.fsync(f.fileno())
                    os.chmod(tmp, 0o644)
                    os.replace(tmp, XBM_STATE)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
                return self._send(200, xbm_config_sha())
        if method == "GET" and path.startswith("/agent/xbm/"):
            sub = path[len("/agent/xbm"):]
            if sub != "/health" and not SHORT_RE.fullmatch(sub.lstrip("/")):
                return self._send(404, {"error": "not found"})
            hdrs = {"X-Real-IP": "127.0.0.1"}
            for k in ("User-Agent", "X-HWID"):
                v = self.headers.get(k)
                if v and len(v) <= 256:
                    hdrs[k] = v
            try:
                code, h, data = http_get(f"http://127.0.0.1:{env('XBM_PORT', '4100')}{sub}", hdrs, timeout=12.0)
            except Exception as exc:  # noqa: BLE001
                return self._send(502, {"error": f"XBM недоступен: {type(exc).__name__}"})
            return self._send(code, raw=data, ctype=h.get("Content-Type") or "application/octet-stream")
        if method == "POST" and path == "/agent/mail/send":
            return self._send(200, mail_send(self._json(body)))
        if method == "POST" and path == "/agent/mail/smtp-test":
            return self._send(200, mail_smtp_test(self._json(body)))
        if method == "POST" and path == "/agent/mail/port25":
            return self._send(200, {"open": port25_open(), "server_ip": public_ip()})
        if method == "POST" and path == "/agent/apply":
            return self._send(200, {"job": start_job("apply", job_apply(self._json(body)))})
        if method == "POST" and path == "/agent/update":
            cfg = self._json(body)
            return self._send(200, {"job": start_job("update", job_update(str(cfg.get("branch") or "")))})
        m = re.fullmatch(r"/agent/jobs/([0-9a-f]{16})", path)
        if method == "GET" and m:
            job = _jobs.get(m.group(1))
            if not job:
                return self._send(404, {"error": "задача не найдена"})
            return self._send(200, {k: job.get(k) for k in ("id", "name", "status", "log")})
        return self._send(404, {"error": "not found"})

    def do_GET(self) -> None:  # noqa: N802
        self._handle()

    def do_POST(self) -> None:  # noqa: N802
        self._handle()

    def do_PUT(self) -> None:  # noqa: N802
        self._handle()


def serve() -> None:
    bind = env("EDGE_AGENT_BIND", "10.213.0.11:9443")
    host, _, port = bind.rpartition(":")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        raise SystemExit(f"EDGE_AGENT_BIND: нужен IP:порт, сейчас {bind!r}")
    if ipaddress.ip_address(host).is_unspecified:
        raise SystemExit("EDGE_AGENT_BIND: нельзя слушать все адреса — только адрес edge в туннеле")
    srv = ThreadingHTTPServer((host, int(port)), Handler)
    srv.daemon_threads = True
    log(f"edge-agent {VERSION} слушает {bind}")
    srv.serve_forever()


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "serve"
    if cmd == "serve":
        serve()
        return 0
    if cmd == "render-nginx":
        return 0 if render_nginx() else 1
    if cmd == "certs":
        d = domains()
        return 0 if ensure_certs([d["app"], d["sub"], d["hook"]], env("SSL_EMAIL")) else 1
    if cmd == "status":
        print(json.dumps(health(), ensure_ascii=False, indent=2))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

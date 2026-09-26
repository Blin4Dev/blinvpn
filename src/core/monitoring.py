"""
Мониторинг серверов BlinVPN.

Схема работы
────────────
• На сервере ставится агент (node.sh в корне проекта). Он сам снимает показания
  и хранит их в памяти; панель раз в минуту забирает новые точки по HTTP.
• Каждый запрос к агенту подписывается секретным ключом ноды (HMAC-SHA256
  метода, пути, времени и одноразового nonce), агент подписывает ответ — так ни
  подделать запрос, ни подменить данные, ни повторить перехваченный запрос нельзя.
  Сам ключ по сети не передаётся.
• Агент ничего не выполняет по командам панели: только отдаёт показания и
  запускает замер скорости. Даже с ключом нельзя получить доступ к серверу.
• Ключи нод и VLESS-ключи хранятся в базе зашифрованными (MONITOR_SECRET_KEY),
  поэтому бэкап базы, отправленный в Telegram, их не раскрывает.

Этот модуль — общий для API панели (core.py) и фонового сервиса (monitor.py).
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
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

try:
    from . import database as db  # type: ignore
    from . import forum  # type: ignore
except ImportError:
    import database as db  # type: ignore
    import forum  # type: ignore

DEFAULT_PORT = 5055
POLL_EVERY = 60                 # сек — опрос агента и TCP-пинг
VLESS_EVERY = 300               # сек — проверка VLESS
RETENTION_DAYS = 7
AGENT_TIMEOUT = 8               # сек — ожидание ответа агента
AGENT_DOWN_AFTER = 3            # столько неудачных опросов подряд → «агент недоступен»
PING_PROBES = 5
PING_TIMEOUT = 2.0
HISTORY_TABLES = ("mon_metrics", "mon_pings", "mon_speed", "mon_vless")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime] = None) -> str:
    return (dt or _now()).isoformat()


def _parse(v: Any) -> Optional[datetime]:
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ─────────────────────────────────────────────────────────────
# Шифрование секретов (Fernet: AES-128-CBC + HMAC-SHA256)
# ─────────────────────────────────────────────────────────────

def _fernet():
    from cryptography.fernet import Fernet, MultiFernet

    keys = []
    for raw, label in ((os.getenv("MONITOR_SECRET_KEY"), b"monitor"), (os.getenv("INTERNAL_API_SECRET"), b"monitor-fallback")):
        raw = (raw or "").strip()
        if raw:
            k = hashlib.sha256(label + b":" + raw.encode()).digest()
            keys.append(Fernet(base64.urlsafe_b64encode(k)))
    if not keys:
        # Только для разработки: без ключей в .env шифруем ключом из базы.
        dev = db.get_setting("monitor_dev_key", "")
        if not dev:
            dev = secrets.token_hex(32)
            db.set_setting("monitor_dev_key", dev)
        keys.append(Fernet(base64.urlsafe_b64encode(hashlib.sha256(dev.encode()).digest())))
    return MultiFernet(keys)


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    try:
        return _fernet().decrypt(token.encode()).decode()
    except Exception:  # noqa: BLE001
        return None


def new_secret() -> str:
    return secrets.token_urlsafe(48)  # 64 символа, 384 бита


# ─────────────────────────────────────────────────────────────
# Проверка вводимых данных
# ─────────────────────────────────────────────────────────────

_HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.I)


class MonitorError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def clean_host(value: Any) -> str:
    v = str(value or "").strip().strip("[]")
    try:
        ip = ipaddress.ip_address(v)
    except ValueError:
        if _HOST_RE.match(v):
            return v.lower()
        raise MonitorError("Укажите IP-адрес или домен сервера")
    if ip.is_loopback and os.getenv("MONITOR_ALLOW_LOOPBACK") == "1":  # только для тестов
        return str(ip)
    if ip.is_loopback or ip.is_multicast or ip.is_unspecified or ip.is_link_local:
        raise MonitorError("Этот адрес нельзя использовать")
    return str(ip)


def clean_port(value: Any) -> int:
    try:
        p = int(value)
    except (TypeError, ValueError):
        raise MonitorError("Порт должен быть числом")
    if not 1024 <= p <= 65535:
        raise MonitorError("Порт — от 1024 до 65535")
    return p


def clean_name(value: Any) -> str:
    v = re.sub(r"\s+", " ", str(value or "")).strip()
    if not v:
        raise MonitorError("Укажите название ноды")
    return v[:64]


def clean_url(value: Any) -> Optional[str]:
    v = str(value or "").strip()
    if not v:
        return None
    p = urllib.parse.urlsplit(v)
    if p.scheme not in ("http", "https") or not p.netloc or len(v) > 500:
        raise MonitorError("Ссылка на оплату должна начинаться с https://")
    return v


# ─────────────────────────────────────────────────────────────
# Клиент агента (подписанные запросы)
# ─────────────────────────────────────────────────────────────

class AgentError(Exception):
    pass


def _sign(secret: str, msg: str) -> str:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()


def agent_request(node: dict[str, Any], method: str, target: str, timeout: float = AGENT_TIMEOUT) -> dict[str, Any]:
    secret = decrypt(node.get("secret_enc"))
    if not secret:
        raise AgentError("Ключ ноды не расшифровывается — перевыпустите ключ")
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    sig = _sign(secret, f"{method}\n{target}\n{ts}\n{nonce}")
    host = node["ip"]
    netloc = f"[{host}]" if ":" in host else host
    req = urllib.request.Request(
        f"http://{netloc}:{int(node['port'])}{target}", method=method, data=b"" if method == "POST" else None,
        headers={"X-Blin-Ts": ts, "X-Blin-Nonce": nonce, "X-Blin-Sig": sig, "User-Agent": "blinvpn-panel"},
    )
    # Никаких редиректов и прокси из окружения
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read(4 * 1024 * 1024)
            rsig = resp.headers.get("X-Blin-Sig", "")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise AgentError("Агент отклонил ключ (ключ не совпадает или часы сервера сбиты)")
        raise AgentError(f"Агент ответил ошибкой {e.code}")
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        reason = getattr(e, "reason", e)
        text = str(reason).lower()
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in text:
            human = "превышено время ожидания (сервер выключен или порт закрыт фаерволом)"
        elif isinstance(reason, ConnectionRefusedError) or "refused" in text:
            human = "порт закрыт — агент не установлен или не запущен"
        elif "no route" in text or "unreachable" in text:
            human = "адрес недоступен"
        else:
            human = str(reason)
        raise AgentError(f"Нет связи с агентом: {human}")
    expected = _sign(secret, f"resp\n{nonce}\n{hashlib.sha256(body).hexdigest()}")
    if not hmac.compare_digest(rsig, expected):
        raise AgentError("Ответ не подписан ключом ноды — возможно, на этом адресе не наш агент")
    try:
        data = json.loads(body)
    except ValueError:
        raise AgentError("Агент прислал некорректный ответ")
    if not isinstance(data, dict):
        raise AgentError("Агент прислал некорректный ответ")
    return data


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # noqa: D401
        return None


# ─────────────────────────────────────────────────────────────
# TCP-«пинг»: доступность и потери без root/ICMP
# ─────────────────────────────────────────────────────────────

def tcp_ping(host: str, port: int, probes: int = PING_PROBES) -> dict[str, Any]:
    """
    Несколько попыток TCP-соединения с портом агента. Отказ в соединении (RST)
    тоже считается ответом сервера — он жив. Таймаут = потерянный пакет.
    """
    rtts: list[float] = []
    lost = 0
    for i in range(probes):
        t0 = time.perf_counter()
        try:
            with socket.create_connection((host, port), timeout=PING_TIMEOUT):
                pass
            rtts.append((time.perf_counter() - t0) * 1000)
        except ConnectionRefusedError:
            rtts.append((time.perf_counter() - t0) * 1000)
        except OSError:
            lost += 1
        if i < probes - 1:
            time.sleep(0.2)
    return {"sent": probes, "lost": lost, "rtt_ms": round(sum(rtts) / len(rtts), 1) if rtts else None}


# ─────────────────────────────────────────────────────────────
# VLESS: разбор ссылки и проверка через Xray
# ─────────────────────────────────────────────────────────────

def parse_vless(uri: str) -> dict[str, Any]:
    uri = (uri or "").strip()
    p = urllib.parse.urlsplit(uri)
    if p.scheme != "vless" or not p.hostname or not p.username:
        raise MonitorError("Нужна ссылка вида vless://uuid@host:port?...")
    try:
        user_id = str(_uuid.UUID(urllib.parse.unquote(p.username)))
    except ValueError:
        raise MonitorError("В VLESS-ссылке неверный UUID")
    host = clean_host(p.hostname)
    port = p.port
    if not port:
        raise MonitorError("В VLESS-ссылке нет порта")
    q = {k: v[0] for k, v in urllib.parse.parse_qs(p.query).items()}
    net = (q.get("type") or "tcp").lower()
    net = {"raw": "tcp", "splithttp": "xhttp"}.get(net, net)
    if net not in ("tcp", "ws", "grpc", "httpupgrade", "xhttp"):
        raise MonitorError(f"Транспорт «{net}» не поддерживается проверкой")
    sec = (q.get("security") or "none").lower()
    if sec not in ("none", "tls", "reality"):
        raise MonitorError(f"Security «{sec}» не поддерживается проверкой")
    flow = q.get("flow") or ""
    if flow and not re.fullmatch(r"[a-z0-9-]{1,40}", flow):
        raise MonitorError("Неверный flow")
    return {"id": user_id, "host": host, "port": int(port), "net": net, "sec": sec, "flow": flow, "q": q,
            "name": urllib.parse.unquote(p.fragment or "")[:64]}


def _s(v: Any, n: int = 256) -> str:
    return str(v or "")[:n]


def xray_config(v: dict[str, Any], http_port: int) -> dict[str, Any]:
    q = v["q"]
    stream: dict[str, Any] = {"network": v["net"], "security": v["sec"]}
    sni = _s(q.get("sni") or q.get("host") or (v["host"] if not re.match(r"^[\d.:]+$", v["host"]) else ""))
    if v["sec"] == "tls":
        tls: dict[str, Any] = {"serverName": sni, "allowInsecure": False}
        if q.get("fp"):
            tls["fingerprint"] = _s(q["fp"], 32)
        if q.get("alpn"):
            tls["alpn"] = [a for a in _s(q["alpn"]).split(",") if a]
        stream["tlsSettings"] = tls
    elif v["sec"] == "reality":
        stream["realitySettings"] = {
            "serverName": sni, "fingerprint": _s(q.get("fp") or "chrome", 32),
            "publicKey": _s(q.get("pbk"), 128), "shortId": _s(q.get("sid"), 32), "spiderX": _s(q.get("spx") or "/", 128),
        }
    path = _s(q.get("path") or "/")
    host_hdr = _s(q.get("host"))
    if v["net"] == "ws":
        stream["wsSettings"] = {"path": path, **({"host": host_hdr} if host_hdr else {})}
    elif v["net"] == "grpc":
        stream["grpcSettings"] = {"serviceName": _s(q.get("serviceName")), "multiMode": q.get("mode") == "multi"}
    elif v["net"] == "httpupgrade":
        stream["httpupgradeSettings"] = {"path": path, **({"host": host_hdr} if host_hdr else {})}
    elif v["net"] == "xhttp":
        stream["xhttpSettings"] = {"path": path, "mode": _s(q.get("mode") or "auto", 32), **({"host": host_hdr} if host_hdr else {})}
    elif v["net"] == "tcp" and q.get("headerType") == "http":
        stream["tcpSettings"] = {"header": {"type": "http", "request": {"path": [path], "headers": {"Host": [host_hdr]} if host_hdr else {}}}}
    user: dict[str, Any] = {"id": v["id"], "encryption": "none"}
    if v["flow"]:
        user["flow"] = v["flow"]
    return {
        "log": {"loglevel": "none"},
        "inbounds": [{"listen": "127.0.0.1", "port": http_port, "protocol": "http", "settings": {}}],
        "outbounds": [{"protocol": "vless", "settings": {"vnext": [{"address": v["host"], "port": v["port"], "users": [user]}]},
                       "streamSettings": stream}],
    }


def xray_bin() -> Optional[str]:
    cand = os.getenv("XRAY_BIN") or shutil.which("xray") or "/usr/local/bin/xray"
    return cand if cand and os.path.isfile(cand) and os.access(cand, os.X_OK) else None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get_via_proxy(proxy_port: int, url: str, timeout: float) -> int:
    """GET через HTTP-прокси Xray явно (CONNECT для https) — без переменных окружения *_proxy."""
    import http.client
    import ssl

    u = urllib.parse.urlsplit(url)
    path = u.path or "/"
    if u.scheme == "https":
        conn = http.client.HTTPSConnection("127.0.0.1", proxy_port, timeout=timeout, context=ssl.create_default_context())
        conn.set_tunnel(u.hostname, u.port or 443)
        conn.request("GET", path, headers={"User-Agent": "blinmon-check", "Host": u.hostname})
    else:
        conn = http.client.HTTPConnection("127.0.0.1", proxy_port, timeout=timeout)
        conn.request("GET", url, headers={"User-Agent": "blinmon-check"})
    try:
        r = conn.getresponse()
        r.read(1024)
        return r.status
    finally:
        conn.close()


def check_vless(uri: str, target: str = "https://www.gstatic.com/generate_204", timeout: float = 12.0) -> dict[str, Any]:
    """Поднимает Xray с этим VLESS-ключом и делает через него HTTPS-запрос."""
    try:
        v = parse_vless(uri)
    except MonitorError as e:
        return {"ok": False, "error": e.message}
    xb = xray_bin()
    if not xb:
        return {"ok": None, "error": "Xray не установлен на сервере панели"}
    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="blinmon-") as tmp:
        cfg = os.path.join(tmp, "config.json")
        fd = os.open(cfg, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(xray_config(v, port), f)
        proc = subprocess.Popen([xb, "run", "-c", cfg], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, cwd=tmp, env={"PATH": "/usr/bin:/bin"})
        try:
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                        break
                except OSError:
                    if proc.poll() is not None:
                        return {"ok": False, "error": "Xray не принял конфигурацию из этого ключа"}
                    time.sleep(0.15)
            t0 = time.perf_counter()
            code = _get_via_proxy(port, target, timeout)
            ms = round((time.perf_counter() - t0) * 1000, 1)
            if 200 <= code < 400:
                return {"ok": True, "ms": ms}
            return {"ok": False, "error": f"HTTP {code}", "ms": ms}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": _short_err(e)}
        finally:
            proc.kill()
            try:
                proc.wait(timeout=3)
            except Exception:  # noqa: BLE001
                pass


def _short_err(e: Exception) -> str:
    reason = getattr(e, "reason", None)
    return str(reason or e or type(e).__name__)[:160]


# ─────────────────────────────────────────────────────────────
# Ноды
# ─────────────────────────────────────────────────────────────

def get_node(node_id: int) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM mon_nodes WHERE id = ?", (int(node_id),))


def create_node(name: Any, ip: Any, port: Any = DEFAULT_PORT) -> tuple[dict[str, Any], str]:
    name, ip, port = clean_name(name), clean_host(ip), clean_port(port or DEFAULT_PORT)
    if db.fetchone("SELECT id FROM mon_nodes WHERE ip = ? AND port = ?", (ip, port)):
        raise MonitorError("Нода с таким адресом и портом уже есть")
    secret = new_secret()
    db.execute(
        "INSERT INTO mon_nodes (name, ip, port, secret_enc, enabled, created_at) VALUES (?, ?, ?, ?, 0, ?)",
        (name, ip, port, encrypt(secret), _iso()),
    )
    node = get_node(db.last_id())
    assert node is not None
    return node, secret


def rotate_secret(node_id: int) -> str:
    secret = new_secret()
    db.execute("UPDATE mon_nodes SET secret_enc = ?, enabled = 0 WHERE id = ?", (encrypt(secret), int(node_id)))
    return secret


def update_node(node_id: int, fields: dict[str, Any]) -> dict[str, Any]:
    node = get_node(node_id)
    if not node:
        raise MonitorError("Нода не найдена", 404)
    sets: dict[str, Any] = {}
    if "name" in fields and fields["name"] is not None:
        sets["name"] = clean_name(fields["name"])
    if "ip" in fields and fields["ip"] is not None:
        sets["ip"] = clean_host(fields["ip"])
    if "port" in fields and fields["port"] is not None:
        sets["port"] = clean_port(fields["port"])
    if "vless" in fields and fields["vless"] is not None:
        raw = str(fields["vless"]).strip()
        if raw:
            parse_vless(raw)
            sets.update({"vless_enc": encrypt(raw), "vless_ok": None, "vless_checked_at": None,
                         "vless_fail_count": 0, "vless_error": None})
        else:
            sets.update({"vless_enc": None, "vless_ok": None, "vless_checked_at": None, "vless_fail_count": 0, "vless_error": None})
            resolve_incident(node, "vless_down")
    if "pay_date" in fields and fields["pay_date"] is not None:
        raw = str(fields["pay_date"]).strip()
        if raw:
            dt = _parse(raw)
            if not dt:
                raise MonitorError("Неверная дата оплаты")
            sets["pay_date"] = dt.astimezone(timezone.utc).isoformat()
        else:
            sets["pay_date"] = None
        sets["pay_notified"] = None
    if "pay_url" in fields and fields["pay_url"] is not None:
        sets["pay_url"] = clean_url(fields["pay_url"])
    if sets:
        cols = ", ".join(f"{k} = ?" for k in sets)
        db.execute(f"UPDATE mon_nodes SET {cols} WHERE id = ?", (*sets.values(), int(node_id)))
    return get_node(node_id) or node


def delete_node(node_id: int) -> None:
    for t in (*HISTORY_TABLES, "mon_incidents"):
        db.execute(f"DELETE FROM {t} WHERE node_id = ?", (int(node_id),))
    db.execute("DELETE FROM mon_nodes WHERE id = ?", (int(node_id),))


def start_node(node_id: int) -> dict[str, Any]:
    """«Запустить»: проверяем связь с агентом и включаем мониторинг."""
    node = get_node(node_id)
    if not node:
        raise MonitorError("Нода не найдена", 404)
    try:
        data = agent_request(node, "GET", "/v1/status?since=0&speed_since=0")
    except AgentError as e:
        raise MonitorError(str(e), 502)
    db.execute("UPDATE mon_nodes SET enabled = 1, started_at = COALESCE(started_at, ?), fail_count = 0, "
               "cursor = 0, speed_cursor = 0, boot_id = NULL WHERE id = ?", (_iso(), int(node_id)))
    ingest(get_node(node_id) or node, data)
    return get_node(node_id) or node


def stop_node(node_id: int) -> None:
    db.execute("UPDATE mon_nodes SET enabled = 0 WHERE id = ?", (int(node_id),))
    node = get_node(node_id)
    if node:
        for kind in _OPEN_KINDS:
            resolve_incident(node, kind, notify=False)


def trigger_speedtest(node_id: int) -> dict[str, Any]:
    node = get_node(node_id)
    if not node:
        raise MonitorError("Нода не найдена", 404)
    try:
        res = agent_request(node, "POST", "/v1/speedtest", timeout=10)
    except AgentError as e:
        raise MonitorError(str(e), 502)
    if res.get("queued"):
        db.execute("UPDATE mon_nodes SET speed_running = 1 WHERE id = ?", (int(node_id),))
    return res


# ─────────────────────────────────────────────────────────────
# Приём данных агента
# ─────────────────────────────────────────────────────────────

def _int(v: Any) -> Optional[int]:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _num(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def ingest(node: dict[str, Any], data: dict[str, Any]) -> None:
    nid = int(node["id"])
    samples = [s for s in (data.get("samples") or []) if isinstance(s, dict)][-1000:]
    speeds = [s for s in (data.get("speed") or []) if isinstance(s, dict)][-300:]
    cutoff = int(time.time()) - RETENTION_DAYS * 86400
    now_i = int(time.time()) + 600
    with db.transaction() as tx:
        for s in samples:
            ts = _int(s.get("ts"))
            if not ts or ts < cutoff or ts > now_i:
                continue
            tx.execute(
                "INSERT OR IGNORE INTO mon_metrics (node_id, ts, cpu, cpu_max, ram_used, ram_total, disk_used, disk_total, "
                "disk_read, disk_write, net_rx, net_tx, load1) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (nid, ts, _num(s.get("cpu")), _num(s.get("cpu_max")), _int(s.get("ram_used")), _int(s.get("ram_total")),
                 _int(s.get("disk_used")), _int(s.get("disk_total")), _int(s.get("disk_read_bps")), _int(s.get("disk_write_bps")),
                 _int(s.get("net_rx_bps")), _int(s.get("net_tx_bps")), _num(s.get("load1"))),
            )
        for s in speeds:
            ts = _int(s.get("ts"))
            if not ts or ts < cutoff or ts > now_i:
                continue
            tx.execute(
                "INSERT OR IGNORE INTO mon_speed (node_id, ts, ok, down, up, ping_ms, manual, error) VALUES (?,?,?,?,?,?,?,?)",
                (nid, ts, 1 if s.get("ok") else 0, _num(s.get("down_mbps")), _num(s.get("up_mbps")), _num(s.get("ping_ms")),
                 1 if s.get("manual") else 0, str(s.get("error") or "")[:80] or None),
            )
        live = data.get("live") if isinstance(data.get("live"), dict) else {}
        tx.execute(
            "UPDATE mon_nodes SET last_seen = ?, last_error = NULL, fail_count = 0, agent_version = ?, boot_id = ?, "
            "cursor = ?, speed_cursor = ?, uptime = ?, cores = ?, live_json = ?, speed_running = ? WHERE id = ?",
            (_iso(), str(data.get("version") or "")[:16], str(data.get("boot_id") or "")[:32],
             _int(data.get("seq")) or 0, _int(data.get("speed_seq")) or 0, _int(data.get("uptime")), _int(data.get("cores")),
             json.dumps({k: live.get(k) for k in ("cpu", "ram_used", "ram_total", "swap_used", "swap_total", "disk_used",
                                                   "disk_total", "disk_read_bps", "disk_write_bps", "net_rx_bps", "net_tx_bps",
                                                   "load1", "ts")}),
             1 if data.get("speed_running") else 0, nid),
        )


def poll_node(node: dict[str, Any]) -> bool:
    """Один опрос: данные агента + TCP-пинг. True — агент ответил."""
    nid = int(node["id"])
    cursor, sp_cursor = int(node.get("cursor") or 0), int(node.get("speed_cursor") or 0)
    ok = False
    try:
        data = agent_request(node, "GET", f"/v1/status?since={cursor}&speed_since={sp_cursor}")
        if node.get("boot_id") and data.get("boot_id") != node.get("boot_id"):
            # Агент перезапускался — нумерация точек началась заново: забираем весь буфер.
            data = agent_request(node, "GET", "/v1/status?since=0&speed_since=0")
        ingest(node, data)
        ok = True
    except AgentError as e:
        db.execute("UPDATE mon_nodes SET fail_count = fail_count + 1, last_error = ? WHERE id = ?", (str(e)[:200], nid))
    ping = tcp_ping(node["ip"], int(node["port"]))
    minute = int(time.time()) // 60 * 60
    db.execute("INSERT OR REPLACE INTO mon_pings (node_id, ts, sent, lost, rtt_ms, agent_ok) VALUES (?,?,?,?,?,?)",
               (nid, minute, ping["sent"], ping["lost"], ping["rtt_ms"], 1 if ok else 0))
    return ok


def vless_node(node: dict[str, Any]) -> None:
    uri = decrypt(node.get("vless_enc"))
    if not uri:
        return
    res = check_vless(uri)
    nid = int(node["id"])
    if res.get("ok") is None:  # Xray не установлен — это не проблема ноды
        db.execute("UPDATE mon_nodes SET vless_ok = NULL, vless_error = ?, vless_checked_at = ? WHERE id = ?",
                   (res.get("error"), _iso(), nid))
        return
    ok = bool(res.get("ok"))
    db.execute("INSERT OR REPLACE INTO mon_vless (node_id, ts, ok, ms, error) VALUES (?,?,?,?,?)",
               (nid, int(time.time()), 1 if ok else 0, res.get("ms"), None if ok else str(res.get("error"))[:160]))
    db.execute(
        "UPDATE mon_nodes SET vless_ok = ?, vless_error = ?, vless_checked_at = ?, "
        "vless_fail_count = CASE WHEN ? THEN 0 ELSE vless_fail_count + 1 END WHERE id = ?",
        (1 if ok else 0, None if ok else str(res.get("error"))[:160], _iso(), 1 if ok else 0, nid),
    )


# ─────────────────────────────────────────────────────────────
# Статус ноды (цвет)
# ─────────────────────────────────────────────────────────────

def agent_ok(node: dict[str, Any]) -> bool:
    seen = _parse(node.get("last_seen"))
    return (bool(node.get("enabled")) and seen is not None
            and int(node.get("fail_count") or 0) < AGENT_DOWN_AFTER
            and _now() - seen < timedelta(seconds=POLL_EVERY * AGENT_DOWN_AFTER + 30))


def status_of(node: dict[str, Any]) -> str:
    """
    idle   — мониторинг не запущен (серый);
    green  — агент на связи и VLESS работает (или не задан);
    yellow — агент на связи, VLESS не работает;
    orange — агент не отвечает, VLESS работает;
    red    — не работает ни агент, ни VLESS (или VLESS не задан).
    """
    if not node.get("enabled"):
        return "idle"
    a = agent_ok(node)
    has_vless = bool(node.get("vless_enc")) and node.get("vless_ok") is not None
    v = bool(node.get("vless_ok")) if has_vless else None
    if a:
        return "yellow" if v is False else "green"
    return "orange" if v is True else "red"


STATUS_LABEL = {"idle": "Не запущена", "green": "Работает", "yellow": "VLESS не отвечает",
                "orange": "Агент не отвечает", "red": "Недоступна"}


# ─────────────────────────────────────────────────────────────
# Инциденты
# ─────────────────────────────────────────────────────────────

_OPEN_KINDS = ("agent_down", "host_down", "packet_loss", "vless_down", "cpu_high", "ram_high",
               "disk_high", "speed_drop", "speed_fail")


def _fmt_dur(sec: float) -> str:
    sec = int(sec)
    if sec < 3600:
        return f"{max(1, sec // 60)} мин"
    if sec < 86400:
        return f"{sec // 3600} ч {sec % 3600 // 60} мин"
    return f"{sec // 86400} д {sec % 86400 // 3600} ч"


def _esc(s: Any) -> str:
    return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _node_ref(node: dict[str, Any]) -> str:
    base = forum.panel_url()
    label = f"{_esc(node['name'])} ({_esc(node['ip'])})"
    return f'<a href="{base}/monitoring?node={int(node["id"])}">{label}</a>' if base else f"<b>{label}</b>"


def _notify(text: str) -> None:
    try:
        forum.send("incidents", text)
    except Exception:  # noqa: BLE001
        pass


def open_incident(node: dict[str, Any], kind: str, severity: str, title: str, details: str = "") -> None:
    cur = db.fetchone("SELECT id FROM mon_incidents WHERE node_id = ? AND kind = ? AND resolved_at IS NULL",
                      (int(node["id"]), kind))
    if cur:
        db.execute("UPDATE mon_incidents SET details = ? WHERE id = ?", (details[:500], cur["id"]))
        return
    db.execute("INSERT INTO mon_incidents (node_id, kind, severity, title, details, started_at) VALUES (?,?,?,?,?,?)",
               (int(node["id"]), kind, severity, title, details[:500], _iso()))
    icon = "🔴" if severity == "critical" else "🟠"
    _notify(f"{icon} <b>Инцидент</b> · {_node_ref(node)}\n{_esc(title)}" + (f"\n<i>{_esc(details)}</i>" if details else ""))


def resolve_incident(node: dict[str, Any], kind: str, notify: bool = True) -> None:
    cur = db.fetchone("SELECT * FROM mon_incidents WHERE node_id = ? AND kind = ? AND resolved_at IS NULL",
                      (int(node["id"]), kind))
    if not cur:
        return
    db.execute("UPDATE mon_incidents SET resolved_at = ? WHERE id = ?", (_iso(), cur["id"]))
    if notify:
        started = _parse(cur["started_at"]) or _now()
        _notify(f"✅ <b>Решено</b> · {_node_ref(node)}\n{_esc(cur['title'])}\nДлилось: {_fmt_dur((_now() - started).total_seconds())}")


def log_event(node: dict[str, Any], kind: str, title: str, details: str = "") -> None:
    """Событие без длительности (напоминание об оплате) — сразу закрытое."""
    now = _iso()
    db.execute("INSERT INTO mon_incidents (node_id, kind, severity, title, details, started_at, resolved_at) "
               "VALUES (?,?,?,?,?,?,?)", (int(node["id"]), kind, "info", title, details[:500], now, now))


def _gb(v: Any) -> str:
    try:
        return f"{float(v) / 1024 ** 3:.1f} ГБ"
    except (TypeError, ValueError):
        return "—"


def evaluate(node: dict[str, Any]) -> None:
    """Правила инцидентов для одной ноды (после очередного опроса)."""
    node = get_node(int(node["id"])) or node
    if not node.get("enabled"):
        return
    nid = int(node["id"])
    now = int(time.time())

    # Агент недоступен
    if int(node.get("fail_count") or 0) >= AGENT_DOWN_AFTER:
        open_incident(node, "agent_down", "critical", "Не удаётся связаться с агентом",
                      str(node.get("last_error") or ""))
    elif int(node.get("fail_count") or 0) == 0:
        resolve_incident(node, "agent_down")

    # Доступность сервера (TCP-пинг)
    pings = db.fetchall("SELECT sent, lost FROM mon_pings WHERE node_id = ? ORDER BY ts DESC LIMIT 5", (nid,))
    if len(pings) >= 3 and all(p["lost"] >= p["sent"] for p in pings[:3]):
        open_incident(node, "host_down", "critical", "Сервер не отвечает", "3 минуты подряд нет ответа на порт агента")
    elif pings and pings[0]["lost"] < pings[0]["sent"]:
        resolve_incident(node, "host_down")
    if len(pings) >= 5:
        sent = sum(p["sent"] for p in pings); lost = sum(p["lost"] for p in pings)
        loss = 100.0 * lost / max(1, sent)
        if 20 <= loss < 100:
            open_incident(node, "packet_loss", "warning", f"Потери пакетов {loss:.0f}%", "за последние 5 минут")
        elif loss < 5:
            resolve_incident(node, "packet_loss")

    # VLESS
    if node.get("vless_enc") and node.get("vless_ok") is not None:
        if not node.get("vless_ok") and int(node.get("vless_fail_count") or 0) >= 2:
            open_incident(node, "vless_down", "critical", "VLESS не отвечает", str(node.get("vless_error") or ""))
        elif node.get("vless_ok"):
            resolve_incident(node, "vless_down")

    # CPU / RAM — держатся высоко 30 минут
    m = db.fetchall("SELECT cpu, ram_used, ram_total, disk_used, disk_total FROM mon_metrics WHERE node_id = ? AND ts >= ? "
                    "ORDER BY ts DESC LIMIT 6", (nid, now - 40 * 60))
    if len(m) >= 6:
        cpu = sum(float(x["cpu"] or 0) for x in m) / len(m)
        if cpu >= 90:
            open_incident(node, "cpu_high", "warning", f"Высокая нагрузка CPU: {cpu:.0f}%", "держится дольше 30 минут")
        elif cpu < 75:
            resolve_incident(node, "cpu_high")
        ram = [100.0 * float(x["ram_used"] or 0) / float(x["ram_total"]) for x in m if x["ram_total"]]
        if ram:
            r = sum(ram) / len(ram)
            if r >= 90:
                open_incident(node, "ram_high", "warning", f"Мало свободной памяти: занято {r:.0f}%", "держится дольше 30 минут")
            elif r < 80:
                resolve_incident(node, "ram_high")
    if m and m[0]["disk_total"]:
        d = 100.0 * float(m[0]["disk_used"] or 0) / float(m[0]["disk_total"])
        if d >= 80:
            open_incident(node, "disk_high", "critical" if d >= 95 else "warning", f"Диск заполнен на {d:.0f}%",
                          f"свободно {_gb(float(m[0]['disk_total']) - float(m[0]['disk_used'] or 0))}")
        elif d < 75:
            resolve_incident(node, "disk_high")

    # Скорость
    sp = db.fetchall("SELECT ok, down FROM mon_speed WHERE node_id = ? ORDER BY ts DESC LIMIT 2", (nid,))
    if len(sp) == 2 and not sp[0]["ok"] and not sp[1]["ok"]:
        open_incident(node, "speed_fail", "warning", "Не удаётся замерить скорость интернета", "2 замера подряд с ошибкой")
    elif sp and sp[0]["ok"]:
        resolve_incident(node, "speed_fail")
    hist = [float(r["down"]) for r in db.fetchall(
        "SELECT down FROM mon_speed WHERE node_id = ? AND ok = 1 AND ts >= ? ORDER BY ts DESC LIMIT 700 OFFSET 2",
        (nid, now - RETENTION_DAYS * 86400)) if r["down"] is not None]
    if len(hist) >= 5 and len(sp) == 2 and all(x["ok"] and x["down"] is not None for x in sp):
        med = sorted(hist)[len(hist) // 2]
        last = max(float(sp[0]["down"]), float(sp[1]["down"]))
        if med >= 10 and last < med * 0.4:
            open_incident(node, "speed_drop", "warning", f"Скорость упала: {last:.0f} Мбит/с",
                          f"обычно около {med:.0f} Мбит/с")
        elif last >= med * 0.6:
            resolve_incident(node, "speed_drop")


def check_payments() -> None:
    """Напоминания об оплате сервера: за 24 ч, за 8 ч и в момент оплаты."""
    now = _now()
    for node in db.fetchall("SELECT * FROM mon_nodes WHERE pay_date IS NOT NULL"):
        pay = _parse(node.get("pay_date"))
        if not pay:
            continue
        try:
            sent = json.loads(node.get("pay_notified") or "{}")
        except ValueError:
            sent = {}
        done = set(sent.get(node["pay_date"], []))
        stage = None
        if now >= pay:
            stage = "due"
        elif now >= pay - timedelta(hours=8):
            stage = "8h"
        elif now >= pay - timedelta(hours=24):
            stage = "24h"
        if not stage or stage in done or now - pay > timedelta(days=1):
            continue
        order = ["24h", "8h", "due"]
        for st in order[: order.index(stage) + 1]:
            done.add(st)
        when = {"24h": "через 24 часа", "8h": "через 8 часов", "due": "сегодня — срок оплаты"}[stage]
        msk = pay.astimezone(timezone(timedelta(hours=3))).strftime("%d.%m.%Y %H:%M МСК")
        link = f'\n<a href="{_esc(node["pay_url"])}">Оплатить</a>' if node.get("pay_url") else ""
        _notify(f"💳 <b>Оплата сервера</b> · {_node_ref(node)}\nОплата {when} ({msk}).{link}\n"
                f"После оплаты продлите дату в мониторинге.")
        log_event(node, "payment", f"Напоминание об оплате: {when}", msk)
        db.execute("UPDATE mon_nodes SET pay_notified = ? WHERE id = ?",
                   (json.dumps({node["pay_date"]: sorted(done)}), node["id"]))


def cleanup() -> None:
    cutoff = int(time.time()) - RETENTION_DAYS * 86400
    for t in HISTORY_TABLES:
        db.execute(f"DELETE FROM {t} WHERE ts < ?", (cutoff,))
    db.execute("DELETE FROM mon_incidents WHERE started_at < ? AND resolved_at IS NOT NULL",
               (_iso(_now() - timedelta(days=90)),))


# ─────────────────────────────────────────────────────────────
# Данные для панели
# ─────────────────────────────────────────────────────────────

def _live(node: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(node.get("live_json") or "{}") or {}
    except ValueError:
        return {}


def node_brief(node: dict[str, Any]) -> dict[str, Any]:
    st = status_of(node)
    return {"id": node["id"], "name": node["name"], "ip": node["ip"], "port": node["port"],
            "status": st, "status_label": STATUS_LABEL[st], "enabled": bool(node.get("enabled"))}


def overview() -> dict[str, Any]:
    nodes = db.fetchall("SELECT * FROM mon_nodes ORDER BY name COLLATE NOCASE, id")
    briefs = []
    for n in nodes:
        b = node_brief(n)
        lv = _live(n) if b["status"] != "idle" else {}
        pct = lambda u, t: round(100.0 * float(lv[u]) / float(lv[t]), 1) if lv.get(u) is not None and lv.get(t) else None
        b["load"] = {"cpu": lv.get("cpu"), "ram": pct("ram_used", "ram_total"), "disk": pct("disk_used", "disk_total")}
        b["last_seen"] = n.get("last_seen")
        briefs.append(b)
    open_inc = db.fetchone("SELECT COUNT(*) AS c FROM mon_incidents WHERE resolved_at IS NULL")
    counts = {k: sum(1 for b in briefs if b["status"] == k) for k in STATUS_LABEL}
    return {
        "summary": {"total": len(briefs), "online": counts["green"], "problems": counts["yellow"] + counts["orange"] + counts["red"],
                    "idle": counts["idle"], "open_incidents": int((open_inc or {}).get("c") or 0)},
        "nodes": briefs,
    }


def _uptime_pct(nid: int, since: int) -> Optional[float]:
    r = db.fetchone("SELECT COUNT(*) AS n, SUM(CASE WHEN lost < sent THEN 1 ELSE 0 END) AS up FROM mon_pings "
                    "WHERE node_id = ? AND ts >= ?", (nid, since))
    if not r or not r["n"]:
        return None
    return round(100.0 * float(r["up"] or 0) / float(r["n"]), 2)


def node_detail(node_id: int) -> dict[str, Any]:
    node = get_node(node_id)
    if not node:
        raise MonitorError("Нода не найдена", 404)
    nid = int(node["id"])
    now = int(time.time())
    last_speed = db.fetchone("SELECT * FROM mon_speed WHERE node_id = ? ORDER BY ts DESC LIMIT 1", (nid,))
    last_ping = db.fetchone("SELECT * FROM mon_pings WHERE node_id = ? ORDER BY ts DESC LIMIT 1", (nid,))
    incidents = db.fetchall("SELECT * FROM mon_incidents WHERE node_id = ? ORDER BY started_at DESC LIMIT 100", (nid,))
    vless = decrypt(node.get("vless_enc"))
    vinfo = None
    if vless:
        try:
            pv = parse_vless(vless)
            vinfo = {"host": pv["host"], "port": pv["port"], "net": pv["net"], "sec": pv["sec"], "name": pv["name"]}
        except MonitorError:
            vinfo = {"host": "?", "port": 0, "net": "?", "sec": "?", "name": ""}
    return {
        **node_brief(node),
        "created_at": node.get("created_at"), "started_at": node.get("started_at"),
        "last_seen": node.get("last_seen"), "last_error": node.get("last_error"),
        "agent_ok": agent_ok(node), "agent_version": node.get("agent_version"),
        "uptime": node.get("uptime"), "cores": node.get("cores"), "live": _live(node),
        "speed_running": bool(node.get("speed_running")),
        "last_speed": last_speed,
        "ping": {"last": last_ping, "uptime_24h": _uptime_pct(nid, now - 86400), "uptime_7d": _uptime_pct(nid, now - 7 * 86400)},
        "vless": {"configured": bool(vless), "info": vinfo, "ok": node.get("vless_ok"),
                  "checked_at": node.get("vless_checked_at"), "error": node.get("vless_error"),
                  "uptime_24h": _vless_uptime(nid, now - 86400)},
        "payment": {"date": node.get("pay_date"), "url": node.get("pay_url")},
        "incidents": incidents,
        "open_incidents": sum(1 for i in incidents if not i.get("resolved_at")),
    }


def _vless_uptime(nid: int, since: int) -> Optional[float]:
    r = db.fetchone("SELECT COUNT(*) AS n, SUM(ok) AS up FROM mon_vless WHERE node_id = ? AND ts >= ?", (nid, since))
    if not r or not r["n"]:
        return None
    return round(100.0 * float(r["up"] or 0) / float(r["n"]), 2)


_RANGES = {"6h": (6 * 3600, 300), "24h": (86400, 300), "7d": (7 * 86400, 1800)}


def series(node_id: int, metric: str, rng: str) -> dict[str, Any]:
    if rng not in _RANGES:
        rng = "24h"
    span, bucket = _RANGES[rng]
    since = int(time.time()) - span
    nid = int(node_id)
    if metric == "cpu":
        rows = db.fetchall(f"SELECT (ts/{bucket})*{bucket} AS t, AVG(cpu) AS v, MAX(cpu_max) AS m FROM mon_metrics "
                           f"WHERE node_id = ? AND ts >= ? GROUP BY t ORDER BY t", (nid, since))
        pts = [[r["t"], r["v"], r["m"]] for r in rows]
    elif metric in ("ram", "disk"):
        u, tot = ("ram_used", "ram_total") if metric == "ram" else ("disk_used", "disk_total")
        rows = db.fetchall(f"SELECT (ts/{bucket})*{bucket} AS t, AVG({u}) AS v, MAX({u}) AS m, MAX({tot}) AS tot FROM mon_metrics "
                           f"WHERE node_id = ? AND ts >= ? GROUP BY t ORDER BY t", (nid, since))
        pts = [[r["t"], r["v"], r["m"], r["tot"]] for r in rows]
    elif metric in ("io", "net"):
        a, b = ("disk_read", "disk_write") if metric == "io" else ("net_rx", "net_tx")
        rows = db.fetchall(f"SELECT (ts/{bucket})*{bucket} AS t, AVG({a}) AS a, AVG({b}) AS b FROM mon_metrics "
                           f"WHERE node_id = ? AND ts >= ? GROUP BY t ORDER BY t", (nid, since))
        pts = [[r["t"], r["a"], r["b"]] for r in rows]
    elif metric == "ping":
        rows = db.fetchall(f"SELECT (ts/{bucket})*{bucket} AS t, AVG(rtt_ms) AS rtt, SUM(lost) AS lost, SUM(sent) AS sent, "
                           f"MIN(agent_ok) AS agent FROM mon_pings WHERE node_id = ? AND ts >= ? GROUP BY t ORDER BY t", (nid, since))
        pts = [[r["t"], r["rtt"], round(100.0 * (r["lost"] or 0) / max(1, r["sent"] or 0), 1), r["agent"]] for r in rows]
    elif metric == "speed":
        rows = db.fetchall("SELECT ts AS t, ok, down, up, ping_ms FROM mon_speed WHERE node_id = ? AND ts >= ? ORDER BY ts",
                           (nid, since))
        pts = [[r["t"], r["down"] if r["ok"] else None, r["up"] if r["ok"] else None, r["ping_ms"]] for r in rows]
    elif metric == "vless":
        rows = db.fetchall("SELECT ts AS t, ok, ms FROM mon_vless WHERE node_id = ? AND ts >= ? ORDER BY ts", (nid, since))
        pts = [[r["t"], r["ok"], r["ms"]] for r in rows]
    else:
        raise MonitorError("Неизвестная метрика")
    return {"metric": metric, "range": rng, "bucket": bucket, "from": since, "to": int(time.time()), "points": pts}

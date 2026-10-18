# ноды blinmon: опрос агента, инциденты, проверка vless
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import math
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
POLL_EVERY = 60  # сек - опрос агента и TCP-пинг
REBOOT_GRACE = 6 * 60  # сек - после перезагрузки из панели простой не считаем аварией
REBOOT_MIN_VERSION = "1.1.0"  # с этой версии агент умеет перезагружать сервер
UPDATE_MIN_VERSION = "1.2.0"  # с этой версии агент обновляется сам по команде панели
UPDATE_RETRY = 3600  # сек - повторить автообновление, если не получилось


# вшитый node.sh → версия агента + sha
_NODE_SH_CANDIDATES = (
    os.getenv("BLINMON_NODE_SH") or "",
    "/app/node.sh",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "node.sh"),
)
_bundled_cache: dict[str, Any] = {}


def bundled_agent() -> dict[str, Any]:
    for path in _NODE_SH_CANDIDATES:
        if not path or not os.path.isfile(path):
            continue
        try:
            mtime = os.path.getmtime(path)
            if _bundled_cache.get("path") == path and _bundled_cache.get("mtime") == mtime:
                return _bundled_cache["info"]
            raw = open(path, "rb").read()
            m = re.search(rb'^NODE_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"', raw, re.M)
            info = {"version": m.group(1).decode() if m else None, "sha": hashlib.sha256(raw).hexdigest()}
            _bundled_cache.update(path=path, mtime=mtime, info=info)
            return info
        except OSError:
            continue
    return {}
VLESS_EVERY = 300  # сек - проверка VLESS
RETENTION_DAYS = 7
AGENT_TIMEOUT = 8  # сек - ожидание ответа агента
AGENT_DOWN_AFTER = 3  # столько неудачных опросов подряд → «агент недоступен»
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


def _fernet():
    from cryptography.fernet import Fernet, MultiFernet

    keys = []
    for raw, label in ((os.getenv("MONITOR_SECRET_KEY"), b"monitor"), (os.getenv("INTERNAL_API_SECRET"), b"monitor-fallback")):
        raw = (raw or "").strip()
        if raw:
            k = hashlib.sha256(label + b":" + raw.encode()).digest()
            keys.append(Fernet(base64.urlsafe_b64encode(k)))
    if not keys:
        # dev fallback: ключ в настройках
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
    return secrets.token_urlsafe(48)


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
    if ip.is_loopback and os.getenv("MONITOR_ALLOW_LOOPBACK") == "1":  # tests only
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


class AgentError(Exception):
    def __init__(self, msg: str, status: Optional[int] = None) -> None:
        super().__init__(msg)
        self.status = status


def _sign(secret: str, msg: str) -> str:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()


MAX_AGENT_BODY = 4 * 1024 * 1024


def _ip_allowed(ip: "ipaddress._BaseAddress") -> bool:
    if ip.is_loopback and os.getenv("MONITOR_ALLOW_LOOPBACK") == "1":  # tests only
        return True
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not (ip.is_loopback or ip.is_multicast or ip.is_unspecified or ip.is_link_local or ip.is_reserved)


def resolve_host(host: str, port: int) -> tuple[int, str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise AgentError("Нет связи с агентом: домен не найден")
    for family, _t, _p, _c, addr in infos:
        try:
            ip = ipaddress.ip_address(addr[0].split("%")[0])
        except ValueError:
            continue
        if _ip_allowed(ip):
            return family, str(ip)
    raise AgentError("Этот адрес нельзя использовать: он ведёт во внутреннюю сеть панели")


def _http(host: str, port: int, method: str, target: str, headers: dict[str, str],
          timeout: float) -> tuple[int, dict[str, str], bytes]:
    deadline = time.monotonic() + timeout
    family, ip = resolve_host(host, port)

    def left() -> float:
        r = deadline - time.monotonic()
        if r <= 0:
            raise socket.timeout("timed out")
        return r

    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(min(left(), 5.0))
        sock.connect((ip, port))
        host_hdr = f"[{host}]" if ":" in host else host
        lines = [f"{method} {target} HTTP/1.0", f"Host: {host_hdr}:{port}", "Connection: close", "Content-Length: 0"]
        lines += [f"{k}: {v}" for k, v in headers.items()]
        sock.settimeout(left())
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        buf = bytearray()
        while True:
            sock.settimeout(min(left(), 2.0))
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                left()
                continue
            if not chunk:
                break
            buf += chunk
            if len(buf) > MAX_AGENT_BODY + 65536:
                raise AgentError("Агент прислал слишком большой ответ")
    finally:
        sock.close()
    head, sep, body = bytes(buf).partition(b"\r\n\r\n")
    if not sep:
        raise AgentError("Агент прислал некорректный ответ")
    hlines = head.decode("latin-1").split("\r\n")
    try:
        status = int(hlines[0].split()[1])
    except (IndexError, ValueError):
        raise AgentError("Агент прислал некорректный ответ")
    hdrs = {}
    for ln in hlines[1:]:
        k, _, v = ln.partition(":")
        hdrs[k.strip().lower()] = v.strip()
    try:
        clen = int(hdrs.get("content-length", len(body)))
        body = body[:max(0, clen)]
    except ValueError:
        pass
    return status, hdrs, body


def agent_request(node: dict[str, Any], method: str, target: str, timeout: float = AGENT_TIMEOUT) -> dict[str, Any]:
    secret = decrypt(node.get("secret_enc"))
    if not secret:
        raise AgentError("Ключ ноды не расшифровывается — перевыпустите ключ")
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    sig = _sign(secret, f"{method}\n{target}\n{ts}\n{nonce}")
    try:
        status, hdrs, body = _http(node["ip"], int(node["port"]), method, target,
                                   {"X-Blin-Ts": ts, "X-Blin-Nonce": nonce, "X-Blin-Sig": sig, "User-Agent": "blinvpn-panel"},
                                   timeout)
    except AgentError:
        raise
    except (socket.timeout, TimeoutError, OSError) as e:
        text = str(e).lower()
        if isinstance(e, (socket.timeout, TimeoutError)) or "timed out" in text:
            human = "превышено время ожидания (сервер выключен или порт закрыт фаерволом)"
        elif isinstance(e, ConnectionRefusedError) or "refused" in text:
            human = "порт закрыт — агент не установлен или не запущен"
        elif "no route" in text or "unreachable" in text:
            human = "адрес недоступен"
        else:
            human = str(e)[:120]
        raise AgentError(f"Нет связи с агентом: {human}")
    if status == 401:
        raise AgentError("Агент отклонил ключ (ключ не совпадает или часы сервера сбиты)", 401)
    if status != 200:
        raise AgentError(f"Агент ответил ошибкой {status}", status)
    expected = _sign(secret, f"resp\n{nonce}\n{hashlib.sha256(body).hexdigest()}")
    if not hmac.compare_digest(hdrs.get("x-blin-sig", ""), expected):
        raise AgentError("Ответ не подписан ключом ноды — возможно, на этом адресе не наш агент")
    try:
        data = json.loads(body)
    except ValueError:
        raise AgentError("Агент прислал некорректный ответ")
    if not isinstance(data, dict):
        raise AgentError("Агент прислал некорректный ответ")
    return data


def tcp_ping(host: str, port: int, probes: int = PING_PROBES) -> dict[str, Any]:
    rtts: list[float] = []
    lost = 0
    try:
        family, ip = resolve_host(host, port)
    except AgentError:
        return {"sent": probes, "lost": probes, "rtt_ms": None}
    for i in range(probes):
        t0 = time.perf_counter()
        try:
            with socket.socket(family, socket.SOCK_STREAM) as sk:
                sk.settimeout(PING_TIMEOUT)
                sk.connect((ip, port))
            rtts.append((time.perf_counter() - t0) * 1000)
        except ConnectionRefusedError:
            rtts.append((time.perf_counter() - t0) * 1000)
        except OSError:
            lost += 1
        if i < probes - 1:
            time.sleep(0.2)
    return {"sent": probes, "lost": lost, "rtt_ms": round(sum(rtts) / len(rtts), 1) if rtts else None}


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
            set_condition(node, "vless_down", False)
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
    node = get_node(node_id)
    if not node:
        raise MonitorError("Нода не найдена", 404)
    db.execute("UPDATE mon_nodes SET enabled = 1, started_at = COALESCE(started_at, ?), connect_since = ?, fail_count = 0, "
               "cursor = 0, speed_cursor = 0, boot_id = NULL, last_error = NULL WHERE id = ?", (_iso(), _iso(), int(node_id)))
    import threading

    def _first_try() -> None:
        try:
            fresh = get_node(node_id)
            if fresh and fresh.get("enabled"):
                poll_node(fresh)
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=_first_try, daemon=True).start()
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
    if res.get("running"):
        db.execute("UPDATE mon_nodes SET speed_running = 1 WHERE id = ?", (int(node_id),))
        raise MonitorError("Замер уже идёт — результат появится примерно через полминуты", 409)
    raise MonitorError("Ручной замер можно запускать не чаще раза в 2 минуты", 429)


def _ver(v: Any) -> tuple:
    try:
        return tuple(int(x) for x in str(v or "0").split(".")[:3])
    except ValueError:
        return (0,)


def agent_outdated(node: dict[str, Any]) -> bool:
    latest = bundled_agent().get("version")
    return bool(node.get("agent_version") and latest) and _ver(node.get("agent_version")) < _ver(latest)


def can_self_update(node: dict[str, Any]) -> bool:
    return bool(node.get("agent_version")) and _ver(node.get("agent_version")) >= _ver(UPDATE_MIN_VERSION)


def can_reboot(node: dict[str, Any]) -> bool:
    return (bool(node.get("agent_version")) and _ver(node.get("agent_version")) >= _ver(REBOOT_MIN_VERSION)
            and node.get("allow_reboot") != 0)


def request_update(node_id: int, manual: bool = True) -> dict[str, Any]:
    node = get_node(node_id)
    if not node:
        raise MonitorError("Нода не найдена", 404)
    info = bundled_agent()
    if not info.get("sha"):
        raise MonitorError("В панели нет файла node.sh — обновите панель", 500)
    if not agent_outdated(node) and manual:
        raise MonitorError(f"Агент уже последней версии ({node.get('agent_version')})", 409)
    if not can_self_update(node):
        raise MonitorError("Эта версия агента не умеет обновляться сама — один раз обновите её командой на сервере", 409)
    try:
        agent_request(node, "POST", f"/v1/update?sha={info['sha']}", timeout=10)
    except AgentError as e:
        raise MonitorError(f"Не удалось отправить команду: {e}", 502)
    db.execute("UPDATE mon_nodes SET update_target = ?, update_requested_at = ? WHERE id = ?",
               (info.get("version"), _iso(), int(node_id)))
    return {"ok": True, "target": info.get("version")}


def maybe_auto_update(node: dict[str, Any]) -> None:
    if db.get_setting("mon_auto_update", "1") == "0":
        return
    if not (node.get("enabled") and agent_outdated(node) and can_self_update(node)):
        return
    info = bundled_agent()
    asked = _parse(node.get("update_requested_at"))
    if asked and node.get("update_target") == info.get("version") and (_now() - asked).total_seconds() < UPDATE_RETRY:
        return
    request_update(int(node["id"]), manual=False)


def reboot_node(node_id: int) -> dict[str, Any]:
    node = get_node(node_id)
    if not node:
        raise MonitorError("Нода не найдена", 404)
    try:
        res = agent_request(node, "POST", "/v1/reboot", timeout=10)
    except AgentError as e:
        if e.status == 404:
            raise MonitorError("Агент на сервере устарел и не умеет перезагружать — обновите его", 409)
        if e.status == 429:
            raise MonitorError("Сервер загрузился меньше 10 минут назад — перезагрузить снова можно чуть позже", 409)
        if e.status == 403:
            raise MonitorError("Перезагрузка из панели выключена в настройках агента. Включить: sudo bash node.sh update", 409)
        raise MonitorError(f"Не удалось отправить команду: {e}", 502)
    if not res.get("rebooting"):
        raise MonitorError("Агент не принял команду перезагрузки", 502)
    db.execute("UPDATE mon_nodes SET reboot_at = ? WHERE id = ?", (_iso(), int(node_id)))
    log_event(node, "reboot", "Перезагрузка из панели", "сервер перезагружается, это займёт 1–3 минуты")
    _notify(f"🔁 <b>Перезагрузка</b> · {_node_ref(node)}\nСервер перезагружается по команде из панели.")
    return {"ok": True}


def _int(v: Any) -> Optional[int]:
    try:
        if v is None or isinstance(v, bool):
            return None
        f = float(v)
        if not math.isfinite(f) or abs(f) > 2 ** 62:
            return None
        return int(f)
    except (TypeError, ValueError, OverflowError):
        return None


def _num(v: Any) -> Optional[float]:
    try:
        if v is None or isinstance(v, bool):
            return None
        f = float(v)
        return f if math.isfinite(f) and abs(f) < 1e18 else None
    except (TypeError, ValueError, OverflowError):
        return None


def _clean_update_state(v: Any) -> Optional[dict[str, Any]]:
    if not isinstance(v, dict):
        return None
    return {"ok": v.get("ok") is True, "error": str(v.get("error") or "")[:200],
            "version": str(v.get("version") or "")[:16], "at": _int(v.get("at"))}


def ingest(node: dict[str, Any], data: dict[str, Any]) -> None:
    nid = int(node["id"])
    samples = [s for s in (data.get("samples") or []) if isinstance(s, dict)][-5000:]
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
            "cursor = ?, speed_cursor = ?, uptime = ?, cores = ?, live_json = ?, speed_running = ?, "
            "update_state = ?, allow_reboot = ? WHERE id = ?",
            (_iso(), re.sub(r"[^0-9.]", "", str(data.get("version") or ""))[:16], str(data.get("boot_id") or "")[:32],
             _int(data.get("seq")) or 0, _int(data.get("speed_seq")) or 0, _int(data.get("uptime")), _int(data.get("cores")),
             json.dumps({k: _num(live.get(k)) for k in ("cpu", "ram_used", "ram_total", "swap_used", "swap_total", "disk_used",
                                                         "disk_total", "disk_read_bps", "disk_write_bps", "net_rx_bps", "net_tx_bps",
                                                         "load1", "ts")}),
             1 if data.get("speed_running") else 0,
             json.dumps(_clean_update_state(data.get("update"))) if isinstance(data.get("update"), dict) else None,
             None if data.get("allow_reboot") is None else (1 if data.get("allow_reboot") else 0), nid),
        )


def poll_node(node: dict[str, Any]) -> bool:
    nid = int(node["id"])
    cursor, sp_cursor = int(node.get("cursor") or 0), int(node.get("speed_cursor") or 0)
    ok = False
    try:
        data = agent_request(node, "GET", f"/v1/status?since={cursor}&speed_since={sp_cursor}")
        if node.get("boot_id") and data.get("boot_id") != node.get("boot_id"):
            # boot_id сменился → заново взять весь буфер
            data = agent_request(node, "GET", "/v1/status?since=0&speed_since=0")
        ingest(node, data)
        ok = True
        try:
            maybe_auto_update(get_node(nid) or node)
        except Exception:  # noqa: BLE001
            pass
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
    if res.get("ok") is None:  # xray missing on panel host
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


def agent_ok(node: dict[str, Any]) -> bool:
    seen = _parse(node.get("last_seen"))
    return (bool(node.get("enabled")) and seen is not None
            and int(node.get("fail_count") or 0) < AGENT_DOWN_AFTER
            and _now() - seen < timedelta(seconds=POLL_EVERY * AGENT_DOWN_AFTER + 30))


def status_of(node: dict[str, Any]) -> str:
    if not node.get("enabled"):
        return "idle"
    if is_connecting(node):
        return "connecting"
    a = agent_ok(node)
    has_vless = bool(node.get("vless_enc")) and node.get("vless_ok") is not None
    v = bool(node.get("vless_ok")) if has_vless else None
    if a:
        return "yellow" if v is False else "green"
    return "orange" if v is True else "red"


def is_connecting(node: dict[str, Any]) -> bool:
    if not node.get("enabled"):
        return False
    since = _parse(node.get("connect_since"))
    seen = _parse(node.get("last_seen"))
    return seen is None or (since is not None and seen < since)


STATUS_LABEL = {"idle": "Не запущена", "connecting": "Подключение…", "green": "Работает", "yellow": "VLESS не отвечает",
                "orange": "Агент не отвечает", "red": "Недоступна"}


_OPEN_KINDS = ("outage", "agent_down", "host_down", "packet_loss", "vless_down", "cpu_high", "ram_high",
               "disk_high", "speed_drop", "speed_fail")

# проблемы связи — один инцидент outage; rank выбирает заголовок
OUTAGE_KINDS: dict[str, tuple[int, str]] = {
    "packet_loss": (0, "warning"),
    "vless_down": (1, "critical"),
    "agent_down": (2, "critical"),
    "host_down": (3, "critical"),
}
OUTAGE_OK_TEXT = {
    "packet_loss": "Потери пакетов прекратились",
    "vless_down": "VLESS снова работает",
    "agent_down": "Агент снова на связи",
    "host_down": "Сервер снова отвечает",
}
LEGACY_OUTAGE = tuple(OUTAGE_KINDS)


def _fmt_dur(sec: float) -> str:
    sec = int(sec)
    if sec < 3600:
        return f"{max(1, sec // 60)} мин"
    if sec < 86400:
        return f"{sec // 3600} ч {sec % 3600 // 60} мин"
    return f"{sec // 86400} д {sec % 86400 // 3600} ч"


def _esc(s: Any) -> str:
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _node_ref(node: dict[str, Any]) -> str:
    base = forum.panel_url()
    label = f"{_esc(node['name'])} ({_esc(node['ip'])})"
    return f'<a href="{_esc(base)}/monitoring?node={int(node["id"])}">{label}</a>' if base else f"<b>{label}</b>"


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


def _hm(iso_s: str) -> str:
    dt = _parse(iso_s) or _now()
    return dt.astimezone(timezone(timedelta(hours=3))).strftime("%H:%M")


def _load_json(v: Any, default: Any) -> Any:
    try:
        out = json.loads(v) if v else default
        return out if isinstance(out, type(default)) else default
    except ValueError:
        return default


def set_condition(node: dict[str, Any], kind: str, active: bool, title: str = "", details: str = "") -> None:
    nid = int(node["id"])
    row = db.fetchone("SELECT * FROM mon_incidents WHERE node_id = ? AND kind = 'outage' AND resolved_at IS NULL", (nid,))
    now = _iso()
    if not active:
        if not row:
            return
        state = _load_json(row.get("state"), {})
        conds = state.get("conds") or {}
        if kind not in conds:
            return
        was = conds.pop(kind)
        timeline = _load_json(row.get("timeline"), [])
        if was.get("shown"):
            timeline.append([now, OUTAGE_OK_TEXT.get(kind, "Прошло")])
        if not conds:
            peak = state.get("peak") or {}
            db.execute("UPDATE mon_incidents SET resolved_at = ?, state = ?, timeline = ?, title = ?, severity = ?, details = ? "
                       "WHERE id = ?", (now, json.dumps({"conds": {}, "peak": peak}), json.dumps(timeline[-40:]),
                                        peak.get("title") or row["title"], peak.get("severity") or row["severity"],
                                        peak.get("details") or row.get("details"), row["id"]))
            started = _parse(row["started_at"]) or _now()
            _notify(f"✅ <b>Решено</b> · {_node_ref(node)}\n{_esc(peak.get('title') or row['title'])}\n"
                    f"Длилось: {_fmt_dur((_now() - started).total_seconds())}")
            return
        _save_outage(row["id"], state | {"conds": conds}, timeline)
        return

    rank, severity = OUTAGE_KINDS[kind]
    cond = {"rank": rank, "severity": severity, "title": title, "details": details[:300], "since": now}
    if not row:
        cond["shown"] = True
        state = {"conds": {kind: cond}, "peak": {"rank": rank, "severity": severity, "title": title, "details": details[:300]}}
        db.execute("INSERT INTO mon_incidents (node_id, kind, severity, title, details, started_at, state, timeline) "
                   "VALUES (?,?,?,?,?,?,?,?)", (nid, "outage", severity, title, details[:500], now,
                                                json.dumps(state), json.dumps([[now, title]])))
        icon = "🔴" if severity == "critical" else "🟠"
        _notify(f"{icon} <b>Инцидент</b> · {_node_ref(node)}\n{_esc(title)}" + (f"\n<i>{_esc(details)}</i>" if details else ""))
        return
    state = _load_json(row.get("state"), {})
    conds = state.get("conds") or {}
    timeline = _load_json(row.get("timeline"), [])
    old_sev = row["severity"]
    if kind in conds:
        conds[kind].update(title=title, details=details[:300])
    else:
        conds[kind] = cond
    state["conds"] = conds
    new_sev = _save_outage(row["id"], state, timeline)
    if old_sev != "critical" and new_sev == "critical":
        _notify(f"🔴 <b>Стало хуже</b> · {_node_ref(node)}\n{_esc(title)}" + (f"\n<i>{_esc(details)}</i>" if details else ""))


def _save_outage(inc_id: int, state: dict[str, Any], timeline: list) -> str:
    conds = state.get("conds") or {}
    worst_kind = max(conds, key=lambda k: conds[k]["rank"])
    worst = conds[worst_kind]
    if not worst.get("shown"):
        worst["shown"] = True
        timeline.append([_iso(), worst["title"]])
    peak = state.get("peak") or {}
    if worst["rank"] >= int(peak.get("rank", -1)):
        state["peak"] = {k: worst[k] for k in ("rank", "severity", "title", "details")}
    db.execute("UPDATE mon_incidents SET title = ?, severity = ?, details = ?, state = ?, timeline = ? WHERE id = ?",
               (worst["title"], worst["severity"], worst.get("details") or "", json.dumps(state), json.dumps(timeline[-40:]), inc_id))
    return worst["severity"]


def log_event(node: dict[str, Any], kind: str, title: str, details: str = "") -> None:
    now = _iso()
    db.execute("INSERT INTO mon_incidents (node_id, kind, severity, title, details, started_at, resolved_at) "
               "VALUES (?,?,?,?,?,?,?)", (int(node["id"]), kind, "info", title, details[:500], now, now))


def _gb(v: Any) -> str:
    try:
        return f"{float(v) / 1024 ** 3:.1f} ГБ"
    except (TypeError, ValueError):
        return "—"


def evaluate(node: dict[str, Any]) -> None:
    node = get_node(int(node["id"])) or node
    if not node.get("enabled") or is_connecting(node):
        return
    nid = int(node["id"])
    now = int(time.time())

    # закрыть старые outage по видам
    db.execute(f"UPDATE mon_incidents SET resolved_at = ? WHERE node_id = ? AND resolved_at IS NULL "
               f"AND kind IN ({','.join('?' * len(LEGACY_OUTAGE))})", (_iso(), nid, *LEGACY_OUTAGE))

    # окно после reboot: ожидаемый простой
    rb = _parse(node.get("reboot_at"))
    in_reboot = bool(rb and (_now() - rb).total_seconds() < REBOOT_GRACE)

    pending: list[tuple[str, bool, str, str]] = []

    def cond(kind: str, active: Optional[bool], title: str = "", details: str = "") -> None:
        if active is None:
            return
        if active and in_reboot:
            return
        pending.append((kind, active, title, details))

    # хост недоступен по tcp-проверкам
    pings = db.fetchall("SELECT ts, sent, lost FROM mon_pings WHERE node_id = ? ORDER BY ts DESC LIMIT 5", (nid,))
    host_down: Optional[bool] = None
    if len(pings) >= 3 and all(p["lost"] >= p["sent"] for p in pings[:3]):
        host_down = True
    elif pings and pings[0]["lost"] < pings[0]["sent"]:
        host_down = False
    cond("host_down", host_down, "Сервер не отвечает", "3 минуты подряд сервер не отвечает на проверки")

    # агент недоступен
    fails = int(node.get("fail_count") or 0)
    cond("agent_down", True if fails >= AGENT_DOWN_AFTER else False if fails == 0 else None,
         "Агент не отвечает", _agent_err_human(node.get("last_error")))

    # не считать packet-loss в окне reboot
    if rb:
        rb_ts = int(rb.timestamp())
        pings = [p for p in pings if not (rb_ts - 60 <= int(p["ts"]) <= rb_ts + REBOOT_GRACE)]
    if len(pings) >= 5:
        sent = sum(p["sent"] for p in pings); lost = sum(p["lost"] for p in pings)
        loss = 100.0 * lost / max(1, sent)
        cond("packet_loss", True if 20 <= loss < 100 else False if loss < 5 else None,
             f"Потери пакетов {loss:.0f}%", "за последние 5 минут")

    # проверка vless
    if node.get("vless_enc") and node.get("vless_ok") is not None:
        vok = node.get("vless_ok")
        cond("vless_down", True if (not vok and int(node.get("vless_fail_count") or 0) >= 2) else False if vok else None,
             "VLESS не отвечает", str(node.get("vless_error") or ""))

    # сначала закрыть, потом открыть (стабильный timeline за проход)
    for kind, active, title, details in sorted(
            pending, key=lambda x: (x[1], -OUTAGE_KINDS[x[0]][0] if x[1] else OUTAGE_KINDS[x[0]][0])):
        set_condition(node, kind, active, title, details)

    # cpu/ram высокий ~30 мин
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

    # скорость
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


def _agent_err_human(err: Any) -> str:
    t = str(err or "")
    return t.split(": ", 1)[1] if t.startswith("Нет связи с агентом: ") else t


def check_payments() -> None:
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


def _live(node: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(node.get("live_json") or "{}") or {}
    except ValueError:
        return {}


def node_brief(node: dict[str, Any], open_titles: Optional[list[str]] = None) -> dict[str, Any]:
    st = status_of(node)
    dot, reason = dot_of(node, open_titles)
    return {"id": node["id"], "name": node["name"], "ip": node["ip"], "port": node["port"],
            "status": st, "status_label": STATUS_LABEL[st], "enabled": bool(node.get("enabled")),
            "agent_version": node.get("agent_version"), "agent_outdated": agent_outdated(node),
            "can_self_update": can_self_update(node), "dot": dot, "dot_reason": reason}


OVERLOAD_PCT = 90  # cpu / RAM / диск выше этого прямо сейчас - перегрузка (жёлтый)


def _load_now(node: dict[str, Any]) -> dict[str, Optional[float]]:
    lv = _live(node)
    pct = lambda u, t: round(100.0 * float(lv[u]) / float(lv[t]), 1) if lv.get(u) is not None and lv.get(t) else None
    return {"cpu": lv.get("cpu"), "ram": pct("ram_used", "ram_total"), "disk": pct("disk_used", "disk_total")}


def dot_of(node: dict[str, Any], open_titles: Optional[list[str]] = None) -> tuple[str, str]:
    if not node.get("enabled"):
        return "grey", "Мониторинг выключен"
    if is_connecting(node):
        return "yellow", "Подключение к агенту…"
    a_ok = agent_ok(node)
    v_bad = bool(node.get("vless_enc")) and node.get("vless_ok") == 0
    if not a_ok and v_bad:
        return "red", "Агент и VLESS недоступны"
    if not a_ok:
        return "red", "Агент не отвечает"
    if v_bad:
        return "red", "VLESS не отвечает"
    load = _load_now(node)
    over = [f"{name} {load[k]:.0f}%" for k, name in (("cpu", "CPU"), ("ram", "RAM"), ("disk", "диск"))
            if load.get(k) is not None and float(load[k]) >= OVERLOAD_PCT]
    if over:
        return "yellow", "Перегрузка: " + ", ".join(over)
    if open_titles is None:
        open_titles = [r["title"] for r in db.fetchall(
            "SELECT title FROM mon_incidents WHERE node_id = ? AND resolved_at IS NULL AND severity != 'info'", (int(node["id"]),))]
    if open_titles:
        return "yellow", "Сбой: " + "; ".join(open_titles[:2])
    return "green", "Всё работает"


def overview() -> dict[str, Any]:
    nodes = db.fetchall("SELECT * FROM mon_nodes ORDER BY name COLLATE NOCASE, id")
    titles: dict[int, list[str]] = {}
    for r in db.fetchall("SELECT node_id, title FROM mon_incidents WHERE resolved_at IS NULL AND severity != 'info'"):
        titles.setdefault(int(r["node_id"]), []).append(r["title"])
    briefs = []
    for n in nodes:
        b = node_brief(n, titles.get(int(n["id"]), []))
        b["load"] = _load_now(n) if b["status"] != "idle" else {"cpu": None, "ram": None, "disk": None}
        b["last_seen"] = n.get("last_seen")
        briefs.append(b)
    dots = {k: sum(1 for b in briefs if b["dot"] == k) for k in ("grey", "red", "yellow", "blue", "green")}
    return {
        "summary": {"total": len(briefs), "online": dots["green"] + dots["blue"], "problems": dots["red"] + dots["yellow"],
                    "idle": dots["grey"], "updates": dots["blue"], "open_incidents": sum(len(v) for v in titles.values())},
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
    incidents = []
    for i in db.fetchall("SELECT * FROM mon_incidents WHERE node_id = ? ORDER BY started_at DESC LIMIT 100", (nid,)):
        tl = _load_json(i.pop("timeline", None), [])
        i.pop("state", None)
        i["timeline"] = [{"at": a, "text": t} for a, t in tl] if len(tl) > 1 else []
        incidents.append(i)
    rb = _parse(node.get("reboot_at"))
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
        "open_incidents": sum(1 for i in incidents if not i.get("resolved_at") and i.get("severity") != "info"),
        "agent_outdated": agent_outdated(node),
        "latest_version": bundled_agent().get("version"),
        "can_self_update": can_self_update(node),
        "can_reboot": can_reboot(node),
        "update": {"target": node.get("update_target"), "requested_at": node.get("update_requested_at"),
                   "state": _load_json(node.get("update_state"), {}) or None},
        "beats_24h": _node_beats(nid, 86400, 48),
        "beats_7d": _node_beats(nid, 7 * 86400, 42),
        "rebooting": bool(rb and (_now() - rb).total_seconds() < REBOOT_GRACE and not
                          (_parse(node.get("last_seen")) and _parse(node.get("last_seen")) > rb + timedelta(seconds=20))),
    }


def _vless_uptime(nid: int, since: int) -> Optional[float]:
    r = db.fetchone("SELECT COUNT(*) AS n, SUM(ok) AS up FROM mon_vless WHERE node_id = ? AND ts >= ?", (nid, since))
    if not r or not r["n"]:
        return None
    return round(100.0 * float(r["up"] or 0) / float(r["n"]), 2)


_RANGES = {"6h": (6 * 3600, 60), "24h": (86400, 300), "7d": (7 * 86400, 1800)}


def _beat_rows(where: str, params: tuple, since: int, bucket: int) -> dict[int, dict[int, dict[str, int]]]:
    rows = db.fetchall(
        f"SELECT node_id, (ts - ?) / ? AS b, COUNT(*) AS n, "
        f"SUM(CASE WHEN lost >= sent THEN 1 ELSE 0 END) AS down, "
        f"SUM(CASE WHEN lost < sent AND (COALESCE(agent_ok, 1) = 0 OR lost * 5 >= sent) THEN 1 ELSE 0 END) AS warn "
        f"FROM mon_pings WHERE {where} AND ts >= ? GROUP BY node_id, b", (since, bucket, *params, since))
    out: dict[int, dict[int, dict[str, int]]] = {}
    for r in rows:
        out.setdefault(int(r["node_id"]), {})[int(r["b"])] = {"n": int(r["n"]), "down": int(r["down"] or 0), "warn": int(r["warn"] or 0)}
    return out


def _beats_from(buckets: dict[int, dict[str, int]], since: int, bucket: int, count: int) -> dict[str, Any]:
    buckets = dict(buckets)
    for k in [k for k in buckets if k >= count]:  # текущая минута на границе - в последнее деление
        extra = buckets.pop(k)
        last = buckets.setdefault(count - 1, {"n": 0, "down": 0, "warn": 0})
        for f in ("n", "down", "warn"):
            last[f] += extra[f]
    beats = []
    total = down = 0
    for i in range(count):
        c = buckets.get(i)
        if not c:
            beats.append([since + i * bucket, 0, 0, 0])
            continue
        st = 3 if c["down"] else 2 if c["warn"] else 1
        beats.append([since + i * bucket, st, c["down"], c["n"]])
        total += c["n"]; down += c["down"]
    return {"beats": beats, "pct": round(100.0 * (total - down) / total, 2) if total else None}


def uptime_beats_all(since: int, span: int, count: int) -> dict[int, dict[str, Any]]:
    bucket = max(60, span // count)
    data = _beat_rows("1 = 1", (), since, bucket)
    return {nid: _beats_from(b, since, bucket, count) for nid, b in data.items()}


def _node_beats(nid: int, span: int, count: int) -> list:
    since = int(time.time()) - span
    b = max(60, span // count)
    return _beats_from(_beat_rows("node_id = ?", (nid,), since, b).get(nid, {}), since, b, count)["beats"]


def downtime_intervals(nid: int, since: int) -> list[list[int]]:
    rows = db.fetchall("SELECT ts, lost, sent FROM mon_pings WHERE node_id = ? AND ts >= ? AND agent_ok = 0 ORDER BY ts",
                       (nid, since))
    out: list[list[int]] = []
    for r in rows:
        t = int(r["ts"]); hard = 1 if r["lost"] >= r["sent"] else 0
        if out and t - out[-1][1] <= 90:
            out[-1][1] = t + 60
            out[-1][2] = max(out[-1][2], hard)
        else:
            out.append([t, t + 60, hard])
    now = int(time.time())
    for iv in out:
        iv[1] = min(iv[1], now)
    return out


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
    elif metric == "down":
        pts = downtime_intervals(nid, since)
    elif metric == "beats":
        count = 90
        b = max(60, span // count)
        res = _beats_from(_beat_rows("node_id = ?", (nid,), since, b).get(nid, {}), since, b, count)
        return {"metric": metric, "range": rng, "bucket": b, "from": since, "to": int(time.time()),
                "points": res["beats"], "pct": res["pct"]}
    elif metric == "vless":
        rows = db.fetchall("SELECT ts AS t, ok, ms FROM mon_vless WHERE node_id = ? AND ts >= ? ORDER BY ts", (nid, since))
        pts = [[r["t"], r["ok"], r["ms"]] for r in rows]
    else:
        raise MonitorError("Неизвестная метрика")
    return {"metric": metric, "range": rng, "bucket": bucket, "from": since, "to": int(time.time()), "points": pts}

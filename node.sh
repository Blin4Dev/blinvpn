#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  BlinVPN — агент мониторинга сервера (blinmon)
#
#  Установка:   curl -fsSL https://<панель>/node.sh -o node.sh && sudo bash node.sh
#  Сменить ключ: sudo bash node.sh set-key
#  Удаление:    sudo bash node.sh uninstall
#
#  Что делает агент:
#    • раз в 5 секунд снимает загрузку CPU / RAM / диска / сети (только чтение /proc);
#    • каждые 5 минут складывает средние значения в память (последние 3 суток);
#    • раз в 15 минут замеряет скорость интернета (speed.cloudflare.com);
#    • отдаёт данные панели по HTTP — только на запросы, подписанные секретным
#      ключом (HMAC-SHA256, защита от повтора), и сам подписывает ответы.
#
#  Агент НИЧЕГО не выполняет по команде панели: нет shell, нет файлов, нет
#  аргументов — только фиксированные пути /v1/status и /v1/speedtest.
#  Работает от отдельного пользователя без прав, в изоляции systemd.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP=blinmon
DIR=/opt/blinmon
CONF_DIR=/etc/blinmon
CONF="$CONF_DIR/config.json"
UNIT=/etc/systemd/system/blinmon.service
DEFAULT_PORT=5055

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

need_root() {
  if [[ $EUID -ne 0 ]]; then red "Запустите от root: sudo bash node.sh"; exit 1; fi
}

ensure_python() {
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
    return
  fi
  bold "Устанавливаю python3…"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq python3 >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q python3
  elif command -v yum >/dev/null; then yum install -y -q python3
  elif command -v apk >/dev/null; then apk add --no-cache python3
  else red "Не удалось установить python3 — поставьте его вручную (нужен 3.8+)."; exit 1
  fi
}

ask_key() {
  local key=""
  while true; do
    read -r -s -p "Секретный ключ из панели: " key </dev/tty; echo
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    if [[ ${#key} -ge 40 && "$key" =~ ^[A-Za-z0-9_-]+$ ]]; then break; fi
    red "Ключ не похож на ключ из панели (минимум 40 символов: буквы, цифры, - и _). Попробуйте ещё раз."
  done
  KEY="$key"
}

ask_port() {
  local p=""
  read -r -p "Порт агента [${DEFAULT_PORT}]: " p </dev/tty || true
  p="${p:-$DEFAULT_PORT}"
  if ! [[ "$p" =~ ^[0-9]+$ ]] || (( p < 1024 || p > 65535 )); then
    red "Порт должен быть числом от 1024 до 65535."; exit 1
  fi
  PORT="$p"
}

write_config() {
  install -d -m 0750 -o root -g "$APP" "$CONF_DIR"
  umask 077
  python3 - "$KEY" "$PORT" "$CONF" <<'PY'
import json, sys
key, port, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(path, "w") as f:
    json.dump({"secret": key, "port": port, "speedtest_interval_min": 15}, f)
PY
  chown root:"$APP" "$CONF"
  chmod 0640 "$CONF"
}

write_agent() {
  install -d -m 0755 "$DIR"
  cat > "$DIR/agent.py" <<'AGENT_PY'
#!/usr/bin/env python3
# BlinVPN monitoring agent (blinmon). Только стандартная библиотека Python 3.8+.
import hashlib, hmac, json, os, socket, ssl, threading, time, urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

VERSION = "1.0.0"
CONF_PATH = os.environ.get("BLINMON_CONFIG", "/etc/blinmon/config.json")
SAMPLE_EVERY = 5            # сек — частота снятия показаний
AGG_EVERY = 300             # сек — одна точка истории (5 минут)
MAX_SAMPLES = 864           # 3 суток по 5 минут — на случай, если панель недоступна
MAX_SPEED = 300
TS_WINDOW = 90              # сек — допустимое расхождение часов с панелью
SPEED_COOLDOWN = 120        # сек — не чаще одного ручного замера
MAX_REQ_PER_MIN = 60        # с одного IP

with open(CONF_PATH) as _f:
    CONF = json.load(_f)
SECRET = str(CONF["secret"]).encode()
PORT = int(CONF.get("port", 5055))
SPEED_INTERVAL = max(5, int(CONF.get("speedtest_interval_min", 15))) * 60

lock = threading.Lock()
samples = deque(maxlen=MAX_SAMPLES)
speeds = deque(maxlen=MAX_SPEED)
seq = {"s": 0, "sp": 0}
live = {}
speed_state = {"running": False, "last_manual": 0.0, "requested": threading.Event()}
nonces = {}
hits = {}


# ── Показания системы (только чтение /proc и statvfs) ─────────────────────────
def read_cpu():
    with open("/proc/stat") as f:
        parts = f.readline().split()[1:]
    vals = [int(x) for x in parts[:8]]
    idle = vals[3] + vals[4]
    return sum(vals), idle


def read_mem():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0]) * 1024
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    return total, max(0, total - avail), info.get("SwapTotal", 0), info.get("SwapTotal", 0) - info.get("SwapFree", 0)


def physical_disks():
    out = set()
    try:
        for name in os.listdir("/sys/block"):
            if name.startswith(("loop", "ram", "zram", "dm-", "sr", "fd", "md")):
                continue
            out.add(name)
    except OSError:
        pass
    return out


DISKS = physical_disks()


def read_disk_io():
    rd = wr = 0
    try:
        with open("/proc/diskstats") as f:
            for line in f:
                p = line.split()
                if len(p) > 9 and p[2] in DISKS:
                    rd += int(p[5]) * 512
                    wr += int(p[9]) * 512
    except OSError:
        pass
    return rd, wr


def read_net():
    rx = tx = 0
    try:
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                name, data = line.split(":", 1)
                name = name.strip()
                if name == "lo" or name.startswith(("docker", "veth", "br-", "virbr")):
                    continue
                d = data.split()
                rx += int(d[0]); tx += int(d[8])
    except OSError:
        pass
    return rx, tx


def read_disk_usage():
    st = os.statvfs("/")
    total = st.f_blocks * st.f_frsize
    free = st.f_bavail * st.f_frsize
    return total, max(0, total - free)


def read_uptime():
    with open("/proc/uptime") as f:
        return int(float(f.read().split()[0]))


def sampler():
    prev_cpu = read_cpu(); prev_io = read_disk_io(); prev_net = read_net(); prev_t = time.time()
    acc = []
    last_agg = time.time()
    while True:
        time.sleep(SAMPLE_EVERY)
        try:
            now = time.time(); dt = max(0.001, now - prev_t)
            cpu = read_cpu(); io = read_disk_io(); net = read_net()
            dtot = cpu[0] - prev_cpu[0]; didle = cpu[1] - prev_cpu[1]
            cpu_pct = 0.0 if dtot <= 0 else max(0.0, min(100.0, 100.0 * (dtot - didle) / dtot))
            mem_total, mem_used, sw_total, sw_used = read_mem()
            point = {
                "cpu": cpu_pct,
                "ram_used": mem_used, "ram_total": mem_total,
                "rd": max(0, io[0] - prev_io[0]) / dt, "wr": max(0, io[1] - prev_io[1]) / dt,
                "rx": max(0, net[0] - prev_net[0]) / dt, "tx": max(0, net[1] - prev_net[1]) / dt,
            }
            prev_cpu, prev_io, prev_net, prev_t = cpu, io, net, now
            acc.append(point)
            disk_total, disk_used = read_disk_usage()
            load1 = os.getloadavg()[0]
            with lock:
                live.update({
                    "cpu": round(cpu_pct, 1), "ram_used": mem_used, "ram_total": mem_total,
                    "swap_used": sw_used, "swap_total": sw_total,
                    "disk_used": disk_used, "disk_total": disk_total,
                    "disk_read_bps": round(point["rd"]), "disk_write_bps": round(point["wr"]),
                    "net_rx_bps": round(point["rx"]), "net_tx_bps": round(point["tx"]),
                    "load1": round(load1, 2), "ts": int(now),
                })
            if now - last_agg >= AGG_EVERY and acc:
                n = len(acc)
                agg = {
                    "ts": int(now),
                    "cpu": round(sum(p["cpu"] for p in acc) / n, 1),
                    "cpu_max": round(max(p["cpu"] for p in acc), 1),
                    "ram_used": int(sum(p["ram_used"] for p in acc) / n), "ram_total": mem_total,
                    "disk_used": disk_used, "disk_total": disk_total,
                    "disk_read_bps": int(sum(p["rd"] for p in acc) / n),
                    "disk_write_bps": int(sum(p["wr"] for p in acc) / n),
                    "net_rx_bps": int(sum(p["rx"] for p in acc) / n),
                    "net_tx_bps": int(sum(p["tx"] for p in acc) / n),
                    "load1": round(load1, 2),
                }
                with lock:
                    seq["s"] += 1
                    agg["seq"] = seq["s"]
                    samples.append(agg)
                acc = []
                last_agg = now
        except Exception:  # показания не должны ронять агента
            time.sleep(1)


# ── Замер скорости ────────────────────────────────────────────────────────────
CTX = ssl.create_default_context()


def _download(n_bytes):
    req = urllib.request.Request(f"https://speed.cloudflare.com/__down?bytes={n_bytes}",
                                 headers={"User-Agent": "blinmon/" + VERSION})
    t0 = time.time(); got = 0
    with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            got += len(chunk)
            if time.time() - t0 > 25:
                break
    return got * 8 / max(0.001, time.time() - t0) / 1e6


def _upload(n_bytes):
    data = os.urandom(n_bytes)
    req = urllib.request.Request("https://speed.cloudflare.com/__up", data=data, method="POST",
                                 headers={"User-Agent": "blinmon/" + VERSION, "Content-Type": "application/octet-stream"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
        r.read()
    return n_bytes * 8 / max(0.001, time.time() - t0) / 1e6


def _latency():
    best = None
    for _ in range(3):
        req = urllib.request.Request("https://speed.cloudflare.com/__down?bytes=0", headers={"User-Agent": "blinmon/" + VERSION})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=10, context=CTX) as r:
            r.read()
        ms = (time.time() - t0) * 1000
        best = ms if best is None else min(best, ms)
    return best


def run_speedtest(manual):
    res = {"ts": int(time.time()), "manual": bool(manual)}
    try:
        res["ping_ms"] = round(_latency(), 1)
        res["down_mbps"] = round(_download(25_000_000), 2)
        res["up_mbps"] = round(_upload(10_000_000), 2)
        res["ok"] = True
    except Exception as e:
        res["ok"] = False
        res["error"] = type(e).__name__
    with lock:
        seq["sp"] += 1
        res["seq"] = seq["sp"]
        speeds.append(res)


def speed_loop():
    next_auto = time.time() + 60
    ev = speed_state["requested"]
    while True:
        manual = ev.wait(timeout=max(1.0, next_auto - time.time()))
        ev.clear()
        speed_state["running"] = True
        try:
            run_speedtest(manual)
        finally:
            speed_state["running"] = False
        next_auto = time.time() + SPEED_INTERVAL


# ── HTTP API с подписью ───────────────────────────────────────────────────────
def sign(msg):
    return hmac.new(SECRET, msg.encode(), hashlib.sha256).hexdigest()


def check_auth(method, target, headers):
    ts = headers.get("X-Blin-Ts", ""); nonce = headers.get("X-Blin-Nonce", ""); sig = headers.get("X-Blin-Sig", "")
    if not (ts.isdigit() and 16 <= len(nonce) <= 64 and len(sig) == 64):
        return None
    if abs(time.time() - int(ts)) > TS_WINDOW:
        return None
    if not hmac.compare_digest(sig, sign(f"{method}\n{target}\n{ts}\n{nonce}")):
        return None
    now = time.time()
    with lock:
        for k in [k for k, exp in nonces.items() if exp < now]:
            nonces.pop(k, None)
        if nonce in nonces:           # повтор перехваченного запроса
            return None
        nonces[nonce] = now + TS_WINDOW * 2
    return nonce


def rate_ok(ip):
    now = time.time()
    with lock:
        win = hits.get(ip)
        if not win or now - win[0] > 60:
            hits[ip] = [now, 1]
            if len(hits) > 5000:
                hits.clear()
            return True
        win[1] += 1
        return win[1] <= MAX_REQ_PER_MIN


class Handler(BaseHTTPRequestHandler):
    server_version = "blinmon"
    sys_version = ""
    timeout = 15

    def log_message(self, *a):  # без логов запросов
        pass

    def _send(self, code, obj, nonce=None):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if nonce:
            self.send_header("X-Blin-Sig", sign(f"resp\n{nonce}\n{hashlib.sha256(body).hexdigest()}"))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self, method):
        if not rate_ok(self.client_address[0]):
            return self._send(429, {"error": "rate"})
        target = self.path
        if len(target) > 200:
            return self._send(404, {"error": "not_found"})
        parts = urlsplit(target)
        if (method, parts.path) not in (("GET", "/v1/status"), ("POST", "/v1/speedtest")):
            return self._send(404, {"error": "not_found"})
        nonce = check_auth(method, target, self.headers)
        if not nonce:
            return self._send(401, {"error": "unauthorized"})
        if parts.path == "/v1/status":
            q = parse_qs(parts.query)
            def num(name):
                try:
                    return max(0, int((q.get(name) or ["0"])[0]))
                except ValueError:
                    return 0
            since, sp_since = num("since"), num("speed_since")
            with lock:
                data = {
                    "version": VERSION, "time": int(time.time()), "uptime": read_uptime(),
                    "cores": os.cpu_count() or 1, "live": dict(live),
                    "samples": [s for s in samples if s["seq"] > since],
                    "speed": [s for s in speeds if s["seq"] > sp_since],
                    "seq": seq["s"], "speed_seq": seq["sp"],
                    "speed_running": speed_state["running"],
                    "boot_id": BOOT_ID,
                }
            return self._send(200, data, nonce)
        # POST /v1/speedtest — тело запроса не читаем вовсе
        now = time.time()
        if speed_state["running"] or now - speed_state["last_manual"] < SPEED_COOLDOWN:
            return self._send(200, {"queued": False, "running": speed_state["running"]}, nonce)
        speed_state["last_manual"] = now
        speed_state["requested"].set()
        return self._send(200, {"queued": True}, nonce)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._send(404, {"error": "not_found"})

    do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_PUT


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()


BOOT_ID = os.urandom(8).hex()   # меняется при перезапуске агента — панель сбрасывает курсоры

if __name__ == "__main__":
    threading.Thread(target=sampler, daemon=True).start()
    threading.Thread(target=speed_loop, daemon=True).start()
    try:
        srv = Server(("::", PORT), Handler)
    except OSError:
        Server.address_family = socket.AF_INET
        srv = Server(("0.0.0.0", PORT), Handler)
    srv.serve_forever()
AGENT_PY
  chmod 0755 "$DIR/agent.py"
}

write_unit() {
  cat > "$UNIT" <<UNIT
[Unit]
Description=BlinVPN monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
User=${APP}
Group=${APP}
ExecStart=/usr/bin/env python3 ${DIR}/agent.py
Restart=always
RestartSec=5
# Изоляция: агент только читает /proc и отвечает по сети
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_INET AF_INET6
SystemCallArchitectures=native
MemoryMax=96M
CPUQuota=25%
TasksMax=64

[Install]
WantedBy=multi-user.target
UNIT
}

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${PORT}/tcp" >/dev/null && green "Порт ${PORT}/tcp открыт в ufw."
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null && firewall-cmd --reload >/dev/null && green "Порт ${PORT}/tcp открыт в firewalld."
  fi
}

do_install() {
  need_root
  command -v systemctl >/dev/null || { red "Нужен systemd."; exit 1; }
  bold "BlinVPN — установка агента мониторинга"
  ensure_python
  id "$APP" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP"
  ask_key
  ask_port
  write_agent
  write_config
  write_unit
  systemctl daemon-reload
  systemctl enable --now "$APP" >/dev/null
  systemctl restart "$APP"
  open_firewall
  sleep 1
  if systemctl is-active --quiet "$APP"; then
    green "Агент запущен на порту ${PORT}."
    echo "Вернитесь в панель и нажмите «Запустить» у этой ноды."
  else
    red "Агент не запустился. Журнал: journalctl -u ${APP} -n 50"
    exit 1
  fi
}

do_set_key() {
  need_root
  [[ -f "$CONF" ]] || { red "Агент не установлен."; exit 1; }
  ask_key
  PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$CONF")"
  write_config
  systemctl restart "$APP"
  green "Ключ обновлён, агент перезапущен."
}

do_uninstall() {
  need_root
  systemctl disable --now "$APP" 2>/dev/null || true
  rm -f "$UNIT"; systemctl daemon-reload
  rm -rf "$DIR" "$CONF_DIR"
  id "$APP" >/dev/null 2>&1 && userdel "$APP" 2>/dev/null || true
  green "Агент удалён."
}

case "${1:-install}" in
  install)   do_install ;;
  set-key)   do_set_key ;;
  uninstall) do_uninstall ;;
  *) echo "Использование: sudo bash node.sh [install|set-key|uninstall]"; exit 1 ;;
esac

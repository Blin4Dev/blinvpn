#!/usr/bin/env bash
# Версия агента. ПРИ ЛЮБОМ ИЗМЕНЕНИИ ЭТОГО ФАЙЛА увеличивайте вторую цифру (1.2.0 → 1.3.0):
# по ней панель понимает, что ноды пора обновить, и обновляет их сама.
NODE_VERSION="1.4.0"
# ─────────────────────────────────────────────────────────────────────────────
#  BlinVPN — агент мониторинга сервера (blinmon)
#
#  Установка:   curl -fsSL https://<панель>/node.sh -o node.sh && sudo bash node.sh install --panel https://<панель>
#  Обновление:  само, по команде панели (см. «Автообновление» ниже); вручную —
#               curl -fsSL https://<панель>/node.sh -o node.sh && sudo bash node.sh update --panel https://<панель>
#  Сменить ключ: sudo bash node.sh set-key
#  Удаление:    sudo bash node.sh uninstall
#
#  Что делает агент:
#    • раз в 5 секунд снимает загрузку CPU / RAM / диска / сети (только чтение /proc);
#    • каждую минуту складывает средние значения в память (последние 3 суток);
#    • раз в 10 минут замеряет скорость интернета (speed.cloudflare.com);
#    • отдаёт данные панели по HTTP — только на запросы, подписанные секретным
#      ключом (HMAC-SHA256, защита от повтора), и сам подписывает ответы.
#
#  Агент НИЧЕГО не выполняет по команде панели: нет shell, нет файлов, нет
#  аргументов — только фиксированные пути /v1/status, /v1/speedtest, /v1/reboot
#  и /v1/update. Работает от отдельного пользователя без прав, в изоляции systemd,
#  и запускается сам: при загрузке сервера и после любого падения.
#  Перезагрузка (если разрешена при установке): агент лишь создаёт флаг
#  /run/blinmon/reboot, а перезагружает сервер отдельный юнит systemd
#  blinmon-reboot.path — у самого агента прав root нет.
#
#  Автообновление (root-юнит blinmon-update, агенту прав root не нужно):
#    • раз в час сервер сам смотрит node.sh на GitHub проекта (запасной источник —
#      панель, указанная при установке) и, если версия новее, обновляется;
#    • кнопка «Обновить» в панели: панель присылает подписанным запросом SHA-256
#      своей версии node.sh, и она ставится, ТОЛЬКО если хэш совпал.
#  Откат на более старую версию не выполняется никогда.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP=blinmon
DIR=/opt/blinmon
CONF_DIR=/etc/blinmon
CONF="$CONF_DIR/config.json"
UNIT=/etc/systemd/system/blinmon.service
REBOOT_PATH_UNIT=/etc/systemd/system/blinmon-reboot.path
REBOOT_SVC_UNIT=/etc/systemd/system/blinmon-reboot.service
UPDATE_PATH_UNIT=/etc/systemd/system/blinmon-update.path
UPDATE_SVC_UNIT=/etc/systemd/system/blinmon-update.service
UPDATE_TIMER_UNIT=/etc/systemd/system/blinmon-update.timer
GITHUB_NODE_SH="https://raw.githubusercontent.com/Blin4Dev/blinvpn/main/node.sh"
DEFAULT_PORT=5055
ALLOW_REBOOT=1
PANEL_URL=""
AUTO=0

# Аргументы: node.sh <команда> [--panel https://панель] [--auto]
CMD="${1:-install}"; [[ $# -gt 0 ]] && shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --panel) PANEL_URL="${2:-}"; shift 2 || shift ;;
    --auto)  AUTO=1; shift ;;
    *) shift ;;
  esac
done
if [[ -n "$PANEL_URL" && ! "$PANEL_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  PANEL_URL=""   # только https://домен[:порт], без путей
fi

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

ask_reboot() {
  local a=""
  read -r -p "Разрешить перезагружать сервер из панели? [Y/n]: " a </dev/tty || true
  case "${a,,}" in n|no|н|нет) ALLOW_REBOOT=0 ;; *) ALLOW_REBOOT=1 ;; esac
}

conf_get() {  # conf_get ключ [по умолчанию]
  python3 - "$CONF" "$1" "${2:-}" <<'PY' 2>/dev/null || printf '%s' "${2:-}"
import json, sys
v = json.load(open(sys.argv[1])).get(sys.argv[2])
print(sys.argv[3] if v is None else (1 if v is True else 0 if v is False else v))
PY
}

write_config() {
  install -d -m 0750 -o root -g "$APP" "$CONF_DIR"
  umask 077
  # Ключ передаём через окружение, а не аргументом — иначе он виден всем в списке процессов
  BLINMON_KEY="$KEY" python3 - "$PORT" "$CONF" "$ALLOW_REBOOT" "$PANEL_URL" <<'PY'
import json, os, sys
key = os.environ["BLINMON_KEY"]
port, path, reboot, panel = int(sys.argv[1]), sys.argv[2], sys.argv[3] == "1", sys.argv[4]
with open(path, "w") as f:
    json.dump({"secret": key, "port": port, "speedtest_interval_min": 10, "allow_reboot": reboot,
               "panel_url": panel}, f)
PY
  chown root:"$APP" "$CONF"
  chmod 0640 "$CONF"
}

write_agent() {
  install -d -m 0755 "$DIR"
  cat > "$DIR/agent.py.new" <<'AGENT_PY'
#!/usr/bin/env python3
# BlinVPN monitoring agent (blinmon). Только стандартная библиотека Python 3.8+.
import hashlib, hmac, json, os, socket, ssl, threading, time, urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

VERSION = "__NODE_VERSION__"
CONF_PATH = os.environ.get("BLINMON_CONFIG", "/etc/blinmon/config.json")
SAMPLE_EVERY = 5            # сек — частота снятия показаний
AGG_EVERY = 60              # сек — одна точка истории (1 минута)
MAX_SAMPLES = 4320          # 3 суток по минуте — на случай, если панель недоступна
MAX_SPEED = 300
TS_WINDOW = 90              # сек — допустимое расхождение часов с панелью
SPEED_COOLDOWN = 120        # сек — не чаще одного ручного замера
MAX_REQ_PER_MIN = 60        # с одного IP

with open(CONF_PATH) as _f:
    CONF = json.load(_f)
SECRET = str(CONF["secret"]).encode()
PORT = int(CONF.get("port", 5055))
SPEED_INTERVAL = max(5, int(CONF.get("speedtest_interval_min", 10))) * 60
ALLOW_REBOOT = bool(CONF.get("allow_reboot", False))
REBOOT_MIN_UPTIME = 600               # сек — после загрузки перезагружать снова можно не раньше чем через 10 минут
AGENT_STARTED = int(time.time())      # запросы, подписанные до запуска агента, не принимаем (повтор после рестарта)
REBOOT_FLAG = "/run/blinmon/reboot"   # его видит blinmon-reboot.path (root) и перезагружает сервер
UPDATE_FLAG = "/run/blinmon/update"   # SHA-256 нужной версии node.sh для blinmon-update.path (root)
UPDATE_STATE = "/var/lib/blinmon-update/update.json"   # итог последнего обновления (папка и файл — root, агент только читает)


def update_state():
    try:
        with open(UPDATE_STATE) as f:
            st = json.load(f)
        return st if isinstance(st, dict) else None
    except (OSError, ValueError):
        return None

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
    if abs(time.time() - int(ts)) > TS_WINDOW or int(ts) < AGENT_STARTED - 2:
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
            if len(hits) > 5000:  # чистим только устаревшие окна, а не всех разом
                for k in [k for k, w in hits.items() if now - w[0] > 60]:
                    hits.pop(k, None)
                if len(hits) > 5000:
                    return False
            hits[ip] = [now, 1]
            return True
        win[1] += 1
        return win[1] <= MAX_REQ_PER_MIN


class Handler(BaseHTTPRequestHandler):
    server_version = "blinmon"
    sys_version = ""
    timeout = 10

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
        if (method, parts.path) not in (("GET", "/v1/status"), ("POST", "/v1/speedtest"), ("POST", "/v1/reboot"),
                                        ("POST", "/v1/update")):
            return self._send(404, {"error": "not_found"})
        nonce = check_auth(method, target, self.headers)
        if not nonce:
            return self._send(401, {"error": "unauthorized"})
        with lock:
            trusted_ips[self.client_address[0]] = time.time()
            if len(trusted_ips) > 16:  # держим только самые свежие
                for k in sorted(trusted_ips, key=trusted_ips.get)[:-16]:
                    trusted_ips.pop(k, None)
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
                    "allow_reboot": ALLOW_REBOOT,
                    "update": update_state(),
                }
            return self._send(200, data, nonce)
        if parts.path == "/v1/update":
            sha = (parse_qs(parts.query).get("sha") or [""])[0].lower()
            if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
                return self._send(400, {"error": "bad_sha"}, nonce)
            try:
                with open(UPDATE_FLAG, "w") as f:
                    f.write(sha)
            except OSError:
                return self._send(500, {"error": "update_unavailable"}, nonce)
            return self._send(200, {"updating": True}, nonce)
        if parts.path == "/v1/reboot":
            if not ALLOW_REBOOT:
                return self._send(403, {"error": "reboot_disabled"}, nonce)
            if read_uptime() < REBOOT_MIN_UPTIME:
                return self._send(429, {"error": "too_soon"}, nonce)
            try:
                with open(REBOOT_FLAG, "w") as f:
                    f.write(str(int(time.time())))
            except OSError:
                return self._send(500, {"error": "reboot_unavailable"}, nonce)
            return self._send(200, {"rebooting": True}, nonce)
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


MAX_CONN = 24
_conn_slots = threading.BoundedSemaphore(MAX_CONN)
# Отдельные места для адресов, которые уже присылали запросы с верным ключом (панель):
# даже если кто-то забил общий лимит висящими соединениями, панель проходит.
_trusted_slots = threading.BoundedSemaphore(8)
trusted_ips = {}   # ip → время последнего успешного запроса


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    # Не больше MAX_CONN одновременных соединений: медленные «висящие» клиенты
    # не могут исчерпать потоки агента, лишние соединения сразу закрываются.
    def process_request(self, request, client_address):
        slot = _conn_slots
        if not slot.acquire(blocking=False):
            slot = _trusted_slots
            if client_address[0] not in trusted_ips or not slot.acquire(blocking=False):
                self.shutdown_request(request)
                return
        try:
            t = threading.Thread(target=self._serve, args=(request, client_address, slot), daemon=True)
            t.start()
        except Exception:
            slot.release()
            self.shutdown_request(request)

    def handle_error(self, request, client_address):
        pass  # оборванные клиентом соединения — не ошибка агента, журнал не засоряем

    def _serve(self, request, client_address, slot):
        try:
            self.process_request_thread(request, client_address)
        finally:
            slot.release()
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
  sed -i "s/__NODE_VERSION__/${NODE_VERSION}/" "$DIR/agent.py.new"
  chmod 0755 "$DIR/agent.py.new"
  mv -f "$DIR/agent.py.new" "$DIR/agent.py"
}

write_unit() {
  cat > "$UNIT" <<UNIT
[Unit]
Description=BlinVPN monitoring agent
After=network-online.target
Wants=network-online.target
# Никогда не сдаваться: перезапускать сколько угодно раз
StartLimitIntervalSec=0

[Service]
User=${APP}
Group=${APP}
ExecStart=/usr/bin/env python3 ${DIR}/agent.py
Restart=always
RestartSec=5
# Единственное место, куда агент может писать: флаги перезагрузки/обновления.
# Итог обновления лежит в /var/lib/blinmon-update — это папка root, агент её только читает.
RuntimeDirectory=${APP}
RuntimeDirectoryMode=0700
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

write_reboot_units() {
  if [[ "$ALLOW_REBOOT" == "1" ]]; then
    cat > "$REBOOT_PATH_UNIT" <<UNIT
[Unit]
Description=BlinVPN: перезагрузка сервера по команде из панели

[Path]
PathExists=/run/${APP}/reboot
Unit=blinmon-reboot.service

[Install]
WantedBy=multi-user.target
UNIT
    cat > "$REBOOT_SVC_UNIT" <<UNIT
[Unit]
Description=BlinVPN: перезагрузка сервера

[Service]
Type=oneshot
# Не чаще раза в 10 минут: даже с ключом ноды нельзя держать сервер в цикле перезагрузок
ExecStart=/bin/sh -c 'rm -f /run/${APP}/reboot; up=\$\$(cut -d. -f1 /proc/uptime); [ "\$\$up" -ge 600 ] || exit 0; sleep 2; systemctl reboot'
UNIT
    systemctl daemon-reload
    systemctl enable --now blinmon-reboot.path >/dev/null 2>&1 || true
  else
    systemctl disable --now blinmon-reboot.path >/dev/null 2>&1 || true
    rm -f "$REBOOT_PATH_UNIT" "$REBOOT_SVC_UNIT"
    systemctl daemon-reload
  fi
}

write_updater() {
  # Сам скрипт обновления (root). Пишем во временный файл и подменяем — так
  # можно обновлять его прямо во время работы.
  cat > "$DIR/update.sh.new" <<'UPD'
#!/usr/bin/env bash
# BlinVPN: автообновление агента. Запускается blinmon-update.path по флагу от агента.
set -uo pipefail
FLAG=/run/blinmon/update
STATE_DIR=/var/lib/blinmon-update     # папка root: агент может только читать
LOG="$STATE_DIR/update.log"
CONF=/etc/blinmon/config.json
GITHUB="__GITHUB__"
umask 022
# Папка должна быть настоящей папкой root, а не ссылкой куда-то ещё
if [[ -L "$STATE_DIR" ]] || { [[ -e "$STATE_DIR" ]] && [[ "$(stat -c %u "$STATE_DIR")" != "0" ]]; }; then
  rm -rf "$STATE_DIR"
fi
install -d -m 0755 -o root -g root "$STATE_DIR"
result() {  # result ok(1/0) "ошибка" "версия" — пишем через временный файл и rename (ссылки не проходят)
  python3 - "$STATE_DIR" "$1" "$2" "$3" <<'PY'
import json, os, sys, tempfile, time
d, ok, err, ver = sys.argv[1:5]
fd, tmp = tempfile.mkstemp(dir=d, prefix=".update.")
with os.fdopen(fd, "w") as f:
    json.dump({"ok": ok == "1", "error": err, "version": ver, "at": int(time.time())}, f)
os.chmod(tmp, 0o644)
os.replace(tmp, os.path.join(d, "update.json"))
PY
}
read_flag() {  # SHA из флага агента: без перехода по ссылкам, только обычный файл, не больше 64 байт
  python3 - "$FLAG" <<'PY' 2>/dev/null
import os, stat, sys
p = sys.argv[1]
try:
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except OSError:
    sys.exit(0)
try:
    if stat.S_ISREG(os.fstat(fd).st_mode):
        data = os.read(fd, 64).decode("ascii", "ignore").strip().lower()
        if len(data) == 64 and all(c in "0123456789abcdef" for c in data):
            print(data)
finally:
    os.close(fd)
PY
}
fetch() {  # fetch URL FILE — curl, а если его нет — Python
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 60 "$1" -o "$2" 2>/dev/null
  else
    python3 -c 'import sys, urllib.request; open(sys.argv[2], "wb").write(urllib.request.urlopen(sys.argv[1], timeout=60).read())' "$1" "$2" 2>/dev/null
  fi
}
ver_of() { sed -n 's/^NODE_VERSION="\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/p' "$1" | head -1; }
newer_or_eq() { python3 -c 'import sys; v=lambda s: tuple(int(x) for x in (s or "0").split(".")); sys.exit(0 if v(sys.argv[1]) >= v(sys.argv[2]) else 1)' "$1" "$2"; }
looks_ok() { [[ -n "$(ver_of "$1")" ]] && grep -q 'blinmon' "$1" && bash -n "$1" 2>/dev/null; }

panel="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("panel_url") or "")' "$CONF" 2>/dev/null || true)"
cur="$(sed -n 's/^VERSION = "\([0-9.]*\)".*/\1/p' /opt/blinmon/agent.py | head -1)"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
got=""

if [[ -L "$FLAG" ]]; then rm -f "$FLAG"; fi
if [[ -f "$FLAG" ]]; then
  # Кнопка в панели: ставим ровно ту версию, чей SHA-256 прислала панель
  sha="$(read_flag)"; rm -f "$FLAG"
  [[ ${#sha} -eq 64 ]] || { result 0 "некорректный запрос" "$cur"; exit 0; }
  for src in "$GITHUB" ${panel:+"$panel/node.sh"}; do
    if fetch "$src" "$tmp" && [[ "$(sha256sum "$tmp" | cut -d' ' -f1)" == "$sha" ]]; then got="$src"; break; fi
  done
  [[ -n "$got" ]] || { result 0 "не удалось скачать нужную версию ни с GitHub, ни с панели" "$cur"; exit 0; }
else
  # Плановая проверка раз в час: берём node.sh с GitHub (или с панели) и ставим, если версия новее
  for src in "$GITHUB" ${panel:+"$panel/node.sh"}; do
    if fetch "$src" "$tmp" && looks_ok "$tmp"; then got="$src"; break; fi
  done
  if [[ -z "$got" ]]; then
    result 0 "не удалось получить node.sh ни с GitHub, ни с панели" "$cur"
    exit 0
  fi
  if newer_or_eq "$cur" "$(ver_of "$tmp")"; then
    exit 0   # уже последняя версия
  fi
fi

new="$(ver_of "$tmp")"
if ! newer_or_eq "$new" "$cur"; then
  result 0 "версия $new старее установленной $cur — не ставим" "$cur"
  exit 0
fi
rm -f "$LOG"
if bash "$tmp" update --auto >"$LOG" 2>&1; then
  result 1 "" "$new"
else
  result 0 "установка $new завершилась с ошибкой (см. /var/lib/blinmon-update/update.log)" "$cur"
fi
UPD
  sed -i "s#__GITHUB__#${GITHUB_NODE_SH}#" "$DIR/update.sh.new"
  chmod 0700 "$DIR/update.sh.new"
  mv -f "$DIR/update.sh.new" "$DIR/update.sh"

  cat > "$UPDATE_PATH_UNIT" <<UNIT
[Unit]
Description=BlinVPN: обновление агента по команде из панели

[Path]
PathExists=/run/${APP}/update
Unit=blinmon-update.service

[Install]
WantedBy=multi-user.target
UNIT
  cat > "$UPDATE_SVC_UNIT" <<UNIT
[Unit]
Description=BlinVPN: обновление агента

[Service]
Type=oneshot
ExecStart=${DIR}/update.sh
TimeoutStartSec=600
UNIT
  cat > "$UPDATE_TIMER_UNIT" <<UNIT
[Unit]
Description=BlinVPN: проверка обновлений агента раз в час

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
RandomizedDelaySec=10min
Unit=blinmon-update.service

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now blinmon-update.path >/dev/null 2>&1 || true
  systemctl enable --now blinmon-update.timer >/dev/null 2>&1 || true
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
  ask_reboot
  write_agent
  write_config
  write_unit
  systemctl daemon-reload
  write_reboot_units
  write_updater
  systemctl enable --now "$APP" >/dev/null
  systemctl restart "$APP"
  open_firewall
  sleep 1
  if systemctl is-active --quiet "$APP"; then
    green "Агент ${NODE_VERSION} запущен на порту ${PORT} и будет стартовать сам после перезагрузки сервера."
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
  ALLOW_REBOOT="$(conf_get allow_reboot 0)"
  PANEL_URL="${PANEL_URL:-$(conf_get panel_url)}"
  write_config
  systemctl restart "$APP"
  green "Ключ обновлён, агент перезапущен."
}

do_update() {
  need_root
  [[ -f "$CONF" ]] || { red "Агент не установлен. Установка: sudo bash node.sh install"; exit 1; }
  [[ "$AUTO" == "1" ]] || bold "BlinVPN — обновление агента мониторинга до ${NODE_VERSION}"
  ensure_python
  id "$APP" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP"
  # Ключ, порт и адрес панели остаются прежними
  KEY="$(conf_get secret)"
  PORT="$(conf_get port "$DEFAULT_PORT")"
  PANEL_URL="${PANEL_URL:-$(conf_get panel_url)}"
  if [[ "$AUTO" == "1" ]]; then
    ALLOW_REBOOT="$(conf_get allow_reboot 1)"
  elif python3 -c 'import json,sys; sys.exit(0 if "allow_reboot" in json.load(open(sys.argv[1])) else 1)' "$CONF"; then
    ALLOW_REBOOT="$(conf_get allow_reboot 0)"
    if [[ "$ALLOW_REBOOT" == "1" ]]; then echo "Перезагрузка из панели: разрешена."; else echo "Перезагрузка из панели: запрещена."; fi
    local a=""
    read -r -p "Изменить? [y/N]: " a </dev/tty || true
    case "${a,,}" in y|yes|д|да) ask_reboot ;; esac
  else
    ask_reboot
  fi
  if [[ -z "$PANEL_URL" && "$AUTO" != "1" ]]; then
    echo "Адрес панели не указан — обновляться агент будет только с GitHub."
    echo "Чтобы добавить запасной источник: sudo bash node.sh update --panel https://<панель>"
  fi
  rm -rf /var/lib/blinmon   # старое место итогов обновления (1.2–1.3) — принадлежало агенту
  write_agent
  write_config
  write_unit
  systemctl daemon-reload
  write_reboot_units
  write_updater
  systemctl enable "$APP" >/dev/null 2>&1 || true
  systemctl restart "$APP"
  sleep 1
  if systemctl is-active --quiet "$APP"; then
    green "Агент обновлён до ${NODE_VERSION} и перезапущен (ключ и порт прежние)."
  else
    red "Агент не запустился. Журнал: journalctl -u ${APP} -n 50"
    exit 1
  fi
}

do_uninstall() {
  need_root
  systemctl disable --now "$APP" 2>/dev/null || true
  systemctl disable --now blinmon-reboot.path blinmon-update.path blinmon-update.timer 2>/dev/null || true
  rm -f "$UNIT" "$REBOOT_PATH_UNIT" "$REBOOT_SVC_UNIT" "$UPDATE_PATH_UNIT" "$UPDATE_SVC_UNIT" "$UPDATE_TIMER_UNIT"; systemctl daemon-reload
  rm -rf /var/lib/blinmon /var/lib/blinmon-update
  rm -rf "$DIR" "$CONF_DIR"
  id "$APP" >/dev/null 2>&1 && userdel "$APP" 2>/dev/null || true
  green "Агент удалён."
}

case "$CMD" in
  install)   do_install ;;
  update)    do_update ;;
  set-key)   do_set_key ;;
  uninstall) do_uninstall ;;
  version)   echo "$NODE_VERSION" ;;
  *) echo "Использование: sudo bash node.sh [install|update|set-key|uninstall|version] [--panel https://панель]"; exit 1 ;;
esac

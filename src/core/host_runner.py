#!/usr/bin/env python3
"""
Помощник BlinVPN на сервере (systemd: blinvpn-host.service, от root).

Панель не может сама ставить контейнеры и править nginx — она работает в Docker
без прав на сервер. Поэтому панель кладёт ЗАДАНИЕ в data/host/jobs/<id>.json,
а этот помощник его выполняет и пишет результат в data/host/results/<id>.json.

Выполняются только перечисленные ниже действия с проверенными параметрами —
произвольные команды помощник не принимает. Сетевых портов не открывает.

Действия:
  status          — состояние XBM, nginx страницы подписки, сети Docker
  xbm_install     — собрать и запустить XBM (параметры: remnawave_url, sub_domain, network)
  xbm_connect     — подключить XBM к nginx страницы подписки (sub_domain, conf, container)
  xbm_disconnect  — вернуть nginx как было (conf, container)
  xbm_stop        — остановить XBM
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Optional

# Файл лежит в src/core/ — корень проекта тремя уровнями выше
PROJECT = os.path.abspath(sys.argv[sys.argv.index("--project") + 1]) if "--project" in sys.argv else os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(PROJECT, "data")
ENV = os.path.join(PROJECT, ".env")

XBM_CONTAINER = "xray-balancer-mw"
ID_RE = re.compile(r"^[a-f0-9]{16}$")
DOMAIN_RE = re.compile(r"^(?=.{4,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")
URL_RE = re.compile(r"^https?://[A-Za-z0-9.:_-]{1,200}(/[A-Za-z0-9._~/-]{0,200})?$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")
CONF_RE = re.compile(r"^/opt/[A-Za-z0-9._/-]{1,200}/nginx\.conf$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{4,128}$")
MAX_JOB_BYTES = 8192
MAX_JOBS_PER_PASS = 3   # больше за проход не выполняем — лишние задания удаляются
MAX_RESULTS = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Каталоги открываются один раз и дальше используются только через дескрипторы:
# data/ пишет контейнер, и подменить каталог ссылкой «на лету» не выйдет.
_FD: dict[str, int] = {}


class Job:
    def __init__(self, jid: str) -> None:
        self.id = jid
        self.name = f"{jid}.json"
        self.data: dict[str, Any] = {"id": jid, "status": "running", "log": [], "started_at": _now(), "result": None}
        self.save()

    def log(self, line: str) -> None:
        self.data["log"] = (self.data["log"] + [str(line)[:500]])[-200:]
        self.save()

    def done(self, ok: bool, result: Any = None, error: str = "") -> None:
        self.data.update(status="ok" if ok else "error", result=result, error=error or None, finished_at=_now())
        self.save()

    def save(self) -> None:
        _write_file(_FD["results"], self.name, json.dumps(self.data, ensure_ascii=False))


class Fail(Exception):
    pass


# ── Утилиты ─────────────────────────────────────────────────────────────────

def _write_file(dir_fd: int, name: str, text: str) -> None:
    tmp = name + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o644, dir_fd=dir_fd)
    try:
        os.write(fd, text.encode("utf-8"))
        os.fchmod(fd, 0o644)
    finally:
        os.close(fd)
    os.replace(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def run(args: list[str], job: Optional[Job] = None, timeout: int = 900, check: bool = True) -> subprocess.CompletedProcess:
    p = subprocess.run(args, cwd=PROJECT, capture_output=True, text=True, timeout=timeout)
    if job is not None and p.returncode != 0:
        for line in (p.stdout + p.stderr).strip().splitlines()[-15:]:
            job.log(line)
    if check and p.returncode != 0:
        raise Fail(f"команда завершилась с ошибкой: {' '.join(args[:4])}")
    return p


def compose(*args: str) -> list[str]:
    if shutil.which("docker") and subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0:
        return ["docker", "compose", *args]
    return ["docker-compose", *args]


def env_get(key: str) -> str:
    try:
        with open(ENV, encoding="utf-8") as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def env_set(key: str, value: str) -> None:
    if "\n" in value or "\r" in value:
        raise Fail("неверное значение")
    lines: list[str] = []
    try:
        with open(ENV, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        pass
    out, found = [], False
    for line in lines:
        if line.startswith(key + "="):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    tmp = ENV + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, ENV)


def xbm_port() -> str:
    p = env_get("XBM_PORT")
    return p if p.isdigit() else "4100"


def http_get(url: str, headers: Optional[dict[str, str]] = None, timeout: float = 10) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — адрес собран из проверенных частей
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, b""


def xbm_healthy() -> bool:
    try:
        code, _, body = http_get(f"http://127.0.0.1:{xbm_port()}/health", timeout=3)
        return code == 200 and b'"ok"' in body
    except Exception:  # noqa: BLE001
        return False


def container_state(name: str) -> str:
    p = subprocess.run(["docker", "inspect", "-f", "{{.State.Status}}", name], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else "absent"


def _root_only(path: str) -> bool:
    """Файл и все каталоги над ним — root и не доступны на запись никому другому."""
    cur = path
    while True:
        try:
            st = os.lstat(cur)
        except OSError:
            return False
        if st.st_uid != 0 or st.st_mode & 0o022 or stat.S_ISLNK(st.st_mode):
            return False
        parent = os.path.dirname(cur)
        if parent == cur:
            return True
        cur = parent


def safe_conf(conf: str) -> str:
    """
    Путь к nginx.conf страницы подписки: настоящий путь, вне каталога BlinVPN, и ни он,
    ни каталоги над ним не может подменить никто, кроме root (иначе правка и резервная
    копия от root пошли бы по чужой ссылке).
    """
    real = os.path.realpath(conf)
    proj = os.path.realpath(PROJECT)
    if not CONF_RE.fullmatch(real) or real == proj or real.startswith(proj + os.sep):
        raise Fail("Неверный путь к nginx.conf")
    if not os.path.isfile(real):
        raise Fail(f"Файла {conf} нет")
    if not _root_only(real):
        raise Fail("nginx.conf и каталоги над ним должны принадлежать root и не быть доступны на запись другим")
    return real


def profiles(add: Optional[bool]) -> None:
    cur = [p for p in env_get("COMPOSE_PROFILES").split(",") if p.strip()]
    if add and "xbm" not in cur:
        cur.append("xbm")
    if add is False:
        cur = [p for p in cur if p != "xbm"]
    env_set("COMPOSE_PROFILES", ",".join(cur))


def nginx_tool():
    sys.path.insert(0, os.path.join(PROJECT, "xbm", "tools"))
    import nginx_xbm  # type: ignore
    return nginx_xbm


# ── Действия ────────────────────────────────────────────────────────────────

def act_status(job: Job, p: dict[str, Any]) -> dict[str, Any]:
    ng = p.get("container") or "remnawave-nginx"
    connected = None
    try:
        conf = safe_conf(p.get("conf") or "/opt/remnawave/nginx/nginx.conf")
        with open(conf, encoding="utf-8", newline="") as f:
            connected = nginx_tool().is_enabled(f.read())
    except (Fail, OSError):
        conf = ""
    nets = subprocess.run(["docker", "network", "ls", "--format", "{{.Name}}"], capture_output=True, text=True).stdout.split()
    return {
        "xbm_container": container_state(XBM_CONTAINER),
        "xbm_healthy": xbm_healthy(),
        "nginx_conf": bool(conf),
        "nginx_container": container_state(ng),
        "connected": connected,
        "networks": [n for n in nets if NAME_RE.fullmatch(n) and n not in ("host", "none", "bridge")][:50],
        "network": env_get("XBM_DOCKER_NETWORK") or "remnawave-network",
        "remnawave_url": env_get("XBM_REMNAWAVE_URL"),
        "sub_domain": env_get("XBM_SUB_DOMAIN"),
    }


def act_xbm_install(job: Job, p: dict[str, Any]) -> dict[str, Any]:
    url, dom, net = p["remnawave_url"], p["sub_domain"], p.get("network") or "remnawave-network"
    job.log("Проверяю сеть Docker Remnawave…")
    if net in ("host", "none", "bridge") or run(["docker", "network", "inspect", net], check=False).returncode != 0:
        raise Fail(f"Сети Docker «{net}» нет. XBM ставится на сервер, где стоит Remnawave")
    env_set("XBM_DOCKER_NETWORK", net)
    env_set("XBM_REMNAWAVE_URL", url)
    env_set("XBM_SUB_DOMAIN", dom)
    profiles(True)
    # data/ пишет контейнер — каталог открываем без перехода по ссылкам
    os.close(_open_dir(_FD["data"], "xbm", 1000, 0o755))
    job.log("Собираю XBM (пара минут)…")
    for attempt in range(3):
        if run(compose("build", "xbm"), job, check=False).returncode == 0:
            break
        job.log(f"Сборка не удалась (попытка {attempt + 1} из 3), повторяю…")
        time.sleep(15)
    else:
        raise Fail("Сборка XBM не удалась — ничего не менял")
    # XBM, поставленный раньше отдельно, заменяем (имя контейнера то же — nginx не заметит)
    proj = subprocess.run(["docker", "inspect", XBM_CONTAINER, "--format",
                           '{{ index .Config.Labels "com.docker.compose.project" }}'], capture_output=True, text=True).stdout.strip()
    if proj and proj != os.path.basename(PROJECT):
        job.log("Заменяю XBM, установленный ранее отдельно…")
        run(["docker", "rm", "-f", XBM_CONTAINER], job, check=False)
    job.log("Запускаю XBM…")
    run(compose("up", "-d", "xbm"), job)
    for _ in range(40):
        if xbm_healthy():
            break
        time.sleep(1)
    else:
        raise Fail("XBM не отвечает после запуска")
    job.log("XBM запущен")
    return {"healthy": True}


def _nginx_common(p: dict[str, Any]) -> tuple[str, str]:
    conf = safe_conf(p.get("conf") or "/opt/remnawave/nginx/nginx.conf")
    ng = p.get("container") or "remnawave-nginx"
    if "nginx" not in ng.lower():
        raise Fail("Укажите контейнер nginx")
    if container_state(ng) != "running":
        raise Fail(f"Контейнер {ng} не запущен")
    if run(["docker", "exec", ng, "nginx", "-t"], check=False).returncode != 0:
        raise Fail("nginx -t уже сейчас с ошибкой — сначала почините конфиг")
    return conf, ng


def _reload_or_restore(job: Job, conf: str, ng: str, backup: str) -> None:
    if run(["docker", "exec", ng, "nginx", "-t"], job, check=False).returncode != 0:
        shutil.copy2(backup, conf)
        raise Fail("nginx -t не прошёл — вернул конфиг как было")
    run(["docker", "exec", ng, "nginx", "-s", "reload"], job)


def act_xbm_connect(job: Job, p: dict[str, Any]) -> dict[str, Any]:
    conf, ng = _nginx_common(p)
    if not xbm_healthy():
        raise Fail("XBM не запущен — сначала первый шаг")
    dom = p.get("sub_domain") or env_get("XBM_SUB_DOMAIN")
    if not DOMAIN_RE.fullmatch(dom or ""):
        raise Fail("Не задан домен страницы подписки")
    nx = nginx_tool()
    with open(conf, encoding="utf-8", newline="") as f:
        text = f.read()
    if nx.is_enabled(text):
        return {"already": True}
    netmode = subprocess.run(["docker", "inspect", "-f", "{{.HostConfig.NetworkMode}}", ng], capture_output=True, text=True).stdout.strip()
    target = f"127.0.0.1:{xbm_port()}" if netmode == "host" else f"{XBM_CONTAINER}:4100"
    job.log("Правлю nginx страницы подписки (с резервной копией)…")
    try:
        new = nx.enable(text, dom, target)
    except nx.NginxXbmError as e:
        raise Fail(str(e))
    backup = nx._write(conf, new)
    job.log(f"Резервная копия: {backup}")
    _reload_or_restore(job, conf, ng, backup)
    tok = p.get("token") or ""
    if tok:
        time.sleep(2)
        job.log("Проверяю подписку через nginx…")
        try:
            code, hdr, _ = http_get(f"https://{dom}/{tok}", {"User-Agent": "Happ/1.0"}, timeout=20)
        except Exception as exc:  # noqa: BLE001
            code, hdr = 0, {}
            job.log(f"{type(exc).__name__}: {exc}")
        if code == 429:
            job.log("XBM ограничил частоту запросов — значит, nginx до него достучался")
        elif code != 200 or "x-xbm" not in hdr:
            shutil.copy2(backup, conf)
            run(["docker", "exec", ng, "nginx", "-s", "reload"], job, check=False)
            raise Fail("Подписка идёт не через XBM — правку nginx откатил" if code == 200 else f"Подписка ответила {code or 'без ответа'} — правку nginx откатил")
    job.log("XBM подключён к подписке")
    return {"connected": True, "checked": bool(tok)}


def act_xbm_disconnect(job: Job, p: dict[str, Any]) -> dict[str, Any]:
    conf, ng = _nginx_common(p)
    nx = nginx_tool()
    with open(conf, encoding="utf-8", newline="") as f:
        text = f.read()
    if not nx.is_enabled(text):
        return {"already": True}
    backup = nx._write(conf, nx.disable(text))
    _reload_or_restore(job, conf, ng, backup)
    job.log("Подписка снова идёт напрямую")
    return {"connected": False}


def act_xbm_stop(job: Job, p: dict[str, Any]) -> dict[str, Any]:
    run(compose("stop", "xbm"), job, check=False)
    profiles(False)
    job.log("XBM остановлен")
    return {"stopped": True}


ACTIONS: dict[str, Callable[[Job, dict[str, Any]], Any]] = {
    "status": act_status, "xbm_install": act_xbm_install, "xbm_connect": act_xbm_connect,
    "xbm_disconnect": act_xbm_disconnect, "xbm_stop": act_xbm_stop,
}


def validate(action: str, params: Any) -> dict[str, Any]:
    if action not in ACTIONS:
        raise Fail("неизвестное действие")
    if not isinstance(params, dict):
        params = {}
    out: dict[str, Any] = {}
    for key, rx in (("remnawave_url", URL_RE), ("sub_domain", DOMAIN_RE), ("network", NAME_RE),
                    ("container", NAME_RE), ("conf", CONF_RE), ("token", TOKEN_RE)):
        v = params.get(key)
        if v in (None, ""):
            continue
        if not isinstance(v, str) or not rx.fullmatch(v) or ".." in v:
            raise Fail(f"неверный параметр {key}")
        out[key] = v
    if action == "xbm_install" and not ("remnawave_url" in out and "sub_domain" in out):
        raise Fail("нужны адрес Remnawave и домен подписки")
    return out


def read_job(name: str) -> Optional[dict[str, Any]]:
    """Задание читаем без перехода по ссылкам (каталог пишет контейнер)."""
    try:
        fd = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), dir_fd=_FD["jobs"])
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_JOB_BYTES:
            return None
        raw = os.read(fd, MAX_JOB_BYTES)
    finally:
        os.close(fd)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def process(name: str) -> None:
    jid = name[:-5]
    data = read_job(name)
    try:
        os.unlink(name, dir_fd=_FD["jobs"])
    except OSError:
        pass
    if not ID_RE.fullmatch(jid):
        return
    try:
        os.stat(f"{jid}.json", dir_fd=_FD["results"], follow_symlinks=False)
        return  # уже выполнялось
    except OSError:
        pass
    job = Job(jid)
    if data is None:
        job.done(False, error="неверное задание")
        return
    try:
        params = validate(str(data.get("action")), data.get("params"))
        job.data["action"] = data.get("action")
        result = ACTIONS[str(data["action"])](job, params)
        job.done(True, result)
    except Fail as e:
        job.done(False, error=str(e))
    except subprocess.TimeoutExpired:
        job.done(False, error="превышено время ожидания")
    except Exception as exc:  # noqa: BLE001
        job.done(False, error=f"{type(exc).__name__}: {exc}"[:300])


def cleanup() -> None:
    """Результаты старше недели и сверх MAX_RESULTS (самые старые) — удаляем."""
    cutoff = time.time() - 7 * 86400
    fd = _FD["results"]
    items = []
    for n in os.listdir(fd):
        try:
            items.append((os.stat(n, dir_fd=fd, follow_symlinks=False).st_mtime, n))
        except OSError:
            pass
    items.sort(reverse=True)
    # недописанные задания панели (.<id>.tmp), брошенные больше часа назад
    jfd = _FD["jobs"]
    for n in os.listdir(jfd):
        try:
            if n.endswith(".tmp") and os.stat(n, dir_fd=jfd, follow_symlinks=False).st_mtime < time.time() - 3600:
                os.unlink(n, dir_fd=jfd)
        except OSError:
            pass
    for i, (mt, n) in enumerate(items):
        if mt < cutoff or i >= MAX_RESULTS:
            try:
                os.unlink(n, dir_fd=fd)
            except OSError:
                pass


def _open_dir(parent_fd: int, name: str, uid: int, mode: int) -> int:
    """Открыть (создать) подкаталог без перехода по ссылкам и выставить владельца/права."""
    try:
        st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(st.st_mode):
            os.unlink(name, dir_fd=parent_fd)  # вместо каталога подсунули файл/ссылку
            raise FileNotFoundError
    except FileNotFoundError:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
    os.fchown(fd, uid, uid)
    os.fchmod(fd, mode)
    return fd


def main() -> None:
    os.makedirs(DATA, exist_ok=True)
    data_fd = os.open(DATA, os.O_RDONLY | os.O_DIRECTORY)
    _FD["data"] = data_fd
    # data/host — помощника (root); задания пишет контейнер (uid 1000), результаты — только помощник
    _FD["host"] = _open_dir(data_fd, "host", 0, 0o755)
    _FD["jobs"] = _open_dir(_FD["host"], "jobs", 1000, 0o700)
    _FD["results"] = _open_dir(_FD["host"], "results", 0, 0o755)
    last_clean = 0.0
    while True:
        _write_file(_FD["host"], "heartbeat", _now())
        names = sorted(n for n in os.listdir(_FD["jobs"]) if n.endswith(".json"))
        for i, name in enumerate(names):
            if i < MAX_JOBS_PER_PASS:
                process(name)
            else:
                try:  # заданий больше, чем панель может поставить, — не выполняем
                    os.unlink(name, dir_fd=_FD["jobs"])
                except OSError:
                    pass
        if time.time() - last_clean > 3600:
            last_clean = time.time()
            cleanup()
        time.sleep(2)


if __name__ == "__main__":
    main()

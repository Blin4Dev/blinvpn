"""
Фоновый сервис мониторинга (docker-compose: monitor).

Раз в минуту опрашивает агентов всех запущенных нод и пингует их, раз в 5 минут
проверяет VLESS, после каждого прохода пересчитывает инциденты, отправляет
напоминания об оплате и раз в час удаляет историю старше 7 дней.

Запуск: python /app/src/core/monitor.py
"""

from __future__ import annotations

import fcntl
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import database as db  # noqa: E402
import monitoring as mon  # noqa: E402

WORKERS = int(os.getenv("MONITOR_WORKERS") or 16)


def log(msg: str) -> None:
    print(f"[monitor] {msg}", flush=True)


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:  # noqa: BLE001
        log("ошибка: " + traceback.format_exc(limit=3).replace("\n", " | "))
        return None


def poll_all(pool: ThreadPoolExecutor) -> None:
    nodes = db.fetchall("SELECT * FROM mon_nodes WHERE enabled = 1")
    list(pool.map(lambda n: _safe(mon.poll_node, n), nodes))
    for n in nodes:
        _safe(mon.evaluate, n)


def vless_all(pool: ThreadPoolExecutor) -> None:
    nodes = db.fetchall("SELECT * FROM mon_nodes WHERE enabled = 1 AND vless_enc IS NOT NULL")
    list(pool.map(lambda n: _safe(mon.vless_node, n), nodes))


def main() -> None:
    db.init_db()
    # Только один экземпляр сервиса на базу
    lock_path = os.path.join(os.path.dirname(os.path.abspath(db.get_db_path())), ".monitor.lock")
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("уже запущен другой экземпляр — выходим")
        return
    log(f"запущен (Xray: {'есть' if mon.xray_bin() else 'нет — проверка VLESS отключена'})")
    last_vless = 0.0
    last_clean = 0.0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        while True:
            started = time.time()
            _safe(poll_all, pool)
            if started - last_vless >= mon.VLESS_EVERY:
                last_vless = started
                _safe(vless_all, pool)
            _safe(mon.check_payments)
            if started - last_clean >= 3600:
                last_clean = started
                _safe(mon.cleanup)
            time.sleep(max(1.0, mon.POLL_EVERY - (time.time() - started)))


if __name__ == "__main__":
    main()

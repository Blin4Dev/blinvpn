"""
Анти-абуз: периодический опрос Remnawave по активным подпискам BlinVPN.

Правила (по каждой активной подписке, лимит = devices_limit):
  1. HWID: если число HWID-устройств ≥ 2 × лимит — бан.
     (лимит 1 → ≥2, лимит 2 → ≥4, лимит 3 → ≥6 …)
  2. IP: если число активных IP ≥ лимит + 2 — бан.
     (лимит 1 → ≥3, лимит 2 → ≥4, лимит 3 → ≥5 …)
     Активные IP берутся из «Активных сессий» Remnawave (/api/connections/by-node):
     каждая нода отдаёт подключённых пользователей и их IP со временем последней
     активности; учитываются IP, активные за последние IP_ACTIVE_MINUTES минут,
     по всем нодам сразу.

Сначала предупреждение, потом бан:
  • первое нарушение — пользователю приходит предупреждение в бота, бана нет;
  • следующие WARN_GRACE_HOURS (24 ч) нарушения игнорируются — время всё исправить;
  • нарушение позже 24 ч (но в пределах WARN_VALID_DAYS после предупреждения) — бан;
  • если после предупреждения прошло больше WARN_VALID_DAYS — снова предупреждение.

Бан = подписка помечается 'Banned' в БД + пользователь Remnawave отключается.

Осторожно: IP-правило срабатывает ТОЛЬКО когда из Remnawave реально удаётся
получить IP-адреса устройств (иначе пропускаем — чтобы не забанить оплатившего
по недостатку данных). HWID-правило работает всегда, пока Remnawave доступна.
"""

from __future__ import annotations

from typing import Any, Optional

try:
    from . import database as db  # type: ignore
except ImportError:
    import database as db  # type: ignore

try:
    from . import provisioning  # type: ignore
except ImportError:
    import provisioning  # type: ignore

try:
    from . import forum  # type: ignore
except ImportError:
    import forum  # type: ignore

try:
    from . import moderation  # type: ignore
except ImportError:
    import moderation  # type: ignore

try:
    import remnawave  # type: ignore
except Exception:  # noqa: BLE001
    remnawave = None  # type: ignore

MAX_PER_RUN = 400
IP_ACTIVE_MINUTES = 10       # IP считается активным, если был виден за это время
NODE_JOB_TIMEOUT = 60        # сколько ждать ответа ноды, сек
HWID_MULTIPLIER = 2  # бан, если HWID-устройств ≥ 2 × лимит тарифа
WARN_GRACE_HOURS = 24   # после предупреждения нарушения игнорируются это время
WARN_VALID_DAYS = 7     # предупреждение «действует» столько дней, потом — новое


def enabled() -> bool:
    return db.get_setting("antiabuse_enabled", "1") in ("1", "true", "True", "yes")


def _int(key: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(float(db.get_setting(key, str(default)) or default))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def limits() -> dict[str, int]:
    """Пороги анти-абуза (настраиваются в панели → Цены → Защита)."""
    return {
        "hwid_multiplier": _int("aa_hwid_multiplier", HWID_MULTIPLIER, 2, 10),   # HWID ≥ N × лимит
        "ip_extra": _int("aa_ip_extra", 2, 1, 20),                             # IP ≥ лимит + N
        "grace_hours": _int("aa_grace_hours", WARN_GRACE_HOURS, 1, 168),       # после предупреждения не считаем
        "warn_days": _int("aa_warn_days", WARN_VALID_DAYS, 1, 60),             # предупреждение действует
    }


def _client():
    if remnawave is None or not provisioning.is_configured():
        return None
    try:
        return remnawave.get_client()
    except Exception:  # noqa: BLE001
        return None


def _rw_num_id_for(sub: dict[str, Any], client) -> Optional[int]:
    """
    ЧИСЛОВОЙ id пользователя Remnawave (3.x идентифицирует им HWID/disable).
    В нашей БД rw_id — это uuid, поэтому резолвим пользователя по telegram_id
    и берём числовое поле id.
    """
    tg = db.fetchone("SELECT telegram_id FROM users WHERE id = ?", (sub.get("user_id"),))
    if not (tg and tg.get("telegram_id")):
        return None
    try:
        rw = client.find_user_by_telegram(int(tg["telegram_id"]))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(rw, dict):
        return None
    val = rw.get("id")
    try:
        return int(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _hwid_devices(client, rw_id: int) -> list[dict[str, Any]]:
    try:
        data = client.get_user_hwid_devices(rw_id)
    except Exception:  # noqa: BLE001
        return []
    if isinstance(data, dict):
        if "response" in data and isinstance(data["response"], (dict, list)):
            data = data["response"]
    if isinstance(data, dict):
        devs = data.get("devices") or data.get("hwidDevices") or data.get("items") or []
        return devs if isinstance(devs, list) else []
    if isinstance(data, list):
        return data
    return []


def _unwrap(data: Any) -> Any:
    if isinstance(data, dict) and "response" in data:
        return data["response"]
    return data


def _parse_ts(value: Any):
    from datetime import datetime, timezone
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def collect_active_ips(client, log=print) -> Optional[dict[int, set[str]]]:
    """
    «Активные сессии» со всех подключённых нод: {числовой id пользователя Remnawave:
    множество IP, активных за последние IP_ACTIVE_MINUTES}. None — данных нет
    (тогда IP-правило пропускается, чтобы не банить вслепую).
    """
    import time
    from datetime import datetime, timedelta, timezone

    try:
        nodes = _unwrap(client.get_nodes())
    except Exception as exc:  # noqa: BLE001
        log(f"[antiabuse] не удалось получить ноды: {exc}")
        return None
    if isinstance(nodes, dict):
        nodes = nodes.get("nodes") or nodes.get("items") or []
    nodes = [n for n in (nodes or []) if isinstance(n, dict)
             and n.get("isConnected", True) and not n.get("isDisabled", False) and n.get("uuid")]
    if not nodes:
        return None

    jobs: dict[str, str] = {}
    for n in nodes:
        try:
            job = _unwrap(client.connections_by_node(str(n["uuid"])))
            if isinstance(job, dict) and job.get("jobId"):
                jobs[str(n["uuid"])] = str(job["jobId"])
        except Exception as exc:  # noqa: BLE001
            log(f"[antiabuse] нода {n.get('name') or n['uuid']}: задача не запущена ({exc})")
    if not jobs:
        return None

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=IP_ACTIVE_MINUTES)
    out: dict[int, set[str]] = {}
    got_any = False
    deadline = time.time() + NODE_JOB_TIMEOUT
    pending = dict(jobs)
    while pending and time.time() < deadline:
        time.sleep(2)
        for node_uuid, job_id in list(pending.items()):
            try:
                res = _unwrap(client.connections_by_node_result(job_id))
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(res, dict):
                continue
            if res.get("isFailed"):
                pending.pop(node_uuid, None)
                continue
            if not res.get("isCompleted"):
                continue
            pending.pop(node_uuid, None)
            got_any = True
            for u in ((res.get("result") or {}).get("users") or []):
                try:
                    uid = int(u.get("userId"))
                except (TypeError, ValueError):
                    continue
                for entry in u.get("ips") or []:
                    ip = str((entry or {}).get("ip") or "").strip()
                    seen = _parse_ts((entry or {}).get("lastSeen"))
                    if ip and (seen is None or seen >= cutoff):
                        out.setdefault(uid, set()).add(ip)
    if pending:
        log(f"[antiabuse] не дождались ответа от нод: {len(pending)}")
    return out if got_any else None


def _ban(sub: dict[str, Any], client, rw_id: Optional[int], reason: str,
         log) -> None:
    sub_id = sub["id"]
    full = f"Анти-абуз: {reason}"
    db.execute("UPDATE subscriptions SET status = 'Banned', ban_reason = ?, banned_at = ? WHERE id = ?",
               (full, db.utcnow_iso(), sub_id))
    moderation.log(int(sub["user_id"]), "aa_ban", reason, sub_id=int(sub_id), actor="antiabuse", actor_name="Анти-абуз")
    if client and rw_id is not None:
        try:
            client.disable_user(rw_id)
        except Exception:  # noqa: BLE001
            pass
    log(f"[antiabuse] БАН подписки #{sub_id} (user {sub.get('user_id')}): {reason}")
    try:
        forum.send(
            "errors",
            f"🚫 <b>Анти-абуз</b>: заблокирована подписка "
            f"{forum.user_link(int(sub['user_id']))} — {forum._esc(reason)}",
        )
    except Exception:  # noqa: BLE001
        pass


def _warn(sub: dict[str, Any], kind: str, count: int, limit: int, notify, log) -> None:
    """Первое нарушение: отмечаем предупреждение и сообщаем пользователю."""
    db.execute("UPDATE subscriptions SET aa_warned_at = ? WHERE id = ?", (db.utcnow_iso(), sub["id"]))
    what = "устройств (HWID)" if kind == "hwid" else "IP-адресов"
    moderation.log(int(sub["user_id"]), "aa_warn", f"{count} {what} при лимите {limit}", sub_id=int(sub["id"]),
                   details={"kind": kind, "count": count, "limit": limit}, actor="antiabuse", actor_name="Анти-абуз")
    log(f"[antiabuse] предупреждение подписке #{sub['id']} (user {sub.get('user_id')}): {kind} {count}, лимит {limit}")
    if notify and sub.get("telegram_id"):
        try:
            notify(int(sub["telegram_id"]), kind, count, limit)
        except Exception as exc:  # noqa: BLE001
            log(f"[antiabuse] не удалось отправить предупреждение: {exc}")
    try:
        what = "устройств (HWID)" if kind == "hwid" else "IP-адресов"
        forum.send(
            "errors",
            f"⚠️ <b>Анти-абуз</b>: предупреждение {forum.user_link(int(sub['user_id']))} — "
            f"{count} {what} при лимите {limit}. Бан, если нарушение повторится через 24 ч.",
        )
    except Exception:  # noqa: BLE001
        pass


def _decide(sub: dict[str, Any]) -> str:
    """'warn' | 'ignore' | 'ban' — что делать с нарушением с учётом предупреждения."""
    from datetime import datetime, timedelta, timezone
    warned = _parse_ts(sub.get("aa_warned_at")) if sub.get("aa_warned_at") else None
    if warned is None:
        return "warn"
    age = datetime.now(timezone.utc) - warned
    lim = limits()
    if age < timedelta(hours=lim["grace_hours"]):
        return "ignore"
    if age <= timedelta(days=lim["warn_days"]):
        return "ban"
    return "warn"


def scan_once(log=print, notify=None) -> dict[str, Any]:
    """
    Один проход анти-абуза. Возвращает {checked, warned, banned}.
    notify(telegram_id, kind, count, limit) — отправка предупреждения пользователю.
    """
    if not enabled():
        return {"checked": 0, "banned": 0, "skipped": "disabled"}
    client = _client()
    if not client:
        return {"checked": 0, "banned": 0, "skipped": "remnawave_off"}

    subs = db.fetchall(
        "SELECT s.id, s.user_id, s.rw_id, s.devices_limit, s.type, s.aa_warned_at, "
        "u.telegram_id AS telegram_id FROM subscriptions s JOIN users u ON u.id = s.user_id "
        "WHERE s.status = 'Active' AND s.type IN ('vpn', 'trial') "
        "ORDER BY s.id DESC LIMIT ?",
        (MAX_PER_RUN,),
    )
    active_ips = collect_active_ips(client, log)
    lim = limits()
    mult, extra = lim["hwid_multiplier"], lim["ip_extra"]
    checked = 0
    banned = 0
    warned = 0
    for sub in subs:
        limit = max(1, int(sub.get("devices_limit") or 1))
        rw_id = _rw_num_id_for(sub, client)
        if rw_id is None:
            continue
        devices = _hwid_devices(client, rw_id)
        checked += 1
        hwid_count = len(devices)
        violation: Optional[tuple[str, int, str]] = None
        # Правило 1 — HWID ≥ 2×лимит
        if hwid_count >= mult * limit:
            violation = ("hwid", hwid_count, f"HWID {hwid_count} ≥ {mult * limit} (лимит {limit})")
        else:
            # Правило 2 — активные IP ≥ лимит+2 («Активные сессии», если данные есть)
            ipc = len(active_ips.get(rw_id, ())) if active_ips is not None else None
            if ipc is not None and ipc >= limit + extra:
                violation = ("ip", ipc, f"IP {ipc} ≥ {limit + extra} (лимит {limit})")
        if violation is None:
            continue
        kind, count, reason = violation
        decision = _decide(sub)
        if decision == "warn":
            _warn(sub, kind, count, limit, notify, log)
            warned += 1
        elif decision == "ban":
            _ban(sub, client, rw_id, reason + " — повторно после предупреждения", log)
            banned += 1
        # 'ignore' — 24 часа после предупреждения нарушения не считаем
    if banned or warned:
        log(f"[antiabuse] проверено {checked}, предупреждений {warned}, забанено {banned}")
    return {"checked": checked, "warned": warned, "banned": banned}


# ─────────────────────────────────────────────────────────────
# Пробный период: не больше N пробных на одно устройство (HWID)
# ─────────────────────────────────────────────────────────────

def trial_hwid_limits() -> tuple[bool, int]:
    on = db.get_setting("trial_hwid_enabled", "1") in ("1", "true", "True", "yes")
    return on, _int("trial_hwid_max", 2, 1, 10)


def _paid_user_ids(user_ids: list[int]) -> set[int]:
    """Кто из пользователей брал (или имеет) платную подписку — таких не считаем."""
    if not user_ids:
        return set()
    marks = ",".join("?" * len(user_ids))
    rows = db.fetchall(
        f"SELECT DISTINCT user_id FROM subscriptions WHERE user_id IN ({marks}) AND type <> 'trial'",
        tuple(user_ids),
    )
    return {int(r["user_id"]) for r in rows}


def _ban_account_trial(uid: int, hwid: str, count: int, limit: int, log) -> None:
    user = db.fetchone("SELECT id, telegram_id, email, is_banned FROM users WHERE id = ?", (uid,))
    if not user:
        return
    db.execute("INSERT OR IGNORE INTO trial_hwid_bans (user_id, hwid, created_at) VALUES (?, ?, ?)",
               (uid, hwid[:128], db.utcnow_iso()))
    if user.get("is_banned"):
        return
    reason = f"Анти-абуз: пробный период на одном устройстве уже взяли {count} аккаунтов (можно {limit})"
    db.execute("UPDATE users SET is_banned = 1, status = 'Banned', ban_reason = ?, banned_at = ? WHERE id = ?",
               (reason, db.utcnow_iso(), uid))
    db.execute("UPDATE subscriptions SET status = 'Banned', ban_reason = ?, banned_at = ? "
               "WHERE user_id = ? AND type = 'trial' AND status = 'Active'", (reason, db.utcnow_iso(), uid))
    moderation.log(uid, "aa_ban", reason, details={"kind": "trial_hwid", "count": count, "limit": limit},
                   actor="antiabuse", actor_name="Анти-абуз")
    if user.get("telegram_id"):
        try:
            provisioning.set_enabled(int(user["telegram_id"]), False, user.get("email"))
        except Exception:  # noqa: BLE001
            pass
    log(f"[antiabuse] БАН аккаунта #{uid}: пробные на одном HWID ({count} > {limit})")
    try:
        forum.send("errors", f"🚫 <b>Анти-абуз</b>: заблокирован {forum.user_link(uid)} — "
                             f"{count} пробных на одном устройстве (можно {limit})")
    except Exception:  # noqa: BLE001
        pass


def scan_trial_hwids(log=print) -> dict[str, Any]:
    """
    Запоминает HWID устройств активных пробных подписок и банит аккаунты сверх лимита:
    на одно устройство — не больше N пробных (аккаунты, бравшие платную подписку, не считаются).
    Банятся самые новые аккаунты сверх лимита; разбаненных вручную повторно не трогаем.
    """
    on, limit = trial_hwid_limits()
    if not on:
        return {"checked": 0, "banned": 0, "skipped": "disabled"}
    client = _client()
    if not client:
        return {"checked": 0, "banned": 0, "skipped": "remnawave_off"}
    subs = db.fetchall(
        "SELECT s.id, s.user_id FROM subscriptions s JOIN users u ON u.id = s.user_id "
        "WHERE s.type = 'trial' AND s.status = 'Active' AND COALESCE(u.is_banned, 0) = 0 "
        "ORDER BY s.id DESC LIMIT ?", (MAX_PER_RUN,))
    touched: set[str] = set()
    now = db.utcnow_iso()
    for sub in subs:
        rw_id = _rw_num_id_for(sub, client)
        if rw_id is None:
            continue
        for d in _hwid_devices(client, rw_id):
            hwid = str((d or {}).get("hwid") or "").strip()[:128] if isinstance(d, dict) else ""
            if not hwid:
                continue
            db.execute("INSERT OR IGNORE INTO trial_hwids (hwid, user_id, seen_at) VALUES (?, ?, ?)",
                       (hwid, int(sub["user_id"]), now))
            touched.add(hwid)
    banned = 0
    for hwid in touched:
        rows = db.fetchall("SELECT user_id, seen_at FROM trial_hwids WHERE hwid = ?", (hwid,))
        uids = [int(r["user_id"]) for r in rows]
        paid = _paid_user_ids(uids)
        # Порядок — кто раньше появился на этом устройстве (самые ранние «законные»),
        # при равенстве — у кого раньше пробная, затем старший аккаунт
        order = []
        for r in rows:
            uid = int(r["user_id"])
            if uid in paid:
                continue
            first = db.fetchone("SELECT MIN(created_at) AS t FROM subscriptions WHERE user_id = ? AND type = 'trial'", (uid,))
            order.append((str(r.get("seen_at") or ""), (first or {}).get("t") or "9999", uid))
        order.sort()
        if len(order) <= limit:
            continue
        already = {int(r["user_id"]) for r in db.fetchall(
            f"SELECT user_id FROM trial_hwid_bans WHERE user_id IN ({','.join('?' * len(order))})",
            tuple(o[2] for o in order))}
        for _, _, uid in order[limit:]:
            if uid in already:
                continue
            _ban_account_trial(uid, hwid, len(order), limit, log)
            banned += 1
    return {"checked": len(subs), "banned": banned}

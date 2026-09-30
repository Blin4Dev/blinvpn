"""
Grace-доступ (по мотивам Bedolaga): когда подписка заканчивается (или кончается
трафик), у человека продолжает работать резервный сквад — обычно один
специальный сервер — с небольшим лимитом трафика (по умолчанию 1 ГБ).
Так он не остаётся совсем без связи и может спокойно продлить подписку.

Когда выдаётся:
  • срок: за GRACE_BEFORE (5 мин) до конца подписки — до её удаления
    (DELETE_AFTER_DAYS = 7 дней после окончания);
  • трафик: Remnawave пометила пользователя LIMITED — до конца подписки или до
    ежемесячного сброса трафика (что раньше).
  В обоих случаях: сквады → резервные, счётчик трафика обнуляется, лимит = квота.

Как устроено:
  • Подписка в БД не меняется (срок, статус, оплаты — как были). Grace — только
    «накладка» в Remnawave.
  • grace_cycle — за что выдан: expires_at (срок) или «t|expires_at|время выдачи»
    (трафик); выдаётся один раз за цикл. grace_until — до какого момента
    действует (NULL — не действует).
  • Продлили / сбросили трафик — reconcile_user() обнуляет счётчик трафика и
    ставит обычные сквады, лимит и срок. Фоновая сверка подчищает всё, что не успели.
  • Не выдаётся: забаненным, подпискам с запретом продления (они удаляются
    сразу), пробным (если не включено), при другой живой подписке.

Проходы запускает фоновый цикл бота (reminders.start_background).
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

try:
    from . import database as db  # type: ignore
    from . import fulfillment, provisioning  # type: ignore
except ImportError:  # pragma: no cover
    import database as db  # type: ignore
    import fulfillment  # type: ignore
    import provisioning  # type: ignore

GB = 1024 ** 3
MAX_TRAFFIC_GB = 1000
# Сколько подписок обрабатываем за проход (остальные — в следующий).
BATCH = 200
# За сколько до конца подписки переключаем на grace
GRACE_BEFORE = timedelta(minutes=5)

_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(v: Any) -> Optional[datetime]:
    dt = fulfillment.parse_iso(v)
    if dt and dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ─────────────────────────────────────────────────────────────
# Настройки
# ─────────────────────────────────────────────────────────────

def settings() -> dict[str, Any]:
    squads = db.loads(db.get_setting("grace_squads", "[]"), []) or []
    return {
        "enabled": db.get_setting("grace_enabled", "0") in ("1", "true", "True"),
        "squads": [str(x) for x in squads if isinstance(x, str) and x][:20],
        "traffic_gb": fulfillment._int_setting("grace_traffic_gb", 1, 0, MAX_TRAFFIC_GB),
        "trial": db.get_setting("grace_trial", "0") in ("1", "true", "True"),
        "days": int(fulfillment.DELETE_AFTER_DAYS),
    }


def save_settings(enabled: bool, squads: list[str], traffic_gb: int, trial: bool) -> dict[str, Any]:
    known = {r["squad_uuid"] for r in db.fetchall("SELECT squad_uuid FROM squads")}
    clean: list[str] = []
    for s in squads[:20]:
        s = str(s)
        if s in known and s not in clean:
            clean.append(s)
    if enabled and not clean:
        raise ValueError("Выберите сквад с резервным сервером — без него grace-доступ не включить")
    db.set_setting("grace_enabled", "1" if enabled else "0")
    db.set_setting("grace_squads", db.dumps(clean))
    db.set_setting("grace_traffic_gb", str(int(max(0, min(MAX_TRAFFIC_GB, traffic_gb)))))
    db.set_setting("grace_trial", "1" if trial else "0")
    return settings()


# ─────────────────────────────────────────────────────────────
# Remnawave
# ─────────────────────────────────────────────────────────────

def _client_and_user(user: dict[str, Any]) -> tuple[Any, Optional[dict[str, Any]]]:
    import remnawave  # type: ignore
    client = remnawave.get_client()
    rw = provisioning.find_user(client, user.get("telegram_id"), user.get("email"), user.get("id"))
    return client, rw


def _rw_uid(rw: dict[str, Any]) -> Any:
    return rw.get("id") or rw.get("userId") or rw.get("uuid")


def _cycle_exp(cycle: Any) -> str:
    """expires_at, для которого выдан grace (из grace_cycle любого вида)."""
    c = str(cycle or "")
    return c.split("|")[1] if c.startswith("t|") and c.count("|") >= 2 else c


def is_traffic_cycle(cycle: Any) -> bool:
    return str(cycle or "").startswith("t|")


def _grace_valid(sub: dict[str, Any], now: datetime) -> bool:
    """Grace действует: не истёк, подписку не продлили (срок тот же), не вернули и не забанили."""
    until = _parse(sub.get("grace_until"))
    return bool(until and until > now and sub.get("status") in ("Active", "Expired")
                and sub.get("expires_at") and _cycle_exp(sub.get("grace_cycle")) == str(sub.get("expires_at")))


def _live_sub(user_id: int, exclude: Optional[set[int]] = None, skip_grace: bool = True) -> Optional[dict[str, Any]]:
    """
    Действующая подписка пользователя (платная — в приоритете). Подписки на
    действующем grace не считаются (skip_grace): доступ по ним уже резервный.
    """
    now = _now()
    rows = db.fetchall(
        "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'Active' "
        "AND (expires_at IS NULL OR expires_at > ?) "
        "ORDER BY CASE WHEN type = 'trial' THEN 1 ELSE 0 END, "
        "CASE WHEN expires_at IS NULL THEN 0 ELSE 1 END, expires_at DESC",
        (int(user_id), fulfillment.iso(now)),
    )
    for r in rows:
        if exclude and int(r["id"]) in exclude:
            continue
        if skip_grace and _grace_valid(r, now):
            continue
        return r
    return None


def _other_live(sub: dict[str, Any]) -> bool:
    return _live_sub(int(sub["user_id"]), exclude={int(sub["id"])}) is not None


def mask_rw(user_id: int, rw: Any) -> Any:
    """
    Пока действует grace, показываем аккаунт Remnawave таким, каким он был до него
    (статус, срок, трафик, сквады): ни в панели, ни в приложении grace не виден.
    """
    if not isinstance(rw, dict):
        return rw
    now = _now()
    for sub in db.fetchall("SELECT * FROM subscriptions WHERE user_id = ? AND grace_until IS NOT NULL", (int(user_id),)):
        if not _grace_valid(sub, now) or not sub.get("grace_snapshot"):
            continue
        snap = db.loads(sub["grace_snapshot"], {}) or {}
        out = dict(rw)
        for k in ("status", "expireAt", "trafficLimitBytes", "trafficLimitStrategy", "activeInternalSquads"):
            if snap.get(k) is not None:
                out[k] = snap[k]
                out.pop({"expireAt": "expire_at", "trafficLimitBytes": "traffic_limit_bytes",
                         "trafficLimitStrategy": "traffic_limit_strategy"}.get(k, "_"), None)
        exp = _parse(sub.get("expires_at"))
        if snap.get("status") in ("ACTIVE", None) and exp and exp <= now:
            out["status"] = "EXPIRED"  # подписка закончилась — так её и показываем
        if snap.get("usedTrafficBytes") is not None:
            out["usedTrafficBytes"] = snap["usedTrafficBytes"]
            out.pop("used_traffic_bytes", None)
            if isinstance(out.get("userTraffic"), dict):
                out["userTraffic"] = {**out["userTraffic"], "usedTrafficBytes": snap["usedTrafficBytes"]}
        return out
    return rw


def reconcile_user(user_id: int, log: Callable[[str], None] = print, end_traffic: bool = False) -> bool:
    """
    Привести Remnawave пользователя в порядок после grace и снять устаревшие отметки:
      • есть действующая подписка — счётчик трафика обнуляется, её сквады,
        лимит трафика, срок, ACTIVE;
      • end_traffic — трафик сбросили (оплата/админ): grace «по трафику» снимается;
      • забанен / подписки возвращены или заблокированы — аккаунт выключается
        (grace мог включить его обратно, пока шёл возврат или бан);
      • подписка всё ещё закончилась, grace просто истёк — ничего не трогаем.
    True — если всё сделано (или делать нечего), False — Remnawave не ответила.
    """
    now = _now()
    subs = db.fetchall("SELECT * FROM subscriptions WHERE user_id = ?", (int(user_id),))
    flagged = [x for x in subs if x.get("grace_until")]
    if not flagged:
        return True
    valid = [x for x in flagged if _grace_valid(x, now)
             and not (end_traffic and is_traffic_cycle(x.get("grace_cycle")))]
    user = db.fetchone("SELECT * FROM users WHERE id = ?", (int(user_id),)) or {}
    banned = bool(user.get("is_banned"))
    live = None if banned else _live_sub(int(user_id), exclude={int(x["id"]) for x in valid}, skip_grace=False)
    revoke = banned or (not valid and any(x.get("status") in ("Refunded", "Banned") for x in flagged))
    if live or revoke:
        if provisioning.is_configured():
            try:
                client, rw = _client_and_user(user)
                if rw and live:
                    squads = fulfillment.trial_squads() if live.get("type") == "trial" else fulfillment.vpn_squads()
                    patch: dict[str, Any] = {
                        **provisioning.rw_ref(rw),
                        "status": "ACTIVE",
                        "traffic_limit_bytes": int(max(0, int(live.get("traffic_limit") or 0))) * GB,
                        "traffic_limit_strategy": fulfillment.RESET_STRATEGY,
                    }
                    exp = _parse(live.get("expires_at"))
                    if exp:
                        patch["expire_at"] = exp
                    if squads:
                        patch["active_internal_squads"] = squads
                    # Лимит — с нуля: на grace счётчик ежемесячно не сбрасывался
                    client.reset_user_traffic(_rw_uid(rw))
                    client.update_user(**patch)
                    db.execute("UPDATE subscriptions SET traffic_used = 0 WHERE id = ?", (int(live["id"]),))
                elif rw:
                    # Возврат, чарджбек, бан: grace не должен держать аккаунт включённым
                    client.disable_user(_rw_uid(rw))
            except Exception as exc:  # noqa: BLE001
                log(f"[grace] не удалось привести в порядок пользователя {user_id}: {type(exc).__name__}: {exc}")
                return False
        log(f"[grace] пользователь {user_id}: " + ("подписка действует — обычный доступ возвращён" if live else "доступ отключён"))
        clear = flagged
    else:
        clear = [x for x in flagged if x not in valid]
    for x in clear:
        db.execute("UPDATE subscriptions SET grace_until = NULL WHERE id = ? AND grace_until = ?", (int(x["id"]), x["grace_until"]))
    return True


def end(sub_id: int, log: Callable[[str], None] = print) -> bool:
    """Подписку продлили (или она ушла): вернуть обычный доступ пользователю этой подписки."""
    sub = db.fetchone("SELECT user_id FROM subscriptions WHERE id = ?", (int(sub_id),))
    return reconcile_user(int(sub["user_id"]), log) if sub else True


def end_for_user(user_id: int, log: Callable[[str], None] = print, traffic: bool = False) -> None:
    """После продления (или сброса трафика — traffic=True) из панели/оплаты."""
    try:
        if db.fetchone("SELECT id FROM subscriptions WHERE user_id = ? AND grace_until IS NOT NULL LIMIT 1", (int(user_id),)):
            reconcile_user(int(user_id), log, end_traffic=traffic)
    except Exception as exc:  # noqa: BLE001
        log(f"[grace] end: {type(exc).__name__}: {exc}")


def active_for_user(user_id: int) -> bool:
    """Сейчас у пользователя действует grace (в Remnawave — резервный доступ)."""
    now = _now()
    return any(_grace_valid(x, now) for x in db.fetchall(
        "SELECT * FROM subscriptions WHERE user_id = ? AND grace_until IS NOT NULL", (int(user_id),)))


def end_traffic_all(log: Callable[[str], None] = print) -> None:
    """Массовый сброс трафика: снять grace «по трафику» у всех."""
    for r in db.fetchall("SELECT DISTINCT user_id FROM subscriptions WHERE grace_until IS NOT NULL AND grace_cycle LIKE 't|%'"):
        end_for_user(int(r["user_id"]), log, traffic=True)


def _next_month(now: datetime) -> datetime:
    """Начало следующего месяца (UTC) — ежемесячный сброс трафика в Remnawave."""
    y, m = (now.year + 1, 1) if now.month == 12 else (now.year, now.month + 1)
    return datetime(y, m, 1, 0, 5, tzinfo=timezone.utc)


def _apply(sub: dict[str, Any], cfg: dict[str, Any], log: Callable[[str], None], traffic: bool = False) -> bool:
    """Выдать grace: по сроку (traffic=False) или по закончившемуся трафику."""
    exp_raw = str(sub["expires_at"])
    exp = _parse(exp_raw)
    if not exp:
        return False
    now = _now()
    if traffic:
        until = min(exp, _next_month(now))
        cycle = f"t|{exp_raw}|{fulfillment.iso(now)}"  # каждый раз новый цикл
        rw_expire = exp
    else:
        until = exp + timedelta(days=cfg["days"])
        cycle = exp_raw
        rw_expire = until
    if until <= now + timedelta(minutes=10):
        return False  # считанные минуты — смысла нет
    # Уже на grace (по трафику, а теперь кончается срок): снимок «как было» оставляем прежний
    prev_valid = _grace_valid(sub, now)
    prev_cycle, prev_until = sub.get("grace_cycle"), sub.get("grace_until")
    # Сначала «занимаем» цикл в БД (атомарно, по неизменному expires_at): второй
    # процесс или оплата, успевшая продлить подписку, не дадут выдать grace дважды.
    cur = db.execute(
        "UPDATE subscriptions SET grace_cycle = ?, grace_until = ? WHERE id = ? AND expires_at = ? "
        "AND status IN ('Active', 'Expired') AND (grace_cycle IS NULL OR grace_cycle != ?) "
        "AND grace_cycle IS ? AND grace_until IS ?",
        (cycle, fulfillment.iso(until), int(sub["id"]), exp_raw, cycle, prev_cycle, prev_until),
    )
    if getattr(cur, "rowcount", 1) == 0:
        return False
    user = db.fetchone("SELECT * FROM users WHERE id = ?", (int(sub["user_id"]),)) or {}
    try:
        client, rw = _client_and_user(user)
        if not rw:
            raise RuntimeError("пользователь не найден в Remnawave")
        if not (prev_valid and sub.get("grace_snapshot")):
            # Снимок «как было» — панель и приложение показывают его, grace снаружи не виден
            ut = rw.get("userTraffic") if isinstance(rw.get("userTraffic"), dict) else {}
            snap = {
                "status": rw.get("status"),
                "expireAt": rw.get("expireAt") or rw.get("expire_at"),
                "trafficLimitBytes": rw.get("trafficLimitBytes", rw.get("traffic_limit_bytes")),
                "trafficLimitStrategy": rw.get("trafficLimitStrategy") or rw.get("traffic_limit_strategy"),
                "usedTrafficBytes": ut.get("usedTrafficBytes", rw.get("usedTrafficBytes")),
                "activeInternalSquads": rw.get("activeInternalSquads"),
            }
            db.execute("UPDATE subscriptions SET grace_snapshot = ? WHERE id = ? AND grace_cycle = ?",
                       (json.dumps(snap, ensure_ascii=False, default=str), int(sub["id"]), cycle))
        gb = cfg["traffic_gb"]
        if gb:
            # Квота — именно столько, сколько указано: счётчик обнуляем (иначе после
            # массового сброса трафика у человека оказалось бы «потрачено + квота»)
            client.reset_user_traffic(_rw_uid(rw))
        client.update_user(**{
            **provisioning.rw_ref(rw),
            "status": "ACTIVE",
            "expire_at": rw_expire,
            "active_internal_squads": cfg["squads"],
            "traffic_limit_bytes": gb * GB if gb else 0,
            "traffic_limit_strategy": "NO_RESET",
        })
    except Exception as exc:  # noqa: BLE001
        # Не вышло — возвращаем прежнюю отметку, попробуем в следующий проход
        db.execute("UPDATE subscriptions SET grace_cycle = ?, grace_until = ? WHERE id = ? AND grace_cycle = ?",
                   (prev_cycle, prev_until, int(sub["id"]), cycle))
        log(f"[grace] не удалось выдать grace подписке #{sub['id']}: {type(exc).__name__}: {exc}")
        return False
    # Пока мы ходили в Remnawave, подписку могли продлить, вернуть деньги или забанить.
    # Проверяем заново и, если так, сразу возвращаем правильное состояние — не полагаясь
    # на отметку grace_until (её могла уже снять оплата, до нашей записи в Remnawave).
    fresh = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (int(sub["id"]),)) or {}
    fresh_user = db.fetchone("SELECT is_banned FROM users WHERE id = ?", (int(sub["user_id"]),)) or {}
    if (str(fresh.get("expires_at")) != exp_raw or fresh.get("status") not in ("Active", "Expired")
            or fresh.get("grace_cycle") != cycle
            or fresh_user.get("is_banned") or _live_sub(int(sub["user_id"]), exclude={int(sub["id"])})):
        db.execute("UPDATE subscriptions SET grace_until = ? WHERE id = ?", (fulfillment.iso(until), int(sub["id"])))
        if not reconcile_user(int(sub["user_id"]), log):
            log(f"[grace] подписка #{sub['id']} изменилась во время выдачи — исправим в следующий проход")
        return False
    why = "кончился трафик" if traffic else "кончается срок"
    log(f"[grace] подписка #{sub['id']} (user {sub['user_id']}, {why}): резервный доступ до {fulfillment.iso(until)}")
    return True


def _stale_users(now: datetime) -> list[int]:
    """Пользователи, у которых grace пора снять или поправить."""
    rows = db.fetchall(
        "SELECT s.*, COALESCE(u.is_banned, 0) AS u_banned FROM subscriptions s JOIN users u ON u.id = s.user_id "
        "WHERE s.grace_until IS NOT NULL ORDER BY s.id")
    out: list[int] = []
    for r in rows:
        uid = int(r["user_id"])
        if uid in out:
            continue
        if not _grace_valid(r, now) or r.get("u_banned") or _other_live(r):
            out.append(uid)
        if len(out) >= BATCH:
            break
    return out


def _limited_user_ids(log: Callable[[str], None]) -> set[int]:
    """Пользователи BlinVPN, у которых в Remnawave закончился трафик (статус LIMITED)."""
    import remnawave  # type: ignore
    client = remnawave.get_client()
    tg_ids: set[int] = set()
    desc_ids: set[int] = set()
    start, size = 0, 250
    for _ in range(400):  # до 100 000 пользователей
        page = client.get_users(start=start, size=size)
        if isinstance(page, dict) and "response" in page:
            page = page["response"]
        users = page.get("users") if isinstance(page, dict) else page
        if not users:
            break
        for u in users:
            if not isinstance(u, dict) or str(u.get("status") or "").upper() != "LIMITED":
                continue
            try:
                if u.get("telegramId"):
                    tg_ids.add(int(u["telegramId"]))
                elif str(u.get("description") or "").isdigit():
                    desc_ids.add(int(u["description"]))
            except (TypeError, ValueError):
                continue
        start += size
        total = page.get("total") if isinstance(page, dict) else None
        if (total is not None and start >= int(total)) or len(users) < size:
            break
    out = set(desc_ids)
    tg = list(tg_ids)
    for i in range(0, len(tg), 500):
        chunk = tg[i:i + 500]
        for r in db.fetchall(f"SELECT id FROM users WHERE telegram_id IN ({','.join('?' * len(chunk))})", tuple(chunk)):
            out.add(int(r["id"]))
    return out


def run_once(log: Callable[[str], None] = print) -> int:
    """Один проход: снять grace у продлённых, выдать новым. Возвращает число выданных."""
    if not _lock.acquire(blocking=False):
        return 0
    try:
        now = _now()
        # 1) Сверка: продлили / удалили / вернули деньги / забанили / grace истёк
        for uid in _stale_users(now):
            reconcile_user(uid, log)

        cfg = settings()
        if not cfg["enabled"] or not cfg["squads"] or not provisioning.is_configured():
            return 0
        types = ("vpn", "trial") if cfg["trial"] else ("vpn",)
        tmarks = ",".join("?" * len(types))
        done = 0

        def _one_grace_elsewhere(sub: dict[str, Any]) -> bool:
            # У одного пользователя — один grace (аккаунт Remnawave один)
            return bool(db.fetchone(
                "SELECT id FROM subscriptions WHERE user_id = ? AND id != ? AND grace_until > ? "
                "AND status IN ('Active', 'Expired') LIMIT 1",
                (int(sub["user_id"]), int(sub["id"]), fulfillment.iso(now))))

        # 2) Срок: за 5 минут до конца и до удаления подписки
        lo = fulfillment.iso(now - timedelta(days=cfg["days"]))
        rows = db.fetchall(
            "SELECT s.* FROM subscriptions s JOIN users u ON u.id = s.user_id "
            f"WHERE s.status IN ('Active', 'Expired') AND s.type IN ({tmarks}) "
            "AND s.expires_at IS NOT NULL AND s.expires_at <= ? AND s.expires_at > ? "
            "AND COALESCE(s.no_renew, 0) = 0 AND COALESCE(u.is_banned, 0) = 0 "
            "AND (s.grace_cycle IS NULL OR s.grace_cycle != s.expires_at) "
            "ORDER BY s.expires_at DESC LIMIT ?",
            (*types, fulfillment.iso(now + GRACE_BEFORE), lo, BATCH),
        )
        for sub in rows:
            if _other_live(sub) or _one_grace_elsewhere(sub):
                continue
            if _apply(sub, cfg, log):
                done += 1

        # 3) Трафик: закончился у действующей подписки
        try:
            limited = _limited_user_ids(log)
        except Exception as exc:  # noqa: BLE001
            log(f"[grace] не удалось получить пользователей Remnawave: {type(exc).__name__}: {exc}")
            limited = set()
        for uid in list(limited)[:BATCH]:
            if db.fetchone("SELECT id FROM users WHERE id = ? AND COALESCE(is_banned, 0) = 0", (uid,)) is None:
                continue
            sub = _live_sub(uid)
            if not sub or sub.get("type") not in types or not sub.get("expires_at"):
                continue
            if _one_grace_elsewhere(sub) or _grace_valid(sub, now):
                continue
            if _apply(sub, cfg, log, traffic=True):
                done += 1
        return done
    finally:
        _lock.release()

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

MSK = timezone(timedelta(hours=3))
MAX_INTERVALS = 8
MAX_PAY = 1_000_000
MAX_RANGE_DAYS = 400          # ~год вперёд
_HM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$|^24:00$")


class PayError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def now_msk() -> datetime:
    return datetime.now(timezone.utc).astimezone(MSK)


def today_msk() -> date:
    return now_msk().date()


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_day(s: Any) -> date:
    try:
        return date.fromisoformat(str(s or "")[:10])
    except ValueError:
        raise PayError("Дата в формате ГГГГ-ММ-ДД")


def _minutes(hm: str) -> int:
    h, m = hm.split(":")
    return int(h) * 60 + int(m)


def _hm(m: int) -> str:
    m = max(0, min(int(m), 24 * 60))
    if m == 24 * 60:
        return "24:00"
    return f"{m // 60:02d}:{m % 60:02d}"


def _wraps(a: str, b: str) -> bool:
    """конец раньше начала → смена уходит на следующие сутки."""
    return _minutes(b) < _minutes(a)


def _duration(a: str, b: str) -> int:
    ma, mb = _minutes(a), _minutes(b)
    if mb > ma:
        return mb - ma
    if mb < ma:
        return 24 * 60 - ma + mb
    raise PayError("Начало и конец части дня совпадают")


def _spill_end(intervals: list[list[str]]) -> Optional[int]:
    """минута конца утреннего хвоста со вчера (если смена через полночь)."""
    for a, b in intervals:
        if _wraps(a, b):
            return _minutes(b)
    return None


def _spill_display(intervals: list[list[str]]) -> list[list[str]]:
    return [["00:00", b] for a, b in intervals if _wraps(a, b)]


def validate_intervals(raw: Any) -> list[list[str]]:
    """интервалы [["10:00","14:00"],...]; конец < начала — через полночь (только последняя часть)."""
    if not isinstance(raw, list) or not raw:
        raise PayError("Укажите часы работы")
    if len(raw) > MAX_INTERVALS:
        raise PayError(f"Не больше {MAX_INTERVALS} частей в дне")
    out: list[list[str]] = []
    prev_end = -1
    for i, it in enumerate(raw):
        if not isinstance(it, (list, tuple)) or len(it) != 2:
            raise PayError("Интервал: [начало, конец]")
        a, b = str(it[0]).strip(), str(it[1]).strip()
        if not _HM.match(a) or not _HM.match(b) or a == "24:00":
            raise PayError("Время в формате ЧЧ:ММ")
        ma, mb = _minutes(a), _minutes(b)
        wrap = mb < ma
        if mb == ma:
            raise PayError("Начало и конец части дня совпадают")
        if wrap and i != len(raw) - 1:
            raise PayError("Смена через полночь может быть только последней частью дня")
        if ma < prev_end:
            raise PayError("Части дня пересекаются или идут не по порядку")
        if ma == prev_end:
            raise PayError("Между частями дня должен быть перерыв")
        if _duration(a, b) > 24 * 60:
            raise PayError("Часть дня не длиннее суток")
        prev_end = 24 * 60 if wrap else mb  # после «хвоста» в этот календарный день больше ничего
        out.append([a, b])
    return out


def _reject_overlap_prev_spill(staff_id: int, day: date, intervals: list[list[str]]) -> None:
    prev = db.fetchone("SELECT * FROM staff_days WHERE staff_id = ? AND day = ?",
                       (int(staff_id), (day - timedelta(days=1)).isoformat()))
    if not prev:
        return
    end = _spill_end(_row(prev)["intervals"])
    if end is None or end <= 0:
        return
    for a, b in intervals:
        if _wraps(a, b):
            continue  # вечерняя часть — на этом дне; утро уже следующий
        if _minutes(a) < end:
            raise PayError(f"До {_hm(end)} продолжается смена со вчера — начало не раньше {_hm(end)}")


def _conn_row(conn: Any, sql: str, params: tuple) -> Optional[dict[str, Any]]:
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def _trim_next_for_overnight(staff_id: int, day: date, intervals: list[list[str]], conn: Any = None) -> None:
    """убрать пересечение с утренним хвостом на следующем дне (чтобы не платить дважды)."""
    end = _spill_end(intervals)
    if end is None:
        return
    key = (day + timedelta(days=1)).isoformat()
    sid = int(staff_id)
    if conn is None:
        row = db.fetchone("SELECT * FROM staff_days WHERE staff_id = ? AND day = ?", (sid, key))
    else:
        row = _conn_row(conn, "SELECT * FROM staff_days WHERE staff_id = ? AND day = ?", (sid, key))
    if not row:
        return
    old = _row(row)["intervals"]
    new_iv: list[list[str]] = []
    for a, b in old:
        if _wraps(a, b):
            new_iv.append([a, b])
            continue
        ma, mb = _minutes(a), _minutes(b)
        if mb <= end:
            continue
        if ma < end:
            new_iv.append([_hm(end), b])
        else:
            new_iv.append([a, b])
    if new_iv == old:
        return
    run = conn.execute if conn is not None else db.execute
    if not new_iv:
        run("DELETE FROM staff_days WHERE staff_id = ? AND day = ?", (sid, key))
    else:
        run("UPDATE staff_days SET intervals = ?, updated_at = ? WHERE staff_id = ? AND day = ?",
            (json.dumps(new_iv), _iso_now(), sid, key))


def validate_money(v: Any, what: str = "Сумма", allow_zero: bool = True) -> float:
    try:
        x = round(float(v), 2)
    except (TypeError, ValueError):
        raise PayError(f"{what}: число")
    if x != x or x < 0 or x > MAX_PAY or (x == 0 and not allow_zero):
        raise PayError(f"{what}: от {'0' if allow_zero else '0,01'} до {MAX_PAY:,} ₽".replace(",", " "))
    return x


def _clean_text(s: Any, n: int) -> str:
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(s or "")).strip()[:n]


def _row(r: dict[str, Any]) -> dict[str, Any]:
    try:
        iv = json.loads(r["intervals"])
    except ValueError:
        iv = []
    return {"day": r["day"], "intervals": iv, "pay": float(r["pay"] or 0)}


def schedule(staff_id: int, d_from: date, d_to: date) -> list[dict[str, Any]]:
    if (d_to - d_from).days > MAX_RANGE_DAYS:
        raise PayError("Слишком большой период")
    rows = db.fetchall("SELECT * FROM staff_days WHERE staff_id = ? AND day >= ? AND day <= ? ORDER BY day",
                       (int(staff_id), d_from.isoformat(), d_to.isoformat()))
    return [_row(r) for r in rows]


def day_bounds(day: date) -> tuple[date, date]:
    """правка графика: месяц назад … год вперёд."""
    t = today_msk()
    return t - timedelta(days=31), t + timedelta(days=366)


def _check_day(day: date) -> None:
    lo, hi = day_bounds(day)
    if not lo <= day <= hi:
        raise PayError("Можно менять дни от месяца назад до года вперёд")


def set_day(staff_id: int, day: date, intervals: Optional[list], pay: Any) -> Optional[dict[str, Any]]:
    """intervals=None: выходной (строка удаляется). Оплата только у дня начала смены."""
    _check_day(day)
    if intervals is None:
        db.execute("DELETE FROM staff_days WHERE staff_id = ? AND day = ?", (int(staff_id), day.isoformat()))
        return None
    iv = validate_intervals(intervals)
    _reject_overlap_prev_spill(staff_id, day, iv)
    p = validate_money(pay, "Оплата за день")
    db.execute("INSERT INTO staff_days (staff_id, day, intervals, pay, updated_at) VALUES (?, ?, ?, ?, ?) "
               "ON CONFLICT(staff_id, day) DO UPDATE SET intervals = excluded.intervals, pay = excluded.pay, "
               "updated_at = excluded.updated_at", (int(staff_id), day.isoformat(), json.dumps(iv), p, _iso_now()))
    _trim_next_for_overnight(staff_id, day, iv)
    return {"day": day.isoformat(), "intervals": iv, "pay": p}


def bulk_fill(staff_id: int, d_from: date, d_to: date, weekdays: list[int], intervals: list, pay: Any,
              overwrite: bool, clear_other: bool = False) -> int:
    """заполнить период по дням недели (0=пн…6=вс); overwrite / clear_other."""
    if d_to < d_from:
        raise PayError("Конец периода раньше начала")
    if (d_to - d_from).days > MAX_RANGE_DAYS:
        raise PayError("Период — не больше года")
    _check_day(d_from)
    _check_day(d_to)
    wd = sorted({int(x) for x in weekdays if str(x).lstrip("-").isdigit() and 0 <= int(x) <= 6})
    if not wd:
        raise PayError("Выберите дни недели")
    iv = validate_intervals(intervals)
    p = validate_money(pay, "Оплата за день")
    n = 0
    now = _iso_now()
    sid = int(staff_id)
    with db.transaction() as tx:
        d = d_from
        while d <= d_to:
            key = d.isoformat()
            if d.weekday() in wd:
                prev = _conn_row(tx, "SELECT * FROM staff_days WHERE staff_id = ? AND day = ?",
                                 (sid, (d - timedelta(days=1)).isoformat()))
                if prev:
                    end = _spill_end(_row(prev)["intervals"])
                    if end is not None:
                        for a, b in iv:
                            if not _wraps(a, b) and _minutes(a) < end:
                                raise PayError(
                                    f"{key}: до {_hm(end)} продолжается смена со вчера — "
                                    f"начало интервала не раньше {_hm(end)}"
                                )
                if overwrite:
                    tx.execute("INSERT INTO staff_days (staff_id, day, intervals, pay, updated_at) VALUES (?, ?, ?, ?, ?) "
                               "ON CONFLICT(staff_id, day) DO UPDATE SET intervals = excluded.intervals, pay = excluded.pay, "
                               "updated_at = excluded.updated_at", (sid, key, json.dumps(iv), p, now))
                    _trim_next_for_overnight(sid, d, iv, tx)
                else:
                    cur = tx.execute("INSERT OR IGNORE INTO staff_days (staff_id, day, intervals, pay, updated_at) "
                                     "VALUES (?, ?, ?, ?, ?)", (sid, key, json.dumps(iv), p, now))
                    if cur.rowcount:
                        _trim_next_for_overnight(sid, d, iv, tx)
                n += 1
            elif clear_other:
                tx.execute("DELETE FROM staff_days WHERE staff_id = ? AND day = ?", (sid, key))
            d += timedelta(days=1)
    return n


def _on_shift_minutes(intervals: list[list[str]], m: int) -> bool:
    """m — минуты текущих суток; учитывает вечернюю часть смены через полночь."""
    for a, b in intervals:
        ma, mb = _minutes(a), _minutes(b)
        if mb > ma:
            if ma <= m < mb:
                return True
        elif m >= ma:
            return True
    return False


def _on_spill_minutes(intervals: list[list[str]], m: int) -> bool:
    end = _spill_end(intervals)
    return end is not None and m < end


def shift_now(staff_id: int) -> dict[str, Any]:
    """сегодня: рабочий ли день и идёт ли смена (включая хвост вчерашней через полночь)."""
    n = now_msk()
    today = n.date()
    m = n.hour * 60 + n.minute
    sid = int(staff_id)
    r = db.fetchone("SELECT * FROM staff_days WHERE staff_id = ? AND day = ?", (sid, today.isoformat()))
    prev = db.fetchone("SELECT * FROM staff_days WHERE staff_id = ? AND day = ?",
                       (sid, (today - timedelta(days=1)).isoformat()))
    today_iv = _row(r)["intervals"] if r else []
    prev_iv = _row(prev)["intervals"] if prev else []
    spill = _spill_display(prev_iv) if _on_spill_minutes(prev_iv, m) else []
    on = _on_shift_minutes(today_iv, m) or bool(spill)
    if r:
        intervals = (spill + today_iv) if spill else today_iv
        return {"working_today": True, "on_shift": on, "intervals": intervals, "pay": _row(r)["pay"]}
    if spill:
        return {"working_today": True, "on_shift": True, "intervals": spill}
    return {"working_today": False, "on_shift": False, "intervals": []}


def _shift_end_offset(intervals: list[list[str]]) -> int:
    """минуты от полуночи дня начала до полного конца смены (может быть > 1440)."""
    a, b = intervals[-1]
    ma, mb = _minutes(a), _minutes(b)
    return (24 * 60 + mb) if mb < ma else mb


def _earned_rows(staff_id: int) -> list[dict[str, Any]]:
    """отработанные дни: после полного конца смены (для через полночь — на следующее утро)."""
    n = now_msk()
    today = n.date()
    rows = [_row(r) for r in db.fetchall("SELECT * FROM staff_days WHERE staff_id = ? AND day <= ? ORDER BY day",
                                         (int(staff_id), today.isoformat()))]
    now_off = n.hour * 60 + n.minute
    out = []
    for r in rows:
        if not r["intervals"]:
            continue
        day = date.fromisoformat(r["day"])
        end_off = _shift_end_offset(r["intervals"])
        # сколько минут прошло с полуночи дня смены
        elapsed = (today - day).days * 24 * 60 + now_off
        if elapsed < end_off:
            continue
        out.append(r)
    return out


def ledger(staff_id: int) -> dict[str, Any]:
    earned = _earned_rows(staff_id)
    fines = db.fetchall("SELECT * FROM staff_fines WHERE staff_id = ? ORDER BY id DESC", (int(staff_id),))
    bonuses = db.fetchall("SELECT * FROM staff_bonuses WHERE staff_id = ? ORDER BY id DESC", (int(staff_id),))
    payouts = db.fetchall("SELECT * FROM staff_payouts WHERE staff_id = ? ORDER BY paid_on DESC, id DESC", (int(staff_id),))
    total_earned = round(sum(r["pay"] for r in earned), 2)
    total_fines = round(sum(float(f["amount"]) for f in fines if not f.get("cancelled_at")), 2)
    total_bonuses = round(sum(float(b["amount"]) for b in bonuses if not b.get("cancelled_at")), 2)
    total_paid = round(sum(float(p["amount"]) for p in payouts), 2)
    # неделя пн-вс мск
    t = today_msk()
    week_start = (t - timedelta(days=t.weekday())).isoformat()
    week = round(sum(r["pay"] for r in earned if r["day"] >= week_start), 2)
    return {
        "balance": round(total_earned + total_bonuses - total_fines - total_paid, 2),
        "earned": total_earned, "bonused": total_bonuses, "fined": total_fines, "paid": total_paid, "earned_this_week": week,
        "days": list(reversed(earned))[:120],
        "fines": [{"id": f["id"], "amount": float(f["amount"]), "reason": f["reason"], "issued_by": f["issued_by"],
                   "issued_name": f.get("issued_name"), "created_at": f["created_at"],
                   "cancelled": bool(f.get("cancelled_at"))} for f in fines[:200]],
        "bonuses": [{"id": b["id"], "amount": float(b["amount"]), "reason": b["reason"], "issued_name": b.get("issued_name"),
                     "created_at": b["created_at"], "cancelled": bool(b.get("cancelled_at"))} for b in bonuses[:200]],
        "payouts": [{"id": p["id"], "amount": float(p["amount"]), "note": p.get("note") or "", "paid_on": p["paid_on"],
                     "created_at": p["created_at"]} for p in payouts[:200]],
    }


def add_fine(staff_id: int, amount: Any, reason: Any, issued_by: str, issued_name: str) -> dict[str, Any]:
    a = validate_money(amount, "Сумма штрафа", allow_zero=False)
    r = _clean_text(reason, 300)
    if len(r) < 3:
        raise PayError("Укажите причину штрафа")
    cur = db.execute("INSERT INTO staff_fines (staff_id, amount, reason, issued_by, issued_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                     (int(staff_id), a, r, issued_by, issued_name[:60], _iso_now()))
    return {"id": cur.lastrowid, "amount": a, "reason": r}


def cancel_fine(fine_id: int, by: str, only_issuer: Optional[str] = None) -> dict[str, Any]:
    f = db.fetchone("SELECT * FROM staff_fines WHERE id = ?", (int(fine_id),))
    if not f:
        raise PayError("Штраф не найден", 404)
    if only_issuer is not None and f["issued_by"] != only_issuer:
        raise PayError("Отменить можно только свой штраф", 403)
    if f.get("cancelled_at"):
        return {"ok": True}
    db.execute("UPDATE staff_fines SET cancelled_at = ?, cancelled_by = ? WHERE id = ? AND cancelled_at IS NULL",
               (_iso_now(), by, int(fine_id)))
    return {"ok": True, "staff_id": f["staff_id"]}


def add_bonus(staff_id: int, amount: Any, reason: Any, issued_by: str, issued_name: str) -> dict[str, Any]:
    a = validate_money(amount, "Сумма премии", allow_zero=False)
    r = _clean_text(reason, 300)
    if len(r) < 3:
        raise PayError("Укажите, за что премия")
    recent = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    if db.fetchone("SELECT 1 FROM staff_bonuses WHERE staff_id = ? AND amount = ? AND cancelled_at IS NULL AND created_at > ?",
                   (int(staff_id), a, recent)):
        raise PayError("Такая премия уже начислена только что", 409)
    cur = db.execute("INSERT INTO staff_bonuses (staff_id, amount, reason, issued_by, issued_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                     (int(staff_id), a, r, issued_by, issued_name[:60], _iso_now()))
    return {"id": cur.lastrowid, "amount": a, "reason": r}


def cancel_bonus(bonus_id: int, by: str) -> dict[str, Any]:
    b = db.fetchone("SELECT * FROM staff_bonuses WHERE id = ?", (int(bonus_id),))
    if not b:
        raise PayError("Премия не найдена", 404)
    db.execute("UPDATE staff_bonuses SET cancelled_at = ?, cancelled_by = ? WHERE id = ? AND cancelled_at IS NULL",
               (_iso_now(), by, int(bonus_id)))
    return {"ok": True, "staff_id": b["staff_id"]}


def add_payout(staff_id: int, amount: Any, note: Any, paid_on: Any) -> dict[str, Any]:
    a = validate_money(amount, "Сумма выплаты", allow_zero=False)
    d = parse_day(paid_on) if paid_on else today_msk()
    if abs((d - today_msk()).days) > 366:
        raise PayError("Неверная дата выплаты")
    # антидаблклик: та же сумма за 30с
    recent = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    if db.fetchone("SELECT 1 FROM staff_payouts WHERE staff_id = ? AND amount = ? AND created_at > ?", (int(staff_id), a, recent)):
        raise PayError("Такая выплата уже записана только что", 409)
    cur = db.execute("INSERT INTO staff_payouts (staff_id, amount, note, paid_on, created_at) VALUES (?, ?, ?, ?, ?)",
                     (int(staff_id), a, _clean_text(note, 200), d.isoformat(), _iso_now()))
    return {"id": cur.lastrowid, "amount": a}


def delete_payout(payout_id: int) -> None:
    db.execute("DELETE FROM staff_payouts WHERE id = ?", (int(payout_id),))

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


def validate_intervals(raw: Any) -> list[list[str]]:
    """интервалы [["10:00","14:00"],...]: по порядку, без пересечений, внутри суток."""
    if not isinstance(raw, list) or not raw:
        raise PayError("Укажите часы работы")
    if len(raw) > MAX_INTERVALS:
        raise PayError(f"Не больше {MAX_INTERVALS} частей в дне")
    out: list[list[str]] = []
    prev_end = -1
    for it in raw:
        if not isinstance(it, (list, tuple)) or len(it) != 2:
            raise PayError("Интервал: [начало, конец]")
        a, b = str(it[0]).strip(), str(it[1]).strip()
        if not _HM.match(a) or not _HM.match(b) or a == "24:00":
            raise PayError("Время в формате ЧЧ:ММ")
        ma, mb = _minutes(a), _minutes(b)
        if mb <= ma:
            raise PayError("Конец части дня должен быть позже начала (смены через полночь не поддерживаются)")
        if ma < prev_end:
            raise PayError("Части дня пересекаются или идут не по порядку")
        if ma == prev_end:
            raise PayError("Между частями дня должен быть перерыв")
        prev_end = mb
        out.append([a, b])
    return out


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
    """intervals=None: выходной (строка удаляется)."""
    _check_day(day)
    if intervals is None:
        db.execute("DELETE FROM staff_days WHERE staff_id = ? AND day = ?", (int(staff_id), day.isoformat()))
        return None
    iv = validate_intervals(intervals)
    p = validate_money(pay, "Оплата за день")
    db.execute("INSERT INTO staff_days (staff_id, day, intervals, pay, updated_at) VALUES (?, ?, ?, ?, ?) "
               "ON CONFLICT(staff_id, day) DO UPDATE SET intervals = excluded.intervals, pay = excluded.pay, "
               "updated_at = excluded.updated_at", (int(staff_id), day.isoformat(), json.dumps(iv), p, _iso_now()))
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
    with db.transaction() as tx:
        d = d_from
        while d <= d_to:
            key = d.isoformat()
            if d.weekday() in wd:
                if overwrite:
                    tx.execute("INSERT INTO staff_days (staff_id, day, intervals, pay, updated_at) VALUES (?, ?, ?, ?, ?) "
                               "ON CONFLICT(staff_id, day) DO UPDATE SET intervals = excluded.intervals, pay = excluded.pay, "
                               "updated_at = excluded.updated_at", (int(staff_id), key, json.dumps(iv), p, now))
                else:
                    tx.execute("INSERT OR IGNORE INTO staff_days (staff_id, day, intervals, pay, updated_at) "
                               "VALUES (?, ?, ?, ?, ?)", (int(staff_id), key, json.dumps(iv), p, now))
                n += 1
            elif clear_other:
                tx.execute("DELETE FROM staff_days WHERE staff_id = ? AND day = ?", (int(staff_id), key))
            d += timedelta(days=1)
    return n


def shift_now(staff_id: int) -> dict[str, Any]:
    """сегодня: рабочий ли день и идёт ли смена."""
    n = now_msk()
    r = db.fetchone("SELECT * FROM staff_days WHERE staff_id = ? AND day = ?", (int(staff_id), n.date().isoformat()))
    if not r:
        return {"working_today": False, "on_shift": False, "intervals": []}
    d = _row(r)
    m = n.hour * 60 + n.minute
    on = any(_minutes(a) <= m < _minutes(b) for a, b in d["intervals"])
    return {"working_today": True, "on_shift": on, "intervals": d["intervals"], "pay": d["pay"]}


def _earned_rows(staff_id: int) -> list[dict[str, Any]]:
    """отработанные дни: прошедшие; сегодня после конца последней части."""
    n = now_msk()
    today = n.date().isoformat()
    rows = [_row(r) for r in db.fetchall("SELECT * FROM staff_days WHERE staff_id = ? AND day <= ? ORDER BY day",
                                         (int(staff_id), today))]
    m = n.hour * 60 + n.minute
    out = []
    for r in rows:
        if r["day"] == today:
            if not r["intervals"] or _minutes(r["intervals"][-1][1]) > m:
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

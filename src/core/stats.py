"""
Статистика для панели: «Главная» (что важно прямо сейчас) и «Статистика» (всё подробно).

Все суммы — по таблице payments (успешные платежи), как в «Финансах»,
чтобы цифры в разных разделах не расходились. Дни считаются по Москве.
"""

from __future__ import annotations

import statistics as st
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Optional

import database as db

MSK = timezone(timedelta(hours=3))
PAID = ("paid", "completed")

PERIODS = {"7d": 7, "30d": 30, "90d": 90, "365d": 365, "all": None}

METHOD_LABELS = {
    "sbp": "СБП", "card": "Карта", "sberpay": "SberPay", "tg_stars": "Звёзды Telegram",
    "stars": "Звёзды Telegram", "balance": "Реф. баланс", "crypto": "Крипта",
}
PURPOSE_LABELS = {"first": "Первая покупка", "renew": "Продление", "devices": "Докупка устройств",
                  "traffic_reset": "Сброс трафика", "other": "Другое"}
WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
MONTHS_FULL = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]
MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


# ── helpers ──────────────────────────────────────────────────────────────────
def _dt(v: Any) -> Optional[datetime]:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _msk_day(d: datetime) -> date:
    return d.astimezone(MSK).date()


def _pct(a: float, b: float) -> Optional[float]:
    return round(100.0 * a / b, 1) if b else None


def _delta(cur: float, prev: float) -> Optional[float]:
    if not prev:
        return None
    return round(100.0 * (cur - prev) / prev, 1)


def _money(v: float) -> float:
    return round(float(v or 0), 2)


def _paid_payments() -> list[dict[str, Any]]:
    rows = db.fetchall(
        "SELECT id, user_id, provider, method, amount, stars, status, purpose, plan_devices, months, "
        "extra_devices, created_at, paid_at, refunded_at, referral_applied FROM payments "
        "WHERE status IN ('paid', 'completed', 'refunded') ORDER BY COALESCE(paid_at, created_at)"
    )
    out = []
    for r in rows:
        t = _dt(r.get("paid_at")) or _dt(r.get("created_at"))
        if t is None or t > _now() + timedelta(minutes=5):
            continue
        r["t"] = t
        r["amount"] = float(r.get("amount") or 0)
        out.append(r)
    return out


def _method(p: dict[str, Any]) -> str:
    m = "balance" if p.get("provider") == "balance" else (p.get("method") or p.get("provider") or "other")
    return METHOD_LABELS.get(str(m).lower(), str(m))


def _classify(payments: list[dict[str, Any]]) -> None:
    """Помечает каждый платёж: первая покупка / продление / устройства / сброс трафика."""
    seen: set[int] = set()
    for p in payments:
        purpose = str(p.get("purpose") or "subscription")
        uid = int(p.get("user_id") or 0)
        if purpose == "devices":
            p["kind"] = "devices"
        elif purpose == "traffic_reset":
            p["kind"] = "traffic_reset"
        elif purpose in ("subscription", "extend"):
            p["kind"] = "renew" if uid in seen else "first"
        else:
            p["kind"] = "other"
        if p["status"] in PAID or p.get("refunded_at"):
            seen.add(uid)


def _bucket(period_days: Optional[int]) -> str:
    if period_days is None:
        return "month"
    if period_days <= 90:
        return "day"
    return "week"


def _bucket_key(d: date, bucket: str) -> date:
    if bucket == "day":
        return d
    if bucket == "week":
        return d - timedelta(days=d.weekday())
    return d.replace(day=1)


def _bucket_label(d: date, bucket: str) -> str:
    if bucket == "month":
        return f"{MONTHS[d.month - 1]} {str(d.year)[2:]}"
    return f"{d.day:02d}.{d.month:02d}"


def _bucket_range(start: date, end: date, bucket: str) -> list[date]:
    keys = []
    k = _bucket_key(start, bucket)
    while k <= end:
        keys.append(k)
        if bucket == "day":
            k += timedelta(days=1)
        elif bucket == "week":
            k += timedelta(days=7)
        else:
            k = (k.replace(day=28) + timedelta(days=4)).replace(day=1)
    return keys


def _users() -> list[dict[str, Any]]:
    rows = db.fetchall(
        "SELECT id, telegram_id, username, email, is_banned, referred_by, tracking_code, balance, "
        "partner_balance, created_at FROM users"
    )
    for u in rows:
        u["t"] = _dt(u.get("created_at"))
    return rows


def _trial_grants() -> dict[int, datetime]:
    """Когда пользователь впервые получил пробный период."""
    out: dict[int, datetime] = {}
    for r in db.fetchall("SELECT user_id, MIN(granted_at) AS t FROM trial_checks GROUP BY user_id"):
        t = _dt(r.get("t"))
        if t:
            out[int(r["user_id"])] = t
    # Пробные, выданные до появления trial_checks, видны по самой подписке
    for r in db.fetchall("SELECT user_id, MIN(created_at) AS t FROM subscriptions WHERE type = 'trial' GROUP BY user_id"):
        t = _dt(r.get("t"))
        if t and int(r["user_id"]) not in out:
            out[int(r["user_id"])] = t
    return out


def _in(t: Optional[datetime], a: Optional[datetime], b: datetime) -> bool:
    return t is not None and (a is None or t >= a) and t < b


# ── Статистика ───────────────────────────────────────────────────────────────
def statistics(period: str = "30d") -> dict[str, Any]:
    if period not in PERIODS:
        period = "30d"
    days = PERIODS[period]
    now = _now()
    today = _msk_day(now)
    # Границы периода — по московским суткам
    start_day = (today - timedelta(days=days - 1)) if days else None
    start = datetime.combine(start_day, datetime.min.time(), MSK).astimezone(timezone.utc) if start_day else None
    prev_start = (start - timedelta(days=days)) if (start and days) else None
    end = now

    pays_all = _paid_payments()
    _classify(pays_all)
    ok_all = [p for p in pays_all if p["status"] in PAID]
    users = _users()
    trials = _trial_grants()

    if start_day is None:
        first_candidates = [p["t"] for p in ok_all] + [u["t"] for u in users if u["t"]]
        start_day = _msk_day(min(first_candidates)) if first_candidates else today
    bucket = _bucket(days)

    cur = [p for p in ok_all if _in(p["t"], start, end)]
    prev = [p for p in ok_all if prev_start and _in(p["t"], prev_start, start)]
    refunded = [p for p in pays_all if p.get("refunded_at") and _in(_dt(p["refunded_at"]), start, end)]

    # Неуспешные платежи за период — доля отказов у платёжки
    attempts = db.fetchall(
        "SELECT status, method, provider, created_at FROM payments WHERE status IN ('paid','completed','refunded','failed','expired','canceled','cancelled')"
    )
    att_cur = [a for a in attempts if _in(_dt(a.get("created_at")), start, end)]
    failed_cur = sum(1 for a in att_cur if a["status"] not in PAID and a["status"] != "refunded")
    fail_by_method: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for a in att_cur:
        m = _method(a)
        fail_by_method[m][1] += 1
        if a["status"] not in PAID and a["status"] != "refunded":
            fail_by_method[m][0] += 1

    rev = sum(p["amount"] for p in cur)
    rev_prev = sum(p["amount"] for p in prev)
    payers = {int(p["user_id"]) for p in cur}
    payers_prev = {int(p["user_id"]) for p in prev}

    # ── ряды по времени
    keys = _bucket_range(start_day, today, bucket)
    series = {k: {"revenue": 0.0, "payments": 0, "new_users": 0, "trials": 0, "first": 0} for k in keys}

    def _add(t: Optional[datetime], field: str, v: float = 1) -> None:
        if t is None:
            return
        k = _bucket_key(_msk_day(t), bucket)
        if k in series:
            series[k][field] += v

    for p in cur:
        _add(p["t"], "revenue", p["amount"])
        _add(p["t"], "payments")
        if p["kind"] == "first":
            _add(p["t"], "first")
    for u in users:
        if _in(u["t"], start, end):
            _add(u["t"], "new_users")
    for t in trials.values():
        if _in(t, start, end):
            _add(t, "trials")
    timeline = [{"t": k.isoformat(), "label": _bucket_label(k, bucket), **{kk: (round(vv, 2) if isinstance(vv, float) else vv) for kk, vv in v.items()}}
                for k, v in series.items()]

    # ── структура выручки
    by_kind: dict[str, list[float]] = defaultdict(lambda: [0, 0.0])
    by_method: dict[str, list[float]] = defaultdict(lambda: [0, 0.0])
    by_plan: Counter = Counter()
    by_months: Counter = Counter()
    by_hour = [0] * 24
    by_wd = [0] * 7
    for p in cur:
        by_kind[p["kind"]][0] += 1
        by_kind[p["kind"]][1] += p["amount"]
        m = _method(p)
        by_method[m][0] += 1
        by_method[m][1] += p["amount"]
        if p["kind"] in ("first", "renew"):
            if p.get("plan_devices"):
                by_plan[int(p["plan_devices"])] += 1
            by_months[int(p.get("months") or 1)] += 1
        lt = p["t"].astimezone(MSK)
        by_hour[lt.hour] += 1
        by_wd[lt.weekday()] += 1

    amounts = [p["amount"] for p in cur if p["amount"] > 0]
    stars_cnt = sum(int(p.get("stars") or 0) for p in cur)

    # ── пользователи
    new_cur = [u for u in users if _in(u["t"], start, end)]
    new_prev = [u for u in users if prev_start and _in(u["t"], prev_start, start)]
    blacklisted = int((db.fetchone("SELECT COUNT(*) AS c FROM users WHERE ban_reason LIKE 'blacklist%' OR ban_reason LIKE '%черн%'") or {}).get("c") or 0)
    src = Counter()
    for u in new_cur:
        if u.get("referred_by"):
            src["По приглашению"] += 1
        elif u.get("tracking_code"):
            src["По ссылке"] += 1
        else:
            src["Сами"] += 1
    login = Counter()
    for u in users:
        if u.get("telegram_id") and u.get("email"):
            login["Telegram + почта"] += 1
        elif u.get("telegram_id"):
            login["Telegram"] += 1
        elif u.get("email"):
            login["Только почта (сайт)"] += 1

    # ── воронка по пользователям, пришедшим в период
    first_pay: dict[int, datetime] = {}
    for p in ok_all:
        uid = int(p["user_id"])
        if uid not in first_pay:
            first_pay[uid] = p["t"]
    cohort_ids = {int(u["id"]) for u in new_cur}
    f_trial = sum(1 for i in cohort_ids if i in trials)
    f_paid = sum(1 for i in cohort_ids if i in first_pay)
    f_trial_paid = sum(1 for i in cohort_ids if i in trials and i in first_pay and first_pay[i] >= trials[i])
    # общая конверсия пробного в оплату (за всё время) и время до первой оплаты
    trial_total = len(trials)
    trial_conv = sum(1 for i, t in trials.items() if i in first_pay and first_pay[i] >= t)
    hours_to_pay = []
    ucreated = {int(u["id"]): u["t"] for u in users}
    for uid, t in first_pay.items():
        c = ucreated.get(uid)
        if c and t >= c and _in(t, start, end):
            hours_to_pay.append((t - c).total_seconds() / 3600)

    # ── подписки
    nowiso = now.isoformat()
    subs = db.fetchall("SELECT id, user_id, type, status, expires_at, devices_limit, traffic_used, no_renew, frozen_at, created_at FROM subscriptions WHERE status != 'Deleted'")
    act_paid = [s for s in subs if s["status"] == "Active" and s["type"] != "trial" and (not s["expires_at"] or s["expires_at"] > nowiso)]
    act_trial = [s for s in subs if s["status"] == "Active" and s["type"] == "trial" and (not s["expires_at"] or s["expires_at"] > nowiso)]

    def _exp_within(h: int) -> int:
        lim = (now + timedelta(hours=h)).isoformat()
        return sum(1 for s in act_paid if s["expires_at"] and s["expires_at"] <= lim)

    dev_dist = Counter(int(s.get("devices_limit") or 1) for s in act_paid)
    expired_period = sum(1 for s in subs if s["type"] != "trial" and _in(_dt(s.get("expires_at")), start, end))
    traffic_total = sum(int(s.get("traffic_used") or 0) for s in act_paid + act_trial)
    renew_cnt = by_kind.get("renew", [0, 0])[0]
    paying_all = {int(p["user_id"]) for p in ok_all}
    pay_counts = Counter(int(p["user_id"]) for p in ok_all)
    repeat_users = sum(1 for c in pay_counts.values() if c >= 2)
    ltv = sum(p["amount"] for p in ok_all) / len(paying_all) if paying_all else 0

    # ── рефералы
    ref_tx = db.fetchall("SELECT user_id, amount, created_at FROM transactions WHERE payment_method = 'referral' AND status = 'completed'")
    ref_cur = [r for r in ref_tx if _in(_dt(r.get("created_at")), start, end)]
    invited_cur = [u for u in new_cur if u.get("referred_by")]
    invited_paid = sum(1 for u in invited_cur if int(u["id"]) in first_pay)
    wd = db.fetchall("SELECT status, amount, created_at, processed_at FROM withdrawals")
    wd_done = [w for w in wd if w["status"] in ("approved", "completed") and _in(_dt(w.get("processed_at") or w.get("created_at")), start, end)]
    wd_pending = [w for w in wd if w["status"] == "pending"]
    earned_by: dict[int, float] = defaultdict(float)
    for r in ref_tx:
        earned_by[int(r["user_id"] or 0)] += float(r["amount"] or 0)
    invited_by: Counter = Counter()
    invited_paid_by: Counter = Counter()
    for u in users:
        if u.get("referred_by"):
            invited_by[int(u["referred_by"])] += 1
            if int(u["id"]) in first_pay:
                invited_paid_by[int(u["referred_by"])] += 1
    uname = {int(u["id"]): (f"@{u['username']}" if u.get("username") else (u.get("email") or f"id{u.get('telegram_id') or u['id']}")) for u in users}
    top_ref = sorted(invited_by.keys(), key=lambda i: (earned_by.get(i, 0), invited_by[i]), reverse=True)[:10]
    partner_owed = sum(float(u.get("partner_balance") or 0) for u in users)

    # ── промокоды и ссылки
    promo_rows = db.fetchall(
        "SELECT p.code, p.name, a.created_at FROM promocode_activations a JOIN promocodes p ON p.id = a.promocode_id"
    )
    promo_cur = [r for r in promo_rows if _in(_dt(r.get("created_at")), start, end)]
    promo_top = Counter(r["code"] for r in promo_cur).most_common(8)
    links = db.fetchall(
        "SELECT name, code, clicks, new_users, paid_users, total_revenue FROM tracking_links ORDER BY total_revenue DESC, new_users DESC LIMIT 8"
    )

    # ── когорты по месяцу регистрации (последние 6 месяцев)
    cohorts = []
    rev_by_user: dict[int, float] = defaultdict(float)
    for p in ok_all:
        rev_by_user[int(p["user_id"])] += p["amount"]
    month0 = today.replace(day=1)
    for i in range(5, -1, -1):
        m = month0
        for _ in range(i):
            m = (m - timedelta(days=1)).replace(day=1)
        m_next = (m.replace(day=28) + timedelta(days=4)).replace(day=1)
        ids = [int(u["id"]) for u in users if u["t"] and m <= _msk_day(u["t"]) < m_next]
        n = len(ids)
        paid_n = sum(1 for x in ids if x in first_pay)
        revenue = sum(rev_by_user.get(x, 0) for x in ids)
        cohorts.append({
            "label": f"{MONTHS[m.month - 1]} {m.year}", "users": n,
            "trial": _pct(sum(1 for x in ids if x in trials), n), "paid": _pct(paid_n, n),
            "repeat": _pct(sum(1 for x in ids if pay_counts.get(x, 0) >= 2), paid_n),
            "revenue": _money(revenue), "ltv": _money(revenue / n) if n else 0,
        })

    def _series_pairs(d: dict[str, list[float]], labels: Optional[dict[str, str]] = None) -> list[dict[str, Any]]:
        rows = [{"name": (labels or {}).get(k, k), "count": int(v[0]), "sum": _money(v[1])} for k, v in d.items()]
        return sorted(rows, key=lambda r: r["sum"], reverse=True)

    return {
        "period": period, "bucket": bucket, "from": start_day.isoformat(), "to": today.isoformat(),
        "money": {
            "revenue": _money(rev), "revenue_prev": _money(rev_prev), "revenue_delta": _delta(rev, rev_prev),
            "payments": len(cur), "payments_prev": len(prev), "payments_delta": _delta(len(cur), len(prev)),
            "avg_check": _money(rev / len(cur)) if cur else 0,
            "median_check": _money(st.median(amounts)) if amounts else 0,
            "payers": len(payers), "payers_delta": _delta(len(payers), len(payers_prev)),
            "arppu": _money(rev / len(payers)) if payers else 0,
            "arpu": _money(rev / len(users)) if users else 0,
            "per_day": _money(rev / max(1, (today - start_day).days + 1)),
            "refunds": len(refunded), "refunds_sum": _money(sum(p["amount"] for p in refunded)),
            "failed": failed_cur, "success_rate": _pct(len(att_cur) - failed_cur, len(att_cur)),
            "stars": stars_cnt,
            "ltv": _money(ltv), "total_all_time": _money(sum(p["amount"] for p in ok_all)),
            "best": max(timeline, key=lambda x: x["revenue"]) if timeline else None,
        },
        "timeline": timeline,
        "by_kind": _series_pairs(by_kind, PURPOSE_LABELS),
        "by_method": _series_pairs(by_method),
        "fail_by_method": sorted(
            [{"name": k, "failed": v[0], "total": v[1], "rate": _pct(v[0], v[1])} for k, v in fail_by_method.items()],
            key=lambda r: r["total"], reverse=True),
        "by_plan": [{"name": f"{k} устр.", "value": v} for k, v in sorted(by_plan.items())],
        "by_months": [{"name": f"{k} мес.", "value": v} for k, v in sorted(by_months.items())],
        "by_hour": by_hour,
        "by_weekday": [{"name": WEEKDAYS[i], "value": by_wd[i]} for i in range(7)],
        "users": {
            "total": len(users), "new": len(new_cur), "new_prev": len(new_prev), "new_delta": _delta(len(new_cur), len(new_prev)),
            "banned": sum(1 for u in users if u.get("is_banned")), "blacklisted": blacklisted,
            "sources": [{"name": k, "value": v} for k, v in src.most_common()],
            "login": [{"name": k, "value": v} for k, v in login.most_common()],
            "with_balance": sum(1 for u in users if float(u.get("balance") or 0) > 0),
            "balance_total": _money(sum(float(u.get("balance") or 0) for u in users)),
        },
        "funnel": {
            "registered": len(cohort_ids), "trial": f_trial, "paid": f_paid, "trial_paid": f_trial_paid,
            "trial_conv_all": _pct(trial_conv, trial_total), "trial_total": trial_total,
            "hours_to_pay_median": round(st.median(hours_to_pay), 1) if hours_to_pay else None,
        },
        "subs": {
            "active_paid": len(act_paid), "active_trial": len(act_trial),
            "devices_total": sum(int(s.get("devices_limit") or 1) for s in act_paid),
            "avg_devices": round(sum(int(s.get("devices_limit") or 1) for s in act_paid) / len(act_paid), 2) if act_paid else 0,
            "exp_24h": _exp_within(24), "exp_3d": _exp_within(72), "exp_7d": _exp_within(168),
            "expired_period": expired_period, "renewed_period": renew_cnt,
            "no_renew": sum(1 for s in act_paid if s.get("no_renew")),
            "frozen": sum(1 for s in act_paid if s.get("frozen_at")),
            "traffic_total": traffic_total,
            "devices_dist": [{"name": f"{k} устр.", "value": v} for k, v in sorted(dev_dist.items())],
            "state_dist": [],  # заполняется в core (user_states_map)
            "repeat_rate": _pct(repeat_users, len(paying_all)), "paying_all": len(paying_all),
        },
        "referrals": {
            "invited": len(invited_cur), "invited_paid": invited_paid,
            "bonuses": _money(sum(float(r["amount"] or 0) for r in ref_cur)), "bonuses_count": len(ref_cur),
            "withdrawn": _money(sum(float(w["amount"] or 0) for w in wd_done)), "withdrawn_count": len(wd_done),
            "pending": _money(sum(float(w["amount"] or 0) for w in wd_pending)), "pending_count": len(wd_pending),
            "owed": _money(partner_owed),
            "partners": len(invited_by),
            "top": [{"id": i, "name": uname.get(i, f"#{i}"), "invited": invited_by[i], "paid": invited_paid_by[i],
                     "earned": _money(earned_by.get(i, 0))} for i in top_ref],
        },
        "promo": {
            "activations": len(promo_cur),
            "top": [{"name": c, "value": n} for c, n in promo_top],
            "links": [{"name": l["name"], "code": l["code"], "clicks": int(l["clicks"] or 0), "new_users": int(l["new_users"] or 0),
                       "paid_users": int(l["paid_users"] or 0), "revenue": _money(l["total_revenue"])} for l in links],
        },
        "cohorts": cohorts,
    }


# ── Главная ──────────────────────────────────────────────────────────────────
def dashboard() -> dict[str, Any]:
    now = _now()
    today = _msk_day(now)
    day0 = datetime.combine(today, datetime.min.time(), MSK).astimezone(timezone.utc)
    pays = [p for p in _paid_payments() if p["status"] in PAID]
    users = _users()

    def rev_between(a: datetime, b: datetime) -> tuple[float, int]:
        sel = [p for p in pays if _in(p["t"], a, b)]
        return sum(p["amount"] for p in sel), len(sel)

    r_today, n_today = rev_between(day0, now)
    r_yday, n_yday = rev_between(day0 - timedelta(days=1), day0)
    # вчера к этому же часу — честное сравнение незаконченного дня
    r_yday_same, _ = rev_between(day0 - timedelta(days=1), now - timedelta(days=1))
    r_7, _ = rev_between(day0 - timedelta(days=6), now)
    r_prev7, _ = rev_between(day0 - timedelta(days=13), day0 - timedelta(days=6))
    r_30, _ = rev_between(day0 - timedelta(days=29), now)

    # Доход за календарный месяц (МСК) и прошлый месяц к этому же дню
    m0_day = today.replace(day=1)
    m0 = datetime.combine(m0_day, datetime.min.time(), MSK).astimezone(timezone.utc)
    pm_day = (m0_day - timedelta(days=1)).replace(day=1)
    pm0 = datetime.combine(pm_day, datetime.min.time(), MSK).astimezone(timezone.utc)
    r_month, n_month = rev_between(m0, now)
    same_point = min(now - m0, m0 - pm0)
    r_prev_month_same, _ = rev_between(pm0, pm0 + same_point)
    r_prev_month, _ = rev_between(pm0, m0)

    new_today = sum(1 for u in users if _in(u["t"], day0, now))
    new_yday = sum(1 for u in users if _in(u["t"], day0 - timedelta(days=1), day0))
    new_7 = sum(1 for u in users if _in(u["t"], day0 - timedelta(days=6), now))

    nowiso = now.isoformat()
    act_paid = int((db.fetchone(
        "SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'Active' AND type != 'trial' AND (expires_at IS NULL OR expires_at > ?)",
        (nowiso,)) or {}).get("c") or 0)
    act_trial = int((db.fetchone(
        "SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'Active' AND type = 'trial' AND (expires_at IS NULL OR expires_at > ?)",
        (nowiso,)) or {}).get("c") or 0)

    series = []
    for i in range(13, -1, -1):
        d = today - timedelta(days=i)
        a = datetime.combine(d, datetime.min.time(), MSK).astimezone(timezone.utc)
        s, n = rev_between(a, a + timedelta(days=1))
        series.append({"label": f"{d.day:02d}.{d.month:02d}", "value": _money(s), "count": n})

    # ── что требует внимания
    todo: list[dict[str, Any]] = []
    wd = db.fetchone("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status = 'pending'") or {}
    if int(wd.get("c") or 0):
        todo.append({"level": "critical", "page": "Выводы", "title": f"Заявки на вывод: {int(wd['c'])}",
                     "text": f"на {_money(wd['s']):,.0f} ₽, ждут решения".replace(",", " ")})
    wd_appr = db.fetchone("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status = 'approved'") or {}
    if int(wd_appr.get("c") or 0):
        todo.append({"level": "warning", "page": "Выводы", "title": f"Одобрено, но не выплачено: {int(wd_appr['c'])}",
                     "text": "отправьте перевод и укажите ссылку на транзакцию"})
    try:
        import monitoring as mon
        ov = mon.overview()["summary"]
        if ov["problems"]:
            todo.append({"level": "critical", "page": "Мониторинг", "title": f"Серверы с проблемами: {ov['problems']}",
                         "text": f"открытых инцидентов: {ov['open_incidents']}"})
        soon = (now + timedelta(days=3)).isoformat()
        due = db.fetchall("SELECT name, pay_date FROM mon_nodes WHERE pay_date IS NOT NULL AND pay_date <= ? ORDER BY pay_date", (soon,))
        if due:
            first = _dt(due[0]["pay_date"])
            when = first.astimezone(MSK).strftime("%d.%m %H:%M") if first else ""
            todo.append({"level": "warning" if first and first > now else "critical", "page": "Мониторинг",
                         "title": f"Оплата серверов: {len(due)}",
                         "text": f"ближайшая: {due[0]['name']}, {when}" + (" (просрочена)" if first and first <= now else "")})
        if ov["idle"]:
            todo.append({"level": "info", "page": "Мониторинг", "title": f"Ноды не запущены: {ov['idle']}",
                         "text": "установите агент и нажмите «Запустить»"})
    except Exception:  # noqa: BLE001
        pass
    stuck = db.fetchone(
        "SELECT COUNT(*) AS c FROM payments WHERE status IN ('pending','processing') AND created_at <= ? AND created_at >= ?",
        ((now - timedelta(minutes=30)).isoformat(), (now - timedelta(days=2)).isoformat())) or {}
    if int(stuck.get("c") or 0):
        todo.append({"level": "warning", "page": "Финансы", "title": f"Зависшие платежи: {int(stuck['c'])}",
                     "text": "висят в ожидании дольше 30 минут, проверьте платёжку"})
    att = db.fetchall("SELECT status FROM payments WHERE created_at >= ? AND status IN ('paid','completed','failed','expired','canceled','cancelled')",
                      ((now - timedelta(hours=24)).isoformat(),))
    failed = sum(1 for a in att if a["status"] not in PAID)
    if len(att) >= 5 and failed / len(att) >= 0.5:
        todo.append({"level": "warning", "page": "Финансы", "title": f"Много неуспешных оплат: {failed} из {len(att)}",
                     "text": "за последние сутки, возможно, проблема у платёжки"})
    try:
        import provisioning
        if not provisioning.is_configured():
            todo.append({"level": "critical", "page": "Настройки", "title": "Remnawave не подключён",
                         "text": "подписки не создаются, заполните REMNAWAVE_* в .env"})
    except Exception:  # noqa: BLE001
        pass
    try:
        import forum
        if not forum.chat_id():
            todo.append({"level": "info", "page": "Настройки", "title": "Форум уведомлений не настроен",
                         "text": "выводы, ошибки и инциденты никуда не приходят"})
    except Exception:  # noqa: BLE001
        pass
    order = {"critical": 0, "warning": 1, "info": 2}
    todo.sort(key=lambda x: order.get(x["level"], 3))

    recent = db.fetchall(
        "SELECT p.amount, p.stars, p.method, p.provider, p.purpose, p.paid_at, p.created_at, p.user_id, u.username, u.email, u.telegram_id "
        "FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.status IN ('paid','completed') "
        "AND COALESCE(p.paid_at, p.created_at) <= ? ORDER BY COALESCE(p.paid_at, p.created_at) DESC LIMIT 8", ((now + timedelta(minutes=5)).isoformat(),)
    )
    return {
        "revenue": {"today": _money(r_today), "yesterday": _money(r_yday), "yesterday_same_time": _money(r_yday_same),
                    "payments_today": n_today, "payments_yesterday": n_yday,
                    "week": _money(r_7), "week_delta": _delta(r_7, r_prev7), "month": _money(r_30),
                    "cal_month": _money(r_month), "cal_month_payments": n_month,
                    "prev_month": _money(r_prev_month), "prev_month_same": _money(r_prev_month_same),
                    "cal_month_delta": _delta(r_month, r_prev_month_same),
                    "month_name": MONTHS_FULL[today.month - 1]},
        "users": {"total": len(users), "today": new_today, "yesterday": new_yday, "week": new_7},
        "subs": {"active_paid": act_paid, "active_trial": act_trial},
        "series": series,
        "todo": todo,
        # Блок «Пользователи» с «Статистики» за последние 30 дней
        "users_block": _users_block(),
        "recent": [{
            "user_id": r["user_id"],
            "who": f"@{r['username']}" if r.get("username") else (r.get("email") or f"id{r.get('telegram_id') or r['user_id']}"),
            "amount": _money(r["amount"]), "stars": r.get("stars"),
            "method": _method(r), "purpose": r.get("purpose"),
            "at": r.get("paid_at") or r.get("created_at"),
        } for r in recent],
    }


def _users_block() -> dict[str, Any]:
    st30 = statistics("30d")
    return {"users": st30["users"], "funnel": st30["funnel"], "timeline": st30["timeline"], "bucket": st30["bucket"]}

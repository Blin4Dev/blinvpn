"""
Анти-абуз: периодический опрос Remnawave по активным подпискам BlinVPN.

Правила (по каждой активной подписке, лимит = devices_limit):
  1. HWID: если число HWID-устройств ≥ 3 × лимит — бан.
     (лимит 1 → ≥3, лимит 2 → ≥6, лимит 3 → ≥9 …)
  2. IP: если число активных IP ≥ лимит + 2 — бан.
     (лимит 1 → ≥3, лимит 2 → ≥4, лимит 3 → ≥5 …)

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
    import remnawave  # type: ignore
except Exception:  # noqa: BLE001
    remnawave = None  # type: ignore

MAX_PER_RUN = 400


def enabled() -> bool:
    return db.get_setting("antiabuse_enabled", "1") in ("1", "true", "True", "yes")


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


def _active_ip_count(devices: list[dict[str, Any]]) -> Optional[int]:
    """
    Число различных IP среди HWID-устройств. None — если IP-данных нет
    (тогда IP-правило пропускается, чтобы не банить по недостатку данных).
    """
    ips: set[str] = set()
    saw_field = False
    for d in devices or []:
        if not isinstance(d, dict):
            continue
        # Remnawave 3.4.4: поле IP устройства называется requestIp.
        ip = (d.get("requestIp") or d.get("request_ip") or d.get("ip")
              or d.get("lastIp") or d.get("lastConnectedIp") or d.get("ipAddress"))
        if ip is not None:
            saw_field = True
            if str(ip).strip():
                ips.add(str(ip).strip())
    if not saw_field:
        return None
    return len(ips)


def _ban(sub: dict[str, Any], client, rw_id: Optional[int], reason: str,
         log) -> None:
    sub_id = sub["id"]
    db.execute("UPDATE subscriptions SET status = 'Banned' WHERE id = ?", (sub_id,))
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


def scan_once(log=print) -> dict[str, Any]:
    """Один проход анти-абуза. Возвращает {checked, banned}."""
    if not enabled():
        return {"checked": 0, "banned": 0, "skipped": "disabled"}
    client = _client()
    if not client:
        return {"checked": 0, "banned": 0, "skipped": "remnawave_off"}

    subs = db.fetchall(
        "SELECT id, user_id, rw_id, devices_limit, type FROM subscriptions "
        "WHERE status = 'Active' AND type IN ('vpn', 'trial') "
        "ORDER BY id DESC LIMIT ?",
        (MAX_PER_RUN,),
    )
    checked = 0
    banned = 0
    for sub in subs:
        limit = max(1, int(sub.get("devices_limit") or 1))
        rw_id = _rw_num_id_for(sub, client)
        if rw_id is None:
            continue
        devices = _hwid_devices(client, rw_id)
        checked += 1
        hwid_count = len(devices)
        # Правило 1 — HWID ≥ 3×лимит
        if hwid_count >= 3 * limit:
            _ban(sub, client, rw_id, f"HWID {hwid_count} ≥ {3 * limit} (лимит {limit})", log)
            banned += 1
            continue
        # Правило 2 — активные IP ≥ лимит+2 (только если IP-данные доступны)
        ipc = _active_ip_count(devices)
        if ipc is not None and ipc >= limit + 2:
            _ban(sub, client, rw_id, f"IP {ipc} ≥ {limit + 2} (лимит {limit})", log)
            banned += 1
            continue
    if banned:
        log(f"[antiabuse] проверено {checked}, забанено {banned}")
    return {"checked": checked, "banned": banned}

"""
Провижининг VPN-доступа в Remnawave для BlinVPN.

Единая точка, через которую ядро/вебхук/бот создают и продлевают
пользователей Remnawave при выдаче подписки. Работает поверх
src/api/remnawave.py. Полностью изолирует ошибки панели: если Remnawave
не настроена или недоступна, подписка всё равно создаётся в локальной БД
(с плейсхолдер-конфигом), а причина складывается в error.

Env (см. remnawave.py):
  REMWAVE_PANEL_URL, REMWAVE_API_KEY
"""

from __future__ import annotations

import os
import uuid as _uuid
from datetime import datetime, timezone
from typing import Any, Optional

try:  # remnawave живёт в src/api — он в PYTHONPATH
    import remnawave  # type: ignore
except Exception:  # noqa: BLE001
    remnawave = None  # type: ignore


def _env(*keys: str, default: str = "") -> str:
    for key in keys:
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return default


def is_configured() -> bool:
    if remnawave is None:
        return False
    return bool(_env("REMWAVE_API_KEY", "REMNAWAVE_TOKEN", "REMNAWAVE_API_TOKEN"))


def _extract(user: dict[str, Any]) -> dict[str, Any]:
    rw_id = user.get("uuid") or user.get("id") or user.get("userId")
    short = user.get("shortUuid") or user.get("short_uuid")
    return {
        "rw_id": str(rw_id) if rw_id is not None else None,
        "short_uuid": str(short) if short else None,
        "vless_uuid": user.get("vlessUuid") or user.get("vless_uuid"),
    }


def provision(
    *,
    telegram_id: int,
    username: Optional[str],
    expire_at: datetime,
    devices: int = 1,
    squads: Optional[list[str]] = None,
    email: Optional[str] = None,
    traffic_limit_bytes: int = 0,
    traffic_reset_strategy: str = "MONTH",
    reset_traffic: bool = False,
) -> dict[str, Any]:
    """
    Создаёт или продлевает пользователя Remnawave до абсолютной даты expire_at.

    Возвращает: {ok, rw_id, short_uuid, subscription_url, error}.
    Никогда не бросает исключений — ошибки возвращаются в поле error.
    """
    result: dict[str, Any] = {
        "ok": False,
        "rw_id": None,
        "short_uuid": None,
        "subscription_url": None,
        "error": None,
    }

    if not is_configured():
        result["error"] = "remnawave_not_configured"
        return result

    if expire_at.tzinfo is None:
        expire_at = expire_at.replace(tzinfo=timezone.utc)

    try:
        client = remnawave.get_client()  # type: ignore[union-attr]
        existing = client.find_user_by_telegram(int(telegram_id))
        squad_list = list(squads or [])

        if existing:
            uid = existing.get("id") or existing.get("userId") or existing.get("uuid")
            patch: dict[str, Any] = {
                "status": "ACTIVE",
                "expire_at": expire_at,
                "hwid_device_limit": int(max(1, devices)),
                "traffic_limit_strategy": traffic_reset_strategy,
            }
            # update_user принимает id/uuid через kwargs
            if isinstance(uid, int) or (isinstance(uid, str) and uid.isdigit()):
                patch["id"] = int(uid)
            else:
                patch["uuid"] = uid
            if squad_list:
                patch["active_internal_squads"] = squad_list
            if traffic_limit_bytes:
                patch["traffic_limit_bytes"] = traffic_limit_bytes
            if email:
                patch["email"] = email
            user = client.update_user(**patch)
            # Сброс трафика (например при переходе с триала на платную).
            if reset_traffic and uid is not None:
                try:
                    client.reset_user_traffic(uid)
                except Exception:  # noqa: BLE001
                    pass
        else:
            uname = username or f"tg_{telegram_id}"
            uname = "".join(c if c.isalnum() or c in "_-" else "_" for c in uname)[:36] or f"tg_{telegram_id}"
            user = client.create_user(
                username=uname,
                expire_at=expire_at,
                status="ACTIVE",
                telegram_id=int(telegram_id),
                email=email or None,
                hwid_device_limit=int(max(1, devices)),
                traffic_limit_bytes=traffic_limit_bytes or None,
                traffic_limit_strategy=traffic_reset_strategy,
                active_internal_squads=squad_list or None,
            )

        if not isinstance(user, dict):
            result["error"] = "unexpected_remnawave_response"
            return result

        fields = _extract(user)
        result.update(fields)
        result["subscription_url"] = client.subscription_url_for(
            user, public_base=_env("REMWAVE_SUB_PUBLIC_URL") or None
        )
        result["ok"] = True
        return result
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result


def reset_traffic(telegram_id: int, email: Optional[str] = None) -> dict[str, Any]:
    """
    Досрочный сброс трафика пользователя в Remnawave. Ничего не бросает.
    Возвращает {ok, error}.
    """
    out: dict[str, Any] = {"ok": False, "error": None}
    if not is_configured():
        out["error"] = "remnawave_not_configured"
        return out
    try:
        client = remnawave.get_client()  # type: ignore[union-attr]
        rw = client.find_user_by_telegram(int(telegram_id)) if telegram_id else None
        if not rw and email:
            try:
                rw = client.resolve_user(email=email)
                if isinstance(rw, dict) and "response" in rw:
                    rw = rw["response"]
            except Exception:  # noqa: BLE001
                rw = None
        if not isinstance(rw, dict):
            out["error"] = "user_not_found"
            return out
        # 3.x: reset-traffic идентифицирует пользователя ЧИСЛОВЫМ id.
        uid = rw.get("id")
        if uid is None:
            out["error"] = "user_id_missing"
            return out
        client.reset_user_traffic(int(uid))
        out["ok"] = True
        return out
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out


def user_ever_connected(telegram_id: int, email: Optional[str] = None) -> Optional[bool]:
    """
    Подключался ли пользователь к VPN хоть раз. True/False, либо None если
    определить нельзя (Remnawave выключена/недоступна/пользователь не найден).
    Сигналы подключения: onlineAt, потраченный трафик, наличие HWID-устройств.
    """
    if not is_configured():
        return None
    try:
        client = remnawave.get_client()  # type: ignore[union-attr]
        rw = client.find_user_by_telegram(int(telegram_id)) if telegram_id else None
        if not rw and email:
            try:
                rw = client.resolve_user(email=email)
                if isinstance(rw, dict) and "response" in rw:
                    rw = rw["response"]
            except Exception:  # noqa: BLE001
                rw = None
        if not isinstance(rw, dict):
            return None
        # В Remnawave 3.4.4 онлайн/трафик лежат в userTraffic; проверяем и там, и на верхнем уровне.
        ut = rw.get("userTraffic") if isinstance(rw.get("userTraffic"), dict) else {}
        if rw.get("onlineAt") or ut.get("onlineAt") or rw.get("lastConnectedAt"):
            return True
        used = (rw.get("usedTrafficBytes") or rw.get("lifetimeUsedTrafficBytes")
                or ut.get("usedTrafficBytes") or ut.get("lifetimeUsedTrafficBytes")
                or rw.get("trafficUsedBytes") or 0)
        try:
            if float(used) > 0:
                return True
        except (TypeError, ValueError):
            pass
        num_id = rw.get("id")  # 3.x: HWID-эндпоинты по числовому id
        try:
            if num_id is not None:
                data = client.get_user_hwid_devices(int(num_id))
                if isinstance(data, dict) and "response" in data:
                    data = data["response"]
                devs = data.get("devices") if isinstance(data, dict) else data
                if devs and len(devs) > 0:
                    return True
        except Exception:  # noqa: BLE001
            pass
        return False
    except Exception:  # noqa: BLE001
        return None


def user_first_connected_at(telegram_id: int, email: Optional[str] = None) -> Optional[str]:
    """
    ISO-время первого подключения пользователя к VPN (Remnawave firstConnectedAt /
    onlineAt), либо None если ещё не подключался / определить нельзя.
    """
    if not is_configured():
        return None
    try:
        client = remnawave.get_client()  # type: ignore[union-attr]
        rw = client.find_user_by_telegram(int(telegram_id)) if telegram_id else None
        if not rw and email:
            try:
                rw = client.resolve_user(email=email)
                if isinstance(rw, dict) and "response" in rw:
                    rw = rw["response"]
            except Exception:  # noqa: BLE001
                rw = None
        if not isinstance(rw, dict):
            return None
        ut = rw.get("userTraffic") if isinstance(rw.get("userTraffic"), dict) else {}
        val = (rw.get("firstConnectedAt") or rw.get("first_connected_at")
               or ut.get("firstConnectedAt") or rw.get("onlineAt") or ut.get("onlineAt")
               or rw.get("lastConnectedAt"))
        return str(val) if val else None
    except Exception:  # noqa: BLE001
        return None


def local_fallback_config(short_uuid: str) -> str:
    """
    Пусто, когда Remnawave недоступна. Подписка всегда берётся из Remnawave
    (реальная subscription-ссылка), а не из локального vless-плейсхолдера —
    поэтому фейковый конфиг не создаём (иначе пользователь получил бы нерабочий).
    """
    return ""

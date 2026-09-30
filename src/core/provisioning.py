# создание/продление в remnawave; локальная подписка создаётся и при недоступной панели
from __future__ import annotations

import os
import uuid as _uuid
from datetime import datetime, timezone
from typing import Any, Optional

try:  # remnawave lives on PYTHONPATH (src/api)
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
    telegram_id: Optional[int],
    username: Optional[str],
    expire_at: datetime,
    devices: int = 1,
    squads: Optional[list[str]] = None,
    email: Optional[str] = None,
    traffic_limit_bytes: int = 0,
    traffic_reset_strategy: str = "MONTH",
    reset_traffic: bool = False,
    user_id: Optional[int] = None,
) -> dict[str, Any]:
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
        # поиск: telegram → email → web_<id>
        existing = client.find_user_by_telegram(int(telegram_id)) if telegram_id else None
        if not existing and email:
            existing = _resolve_quiet(client, email=email)
        if not existing and not telegram_id and user_id:
            existing = _resolve_quiet(client, username=f"web_{int(user_id)}")
        squad_list = list(squads or [])

        if existing:
            uid = existing.get("id") or existing.get("userId") or existing.get("uuid")
            patch: dict[str, Any] = {
                "status": "ACTIVE",
                "expire_at": expire_at,
                "hwid_device_limit": int(max(1, devices)),
                "traffic_limit_strategy": traffic_reset_strategy,
            }
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
            if user_id:
                patch["description"] = str(int(user_id))
            user = client.update_user(**patch)
            # опциональный сброс трафика (напр. trial→paid)
            if reset_traffic and uid is not None:
                try:
                    client.reset_user_traffic(uid)
                except Exception:  # noqa: BLE001
                    pass
        else:
            fallback = f"tg_{telegram_id}" if telegram_id else f"web_{int(user_id or 0)}"
            uname = (username or fallback) if telegram_id else fallback
            uname = "".join(c if c.isalnum() or c in "_-" else "_" for c in uname)[:36] or fallback
            user = client.create_user(
                username=uname,
                expire_at=expire_at,
                status="ACTIVE",
                telegram_id=int(telegram_id) if telegram_id else None,
                email=email or None,
                description=str(int(user_id)) if user_id else None,
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


def find_user(client: Any, telegram_id: Optional[int], email: Optional[str] = None,
              user_id: Optional[int] = None) -> Optional[dict[str, Any]]:
    rw = client.find_user_by_telegram(int(telegram_id)) if telegram_id else None
    if isinstance(rw, dict) and "response" in rw:
        rw = rw["response"]
    if not rw and email:
        rw = _resolve_quiet(client, email=email)
    if not rw and not telegram_id and user_id:
        rw = _resolve_quiet(client, username=f"web_{int(user_id)}")
    return rw if isinstance(rw, dict) else None


def rw_ref(rw: dict[str, Any]) -> dict[str, Any]:
    uid = rw.get("id") or rw.get("userId") or rw.get("uuid")
    if isinstance(uid, int) or (isinstance(uid, str) and uid.isdigit()):
        return {"id": int(uid)}
    return {"uuid": uid}


def _resolve_quiet(client: Any, **kw: Any) -> Optional[dict[str, Any]]:
    try:
        rw = client.resolve_user(**kw)
    except Exception:  # noqa: BLE001
        return None
    if isinstance(rw, dict) and "response" in rw:
        rw = rw["response"]
    return rw if isinstance(rw, dict) and (rw.get("uuid") or rw.get("id")) else None


def backfill_descriptions(tg_to_user_id: dict[int, int]) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": False, "updated": 0, "error": None}
    if not is_configured():
        out["error"] = "remnawave_not_configured"
        return out
    try:
        client = remnawave.get_client()  # type: ignore[union-attr]
        start, size = 0, 250
        while True:
            page = client.get_users(start=start, size=size)
            if isinstance(page, dict) and "response" in page:
                page = page["response"]
            users = page.get("users") if isinstance(page, dict) else page
            if not users:
                break
            for u in users:
                try:
                    tg = int(u.get("telegramId") or 0)
                except (TypeError, ValueError):
                    continue
                uid = tg_to_user_id.get(tg) if tg else None
                if not uid or str(u.get("description") or "") == str(uid) or u.get("id") is None:
                    continue
                try:
                    client.update_user(id=int(u["id"]), description=str(uid))
                    out["updated"] += 1
                except Exception:  # noqa: BLE001
                    pass
            start += size
            total = page.get("total") if isinstance(page, dict) else None
            if (total is not None and start >= int(total)) or len(users) < size:
                break
        out["ok"] = True
        return out
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out


def reset_traffic(telegram_id: int, email: Optional[str] = None) -> dict[str, Any]:
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
        # remnawave 3.x ждёт числовой id для reset-traffic
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
        # online/traffic могут быть в userTraffic или на верхнем уровне
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
        num_id = rw.get("id")  # hwid endpoints use numeric id
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


def set_enabled(telegram_id: Optional[int], enabled: bool, email: Optional[str] = None) -> dict[str, Any]:
    if not is_configured():
        return {"ok": False, "error": "remnawave_not_configured"}
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
        if not isinstance(rw, dict) or rw.get("id") is None:
            return {"ok": True, "already_absent": True}
        uid = int(rw["id"])
        if enabled:
            client.enable_user(uid)
        else:
            client.disable_user(uid)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def delete_user(telegram_id: Optional[int], email: Optional[str] = None) -> dict[str, Any]:
    if not is_configured():
        return {"ok": False, "error": "remnawave_not_configured"}
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
            return {"ok": True, "already_absent": True}
        uid = rw.get("id")
        if uid is None:
            uid = rw.get("userId") or rw.get("uuid")
        client.delete_user(int(uid) if str(uid).isdigit() else uid)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def local_fallback_config(short_uuid: str) -> str:
    return ""

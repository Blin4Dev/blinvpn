"""
Remnawave Panel API client — contract 3.4.4

Документация / контракт: @remnawave/backend-contract@3.4.4
Панель на том же сервере: REMWAVE_PANEL_URL=http://127.0.0.1:3000

Env:
  REMWAVE_PANEL_URL | REMNAWAVE_BASE_URL | REMNAWAVE_PANEL_URL
  REMWAVE_API_KEY   | REMNAWAVE_TOKEN    | REMNAWAVE_API_TOKEN
"""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

API_CONTRACT = "3.4.4"

# ─────────────────────────────────────────────────────────────
# Exceptions
# ─────────────────────────────────────────────────────────────


class RemnawaveError(Exception):
    """Базовая ошибка клиента Remnawave."""

    def __init__(self, message: str, *, status: Optional[int] = None, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


class RemnawaveAuthError(RemnawaveError):
    pass


class RemnawaveNotFoundError(RemnawaveError):
    pass


class RemnawaveValidationError(RemnawaveError):
    pass


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────


def _env(*keys: str, default: str = "") -> str:
    for key in keys:
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return default


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | str | None) -> Optional[str]:
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _to_camel(key: str) -> str:
    parts = key.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:])


def camelize(obj: Any) -> Any:
    """Рекурсивно snake_case → camelCase для тела запроса."""
    if isinstance(obj, dict):
        return {_to_camel(k): camelize(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [camelize(x) for x in obj]
    if isinstance(obj, datetime):
        return _iso(obj)
    return obj


def unwrap(data: Any) -> Any:
    """Ответ панели часто обёрнут в {\"response\": ...}."""
    if isinstance(data, dict) and "response" in data and len(data) <= 3:
        return data["response"]
    return data


# ─────────────────────────────────────────────────────────────
# Client
# ─────────────────────────────────────────────────────────────


class RemnawaveAPI:
    """
    Синхронный HTTP-клиент Remnawave Panel API 3.4.4.

    Пример:
        api = RemnawaveAPI()  # из env
        user = api.create_user(username=\"tg_123\", expire_at=_utcnow()+timedelta(days=30),
                               telegram_id=123, active_internal_squads=[squad_uuid])
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        timeout: Optional[float] = None,
        verify_ssl: bool = True,
    ) -> None:
        raw = (
            base_url
            or _env("REMWAVE_PANEL_URL", "REMNAWAVE_BASE_URL", "REMNAWAVE_PANEL_URL", default="http://127.0.0.1:3000")
        )
        self.base_url = raw.rstrip("/")
        self.token = token or _env("REMWAVE_API_KEY", "REMNAWAVE_TOKEN", "REMNAWAVE_API_TOKEN")
        # Короткий таймаут: запросы к Remnawave идут прямо внутри обработки запросов
        # API — при «тормозящей» панели сервер не должен виснуть по 30 секунд.
        if timeout is None:
            try:
                timeout = float(_env("REMWAVE_TIMEOUT", default="10") or 10)
            except ValueError:
                timeout = 10.0
        self.timeout = timeout
        self.verify_ssl = verify_ssl
        if not self.token:
            raise RemnawaveAuthError("Не задан API-токен Remnawave (REMWAVE_API_KEY)")

    # ── low-level ────────────────────────────────────────────

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, Any]] = None,
        json_body: Any = None,
        raw_body: Optional[bytes] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        if not path.startswith("/"):
            path = "/" + path
        url = f"{self.base_url}{path}"
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                # lists → repeated query or JSON-string; Remnawave pagination uses scalars
                qs = urllib.parse.urlencode(
                    {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in clean.items()},
                    doseq=True,
                )
                url = f"{url}?{qs}"

        hdrs = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.token}",
            "X-Api-Contract": API_CONTRACT,
        }
        if headers:
            hdrs.update(headers)

        data: Optional[bytes] = raw_body
        if json_body is not None:
            payload = camelize(json_body)
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            hdrs["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=hdrs, method=method.upper())
        ctx = None
        if url.startswith("https://") and not self.verify_ssl:
            ctx = ssl._create_unverified_context()  # noqa: S323

        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=ctx) as resp:
                body = resp.read()
                if not body or resp.status == 204:
                    return None
                try:
                    parsed = json.loads(body.decode("utf-8"))
                except json.JSONDecodeError:
                    return body.decode("utf-8", errors="replace")
                return unwrap(parsed)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
            try:
                err_payload = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                err_payload = raw
            msg = None
            if isinstance(err_payload, dict):
                msg = err_payload.get("message") or err_payload.get("error") or err_payload.get("detail")
            message = str(msg or raw or e.reason)
            if e.code in (401, 403):
                raise RemnawaveAuthError(message, status=e.code, payload=err_payload) from e
            if e.code == 404:
                raise RemnawaveNotFoundError(message, status=e.code, payload=err_payload) from e
            if e.code == 400:
                raise RemnawaveValidationError(message, status=e.code, payload=err_payload) from e
            raise RemnawaveError(message, status=e.code, payload=err_payload) from e
        except urllib.error.URLError as e:
            raise RemnawaveError(f"Не удалось связаться с Remnawave ({self.base_url}): {e.reason}") from e

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, json_body: Any = None, **kwargs: Any) -> Any:
        return self.request("POST", path, json_body=json_body, **kwargs)

    def patch(self, path: str, json_body: Any = None, **kwargs: Any) -> Any:
        return self.request("PATCH", path, json_body=json_body, **kwargs)

    def put(self, path: str, json_body: Any = None, **kwargs: Any) -> Any:
        return self.request("PUT", path, json_body=json_body, **kwargs)

    def delete(self, path: str, json_body: Any = None, **kwargs: Any) -> Any:
        return self.request("DELETE", path, json_body=json_body, **kwargs)

    # ═════════════════════════════════════════════════════════
    # USERS  (/api/users)
    # ═════════════════════════════════════════════════════════

    def get_users(
        self,
        *,
        start: int = 0,
        size: int = 50,
        filters: Any = None,
        sorting: Any = None,
        **extra: Any,
    ) -> Any:
        params: dict[str, Any] = {"start": start, "size": size, **extra}
        if filters is not None:
            params["filters"] = filters
        if sorting is not None:
            params["sorting"] = sorting
        return self.get("/api/users", params=params)

    def get_user(self, user_id: int) -> Any:
        return self.get(f"/api/users/{user_id}")

    def get_user_by_username(self, username: str) -> Any:
        return self.get(f"/api/users/by-username/{urllib.parse.quote(username, safe='')}")

    def get_user_by_short_uuid(self, short_uuid: str) -> Any:
        return self.get(f"/api/users/by-short-uuid/{urllib.parse.quote(short_uuid, safe='')}")

    def resolve_user(
        self,
        *,
        id: Optional[int] = None,
        uuid: Optional[str] = None,
        short_uuid: Optional[str] = None,
        username: Optional[str] = None,
        telegram_id: Optional[int] = None,
        email: Optional[str] = None,
    ) -> Any:
        """Найти пользователя по любому идентификатору (3.x)."""
        body: dict[str, Any] = {}
        if id is not None:
            body["id"] = id
        if uuid is not None:
            body["uuid"] = uuid
        if short_uuid is not None:
            body["shortUuid"] = short_uuid
        if username is not None:
            body["username"] = username
        if telegram_id is not None:
            body["telegramId"] = telegram_id
        if email is not None:
            body["email"] = email
        return self.post("/api/users/resolve", json_body=body)

    def create_user(
        self,
        *,
        username: str,
        expire_at: datetime | str,
        status: str = "ACTIVE",
        short_uuid: Optional[str] = None,
        trojan_password: Optional[str] = None,
        vless_uuid: Optional[str] = None,
        ss_password: Optional[str] = None,
        traffic_limit_bytes: Optional[int] = None,
        traffic_limit_strategy: str = "NO_RESET",
        description: Optional[str] = None,
        tag: Optional[str] = None,
        telegram_id: Optional[int] = None,
        email: Optional[str] = None,
        hwid_device_limit: Optional[int] = None,
        active_internal_squads: Optional[list[str]] = None,
        external_squad_uuid: Optional[str] = None,
        **extra: Any,
    ) -> Any:
        body: dict[str, Any] = {
            "username": username,
            "expire_at": expire_at,
            "status": status,
            "short_uuid": short_uuid,
            "trojan_password": trojan_password,
            "vless_uuid": vless_uuid,
            "ss_password": ss_password,
            "traffic_limit_bytes": traffic_limit_bytes,
            "traffic_limit_strategy": traffic_limit_strategy,
            "description": description,
            "tag": tag,
            "telegram_id": telegram_id,
            "email": email,
            "hwid_device_limit": hwid_device_limit,
            "active_internal_squads": active_internal_squads,
            "external_squad_uuid": external_squad_uuid,
            **extra,
        }
        return self.post("/api/users", json_body=body)

    def update_user(self, *, id: Optional[int] = None, username: Optional[str] = None, **fields: Any) -> Any:
        body: dict[str, Any] = {**fields}
        if id is not None:
            body["id"] = id
        if username is not None:
            body["username"] = username
        return self.patch("/api/users", json_body=body)

    def delete_user(self, user_id: int) -> Any:
        return self.delete(f"/api/users/{user_id}")

    def enable_user(self, user_id: int) -> Any:
        return self.post(f"/api/users/{user_id}/actions/enable")

    def disable_user(self, user_id: int) -> Any:
        return self.post(f"/api/users/{user_id}/actions/disable")

    def reset_user_traffic(self, user_id: int) -> Any:
        return self.post(f"/api/users/{user_id}/actions/reset-traffic")

    def revoke_user_subscription(self, user_id: int, body: Optional[dict[str, Any]] = None) -> Any:
        return self.post(f"/api/users/{user_id}/actions/revoke", json_body=body or {})

    def extend_user(
        self,
        user_id: int,
        *,
        days: Optional[int] = None,
        hours: Optional[int] = None,
        minutes: Optional[int] = None,
        extend_to: Optional[datetime | str] = None,
        **extra: Any,
    ) -> Any:
        body: dict[str, Any] = {**extra}
        if days is not None:
            body["days"] = days
        if hours is not None:
            body["hours"] = hours
        if minutes is not None:
            body["minutes"] = minutes
        if extend_to is not None:
            body["expire_at"] = extend_to
        return self.post(f"/api/users/{user_id}/actions/extend", json_body=body)

    def get_user_accessible_nodes(self, user_id: int) -> Any:
        return self.get(f"/api/users/{user_id}/accessible-nodes")

    def get_user_subscription_request_history(self, user_id: int) -> Any:
        return self.get(f"/api/users/{user_id}/subscription-request-history")

    def get_users_tags(self) -> Any:
        return self.get("/api/users/tags")

    # bulk users
    def bulk_update_users(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/update", json_body=body)

    def bulk_delete_users(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/delete", json_body=body)

    def bulk_delete_users_by_status(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/delete-by-status", json_body=body)

    def bulk_reset_traffic(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/reset-traffic", json_body=body)

    def bulk_revoke_subscription(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/revoke-subscription", json_body=body)

    def bulk_extend_expiration(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/extend-expiration-date", json_body=body)

    def bulk_update_squads(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/update-squads", json_body=body)

    def bulk_all_update(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/all/update", json_body=body)

    def bulk_all_reset_traffic(self, body: Optional[dict[str, Any]] = None) -> Any:
        return self.post("/api/users/bulk/all/reset-traffic", json_body=body or {})

    def bulk_all_extend(self, body: dict[str, Any]) -> Any:
        return self.post("/api/users/bulk/all/extend-expiration-date", json_body=body)

    # ═════════════════════════════════════════════════════════
    # INTERNAL SQUADS
    # ═════════════════════════════════════════════════════════

    def get_internal_squads(self) -> Any:
        return self.get("/api/internal-squads")

    def get_internal_squad(self, uuid: str) -> Any:
        return self.get(f"/api/internal-squads/{uuid}")

    def create_internal_squad(self, body: dict[str, Any]) -> Any:
        return self.post("/api/internal-squads", json_body=body)

    def update_internal_squad(self, body: dict[str, Any]) -> Any:
        return self.patch("/api/internal-squads", json_body=body)

    def delete_internal_squad(self, uuid: str) -> Any:
        return self.delete(f"/api/internal-squads/{uuid}")

    def get_internal_squad_accessible_nodes(self, uuid: str) -> Any:
        return self.get(f"/api/internal-squads/{uuid}/accessible-nodes")

    def get_internal_squad_usage(self, uuid: str, **params: Any) -> Any:
        return self.get(f"/api/internal-squads/{uuid}/usage", params=params)

    def add_users_to_internal_squad(self, uuid: str) -> Any:
        """Добавить ВСЕХ пользователей в сквад (фоновая операция)."""
        return self.post(f"/api/internal-squads/{uuid}/bulk-actions/add-users")

    def remove_users_from_internal_squad(self, uuid: str) -> Any:
        return self.delete(f"/api/internal-squads/{uuid}/bulk-actions/remove-users")

    def add_many_users_to_internal_squad(self, uuid: str, user_ids: list[int]) -> Any:
        return self.post(
            f"/api/internal-squads/{uuid}/bulk-actions/add-many-users",
            json_body={"user_ids": user_ids},
        )

    def remove_many_users_from_internal_squad(self, uuid: str, user_ids: list[int]) -> Any:
        return self.delete(
            f"/api/internal-squads/{uuid}/bulk-actions/remove-many-users",
            json_body={"user_ids": user_ids},
        )

    def reorder_internal_squads(self, body: dict[str, Any]) -> Any:
        return self.post("/api/internal-squads/actions/reorder", json_body=body)

    def get_internal_squad_tags(self) -> Any:
        return self.get("/api/internal-squads/tags")

    # ═════════════════════════════════════════════════════════
    # EXTERNAL SQUADS
    # ═════════════════════════════════════════════════════════

    def get_external_squads(self) -> Any:
        return self.get("/api/external-squads")

    def get_external_squad(self, uuid: str) -> Any:
        return self.get(f"/api/external-squads/{uuid}")

    def create_external_squad(self, body: dict[str, Any]) -> Any:
        return self.post("/api/external-squads", json_body=body)

    def update_external_squad(self, body: dict[str, Any]) -> Any:
        return self.patch("/api/external-squads", json_body=body)

    def delete_external_squad(self, uuid: str) -> Any:
        return self.delete(f"/api/external-squads/{uuid}")

    def add_users_to_external_squad(self, uuid: str) -> Any:
        return self.post(f"/api/external-squads/{uuid}/bulk-actions/add-users")

    def remove_users_from_external_squad(self, uuid: str) -> Any:
        return self.delete(f"/api/external-squads/{uuid}/bulk-actions/remove-users")

    # ═════════════════════════════════════════════════════════
    # HWID DEVICES
    # ═════════════════════════════════════════════════════════

    def get_hwid_devices(self, **params: Any) -> Any:
        return self.get("/api/hwid/devices", params=params or None)

    def get_user_hwid_devices(self, user_id: int) -> Any:
        return self.get(f"/api/hwid/devices/{user_id}")

    def create_hwid_device(self, body: dict[str, Any]) -> Any:
        return self.post("/api/hwid/devices", json_body=body)

    def delete_hwid_device(self, body: dict[str, Any]) -> Any:
        return self.post("/api/hwid/devices/delete", json_body=body)

    def delete_all_user_hwid_devices(self, body: dict[str, Any]) -> Any:
        return self.post("/api/hwid/devices/delete-all", json_body=body)

    def get_hwid_stats(self) -> Any:
        return self.get("/api/hwid/devices/stats")

    def get_hwid_top_users(self, **params: Any) -> Any:
        return self.get("/api/hwid/devices/top-users", params=params or None)

    # ═════════════════════════════════════════════════════════
    # SUBSCRIPTIONS
    # ═════════════════════════════════════════════════════════

    def get_subscriptions(self, **params: Any) -> Any:
        return self.get("/api/subscriptions", params=params or None)

    def get_subscription_by_user_id(self, user_id: int) -> Any:
        return self.get(f"/api/subscriptions/by-id/{user_id}")

    def get_subscription_by_username(self, username: str) -> Any:
        return self.get(f"/api/subscriptions/by-username/{urllib.parse.quote(username, safe='')}")

    def get_subscription_by_short_uuid(self, short_uuid: str) -> Any:
        return self.get(f"/api/subscriptions/by-short-uuid/{urllib.parse.quote(short_uuid, safe='')}")

    def get_subscription_raw(self, short_uuid: str) -> Any:
        return self.get(f"/api/subscriptions/by-short-uuid/{urllib.parse.quote(short_uuid, safe='')}/raw")

    def get_connection_keys(self, user_id: int) -> Any:
        return self.get(f"/api/subscriptions/connection-keys/{user_id}")

    def get_subpage_config(self, short_uuid: str) -> Any:
        return self.get(f"/api/subscriptions/subpage-config/{urllib.parse.quote(short_uuid, safe='')}")

    def get_public_subscription(self, short_uuid: str) -> Any:
        return self.get(f"/api/sub/{urllib.parse.quote(short_uuid, safe='')}")

    def get_public_subscription_info(self, short_uuid: str) -> Any:
        return self.get(f"/api/sub/{urllib.parse.quote(short_uuid, safe='')}/info")

    # ═════════════════════════════════════════════════════════
    # NODES / HOSTS / CONFIG PROFILES
    # ═════════════════════════════════════════════════════════

    def get_nodes(self) -> Any:
        return self.get("/api/nodes")

    # ── Активные сессии (Remnawave 3.x: /api/connections, раньше /api/ip-control) ──

    def connections_by_node(self, node_uuid: str) -> Any:
        """Запускает задачу «кто подключён к ноде и с каких IP» → {jobId}."""
        return self.post(f"/api/connections/by-node/{node_uuid}")

    def connections_by_node_result(self, job_id: str) -> Any:
        """{isCompleted, isFailed, result: {users: [{userId, ips: [{ip, lastSeen}]}]}}"""
        return self.get(f"/api/connections/by-node/{job_id}")

    def get_node(self, uuid: str) -> Any:
        return self.get(f"/api/nodes/{uuid}")

    def create_node(self, body: dict[str, Any]) -> Any:
        return self.post("/api/nodes", json_body=body)

    def update_node(self, body: dict[str, Any]) -> Any:
        return self.patch("/api/nodes", json_body=body)

    def delete_node(self, uuid: str) -> Any:
        return self.delete(f"/api/nodes/{uuid}")

    def enable_node(self, uuid: str) -> Any:
        return self.post(f"/api/nodes/{uuid}/actions/enable")

    def disable_node(self, uuid: str) -> Any:
        return self.post(f"/api/nodes/{uuid}/actions/disable")

    def restart_node(self, uuid: str, body: Optional[dict[str, Any]] = None) -> Any:
        return self.post(f"/api/nodes/{uuid}/actions/restart", json_body=body or {})

    def restart_all_nodes(self) -> Any:
        return self.post("/api/nodes/actions/restart-all")

    def reset_node_traffic(self, uuid: str) -> Any:
        return self.post(f"/api/nodes/{uuid}/actions/reset-traffic")

    def get_hosts(self) -> Any:
        return self.get("/api/hosts")

    def get_host(self, uuid: str) -> Any:
        return self.get(f"/api/hosts/{uuid}")

    def create_host(self, body: dict[str, Any]) -> Any:
        return self.post("/api/hosts", json_body=body)

    def update_host(self, body: dict[str, Any]) -> Any:
        return self.patch("/api/hosts", json_body=body)

    def delete_host(self, uuid: str) -> Any:
        return self.delete(f"/api/hosts/{uuid}")

    def get_config_profiles(self) -> Any:
        return self.get("/api/config-profiles")

    def get_config_profile(self, uuid: str) -> Any:
        return self.get(f"/api/config-profiles/{uuid}")

    def get_config_profile_inbounds(self, uuid: str) -> Any:
        return self.get(f"/api/config-profiles/{uuid}/inbounds")

    def get_all_inbounds(self) -> Any:
        return self.get("/api/config-profiles/inbounds")

    # ═════════════════════════════════════════════════════════
    # SYSTEM / STATS / BANDWIDTH
    # ═════════════════════════════════════════════════════════

    def health(self) -> Any:
        return self.get("/api/system/health")

    def system_stats(self) -> Any:
        return self.get("/api/system/stats")

    def bandwidth_stats(self) -> Any:
        return self.get("/api/system/stats/bandwidth")

    def nodes_stats(self) -> Any:
        return self.get("/api/system/stats/nodes")

    def nodes_metrics(self) -> Any:
        return self.get("/api/system/nodes/metrics")

    def stats_recap(self) -> Any:
        return self.get("/api/system/stats/recap")

    def stats_digest(self) -> Any:
        return self.get("/api/system/stats/digest")

    def system_metadata(self) -> Any:
        return self.get("/api/system/metadata")

    def system_configuration(self) -> Any:
        return self.get("/api/system/configuration")

    def generate_x25519(self) -> Any:
        return self.get("/api/system/tools/x25519/generate")

    def get_user_bandwidth(self, user_id: int, **params: Any) -> Any:
        return self.get(f"/api/bandwidth-stats/users/{user_id}", params=params or None)

    def get_node_bandwidth(self, **params: Any) -> Any:
        return self.get("/api/bandwidth-stats/nodes", params=params or None)

    def get_internal_squad_bandwidth(self, uuid: str, **params: Any) -> Any:
        return self.get(f"/api/bandwidth-stats/internal-squads/{uuid}/usage", params=params or None)

    # ═════════════════════════════════════════════════════════
    # METADATA
    # ═════════════════════════════════════════════════════════

    def get_user_metadata(self, user_id: int) -> Any:
        return self.get(f"/api/metadata/user/{user_id}")

    def upsert_user_metadata(self, user_id: int, body: dict[str, Any]) -> Any:
        return self.put(f"/api/metadata/user/{user_id}", json_body=body)

    def get_node_metadata(self, uuid: str) -> Any:
        return self.get(f"/api/metadata/node/{uuid}")

    def upsert_node_metadata(self, uuid: str, body: dict[str, Any]) -> Any:
        return self.put(f"/api/metadata/node/{uuid}", json_body=body)

    # ═════════════════════════════════════════════════════════
    # BlinVPN helpers
    # ═════════════════════════════════════════════════════════

    def list_squads_simple(self) -> list[dict[str, str]]:
        """Список internal squads в формате панели BlinVPN: [{uuid, name}]."""
        data = self.get_internal_squads()
        items = data
        if isinstance(data, dict):
            items = data.get("internalSquads") or data.get("squads") or data.get("items") or []
        result: list[dict[str, str]] = []
        for s in items or []:
            if not isinstance(s, dict):
                continue
            uuid = str(s.get("uuid") or s.get("squadUuid") or "")
            name = str(s.get("name") or s.get("squadName") or uuid)
            if uuid:
                result.append({"uuid": uuid, "name": name})
        return result

    def find_user_by_telegram(self, telegram_id: int) -> Optional[dict[str, Any]]:
        try:
            user = self.resolve_user(telegram_id=telegram_id)
            if isinstance(user, dict):
                return user
        except RemnawaveNotFoundError:
            return None
        except RemnawaveValidationError:
            # fallback: страницами (медленно, только если resolve не умеет telegramId)
            start = 0
            size = 100
            while True:
                page = self.get_users(start=start, size=size)
                users = page.get("users") if isinstance(page, dict) else page
                if not users:
                    break
                for u in users:
                    if int(u.get("telegramId") or u.get("telegram_id") or 0) == int(telegram_id):
                        return u
                if isinstance(page, dict) and page.get("total") is not None:
                    start += size
                    if start >= int(page["total"]):
                        break
                else:
                    if len(users) < size:
                        break
                    start += size
            return None
        return None

    def ensure_user(
        self,
        *,
        telegram_id: int,
        username: Optional[str] = None,
        days: int = 30,
        traffic_limit_bytes: int = 0,
        hwid_device_limit: int = 1,
        squad_uuids: Optional[Iterable[str]] = None,
        email: Optional[str] = None,
        description: Optional[str] = None,
        status: str = "ACTIVE",
    ) -> dict[str, Any]:
        """
        Создать или обновить пользователя Remnawave под Telegram ID.
        Возвращает объект пользователя панели (с id / shortUuid / subscriptionUrl и т.п.).
        """
        squads = list(squad_uuids or [])
        uname = username or f"tg_{telegram_id}"
        # username в Remnawave: [a-zA-Z0-9_-], обычно lowercase
        uname = "".join(c if c.isalnum() or c in "_-" else "_" for c in uname)[:36] or f"tg_{telegram_id}"

        existing = self.find_user_by_telegram(telegram_id)
        expire = _utcnow() + timedelta(days=max(1, days))

        if existing:
            uid = int(existing.get("id") or existing.get("userId"))
            patch: dict[str, Any] = {
                "id": uid,
                "status": status,
                "expire_at": expire,
                "hwid_device_limit": hwid_device_limit,
            }
            if traffic_limit_bytes:
                patch["traffic_limit_bytes"] = traffic_limit_bytes
            if squads:
                patch["active_internal_squads"] = squads
            if email is not None:
                patch["email"] = email
            if description is not None:
                patch["description"] = description
            return self.update_user(**patch)

        return self.create_user(
            username=uname,
            expire_at=expire,
            status=status,
            telegram_id=telegram_id,
            email=email,
            description=description,
            traffic_limit_bytes=traffic_limit_bytes or None,
            hwid_device_limit=hwid_device_limit,
            active_internal_squads=squads or None,
        )

    def subscription_url_for(self, user: dict[str, Any], public_base: Optional[str] = None) -> Optional[str]:
        """Собрать URL подписки (Happ / v2raytun и т.п.)."""
        short = user.get("shortUuid") or user.get("short_uuid")
        if not short:
            return None
        # Иногда панель уже отдаёт готовый URL
        for key in ("subscriptionUrl", "subscription_url", "happUrl", "happ_url"):
            if user.get(key):
                return str(user[key])
        base = (public_base or self.base_url).rstrip("/")
        return f"{base}/api/sub/{short}"

    def ping(self) -> bool:
        try:
            self.health()
            return True
        except RemnawaveError:
            return False


# Singleton convenience
_default: Optional[RemnawaveAPI] = None


def get_client() -> RemnawaveAPI:
    global _default
    if _default is None:
        _default = RemnawaveAPI()
    return _default


def reset_client() -> None:
    global _default
    _default = None


# Back-compat alias
Remnawave = RemnawaveAPI

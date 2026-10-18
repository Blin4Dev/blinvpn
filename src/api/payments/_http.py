"""общий HTTP для клиентов платёжек (urllib, JSON)."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class GatewayError(Exception):
    def __init__(self, message: str, *, status: Optional[int] = None, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


def _error_text(payload: Any, raw: str) -> str:
    if isinstance(payload, dict):
        for k in ("description", "message", "error", "detail", "errors"):
            v = payload.get(k)
            if v:
                return json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v)
    return raw[:300]


def request(method: str, url: str, *, headers: dict[str, str], body: Optional[bytes] = None,
            params: Optional[dict[str, Any]] = None, timeout: float = 30.0, name: str = "платёжка",
            error_cls: type = GatewayError) -> Any:
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    req = urllib.request.Request(url, data=body, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        try:
            payload: Any = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = raw
        raise error_cls(_error_text(payload, raw) or str(e.reason), status=e.code, payload=payload) from e
    except urllib.error.URLError as e:
        raise error_cls(f"Не удалось связаться с {name}: {e.reason}") from e
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise error_cls(f"Некорректный ответ {name}", payload=raw) from e

"""
Балансировщик подписки XBM (Xray Balancer Middleware, автор — Haxonate) —
панель → «Балансировщик».

XBM стоит между клиентами и Remnawave: забирает подписку из панели Remnawave и
собирает из неё то, что видит пользователь. Через XBM идёт только подписка, не трафик.

Модель:
  • хосты Remnawave (de1, de2, …) — «сырьё» для XBM, пользователю напрямую не видны;
  • по умолчанию в подписке ОДНА строка — «Авто-выбор» из всех хостов Remnawave;
  • «хосты панели» — строки подписки, которые видит пользователь (например,
    «🇩🇪 Германия» из de1…de4): клиент держит хост с меньшим пингом;
  • хост панели «белые списки»: в авто-выборе (и внутри себя) его хосты — резерв,
    подключаются, только если ни один обычный не отвечает;
  • описание (meta.serverDescription) и шаблон Xray JSON из Remnawave — по желанию,
    иначе у каждого хоста Remnawave остаются его собственные настройки.

Хосты выбираются по UUID, а в panel.json попадают их ТЕКУЩИЕ названия —
после переименования хоста в Remnawave файл пересобирается (сверка раз в минуту).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

SETTINGS_KEY = "xbm_settings"
DEFAULT_AUTO_NAME = "🇪🇺 Автоматический выбор"
MAX_NAME = 64
MAX_DESCRIPTION = 30       # Happ показывает описание до 30 символов
MAX_GROUPS = 100
MAX_TEMPLATE_BYTES = 256 * 1024
UUID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")

_state_lock = threading.Lock()
# Сохранение из панели и фоновая сверка не должны перемешиваться: иначе сверка могла бы
# записать в panel.json настройки, которые сохранение тут же откатит.
save_lock = threading.RLock()
# Последние удачно скачанные шаблоны: если Remnawave временно не отдаёт шаблоны,
# хосты всё равно пересобираются, а выбранные шаблоны берутся отсюда.
_tpl_cache: dict[str, dict[str, Any]] = {}
_last_sync: dict[str, Any] = {"at": None, "ok": None, "error": None, "warnings": []}


class XbmError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def xbm_url() -> str:
    """Адрес XBM изнутри сервера (контейнеры BlinVPN — в сети хоста)."""
    port = (os.getenv("XBM_PORT") or "4100").strip()
    if not port.isdigit():
        port = "4100"
    return (os.getenv("XBM_URL") or f"http://127.0.0.1:{port}").rstrip("/")


def state_dir() -> str:
    base = os.getenv("XBM_STATE_DIR") or os.path.join(os.path.dirname(os.path.abspath(db.get_db_path())), "xbm")
    return base


def panel_json_path() -> str:
    return os.path.join(state_dir(), "panel.json")


def _tpl_cache_path() -> str:
    return os.path.join(state_dir(), "templates-cache.json")


def _load_tpl_cache() -> dict[str, dict[str, Any]]:
    if not _tpl_cache:
        try:
            with open(_tpl_cache_path(), encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                _tpl_cache.update({k: v for k, v in data.items() if UUID_RE.fullmatch(str(k)) and isinstance(v, dict)})
        except (OSError, ValueError):
            pass
    return _tpl_cache


def _save_tpl_cache(tpls: dict[str, dict[str, Any]]) -> None:
    if not tpls or all(_tpl_cache.get(k) == v for k, v in tpls.items()):
        return
    _tpl_cache.update(tpls)
    try:
        path = _tpl_cache_path()
        tmp = f"{path}.{secrets.token_hex(4)}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_tpl_cache, f, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError:
        pass


# ─────────────────────────────────────────────────────────────
# Настройки
# ─────────────────────────────────────────────────────────────

def _clean(v: Any, max_len: int) -> str:
    return _CTRL_RE.sub("", str(v or "")).strip()[:max_len]


def _uuid_or_none(v: Any) -> Optional[str]:
    v = str(v or "").strip()
    return v if UUID_RE.fullmatch(v) else None


def default_settings() -> dict[str, Any]:
    return {"auto_group_name": DEFAULT_AUTO_NAME, "auto_template_uuid": None, "groups": []}


def get_settings() -> dict[str, Any]:
    raw = db.get_setting(SETTINGS_KEY, "")
    out = default_settings()
    if not raw:
        return out
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return out
    if not isinstance(data, dict):
        return out
    if isinstance(data.get("auto_group_name"), str) and data["auto_group_name"]:
        out["auto_group_name"] = data["auto_group_name"]
    out["auto_template_uuid"] = _uuid_or_none(data.get("auto_template_uuid"))
    groups = []
    for g in data.get("groups") or []:
        if not isinstance(g, dict) or not g.get("name"):
            continue
        groups.append({
            "id": str(g.get("id") or secrets.token_hex(4)),
            "name": str(g["name"]),
            "hosts": [str(u) for u in g.get("hosts") or []],
            "whitelist": bool(g.get("whitelist")),
            "description": str(g.get("description") or ""),
            "template_uuid": _uuid_or_none(g.get("template_uuid")),
        })
    out["groups"] = groups
    return out


def configured() -> bool:
    return bool(db.get_setting(SETTINGS_KEY, ""))


def validate(body: dict[str, Any], hosts: list[dict[str, Any]],
             templates: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
    """
    Проверить настройки из панели против текущих хостов Remnawave.
    templates — шаблоны XRAY_JSON из Remnawave (None — не удалось получить:
    тогда выбрать шаблон нельзя, а уже выбранные сохраняются как были).
    """
    if not isinstance(body, dict):
        raise XbmError("Неверный формат настроек")
    by_uuid = {h["uuid"]: h for h in hosts}
    dup = set(duplicate_remarks(hosts))
    tpl_ids = {t["uuid"] for t in templates} if templates is not None else None
    prev = get_settings()
    prev_tpls = {prev.get("auto_template_uuid")} | {g.get("template_uuid") for g in prev["groups"]}

    def check_tpl(v: Any, where: str) -> Optional[str]:
        if v in (None, ""):
            return None
        u = _uuid_or_none(v)
        if not u:
            raise XbmError(f"Неверный шаблон ({where})")
        if tpl_ids is None:
            if u in prev_tpls:
                return u  # Remnawave сейчас не отдаёт шаблоны — оставляем, что было
            raise XbmError("Не удалось получить шаблоны из Remnawave — выбрать шаблон сейчас нельзя")
        if u not in tpl_ids:
            raise XbmError(f"Шаблон ({where}) не найден в Remnawave или это не Xray JSON")
        return u

    name = _clean(body.get("auto_group_name"), MAX_NAME + 1)
    if not name:
        raise XbmError("Название авто-выбора не может быть пустым")
    if len(name) > MAX_NAME:
        raise XbmError(f"Название авто-выбора — до {MAX_NAME} символов")
    auto_tpl = check_tpl(body.get("auto_template_uuid"), "авто-выбор")

    groups: list[dict[str, Any]] = []
    raw_groups = body.get("groups") or []
    if not isinstance(raw_groups, list):
        raise XbmError("Неверный формат хостов панели")
    if len(raw_groups) > MAX_GROUPS:
        raise XbmError(f"Не больше {MAX_GROUPS} хостов в панели")
    used_names: set[str] = {name.casefold()}
    used_hosts: dict[str, str] = {}
    used_ids: set[str] = set()
    for g in raw_groups:
        if not isinstance(g, dict):
            raise XbmError("Неверный формат хоста панели")
        gname = _clean(g.get("name"), MAX_NAME + 1)
        if not gname:
            raise XbmError("У каждого хоста панели должно быть название")
        if len(gname) > MAX_NAME:
            raise XbmError(f"Название «{gname[:20]}…» длиннее {MAX_NAME} символов")
        if gname.casefold() in used_names:
            raise XbmError(f"Название «{gname}» уже занято (авто-выбор или другой хост панели)")
        raw_members = g.get("hosts") or []
        if not isinstance(raw_members, list):
            raise XbmError("Неверный формат списка хостов Remnawave")
        members: list[str] = []
        for u in raw_members[:1000]:
            u = str(u)
            if u in by_uuid and u not in members:
                members.append(u)
        if not members:
            raise XbmError(f"В «{gname}» не выбран ни один хост Remnawave")
        for u in members:
            h = by_uuid[u]
            if u in used_hosts:
                raise XbmError(f"Хост Remnawave «{h['remark']}» уже в «{used_hosts[u]}» — хост может входить только в один хост панели")
            if h["remark"] in dup and not h["disabled"]:
                raise XbmError(f"В Remnawave несколько хостов с названием «{h['remark']}» — переименуйте их, иначе XBM их перепутает")
            used_hosts[u] = gname
        desc = _clean(g.get("description"), MAX_DESCRIPTION + 1)
        if len(desc) > MAX_DESCRIPTION:
            raise XbmError(f"Описание «{gname}» — до {MAX_DESCRIPTION} символов (столько показывает Happ)")
        gid = str(g.get("id") or "")
        if not re.fullmatch(r"[a-z0-9]{6,16}", gid) or gid in used_ids:
            gid = secrets.token_hex(4)
        used_ids.add(gid)
        used_names.add(gname.casefold())
        groups.append({
            "id": gid, "name": gname, "hosts": members, "whitelist": bool(g.get("whitelist")),
            "description": desc, "template_uuid": check_tpl(g.get("template_uuid"), gname),
        })
    return {"auto_group_name": name, "auto_template_uuid": auto_tpl, "groups": groups}


def save_settings(s: dict[str, Any]) -> None:
    db.set_setting(SETTINGS_KEY, json.dumps(s, ensure_ascii=False))


def used_template_uuids(settings: dict[str, Any]) -> list[str]:
    out = []
    for u in [settings.get("auto_template_uuid")] + [g.get("template_uuid") for g in settings.get("groups") or []]:
        if u and u not in out:
            out.append(u)
    return out


# ─────────────────────────────────────────────────────────────
# Хосты и шаблоны Remnawave → panel.json
# ─────────────────────────────────────────────────────────────

def _unwrap(raw: Any) -> Any:
    return raw.get("response") if isinstance(raw, dict) and "response" in raw else raw


def normalize_hosts(raw: Any) -> list[dict[str, Any]]:
    """Хосты из ответа Remnawave в порядке панели."""
    items = _unwrap(raw)
    if isinstance(items, dict):
        items = items.get("hosts") or items.get("items") or []
    out = []
    for h in items or []:
        if not isinstance(h, dict) or not h.get("uuid"):
            continue
        out.append({
            "uuid": str(h["uuid"]),
            "remark": str(h.get("remark") or h.get("tag") or h.get("address") or ""),
            "address": str(h.get("address") or ""),
            "port": h.get("port"),
            "disabled": bool(h.get("isDisabled")),
            "hidden": bool(h.get("isHidden")),
            "description": str(h.get("serverDescription") or ""),
            "view_position": h.get("viewPosition"),
        })
    if any(isinstance(h.get("view_position"), int) for h in out):
        out.sort(key=lambda h: (h["view_position"] if isinstance(h["view_position"], int) else 10 ** 9))
    return out


def normalize_templates(raw: Any) -> list[dict[str, Any]]:
    """Шаблоны подписки из Remnawave: только Xray JSON (другие форматы XBM не применяет)."""
    data = _unwrap(raw)
    items = data.get("templates") if isinstance(data, dict) else data
    out = []
    for t in items or []:
        if not isinstance(t, dict) or not _uuid_or_none(t.get("uuid")):
            continue
        if str(t.get("templateType") or "").upper() != "XRAY_JSON":
            continue
        out.append({"uuid": str(t["uuid"]), "name": str(t.get("name") or "")[:100],
                    "view_position": t.get("viewPosition"),
                    "json": t.get("templateJson") if isinstance(t.get("templateJson"), dict) else None})
    out.sort(key=lambda t: (t["view_position"] if isinstance(t["view_position"], int) else 10 ** 9, t["name"]))
    return out


def resolve_templates(uuids: list[str], listing: list[dict[str, Any]],
                      fetch_one: Callable[[str], Any]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """uuid → Xray JSON шаблона. Второе значение — uuid, которых в Remnawave больше нет."""
    by = {t["uuid"]: t for t in listing}
    out: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for u in uuids:
        t = by.get(u)
        if not t:
            missing.append(u)
            continue
        js = t.get("json")
        if js is None:
            full = _unwrap(fetch_one(u))
            js = full.get("templateJson") if isinstance(full, dict) else None
        if isinstance(js, str):
            try:
                js = json.loads(js)
            except ValueError:
                js = None
        if not isinstance(js, dict) or len(json.dumps(js, ensure_ascii=False)) > MAX_TEMPLATE_BYTES:
            missing.append(u)
            continue
        out[u] = js
    return out, missing


def duplicate_remarks(hosts: list[dict[str, Any]]) -> list[str]:
    seen: dict[str, int] = {}
    for h in hosts:
        if not h["disabled"]:
            seen[h["remark"]] = seen.get(h["remark"], 0) + 1
    return sorted(r for r, n in seen.items() if n > 1)


def render(settings: dict[str, Any], hosts: list[dict[str, Any]],
           templates: Optional[dict[str, dict[str, Any]]] = None) -> dict[str, Any]:
    """Настройки (по UUID) → panel.json для XBM (по текущим названиям хостов)."""
    templates = templates or {}
    remark = {h["uuid"]: h["remark"] for h in hosts if not h["disabled"] and h["remark"]}
    groups = []
    reserve: list[str] = []
    for g in settings.get("groups") or []:
        tags = [remark[u] for u in g.get("hosts") or [] if u in remark]
        if not tags:
            continue  # все хосты выключены/удалены в Remnawave — строки в подписке не будет
        item: dict[str, Any] = {"name": g["name"], "tags": tags}
        if g.get("description"):
            item["description"] = g["description"]
        tpl = templates.get(g.get("template_uuid") or "")
        if tpl:
            item["template"] = tpl
        groups.append(item)
        if g.get("whitelist"):
            reserve += [t for t in tags if t not in reserve]
    return {
        "version": 2,
        "only_groups": True,
        "auto_group_name": settings.get("auto_group_name") or DEFAULT_AUTO_NAME,
        "auto_template": templates.get(settings.get("auto_template_uuid") or "") or None,
        "reserve_tags": reserve,
        "auto_exclude_tags": [],
        "groups": groups,
    }


def write_panel_json(doc: dict[str, Any]) -> bool:
    """Атомарно записать panel.json. True — если содержимое изменилось."""
    body = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True)
    path = panel_json_path()
    with _state_lock:
        try:
            with open(path, "r", encoding="utf-8") as f:
                if f.read() == body:
                    return False
        except OSError:
            pass
        os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
        tmp = f"{path}.{secrets.token_hex(4)}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(body)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o644)  # XBM в своём контейнере читает под другим пользователем
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return True


def sync(fetch_hosts: Callable[[], Any],
         fetch_templates: Optional[Callable[[], Any]] = None,
         fetch_template: Optional[Callable[[str], Any]] = None,
         hosts: Optional[list[dict[str, Any]]] = None, strict: bool = False) -> dict[str, Any]:
    """
    Забрать хосты (и нужные шаблоны) из Remnawave и пересобрать panel.json.
    Если Remnawave не отдала хосты — файл не трогаем (XBM работает по-прежнему).
    strict (сохранение из панели) — выбранный шаблон обязан скачаться, иначе ошибка.
    """
    try:
        with save_lock:
            settings = get_settings()
            if hosts is None:
                hosts = normalize_hosts(fetch_hosts())
            warnings: list[str] = []
            tpls: dict[str, dict[str, Any]] = {}
            need = used_template_uuids(settings)
            if need:
                try:
                    if not fetch_templates or not fetch_template:
                        raise XbmError("Шаблоны Remnawave недоступны", 503)
                    tpls, missing = resolve_templates(need, normalize_templates(fetch_templates()), fetch_template)
                    _save_tpl_cache(tpls)
                    if missing and strict:
                        raise XbmError("Не удалось получить выбранный шаблон из Remnawave (удалён или не Xray JSON)", 502)
                    if missing:
                        warnings.append("Выбранный шаблон удалён в Remnawave или это не Xray JSON — "
                                        "используются настройки хостов из Remnawave")
                except Exception:  # noqa: BLE001 — Remnawave не отдала шаблоны: берём последние удачные
                    cache = _load_tpl_cache()
                    tpls = {u: cache[u] for u in need if u in cache}
                    if strict and len(tpls) != len(need):
                        raise XbmError("Не удалось получить выбранный шаблон из Remnawave — попробуйте ещё раз", 502)
                    warnings.append("Remnawave сейчас не отдаёт шаблоны — используются последние полученные"
                                    + ("" if len(tpls) == len(need) else "; для части строк шаблона нет, берутся настройки хостов"))
            changed = write_panel_json(render(settings, hosts, tpls))
            _last_sync.update(at=time.time(), ok=True, error=None, warnings=warnings)
            return {"ok": True, "changed": changed, "hosts": hosts}
    except Exception as exc:  # noqa: BLE001
        msg = exc.message if isinstance(exc, XbmError) else f"{type(exc).__name__}: {exc}"
        _last_sync.update(at=time.time(), ok=False, error=msg[:300])
        raise


def ensure_default_file() -> None:
    """
    panel.json ещё нет (Remnawave не настроена или не ответила) — пишем настройки без
    хостов: пользователи видят только авто-выбор, а не все хосты Remnawave подряд.
    """
    if os.path.exists(panel_json_path()):
        return
    with save_lock:
        write_panel_json(render(get_settings(), [], {}))


def last_sync() -> dict[str, Any]:
    out = dict(_last_sync)
    out["warnings"] = list(out.get("warnings") or [])
    return out


# ─────────────────────────────────────────────────────────────
# XBM: статус и предпросмотр
# ─────────────────────────────────────────────────────────────

def _get(url: str, headers: Optional[dict[str, str]] = None, timeout: float = 8.0) -> tuple[int, str]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — адрес задаёт только .env
            return r.status, r.read(4 * 1024 * 1024).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read(4096) or b"").decode("utf-8", "replace")


def health() -> dict[str, Any]:
    try:
        code, body = _get(f"{xbm_url()}/health", timeout=3.0)
        return {"running": code == 200 and '"ok"' in body}
    except Exception as exc:  # noqa: BLE001
        return {"running": False, "error": type(exc).__name__}


def _is_placeholder(cfgs: list[Any]) -> bool:
    """Заглушка Remnawave: все прокси-выходы — 0.0.0.0:1."""
    total = fake = 0
    for c in cfgs:
        for o in (c.get("outbounds") or []) if isinstance(c, dict) else []:
            if not isinstance(o, dict) or o.get("protocol") in ("freedom", "blackhole", "dns", "loopback"):
                continue
            st = o.get("settings") or {}
            srv = ((st.get("vnext") or st.get("servers") or [{}]) or [{}])[0] or {}
            total += 1
            if srv.get("address") == "0.0.0.0" and srv.get("port") == 1:
                fake += 1
    return total > 0 and total == fake


def preview(short_uuid: str, ua: str = "Happ/1.0", hwid: Optional[str] = None) -> list[dict[str, Any]]:
    """
    Как подписку увидит клиент (по умолчанию — Happ): локации и их сервера.
    hwid — ID уже привязанного устройства пользователя (если есть): при лимите устройств
    Remnawave без него отдала бы заглушку. Новый HWID не придумываем — иначе
    предпросмотр засчитался бы пользователю как новое устройство.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,128}", short_uuid or ""):
        raise XbmError("Неверная ссылка подписки")
    headers = {"User-Agent": ua}
    if hwid and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", hwid):
        headers["X-HWID"] = hwid
    code, body = _get(f"{xbm_url()}/{short_uuid}", headers)
    if code == 429:
        raise XbmError("XBM ограничивает частоту запросов — повторите через минуту", 429)
    if code != 200:
        raise XbmError(f"XBM ответил {code}", 502)
    try:
        cfgs = json.loads(body)
    except ValueError:
        raise XbmError("XBM вернул не Xray JSON — проверьте Response Rules в Remnawave", 502)
    if not isinstance(cfgs, list):
        cfgs = [cfgs]
    if _is_placeholder(cfgs):
        raise XbmError("Remnawave отдала заглушку (лимит устройств, подписка неактивна или нужен HWID) — выберите другого пользователя", 409)
    out = []
    for c in cfgs:
        if not isinstance(c, dict):
            continue
        obs = c.get("outbounds") or []
        servers = [o.get("tag") for o in obs if isinstance(o, dict) and o.get("protocol") not in ("freedom", "blackhole", "dns", "loopback") and o.get("tag")]
        reserve: list[str] = []
        main: list[str] = []
        for b in ((c.get("routing") or {}).get("balancers") or []):
            tag = str(b.get("tag") or "")
            if tag.endswith("-lte-balancer"):
                reserve = list(b.get("selector") or [])
            elif tag.endswith("-balancer") and not re.search(r"-(all|tier2|sticky)-balancer$", tag):
                main = list(b.get("selector") or [])
        out.append({
            "name": c.get("remarks") or "",
            "description": ((c.get("meta") or {}).get("serverDescription") or ""),
            "servers": main or servers,
            "reserve": reserve,
        })
    return out


# ─────────────────────────────────────────────────────────────
# Помощник на сервере (src/core/host_runner.py, systemd blinvpn-host):
# панель кладёт задание в data/host/jobs, помощник пишет результат в data/host/results
# ─────────────────────────────────────────────────────────────

HOST_ACTIONS = ("status", "xbm_install", "xbm_connect", "xbm_disconnect", "xbm_stop")


def _host_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(db.get_db_path())), "host")


def runner_alive() -> bool:
    try:
        with open(os.path.join(_host_dir(), "heartbeat"), encoding="utf-8") as f:
            t = f.read(64).strip()
        from datetime import datetime, timezone
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(t)).total_seconds()
        return age < 30
    except (OSError, ValueError):
        return False


def submit_job(action: str, params: Optional[dict[str, Any]] = None) -> str:
    if action not in HOST_ACTIONS:
        raise XbmError("Неизвестное действие")
    if not runner_alive():
        raise XbmError("Помощник на сервере не запущен — обновите BlinVPN командой sudo bash install.sh", 503)
    jobs = os.path.join(_host_dir(), "jobs")
    try:
        pending = [n for n in os.listdir(jobs) if n.endswith(".json")]
    except OSError:
        raise XbmError("Помощник на сервере не запущен — обновите BlinVPN командой sudo bash install.sh", 503)
    if len(pending) >= 3:
        raise XbmError("Подождите — предыдущее действие ещё выполняется", 429)
    jid = secrets.token_hex(8)
    body = json.dumps({"action": action, "params": params or {}}, ensure_ascii=False)
    if len(body) > 4000:
        raise XbmError("Слишком длинные параметры")
    tmp = os.path.join(jobs, f".{jid}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(body)
    os.replace(tmp, os.path.join(jobs, f"{jid}.json"))
    return jid


def job_result(jid: str) -> dict[str, Any]:
    if not re.fullmatch(r"[a-f0-9]{16}", jid or ""):
        raise XbmError("Неверный номер задания", 404)
    path = os.path.join(_host_dir(), "results", f"{jid}.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"id": jid, "status": "queued", "log": []}
    except (OSError, ValueError):
        return {"id": jid, "status": "running", "log": []}
    return {k: data.get(k) for k in ("id", "status", "log", "result", "error", "started_at", "finished_at")}


def sample_short_uuid() -> Optional[str]:
    r = db.fetchone("SELECT short_uuid FROM subscriptions WHERE status = 'Active' AND short_uuid IS NOT NULL "
                    "AND short_uuid != '' ORDER BY id DESC LIMIT 1")
    return str(r["short_uuid"]) if r else None


def response_rules_text() -> str:
    for p in ("/app/xbm/response-rules.json",
              os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "xbm", "response-rules.json")):
        try:
            with open(p, encoding="utf-8") as f:
                return f.read(200_000)
        except OSError:
            continue
    return ""

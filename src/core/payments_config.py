# платёжные системы: ключи из панели (Настройки → Платежи) и способы оплаты.
#
# Способ оплаты (СБП, карта, звёзды, криптовалюта) включается целиком, а внутри него —
# список платёжек по приоритету: новый платёж создаётся через первую рабочую, при сбое —
# через следующую. Платёжку можно выключить в отдельном способе, не трогая остальные.
#
# Если в панели ничего не сохраняли — работает как раньше: Platega из .env для СБП и карты,
# звёзды по TELEGRAM_BOT_TOKEN, крипта выключена.
#
# В панели вводятся только обязательные ключи. Адреса API можно переопределить в .env
# (<PROVIDER>_API_URL), остальное берётся из API платёжки.
from __future__ import annotations

import json
import os
import sys as _sys
import time
from typing import Any, Optional

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

_API_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
if os.path.isdir(_API_DIR) and _API_DIR not in _sys.path:
    _sys.path.insert(0, _API_DIR)

from payments import (  # noqa: E402
    cispay, heleket, lava, pay2328, paypalych, platega, rollypay, stars, wata, yookassa,
)

SETTINGS_KEY = "payments_config"

# ── описание платёжек ────────────────────────────────────────────
# поле: name, label, type (text | secret | bool), required, env, hint, placeholder, show_if


def _f(name: str, label: str, type_: str = "text", *, required: bool = False, env: str = "", default: Any = "",
       hint: str = "", placeholder: str = "", show_if: Optional[str] = None) -> dict[str, Any]:
    return {"name": name, "label": label, "type": type_, "required": required, "env": env, "default": default,
            "hint": hint, "placeholder": placeholder, "show_if": show_if}


# скрытые настройки: только .env (в панели их нет)
HIDDEN: dict[str, dict[str, tuple[str, Any]]] = {
    "platega": {"api_url": ("PLATEGA_API_URL", "https://app.platega.io")},
    "cispay": {"api_url": ("CISPAY_API_URL", cispay.DEFAULT_API_URL)},
    "yookassa": {"api_url": ("YOOKASSA_API_URL", yookassa.DEFAULT_API_URL)},
    "lava": {"api_url": ("LAVA_API_URL", lava.DEFAULT_API_URL), "min_amount": ("LAVA_MIN_AMOUNT", 10)},
    "paypalych": {"api_url": ("PAYPALYCH_API_URL", paypalych.DEFAULT_API_URL), "min_amount": ("PAYPALYCH_MIN_AMOUNT", 10)},
    "rollypay": {"api_url": ("ROLLYPAY_API_URL", rollypay.DEFAULT_API_URL), "min_amount": ("ROLLYPAY_MIN_AMOUNT", 10)},
    "wata": {"api_url": ("WATA_API_URL", wata.DEFAULT_API_URL), "min_amount": ("WATA_MIN_AMOUNT", 10)},
    "heleket": {"api_url": ("HELEKET_API_URL", heleket.DEFAULT_API_URL), "min_amount": ("HELEKET_MIN_AMOUNT", 10)},
    "pay2328": {"api_url": ("PAY2328_API_URL", pay2328.DEFAULT_API_URL), "min_amount": ("PAY2328_MIN_AMOUNT", 10)},
}

SPECS: dict[str, dict[str, Any]] = {
    "platega": {
        "label": "Platega", "webhook": "/platega", "webhook_label": "Callback URL для кабинета Platega",
        "refunds": True, "note": "Карта от 50 ₽, СБП от 10 ₽ · возвраты из панели",
        "fields": [
            _f("merchant_id", "Merchant ID", required=True, env="PLATEGA_MERCHANT_ID"),
            _f("secret", "Secret", "secret", required=True, env="PLATEGA_SECRET_KEY"),
        ],
    },
    "cispay": {
        "label": "cisPay", "webhook": "/cispay", "webhook_label": "Webhook URL для кабинета cisPay",
        "refunds": True, "testable": True, "note": "Карта от 50 ₽, СБП без минимума · возвраты из панели",
        "fields": [
            _f("shop_id", "Shop ID", required=True, env="CISPAY_SHOP_ID", placeholder="UUID магазина"),
            _f("api_key", "API-ключ", "secret", required=True, env="CISPAY_API_KEY", placeholder="cis_sec_…"),
        ],
    },
    "yookassa": {
        "label": "ЮKassa", "webhook": "/yookassa", "webhook_label": "URL для HTTP-уведомлений ЮKassa",
        "refunds": True, "testable": True,
        "note": "От 1 ₽ · возвраты из панели · в кабинете включите HTTP-уведомления payment.succeeded, "
                "payment.canceled, payment.waiting_for_capture, refund.succeeded",
        "fields": [
            _f("shop_id", "shopId", required=True, env="YOOKASSA_SHOP_ID", placeholder="123456"),
            _f("secret_key", "Секретный ключ", "secret", required=True, env="YOOKASSA_SECRET_KEY", placeholder="live_…"),
            _f("nalogo", "Чеки самозанятого в «Мой налог»", "bool", default=False,
               hint="Доход по каждой оплате через ЮKassa регистрируется автоматически, при возврате чек аннулируется"),
            _f("nalogo_inn", "ИНН", show_if="nalogo", placeholder="12 цифр"),
            _f("nalogo_password", "Пароль от «Мой налог»", "secret", show_if="nalogo"),
        ],
    },
    "lava": {
        "label": "Lava", "webhook": "/lava", "webhook_label": "Адрес уведомлений (передаётся в каждом счёте сам)",
        "refunds": False, "testable": True, "note": "Возврат — в кабинете Lava",
        "fields": [
            _f("shop_id", "Shop ID", required=True, env="LAVA_SHOP_ID", placeholder="UUID проекта"),
            _f("secret_key", "Секретный ключ", "secret", required=True, env="LAVA_SECRET_KEY"),
            _f("additional_key", "Дополнительный ключ", "secret", required=True, env="LAVA_ADDITIONAL_KEY"),
        ],
    },
    "paypalych": {
        "label": "PayPalych", "webhook": "/paypalych", "webhook_label": "Result URL для магазина PayPalych",
        "refunds": False, "testable": True, "note": "Возврат — в кабинете PayPalych",
        "fields": [
            _f("shop_id", "ID магазина", required=True, env="PAYPALYCH_SHOP_ID"),
            _f("api_token", "API-токен", "secret", required=True, env="PAYPALYCH_API_TOKEN"),
        ],
    },
    "rollypay": {
        "label": "RollyPay", "webhook": "/rollypay", "webhook_label": "callback_url для кассы RollyPay",
        "refunds": False, "testable": True, "note": "СБП, карта и крипта · возврат — в кабинете RollyPay",
        "fields": [
            _f("api_key", "API-ключ кассы", "secret", required=True, env="ROLLYPAY_API_KEY"),
            _f("signing_secret", "Секрет подписи", "secret", required=True, env="ROLLYPAY_SIGNING_SECRET"),
        ],
    },
    "wata": {
        "label": "WATA", "webhook": "/wata", "webhook_label": "Webhook URL для терминала WATA",
        "refunds": True, "testable": True, "note": "Покупатель выбирает карту, СБП или T-Pay на странице WATA · возвраты из панели",
        "fields": [
            _f("access_token", "Токен терминала", "secret", required=True, env="WATA_ACCESS_TOKEN",
               placeholder="eyJ…"),
        ],
    },
    "heleket": {
        "label": "Heleket", "webhook": "/heleket", "webhook_label": "Адрес уведомлений (передаётся в каждом счёте сам)",
        "refunds": False, "testable": True, "note": "Счёт в рублях, монету выбирает покупатель · возврат — в кабинете Heleket",
        "fields": [
            _f("merchant_id", "UUID мерчанта", required=True, env="HELEKET_MERCHANT_ID"),
            _f("api_key", "Платёжный API-ключ", "secret", required=True, env="HELEKET_API_KEY"),
        ],
    },
    "pay2328": {
        "label": "2328", "webhook": "/2328", "webhook_label": "Адрес уведомлений (передаётся в каждом счёте сам)",
        "refunds": False, "testable": True, "note": "Счёт в рублях, монету выбирает покупатель · возврат — в кабинете 2328",
        "fields": [
            _f("project_id", "UUID проекта", required=True, env="PAY2328_PROJECT_ID"),
            _f("api_key", "API-ключ", "secret", required=True, env="PAY2328_API_KEY"),
        ],
    },
    "stars": {
        "label": "Звёзды Telegram", "webhook": "", "refunds": True, "testable": True,
        "note": "Оплату принимает ваш бот, ключи не нужны · 1 звезда = 1 ₽", "fields": [],
    },
}
PROVIDERS = tuple(SPECS)
# создают ссылку на оплату в рублях
PAID_PROVIDERS = ("platega", "cispay", "yookassa", "lava", "paypalych", "rollypay", "wata", "heleket", "pay2328")
PROVIDER_LABEL = {**{k: v["label"] for k, v in SPECS.items()}, "tg_stars": "Звёзды Telegram", "balance": "Реф. баланс"}

_FIAT = ("platega", "cispay", "yookassa", "lava", "paypalych", "rollypay", "wata")
# способ оплаты → какие платёжки его умеют (порядок по умолчанию)
METHODS: dict[str, tuple[str, ...]] = {
    "sbp": _FIAT,
    "card": _FIAT,
    "tg_stars": ("stars",),
    "crypto": ("heleket", "pay2328", "rollypay"),
}
METHOD_LABEL = {"sbp": "СБП", "card": "Банковские карты", "tg_stars": "Звёзды Telegram", "crypto": "Криптовалюта"}
METHOD_ICON = {"sbp": "/assets/sbp.png", "card": "/assets/card.png", "tg_stars": "/assets/stars.png",
               "crypto": "/assets/crypto.png"}
METHOD_DEFAULT_ON = {"sbp": True, "card": True, "tg_stars": True, "crypto": False}
# минимальная сумма у платёжки, ₽
PLATEGA_MIN = {"card": 50.0, "sberpay": 50.0, "international": 50.0, "sbp": 10.0, "erip": 10.0, "crypto": 10.0}


class PaymentsConfigError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _env(*keys: str) -> str:
    for k in keys:
        v = (os.getenv(k) or "").strip() if k else ""
        if v:
            return v
    return ""


def _crypto():
    try:
        from . import monitoring  # type: ignore
    except ImportError:  # pragma: no cover
        import monitoring  # type: ignore
    return monitoring


def _raw() -> dict[str, Any]:
    raw = db.get_setting(SETTINGS_KEY, "") or ""
    try:
        cfg = json.loads(raw) if raw else {}
    except ValueError:
        cfg = {}
    return cfg if isinstance(cfg, dict) else {}


def _dec(token: Optional[str]) -> str:
    return (_crypto().decrypt(token) or "") if token else ""


def _prov(provider: str) -> str:
    return "stars" if provider == "tg_stars" else provider


# ── значения полей (панель → .env → по умолчанию) ───────────────

def _value(cfg: dict[str, Any], provider: str, field: dict[str, Any]) -> Any:
    saved = cfg.get(provider) or {}
    name, type_ = field["name"], field["type"]
    if type_ == "secret":
        v = _dec(saved.get(f"{name}_enc"))
    elif type_ == "bool":
        v = saved.get(name)
        return field["default"] if v is None else bool(v)
    else:
        v = str(saved.get(name) or "").strip()
    return v or _env(field["env"]) or field["default"]


def creds(provider: str, cfg: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    cfg = _raw() if cfg is None else cfg
    p = _prov(provider)
    out = {f["name"]: _value(cfg, p, f) for f in SPECS[p]["fields"]}
    saved = cfg.get(p) or {}
    for name, (env, default) in HIDDEN.get(p, {}).items():
        v = saved.get(name)  # старые сохранённые значения (раньше были в панели)
        out[name] = v if v not in (None, "") else (_env(env) or default)
    return out


def _build_client(provider: str, c: dict[str, Any]):
    if provider == "platega":
        return platega.PlategaClient(c["merchant_id"], c["secret"], base_url=c["api_url"])
    if provider == "cispay":
        return cispay.CisPayClient(c["shop_id"], c["api_key"], base_url=c["api_url"])
    if provider == "yookassa":
        return yookassa.YooKassaClient(c["shop_id"], c["secret_key"], base_url=c["api_url"])
    if provider == "lava":
        return lava.LavaClient(c["shop_id"], c["secret_key"], c["additional_key"], base_url=c["api_url"])
    if provider == "paypalych":
        return paypalych.PayPalychClient(c["shop_id"], c["api_token"], base_url=c["api_url"])
    if provider == "rollypay":
        return rollypay.RollyPayClient(c["api_key"], c["signing_secret"], base_url=c["api_url"])
    if provider == "wata":
        return wata.WataClient(c["access_token"], base_url=c["api_url"])
    if provider == "heleket":
        return heleket.HeleketClient(c["merchant_id"], c["api_key"], base_url=c["api_url"])
    if provider == "pay2328":
        return pay2328.Pay2328Client(c["project_id"], c["api_key"], base_url=c["api_url"])
    if provider == "stars":
        return stars.TelegramStars()
    raise PaymentsConfigError(f"Неизвестная платёжка {provider}")


def client(provider: str):
    p = _prov(provider)
    return _build_client(p, creds(p))


def platega_client() -> platega.PlategaClient:
    return client("platega")


def cispay_client() -> cispay.CisPayClient:
    return client("cispay")


def yookassa_client() -> yookassa.YooKassaClient:
    return client("yookassa")


def lava_client() -> lava.LavaClient:
    return client("lava")


def paypalych_client() -> paypalych.PayPalychClient:
    return client("paypalych")


def rollypay_client() -> rollypay.RollyPayClient:
    return client("rollypay")


def wata_client() -> wata.WataClient:
    return client("wata")


def heleket_client() -> heleket.HeleketClient:
    return client("heleket")


def pay2328_client() -> pay2328.Pay2328Client:
    return client("pay2328")


def stars_client() -> stars.TelegramStars:
    return stars.TelegramStars()


def _configured_with(provider: str, c: dict[str, Any]) -> bool:
    if provider == "stars":
        return stars.TelegramStars().is_configured()
    return all(str(c.get(f["name"]) or "").strip() for f in SPECS[provider]["fields"] if f["required"])


def configured(provider: str) -> bool:
    p = _prov(provider)
    if p not in SPECS:
        return False
    return _configured_with(p, creds(p))


# ── способы оплаты ───────────────────────────────────────────────

def _legacy_enabled(cfg: dict[str, Any], provider: str) -> bool:
    """старый формат: платёжка включалась целиком. Без настроек — Platega и звёзды."""
    p = cfg.get(provider) or {}
    if "enabled" in p:
        return bool(p["enabled"])
    return provider in ("platega", "stars")


def _method(cfg: dict[str, Any], m: str) -> dict[str, Any]:
    """{enabled, order, on}: включён ли способ, порядок платёжек, какие из них включены."""
    provs = METHODS[m]
    saved = (cfg.get("methods") or {}).get(m)
    if isinstance(saved, dict):
        order = [p for p in saved.get("order") or [] if p in provs]
        order += [p for p in provs if p not in order]
        on = saved.get("on") if isinstance(saved.get("on"), dict) else {}
        return {"enabled": bool(saved.get("enabled", METHOD_DEFAULT_ON[m])), "order": order,
                "on": {p: bool(on.get(p, False)) for p in provs}}
    # старый формат: routes = {способ: основная платёжка | off}
    route = str((cfg.get("routes") or {}).get(m) or "")
    order = list(provs)
    if route in provs:
        order = [route] + [p for p in provs if p != route]
    is_on = METHOD_DEFAULT_ON[m] if not route else route != "off"
    on = {p: (_legacy_enabled(cfg, p) if m != "crypto" else False) for p in provs}
    return {"enabled": is_on, "order": order, "on": on}


def providers_for(method: str) -> list[str]:
    """рабочие платёжки способа по приоритету: первая создаёт платёж, остальные — запасные."""
    if method not in METHODS:
        return []
    cfg = _raw()
    st = _method(cfg, method)
    if not st["enabled"]:
        return []
    return [p for p in st["order"] if st["on"][p] and _configured_with(p, creds(p, cfg))]


def available_methods() -> list[str]:
    return [m for m in METHODS if providers_for(m)]


def enabled(provider: str) -> bool:
    """платёжка включена хотя бы в одном способе."""
    cfg, p = _raw(), _prov(provider)
    return any(_method(cfg, m)["on"].get(p) for m in METHODS if p in METHODS[m])


def usable(provider: str) -> bool:
    return enabled(provider) and configured(provider)


def provider_min(method: str, provider: Optional[str] = None) -> float:
    prov = provider or (providers_for(method) or [None])[0]
    m = str(method or "").lower()
    if prov == "cispay":
        return float(cispay.MIN_RUB.get(m, 1.0))  # карта от 50 ₽, СБП без ограничения
    if prov == "yookassa":
        return float(yookassa.MIN_RUB.get(m, 1.0))
    if prov in HIDDEN and "min_amount" in HIDDEN[prov]:
        try:
            return max(1.0, float(creds(prov).get("min_amount") or 10))
        except (TypeError, ValueError):
            return 10.0
    return float(PLATEGA_MIN.get(m, 10.0))


def provider_min_map() -> dict[str, float]:
    out = dict(PLATEGA_MIN)
    for m in ("sbp", "card", "crypto"):
        out[m] = provider_min(m)
    return out


def refunds_supported(provider: str) -> bool:
    return bool(SPECS.get(_prov(provider), {}).get("refunds"))


# ── чеки 54-ФЗ ЮKassa: включаются сами, если в магазине подключена онлайн-касса ──

_FISCAL_TTL = 3600


def yookassa_fiscal() -> bool:
    """подключены ли в ЮKassa чеки (по GET /me, кэш на час)."""
    saved = (_raw().get("yookassa") or {})
    if "receipts" in saved:  # старая ручная настройка
        return bool(saved["receipts"])
    env = _env("YOOKASSA_RECEIPTS").lower()
    if env in ("1", "true", "yes", "0", "false", "no"):
        return env in ("1", "true", "yes")
    try:
        cached = json.loads(db.get_setting("yookassa_fiscal", "") or "{}")
    except ValueError:
        cached = {}
    if cached and time.time() - float(cached.get("ts") or 0) < _FISCAL_TTL:
        return bool(cached.get("on"))
    try:
        on = bool(yookassa_client().me().get("fiscalization_enabled"))
    except Exception:  # noqa: BLE001
        return bool(cached.get("on"))
    db.set_setting("yookassa_fiscal", json.dumps({"ts": time.time(), "on": on}))
    return on


def yookassa_receipt_opts() -> dict[str, Any]:
    saved = (_raw().get("yookassa") or {})
    return {
        "email": str(saved.get("receipt_email") or _env("YOOKASSA_RECEIPT_EMAIL") or ""),
        "vat_code": int(saved.get("vat_code") or _env("YOOKASSA_VAT_CODE") or 1),
        "tax_system_code": int(saved.get("tax_system_code") or _env("YOOKASSA_TAX_SYSTEM") or 0) or None,
    }


# ── панель ───────────────────────────────────────────────────────

def webhook_base() -> str:
    """база адресов уведомлений платёжек. В разделённой установке — только домен вебхуков (edge),
    без запасного варианта: Lava, Heleket и 2328 передают этот адрес в каждом счёте."""
    try:
        from . import deploy  # type: ignore
    except ImportError:  # pragma: no cover
        import deploy  # type: ignore
    url = deploy.webhook_url()
    if url and deploy.contains_leak(url):
        return ""
    return url.rstrip("/")


def webhook_url(provider: str) -> str:
    base, path = webhook_base(), SPECS[_prov(provider)].get("webhook") or ""
    return f"{base}{path}" if base and path else ""


def get_config() -> dict[str, Any]:
    """настройки для панели, без секретов."""
    cfg = _raw()
    usable_now = {p: _configured_with(p, creds(p, cfg)) for p in SPECS}
    methods = []
    for m in METHODS:
        st = _method(cfg, m)
        working = [p for p in st["order"] if st["on"][p] and usable_now[p]] if st["enabled"] else []
        methods.append({
            "id": m, "label": METHOD_LABEL[m], "icon": METHOD_ICON[m], "enabled": st["enabled"],
            "providers": [{"id": p, "enabled": st["on"][p]} for p in st["order"]],
            "active_provider": working[0] if working else None,
        })
    providers = []
    for pid, spec in SPECS.items():
        saved = cfg.get(pid) or {}
        fields = []
        for f in spec["fields"]:
            item = {k: f[k] for k in ("name", "label", "type", "required", "hint", "placeholder", "show_if")}
            if f["type"] == "secret":
                item["value"] = ""
                item["saved"] = bool(saved.get(f"{f['name']}_enc"))
                item["from_env"] = bool(not item["saved"] and f["env"] and _env(f["env"]))
            elif f["type"] == "bool":
                v = saved.get(f["name"])
                item["value"] = f["default"] if v is None else bool(v)
            else:
                item["value"] = str(saved.get(f["name"]) or "")
                item["from_env"] = bool(not item["value"] and f["env"] and _env(f["env"]))
            fields.append(item)
        providers.append({
            "id": pid, "label": spec["label"], "note": spec["note"],
            "methods": [m for m, provs in METHODS.items() if pid in provs],
            "configured": usable_now[pid],
            "from_env": any(fl.get("from_env") for fl in fields),
            "refunds": bool(spec.get("refunds")), "testable": bool(spec.get("testable")),
            "webhook_url": webhook_url(pid), "webhook_label": spec.get("webhook_label") or "",
            "fields": fields,
        })
    return {"methods": methods, "providers": providers}


def _clean(v: Any, n: int) -> str:
    return str(v or "").strip()[:n]


def save_config(data: dict[str, Any]) -> dict[str, Any]:
    """тело: {methods: {способ: {enabled, order: [...], providers: {платёжка: bool}}},
              providers: {платёжка: {поле: значение}}} — всё необязательно, меняется только переданное."""
    cur = _raw()
    new: dict[str, Any] = {k: dict(cur.get(k) or {}) for k in PROVIDERS}
    new["methods"] = {m: _method(cur, m) for m in METHODS}
    provs = data.get("providers") if isinstance(data.get("providers"), dict) else {}

    for pid, spec in SPECS.items():
        body = provs.get(pid)
        if not isinstance(body, dict):
            continue
        new[pid].pop("enabled", None)  # старый формат — теперь включение в способах оплаты
        for f in spec["fields"]:
            name, type_ = f["name"], f["type"]
            if name not in body or body[name] is None:
                continue
            v = body[name]
            if type_ == "secret":
                if str(v).strip():
                    new[pid][f"{name}_enc"] = _crypto().encrypt(_clean(v, 1000))
            elif type_ == "bool":
                new[pid][name] = bool(v)
            else:
                new[pid][name] = _clean(v, 200)

    methods = data.get("methods") if isinstance(data.get("methods"), dict) else {}
    for m, body in methods.items():
        if m not in METHODS or not isinstance(body, dict):
            continue
        st = new["methods"][m]
        if "enabled" in body:
            st["enabled"] = bool(body["enabled"])
        if isinstance(body.get("order"), list):
            order = [p for p in body["order"] if p in METHODS[m]]
            st["order"] = list(dict.fromkeys(order)) + [p for p in METHODS[m] if p not in order]
        if isinstance(body.get("providers"), dict):
            for p, v in body["providers"].items():
                if p in METHODS[m]:
                    st["on"][p] = bool(v)

    # только что включённая платёжка без ключей — сразу говорим, а не при первой оплате
    old = {m: _method(cur, m) for m in METHODS}
    for m, st in new["methods"].items():
        for p in st["order"]:
            if p == "stars" or not st["on"][p] or old[m]["on"][p]:
                continue
            if not _configured_with(p, creds(p, new)):
                raise PaymentsConfigError(f"{SPECS[p]['label']}: заполните ключи, чтобы включить её для «{METHOD_LABEL[m]}»")

    yk = new.get("yookassa") or {}
    if yk.get("nalogo"):
        inn = str(yk.get("nalogo_inn") or "").strip()
        if not (inn.isdigit() and len(inn) == 12):
            raise PaymentsConfigError("Чеки самозанятого: ИНН физлица — 12 цифр")
        if not _dec(yk.get("nalogo_password_enc")):
            raise PaymentsConfigError("Чеки самозанятого: укажите пароль от «Мой налог»")
        if not (old_yk := (cur.get("yookassa") or {})).get("nalogo") or old_yk.get("nalogo_inn") != inn \
                or old_yk.get("nalogo_password_enc") != yk.get("nalogo_password_enc"):
            _check_nalogo(inn, _dec(yk.get("nalogo_password_enc")))

    new.pop("routes", None)
    db.set_setting(SETTINGS_KEY, json.dumps(new, ensure_ascii=False))
    return get_config()


def _check_nalogo(inn: str, pwd: str) -> str:
    try:
        try:
            from . import nalogo_receipts  # type: ignore
        except ImportError:  # pragma: no cover
            import nalogo_receipts  # type: ignore
        return nalogo_receipts.check(inn, pwd)
    except ImportError:
        raise PaymentsConfigError("Не установлена библиотека nalogo — пересоберите контейнер (pip install nalogo)", 503)
    except Exception as exc:  # noqa: BLE001
        name = type(exc).__name__
        if "Unauthorized" in name or "Validation" in name:
            raise PaymentsConfigError("«Мой налог» не принял ИНН или пароль — проверьте их")
        raise PaymentsConfigError(f"Не удалось войти в «Мой налог»: {exc}", 502)


# ── проверка ключей ─────────────────────────────────────────────

_ERRORS = (cispay.CisPayError, yookassa.YooKassaError, lava.LavaError, paypalych.PayPalychError,
           rollypay.RollyPayError, wata.WataError, heleket.HeleketError, pay2328.Pay2328Error)


def test_provider(provider: str) -> dict[str, Any]:
    """проверка ключей у платёжки (без создания платежа)."""
    p = _prov(provider)
    if p not in SPECS:
        raise PaymentsConfigError("Неизвестная платёжка")
    label = SPECS[p]["label"]
    if p == "stars":
        if not configured("stars"):
            raise PaymentsConfigError("TELEGRAM_BOT_TOKEN не задан в .env")
        return {"ok": True, "message": "Звёзды принимает ваш бот — отдельных ключей не нужно"}
    if not configured(p):
        raise PaymentsConfigError(f"Заполните ключи {label} и сохраните")
    cfg = _raw()
    mine = [m for m in ("sbp", "card") if p in METHODS[m] and _method(cfg, m)["on"].get(p)]
    try:
        if p == "cispay":
            return _test_cispay(mine)
        if p == "yookassa":
            return _test_yookassa(mine)
        if p == "lava":
            tariffs = lava_client().tariffs()
            names = [str(t.get("service_name") or t.get("service") or t.get("name") or t.get("service_id") or "")
                     for t in tariffs if isinstance(t, dict) and str(t.get("status", 1)) in ("1", "True", "true")]
            names = list(dict.fromkeys(n for n in names if n))
            return {"ok": True, "message": "Lava подключена" + (f". Доступно: {', '.join(names)}" if names else "")}
        if p == "paypalych":
            bal = paypalych_client().balance()
            rows = bal.get("balances") or bal.get("data") or []
            return {"ok": True, "message": "PayPalych подключён" + (f" · баланс: {_fmt_balance(rows)}" if rows else "")}
        if p == "rollypay":
            rollypay_client().check_key()
            return {"ok": True, "message": "RollyPay принял ключ. Укажите callback_url кассы — адрес ниже"}
        if p == "wata":
            bal = wata_client().balance()
            return {"ok": True, "message": f"WATA подключена · баланс терминала: {bal.get('balance')} {bal.get('currency') or ''}".strip()}
        if p == "heleket":
            heleket_client().balance()
            return {"ok": True, "message": "Heleket подключён"}
        if p == "pay2328":
            pay2328_client().balance()
            return {"ok": True, "message": "2328 подключён"}
    except _ERRORS as e:
        if e.status in (401, 403):
            raise PaymentsConfigError(f"{label} отклонил ключи — проверьте их")
        raise PaymentsConfigError(f"{label}: {e}", 502)
    raise PaymentsConfigError(f"Для {label} проверки нет — сделайте тестовый платёж на маленькую сумму")


def _fmt_balance(rows: Any) -> str:
    out = []
    for r in rows if isinstance(rows, list) else []:
        if isinstance(r, dict):
            out.append(f"{r.get('balance_available') or r.get('balance') or r.get('amount')} {r.get('currency') or ''}".strip())
    return ", ".join(out[:3])


def _test_cispay(mine: list[str]) -> dict[str, Any]:
    caps = cispay_client().capabilities()
    if caps.get("is_active") is False:
        raise PaymentsConfigError("Ключи верные, но магазин в cisPay не активен — платежи будут отклоняться")
    active = cispay.active_methods(caps)
    names = {"SBP": "СБП", "CARD": "карта", "CRYPTO": "крипта"}
    store = str(caps.get("store_name") or "").strip()
    msg = f"Магазин {store or 'cisPay'} подключён. Активно: {', '.join(names.get(m, m) for m in active) or 'ничего'}"
    missing = [METHOD_LABEL[m] for m in mine if cispay.APP_METHOD_MAP[m] not in active]
    if missing:
        msg += f". Внимание: в магазине cisPay не включено — {', '.join(missing)}"
    return {"ok": not missing, "message": msg, "methods": active}


def _test_yookassa(mine: list[str]) -> dict[str, Any]:
    me = yookassa_client().me()
    warn, info = [], []
    if me.get("status") and me.get("status") != "enabled":
        warn.append("магазин не активен")
    if me.get("test"):
        warn.append("это тестовый магазин — реальные деньги не списываются")
    fiscal = bool(me.get("fiscalization_enabled"))
    db.set_setting("yookassa_fiscal", json.dumps({"ts": time.time(), "on": fiscal}))
    if fiscal:
        info.append("чеки 54-ФЗ отправляются автоматически")
        if not yookassa_receipt_opts()["email"]:
            warn.append("для чеков пользователям без почты задайте YOOKASSA_RECEIPT_EMAIL в .env")
    methods = [str(x) for x in (me.get("payment_methods") or [])]
    want = {"sbp": "sbp", "card": "bank_card"}
    missing = [METHOD_LABEL[m] for m in mine if methods and want[m] not in methods]
    if missing:
        warn.append(f"не подключено: {', '.join(missing)}")
    c = creds("yookassa")
    if c.get("nalogo") and c.get("nalogo_inn") and c.get("nalogo_password"):
        try:
            who = _check_nalogo(str(c["nalogo_inn"]), str(c["nalogo_password"]))
            info.append(f"«Мой налог»: вход выполнен ({who})")
        except PaymentsConfigError as e:
            warn.append(e.message)
    msg = f"ЮKassa подключена (магазин {me.get('account_id') or ''})".replace(" ()", "")
    if info:
        msg += " · " + "; ".join(info)
    if warn:
        msg += ". Внимание: " + "; ".join(warn)
    return {"ok": not warn, "message": msg}

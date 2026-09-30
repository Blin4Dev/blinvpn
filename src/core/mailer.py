from __future__ import annotations

import ipaddress
import os
import smtplib
import socket
import ssl
from email import policy as _email_policy
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid
from typing import Optional


def _env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


CONFIG_KEY = "mail_config"


def _db():
    try:
        from . import database as db  # type: ignore
    except ImportError:  # pragma: no cover
        import database as db  # type: ignore
    return db


def _crypto():
    try:
        from . import monitoring  # type: ignore
    except ImportError:  # pragma: no cover
        import monitoring  # type: ignore
    return monitoring


def config() -> dict:
    """
    Настройки почты: из панели (БД), иначе — из .env (старые установки).
    mode: off | smtp (почтовый ящик) | direct (напрямую с сервера, порт 25 + DKIM).
    """
    try:
        import json
        raw = _db().get_setting(CONFIG_KEY, "")
        data = json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001
        data = None
    if isinstance(data, dict) and data.get("mode"):
        pwd = _crypto().decrypt(data.get("password_enc")) if data.get("password_enc") else ""
        user = str(data.get("user") or "")
        dom = str(data.get("domain") or (user.split("@")[-1] if "@" in user else ""))
        return {
            "mode": data["mode"], "host": str(data.get("host") or ""), "port": int(data.get("port") or 465),
            "user": user, "password": pwd or "", "from": user if data["mode"] == "smtp" else (f"no-reply@{dom}" if dom else ""),
            "from_name": str(data.get("from_name") or "BlinVPN"), "domain": dom, "source": "panel",
        }
    host = _env("MAIL_SMTP_HOST")
    en = _env("MAIL_ENABLED", "1") in ("1", "true", "True", "yes")
    d = _env("MAIL_DOMAIN")
    frm = _env("MAIL_FROM")
    if not d and "@" in frm:
        d = frm.split("@")[-1]
    return {
        "mode": ("smtp" if host else "direct") if en else "off", "host": host,
        "port": int(_env("MAIL_SMTP_PORT", "587") or 587), "user": _env("MAIL_SMTP_USER"),
        "password": _env("MAIL_SMTP_PASSWORD"), "from": frm or (f"no-reply@{d}" if d else ""),
        "from_name": _env("MAIL_FROM_NAME", "BlinVPN") or "BlinVPN", "domain": d, "source": "env",
    }


def enabled() -> bool:
    return config()["mode"] != "off"


def domain() -> str:
    return config()["domain"]


def mail_from() -> str:
    return config()["from"]


def mail_from_name() -> str:
    return config()["from_name"]


def _dkim_selector() -> str:
    return _env("DKIM_SELECTOR", "mail") or "mail"


def _dkim_key_path() -> str:
    # явный путь
    p = _env("DKIM_PRIVATE_KEY_PATH")
    if p and os.path.isfile(p) and config()["source"] == "env":
        return p
    # иначе <data>/dkim/<домен>.private
    dbp = _env("DB_PATH", "data/data.db")
    cand = os.path.join(os.path.dirname(os.path.abspath(dbp)), "dkim", f"{domain()}.private")
    if os.path.isfile(cand):
        return cand
    return p or cand


def is_configured() -> bool:
    return bool(enabled() and mail_from() and domain())


def _build_message(to: str, subject: str, html: str, text: str) -> bytes:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = formataddr((mail_from_name(), mail_from()))
    msg["To"] = to
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=domain() or None)
    msg.attach(MIMEText(text or "", "plain", "utf-8"))
    msg.attach(MIMEText(html or "", "html", "utf-8"))
    raw = msg.as_bytes(policy=_email_policy.SMTP)  # crlf
    return _dkim_sign(raw)


_DKIM_HEADERS = ["from", "to", "subject", "date", "message-id", "mime-version", "content-type"]


def _dkim_sign(raw: bytes) -> bytes:
    """
    Подписывает письмо DKIM (rsa-sha256, relaxed/relaxed) собственными силами —
    через cryptography, без сторонних DKIM-библиотек. Если ключа нет — возвращает
    письмо как есть.
    """
    path = _dkim_key_path()
    if not path or not os.path.isfile(path):
        return raw
    try:
        import base64
        import hashlib
        import time as _time
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        with open(path, "rb") as fh:
            priv = serialization.load_pem_private_key(fh.read(), password=None)

        header_block, _, body = raw.partition(b"\r\n\r\n")
        # тело: relaxed
        body_c = _canon_body_relaxed(body)
        bh = base64.b64encode(hashlib.sha256(body_c).digest()).decode()

        # заголовки как (name, raw)
        headers = _split_headers(header_block)
        signed_names = [h for h in _DKIM_HEADERS if _find_header(headers, h) is not None]

        dkim_fields = (
            f"v=1; a=rsa-sha256; c=relaxed/relaxed; d={domain()}; s={_dkim_selector()}; "
            f"t={int(_time.time())}; h={':'.join(signed_names)}; bh={bh}; b="
        )
        # signed headers + dkim-signature (b= пустой)
        signing_input = b""
        for name in signed_names:
            signing_input += _canon_header_relaxed(name, _find_header(headers, name)) + b"\r\n"
        signing_input += b"dkim-signature:" + _canon_value(dkim_fields)

        signature = priv.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        b64sig = base64.b64encode(signature).decode()
        dkim_header = "DKIM-Signature: " + dkim_fields + b64sig
        # dkim-signature первым
        return dkim_header.encode() + b"\r\n" + header_block + b"\r\n\r\n" + body
    except Exception as exc:  # noqa: BLE001
        print(f"[mail] DKIM подпись не удалась: {exc}", flush=True)
        return raw


def _split_headers(header_block: bytes) -> list[tuple[str, bytes]]:
    """Разбор блока заголовков с учётом свёрнутых (folded) строк."""
    out: list[tuple[str, bytes]] = []
    for line in header_block.split(b"\r\n"):
        if line[:1] in (b" ", b"\t") and out:
            name, val = out[-1]
            out[-1] = (name, val + b"\r\n" + line)
        elif b":" in line:
            name = line.split(b":", 1)[0].decode("ascii", "replace").strip().lower()
            out.append((name, line))
    return out


def _find_header(headers: list[tuple[str, bytes]], name: str) -> Optional[bytes]:
    for n, raw in headers:
        if n == name:
            return raw
    return None


def _canon_header_relaxed(name: str, raw_line: bytes) -> bytes:
    value = raw_line.split(b":", 1)[1] if b":" in raw_line else b""
    return name.encode("ascii") + b":" + _canon_value(value.decode("utf-8", "replace"))


def _canon_value(value: str) -> bytes:
    import re
    unfolded = re.sub(r"\r\n[ \t]+", " ", value)
    collapsed = re.sub(r"[ \t]+", " ", unfolded)
    return collapsed.strip().encode("utf-8")


def _canon_body_relaxed(body: bytes) -> bytes:
    import re
    if not body:
        return b"\r\n"
    lines = body.split(b"\r\n")
    out = []
    for line in lines:
        line = re.sub(rb"[ \t]+", b" ", line)
        out.append(line.rstrip(b" \t"))
    text = b"\r\n".join(out)
    text = text.rstrip(b"\r\n") + b"\r\n"  # один crlf в конце
    return text


def _resolve_mx(dom: str) -> list[str]:
    """Список хостов MX (по приоритету). Фолбэк — сам домен (A-запись)."""
    hosts: list[str] = []
    try:
        import dns.resolver
        answers = dns.resolver.resolve(dom, "MX")
        ranked = sorted((int(r.preference), str(r.exchange).rstrip(".")) for r in answers)
        hosts = [h for _, h in ranked if h]
    except Exception:  # noqa: BLE001
        hosts = []
    if not hosts:
        hosts = [dom]  # fallback на a-запись
    return hosts


def _ehlo_name() -> str:
    d = domain()
    return f"mail.{d}" if d else (socket.getfqdn() or "localhost")


def _resolve_public_ip(host: str) -> Optional[str]:
    """
    Резолвит хост и возвращает первый ПУБЛИЧНЫЙ IP. Приватные/loopback/link-local
    и прочие зарезервированные адреса отбрасываются — защита от SMTP-SSRF
    (чтобы по MX-записи нельзя было заставить сервер стучаться во внутреннюю сеть).
    """
    try:
        infos = socket.getaddrinfo(host, 25, proto=socket.IPPROTO_TCP)
    except OSError:
        return None
    for info in infos:
        ip = info[4][0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast:
            continue
        return ip
    return None


def _send_via_relay(to: str, message: bytes) -> tuple[bool, str]:
    """
    Отправка через SMTP-сервер (релей): для VPS, где исходящий порт 25 закрыт.
    .env: MAIL_SMTP_HOST, MAIL_SMTP_PORT (587 — STARTTLS, 465 — SSL),
          MAIL_SMTP_USER, MAIL_SMTP_PASSWORD. Сертификат сервера проверяется.
    """
    cfg = config()
    host, port, user, password = cfg["host"], int(cfg["port"] or 587), cfg["user"], cfg["password"]
    timeout = float(_env("MAIL_TIMEOUT", "20") or 20)
    ctx = ssl.create_default_context()
    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=timeout, context=ctx)
        else:
            server = smtplib.SMTP(host, port, timeout=timeout)
            server.ehlo()
            server.starttls(context=ctx)
            server.ehlo()
        try:
            if user:
                server.login(user, password)
            server.sendmail(mail_from(), [to], message)
        finally:
            try:
                server.quit()
            except Exception:  # noqa: BLE001
                pass
        return True, ""
    except Exception as exc:  # noqa: BLE001
        return False, f"SMTP {host}:{port}: {type(exc).__name__}: {exc}"


def send(to: str, subject: str, *, html: Optional[str] = None, text: Optional[str] = None) -> tuple[bool, str]:
    """Отправляет письмо напрямую на MX получателя. Возвращает (ok, error)."""
    if not enabled():
        return False, "Почта выключена"
    if not mail_from() or not domain():
        return False, "Почта не настроена"
    to = (to or "").strip()
    if "@" not in to:
        return False, "Некорректный адрес получателя"

    if not text and html:
        text = _html_to_text(html)
    if not html and text:
        text = text
        html = f"<pre style='font-family:inherit;white-space:pre-wrap'>{_esc(text)}</pre>"

    message = _build_message(to, subject, html or "", text or "")
    if config()["mode"] == "smtp":
        return _send_via_relay(to, message)
    recipient_domain = to.split("@")[-1]
    timeout = float(_env("MAIL_TIMEOUT", "20") or 20)
    sender = mail_from()
    ehlo = _ehlo_name()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # starttls без проверки cert

    last_err = "нет доступных MX"
    port25_blocked = False
    for host in _resolve_mx(recipient_domain):
        ip = _resolve_public_ip(host)
        if not ip:
            last_err = f"{host}: не публичный/не резолвится"
            continue
        try:
            server = smtplib.SMTP(ip, 25, timeout=timeout, local_hostname=ehlo)
            try:
                server.ehlo(ehlo)
                try:
                    if server.has_extn("starttls"):
                        server.starttls(context=ctx)
                        server.ehlo(ehlo)
                except (smtplib.SMTPException, ssl.SSLError):
                    pass  # без tls если mx не умеет
                server.mail(sender)
                server.rcpt(to)
                code, _ = server.data(message)
                if 200 <= code < 300:
                    return True, ""
                last_err = f"MX {host} ответил кодом {code}"
            finally:
                try:
                    server.quit()
                except Exception:  # noqa: BLE001
                    pass
        except Exception as exc:  # noqa: BLE001
            last_err = f"{host}: {type(exc).__name__}: {exc}"
            if isinstance(exc, (TimeoutError, socket.timeout, ConnectionRefusedError, OSError)) and not isinstance(exc, smtplib.SMTPException):
                port25_blocked = True
            continue
    if port25_blocked:
        last_err += (" — похоже, хостинг закрыл исходящий порт 25. Настройте отправку через почтовый ящик: "
                     "sudo bash install.sh → «Настроить почту»")
    return False, last_err


def _brand_wrap(inner_html: str) -> str:
    return (
        "<div style=\"background:#111;padding:32px 0;font-family:'Inter',Arial,sans-serif\">"
        "<table role='presentation' width='100%' cellpadding='0' cellspacing='0'><tr><td align='center'>"
        "<table role='presentation' width='440' cellpadding='0' cellspacing='0' "
        "style='max-width:440px;background:#1c1c1c;border-radius:20px;overflow:hidden'>"
        "<tr><td style='padding:28px 32px 8px'>"
        "<div style='font-size:22px;font-weight:700;color:#fff'>Blin<span style='color:#F18726'>VPN</span></div>"
        "</td></tr>"
        f"<tr><td style='padding:8px 32px 30px;color:#d4d4d4;font-size:15px;line-height:1.6'>{inner_html}</td></tr>"
        "<tr><td style='padding:18px 32px;border-top:1px solid #2a2a2a;color:#6b6b6b;font-size:12px'>"
        "Это автоматическое письмо, отвечать на него не нужно.</td></tr>"
        "</table></td></tr></table></div>"
    )


def send_login_code(to: str, code: str) -> tuple[bool, str]:
    inner = (
        "<p style='margin:0 0 14px;color:#fff;font-size:17px;font-weight:600'>Код для входа</p>"
        "<p style='margin:0 0 18px'>Используйте этот код, чтобы войти в BlinVPN:</p>"
        f"<div style='font-size:34px;font-weight:700;letter-spacing:8px;color:#F18726;"
        f"background:#111;border-radius:14px;padding:18px 0;text-align:center'>{_esc(code)}</div>"
        "<p style='margin:18px 0 0;color:#8a8a8a;font-size:13px'>Код действует 10 минут. "
        "Если вы не запрашивали вход — просто проигнорируйте это письмо.</p>"
    )
    text = f"Ваш код для входа в BlinVPN: {code}\nКод действует 10 минут."
    return send(to, "Код для входа в BlinVPN", html=_brand_wrap(inner), text=text)


def _notice(to: str, subject: str, title: str, paragraphs: list[str], footer: str) -> tuple[bool, str]:
    """Короткое служебное письмо о безопасности аккаунта (привязка почты, вход)."""
    inner = f"<p style='margin:0 0 14px;color:#fff;font-size:17px;font-weight:600'>{_esc(title)}</p>"
    for p in paragraphs:
        inner += f"<p style='margin:0 0 12px'>{p}</p>"
    inner += f"<p style='margin:18px 0 0;color:#8a8a8a;font-size:13px'>{_esc(footer)}</p>"
    text = title + "\n\n" + "\n".join(_html_to_text(p) for p in paragraphs) + "\n\n" + footer
    return send(to, subject, html=_brand_wrap(inner), text=text)


_NOT_YOU = "Если это были не вы — войдите в BlinVPN и отвяжите эту почту или напишите в поддержку."


def send_email_bound(to: str) -> tuple[bool, str]:
    return _notice(
        to, "Почта привязана к BlinVPN", "Почта привязана",
        [f"Адрес <b>{_esc(to)}</b> привязан к вашему аккаунту BlinVPN. "
         "Теперь по нему можно входить на сайт."],
        _NOT_YOU,
    )


def send_email_unbound(to: str, new_email: Optional[str] = None) -> tuple[bool, str]:
    if new_email:
        body = [f"Почта аккаунта BlinVPN изменена на <b>{_esc(mask_email(new_email))}</b>. "
                "Входить по этому адресу больше нельзя."]
    else:
        body = ["Этот адрес отвязан от аккаунта BlinVPN. Входить по нему больше нельзя."]
    return _notice(to, "Почта отвязана от BlinVPN", "Почта отвязана", body,
                   "Если это были не вы — срочно напишите в поддержку.")


def send_login_notice(to: str, when: str, method: str, ip: str = "", device: str = "") -> tuple[bool, str]:
    rows = [f"Время: <b>{_esc(when)}</b> (МСК)", f"Способ входа: <b>{_esc(method)}</b>"]
    if device:
        rows.append(f"Устройство: <b>{_esc(device)}</b>")
    if ip:
        rows.append(f"IP-адрес: <b>{_esc(ip)}</b>")
    return _notice(to, "Вход в аккаунт BlinVPN", "Выполнен вход в аккаунт",
                   ["В ваш аккаунт BlinVPN только что вошли.", "<br>".join(rows)],
                   "Если это были не вы — срочно напишите в поддержку.")


def send_support_reply(to: str, text: str, files: int = 0, url: str = "") -> tuple[bool, str]:
    """Письмо «Вам ответила поддержка» с текстом ответа и кнопкой «Открыть чат»."""
    body = text.strip()
    short = body[:600] + ("…" if len(body) > 600 else "")
    parts = []
    if short:
        parts.append("<div style='white-space:pre-wrap;background:#111;border-radius:12px;padding:14px 16px;color:#eee'>"
                     + _esc(short) + "</div>")
    if files:
        parts.append(f"📎 Вложений: {files}")
    if url:
        parts.append(f"<a href='{_esc(url)}' style='display:inline-block;background:#F18726;color:#fff;text-decoration:none;"
                     "padding:12px 20px;border-radius:12px;font-weight:600'>Открыть чат</a>")
    inner = ("<p style='margin:0 0 14px;color:#fff;font-size:17px;font-weight:600'>Вам ответила поддержка</p>"
             + "".join(f"<p style='margin:0 0 14px'>{p}</p>" for p in parts))
    plain = "Вам ответила поддержка BlinVPN\n\n" + short + (f"\n\nВложений: {files}" if files else "") + (f"\n\nОткрыть чат: {url}" if url else "")
    return send(to, "Ответ поддержки BlinVPN", html=_brand_wrap(inner), text=plain)


def mask_email(e: str) -> str:
    """ivan.petrov@mail.ru → iv***@mail.ru"""
    name, _, dom = (e or "").partition("@")
    return (name[:2] + "***@" + dom) if dom else e


def send_broadcast(to: str, subject: str, body_html: str, body_text: Optional[str] = None) -> tuple[bool, str]:
    return send(to, subject, html=_brand_wrap(body_html), text=body_text)


def _esc(s: str) -> str:
    return ((s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def _html_to_text(html: str) -> str:
    import re
    text = re.sub(r"<br\s*/?>", "\n", html)
    text = re.sub(r"</p>", "\n\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    return text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").strip()


SMTP_PRESETS = {
    "yandex": ("smtp.yandex.ru", 465), "mailru": ("smtp.mail.ru", 465), "gmail": ("smtp.gmail.com", 465),
}


def smtp_login_test(host: str, port: int, user: str, password: str) -> tuple[bool, str]:
    """Проверка входа в почтовый ящик (без отправки письма)."""
    ctx = ssl.create_default_context()
    try:
        if port == 465:
            s = smtplib.SMTP_SSL(host, port, timeout=15, context=ctx)
        else:
            s = smtplib.SMTP(host, port, timeout=15)
            s.ehlo()
            s.starttls(context=ctx)
            s.ehlo()
        try:
            s.login(user, password)
        finally:
            try:
                s.quit()
            except Exception:  # noqa: BLE001
                pass
        return True, ""
    except smtplib.SMTPAuthenticationError:
        return False, "Неверная почта или пароль. Нужен именно пароль приложения, а не обычный пароль"
    except (socket.timeout, TimeoutError):
        return False, f"{host}:{port} не отвечает"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"[:200]


def port25_open() -> bool:
    """Выпускает ли хостинг письма наружу (исходящий порт 25)."""
    for host in ("gmail-smtp-in.l.google.com", "mx.yandex.ru"):
        try:
            with socket.create_connection((host, 25), timeout=6):
                return True
        except OSError:
            continue
    return False


def dkim_key_file(dom: str) -> str:
    dbp = _env("DB_PATH", "data/data.db")
    return os.path.join(os.path.dirname(os.path.abspath(dbp)), "dkim", f"{dom}.private")


def ensure_dkim(dom: str) -> str:
    """Ключ DKIM для домена (создаётся один раз). Возвращает значение DNS TXT-записи."""
    import base64
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    path = dkim_key_file(dom)
    if os.path.isfile(path):
        with open(path, "rb") as f:
            key = serialization.load_pem_private_key(f.read(), password=None)
    else:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                serialization.NoEncryption())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
    pub = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return "v=DKIM1; k=rsa; p=" + base64.b64encode(pub).decode()


def _txt(name: str) -> list[str]:
    try:
        import dns.resolver
        return ["".join(p.decode("utf-8", "replace") for p in r.strings) for r in dns.resolver.resolve(name, "TXT", lifetime=6)]
    except Exception:  # noqa: BLE001
        return []


def dns_records(dom: str, server_ip: str) -> list[dict]:
    """DNS-записи для прямой отправки и есть ли они уже у домена."""
    dkim = ensure_dkim(dom)
    sel = _dkim_selector()
    spf_ok = any(t.startswith("v=spf1") and (server_ip in t or " a " in f" {t} " or " mx " in f" {t} ") for t in _txt(dom))
    dkim_ok = any(t.replace(" ", "").endswith(dkim.split("p=")[1]) for t in _txt(f"{sel}._domainkey.{dom}"))
    dmarc_ok = any(t.startswith("v=DMARC1") for t in _txt(f"_dmarc.{dom}"))
    return [
        {"type": "TXT", "host": "@", "value": f"v=spf1 a mx ip4:{server_ip} ~all" if server_ip else "v=spf1 a mx ~all", "ok": spf_ok},
        {"type": "TXT", "host": f"{sel}._domainkey", "value": dkim, "ok": dkim_ok},
        {"type": "TXT", "host": "_dmarc", "value": f"v=DMARC1; p=none; rua=mailto:postmaster@{dom}", "ok": dmarc_ok},
    ]


def save_config(mode: str, *, host: str = "", port: int = 465, user: str = "", password: Optional[str] = None,
                domain_name: str = "", from_name: str = "BlinVPN") -> None:
    import json
    prev_raw = _db().get_setting(CONFIG_KEY, "")
    try:
        prev = json.loads(prev_raw) if prev_raw else {}
    except ValueError:
        prev = {}
    # пароль только для того же ящика/сервера
    same = prev.get("user") == user and str(prev.get("host") or "").lower() == str(host or "").lower()
    enc = prev.get("password_enc") if password is None and same else (
        _crypto().encrypt(password) if password else None)
    data = {"mode": mode, "host": host, "port": int(port), "user": user, "password_enc": enc,
            "domain": domain_name, "from_name": from_name or "BlinVPN"}
    _db().set_setting(CONFIG_KEY, json.dumps(data, ensure_ascii=False))


def public_config() -> dict:
    c = config()
    return {"mode": c["mode"], "host": c["host"], "port": c["port"], "user": c["user"], "has_password": bool(c["password"]),
            "domain": c["domain"], "from": c["from"], "from_name": c["from_name"], "source": c["source"]}

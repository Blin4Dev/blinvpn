"""
Почтовый модуль BlinVPN — без внешних релеев и без почтового демона.

Два режима. Если в .env задан MAIL_SMTP_HOST — письма уходят через обычный
почтовый ящик (Яндекс, Mail.ru, Gmail…) по SMTP: это проще и работает на любом
хостинге. Иначе приложение само доставляет письмо на почтовый сервер получателя:
находит MX-запись домена адресата и отправляет на неё по SMTP (порт 25),
подписывая письмо ключом DKIM. Ничего не крутится в фоне — соединение
открывается только когда есть что отправить (код входа или рассылка).

Только исходящая транзакционная почта с no-reply@<домен>. Входящих нет.

Настройки берутся из .env (их выставляет install.sh):
  MAIL_ENABLED, MAIL_DOMAIN, MAIL_FROM, MAIL_FROM_NAME,
  DKIM_SELECTOR (по умолч. mail), DKIM_PRIVATE_KEY_PATH.
"""

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


def enabled() -> bool:
    return _env("MAIL_ENABLED", "1") in ("1", "true", "True", "yes")


def domain() -> str:
    d = _env("MAIL_DOMAIN")
    if d:
        return d
    frm = _env("MAIL_FROM")
    return frm.split("@")[-1] if "@" in frm else ""


def mail_from() -> str:
    return _env("MAIL_FROM") or (f"no-reply@{domain()}" if domain() else "")


def mail_from_name() -> str:
    return _env("MAIL_FROM_NAME", "BlinVPN") or "BlinVPN"


def _dkim_selector() -> str:
    return _env("DKIM_SELECTOR", "mail") or "mail"


def _dkim_key_path() -> str:
    # Явный путь, если существует.
    p = _env("DKIM_PRIVATE_KEY_PATH")
    if p and os.path.isfile(p):
        return p
    # Иначе ищем рядом с БД: <data>/dkim/<домен>.private (работает и в контейнере, и локально).
    dbp = _env("DB_PATH", "data/data.db")
    cand = os.path.join(os.path.dirname(os.path.abspath(dbp)), "dkim", f"{domain()}.private")
    if os.path.isfile(cand):
        return cand
    return p or cand


def is_configured() -> bool:
    return bool(enabled() and mail_from() and domain())


# ── Построение письма ────────────────────────────────────────

def _build_message(to: str, subject: str, html: str, text: str) -> bytes:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = formataddr((mail_from_name(), mail_from()))
    msg["To"] = to
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=domain() or None)
    msg.attach(MIMEText(text or "", "plain", "utf-8"))
    msg.attach(MIMEText(html or "", "html", "utf-8"))
    raw = msg.as_bytes(policy=_email_policy.SMTP)  # CRLF-переводы строк
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
        # Тело: relaxed canonicalization.
        body_c = _canon_body_relaxed(body)
        bh = base64.b64encode(hashlib.sha256(body_c).digest()).decode()

        # Разбираем заголовки в список (имя, «сырая» строка).
        headers = _split_headers(header_block)
        signed_names = [h for h in _DKIM_HEADERS if _find_header(headers, h) is not None]

        dkim_fields = (
            f"v=1; a=rsa-sha256; c=relaxed/relaxed; d={domain()}; s={_dkim_selector()}; "
            f"t={int(_time.time())}; h={':'.join(signed_names)}; bh={bh}; b="
        )
        # Каноничные подписываемые заголовки + сам DKIM-Signature (с пустым b=).
        signing_input = b""
        for name in signed_names:
            signing_input += _canon_header_relaxed(name, _find_header(headers, name)) + b"\r\n"
        signing_input += b"dkim-signature:" + _canon_value(dkim_fields)

        signature = priv.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        b64sig = base64.b64encode(signature).decode()
        dkim_header = "DKIM-Signature: " + dkim_fields + b64sig
        # Ставим DKIM-Signature первым заголовком.
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
    text = text.rstrip(b"\r\n") + b"\r\n"  # убрать пустые хвостовые строки, оставить один CRLF
    return text


# ── Доставка напрямую на MX получателя ───────────────────────

def _resolve_mx(dom: str) -> list[str]:
    """Список хостов MX (по приоритету). Фолбэк — сам домен (A-запись)."""
    hosts: list[str] = []
    try:
        import dns.resolver  # dnspython
        answers = dns.resolver.resolve(dom, "MX")
        ranked = sorted((int(r.preference), str(r.exchange).rstrip(".")) for r in answers)
        hosts = [h for _, h in ranked if h]
    except Exception:  # noqa: BLE001
        hosts = []
    if not hosts:
        hosts = [dom]  # некоторые домены принимают почту на A-запись
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
    host = _env("MAIL_SMTP_HOST")
    port = int(_env("MAIL_SMTP_PORT", "587") or 587)
    user = _env("MAIL_SMTP_USER")
    password = _env("MAIL_SMTP_PASSWORD")
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
        return False, "Почта отключена (MAIL_ENABLED=0)"
    if not mail_from() or not domain():
        return False, "Не задан MAIL_DOMAIN / MAIL_FROM"
    to = (to or "").strip()
    if "@" not in to:
        return False, "Некорректный адрес получателя"

    if not text and html:
        text = _html_to_text(html)
    if not html and text:
        text = text
        html = f"<pre style='font-family:inherit;white-space:pre-wrap'>{_esc(text)}</pre>"

    message = _build_message(to, subject, html or "", text or "")
    if _env("MAIL_SMTP_HOST"):
        return _send_via_relay(to, message)
    recipient_domain = to.split("@")[-1]
    timeout = float(_env("MAIL_TIMEOUT", "20") or 20)
    sender = mail_from()
    ehlo = _ehlo_name()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # оппортунистический TLS: шифруем, но не валидируем cert MX

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
                    pass  # доставим без TLS, если MX не смог
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


# ── Готовые письма ───────────────────────────────────────────

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


def send_broadcast(to: str, subject: str, body_html: str, body_text: Optional[str] = None) -> tuple[bool, str]:
    return send(to, subject, html=_brand_wrap(body_html), text=body_text)


# ── Утилиты ──────────────────────────────────────────────────

def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _html_to_text(html: str) -> str:
    import re
    text = re.sub(r"<br\s*/?>", "\n", html)
    text = re.sub(r"</p>", "\n\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    return text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").strip()

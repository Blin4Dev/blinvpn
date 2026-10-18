#!/usr/bin/env python3
"""
Подключение XBM к странице подписки Remnawave (nginx из docs.rw) и отключение.

Правится ТОЛЬКО блок server с доменом подписки — остальное (например, панель
Remnawave в том же nginx.conf) не трогается. Правка обратимая: исходная строка
proxy_pass сохраняется в комментарии, всё добавленное помечено «BLINVPN-XBM».

Что делает «включить»:
  • VPN-клиенты (Happ, v2rayTun, Clash, Sing-box, Incy…) → XBM, браузеры → как раньше;
  • если XBM не отвечает (выключен, упал) — nginx сам отдаёт обычную подписку
    (error_page → исходный upstream), люди не остаются без подписки;
  • адрес XBM резолвится при запросе (resolver Docker), поэтому остановленный XBM
    не мешает nginx перезапускаться.

Использование:
  nginx_xbm.py status  --conf /opt/remnawave/nginx/nginx.conf --domain sub.example.com
  nginx_xbm.py enable  --conf ... --domain ... [--xbm blinvpn-xbm:4100]
  nginx_xbm.py disable --conf ...
Код выхода: 0 — успех/включено, 3 — выключено (для status), 1 — ошибка.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import time

MARK = "BLINVPN-XBM"
UA_RE = r"~*(?:happ|streisand|v2raytun|v2ray|neko|foxray|v2box|incy|clash|mihomo|flclash|flowvy|hiddify|singbox|karing|^sfa|^sfi|^sfm|^sft|stash)"
MAP_VAR = "$blinvpn_sub_backend"


class NginxXbmError(Exception):
    pass


def _strip_comments(line: str) -> str:
    return line.split("#", 1)[0]


def _find_block_end(text: str, open_idx: int) -> int:
    """Индекс закрывающей «}» для «{» в позиции open_idx (без учёта скобок в комментариях и строках)."""
    depth = 0
    i = open_idx
    in_comment = False
    quote = ""
    while i < len(text):
        ch = text[i]
        if in_comment:
            if ch == "\n":
                in_comment = False
        elif quote:
            if ch == "\\":
                i += 1
            elif ch == quote:
                quote = ""
        elif ch == "#":
            in_comment = True
        elif ch in "\"'":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise NginxXbmError("Несбалансированные скобки в nginx.conf")


def _server_blocks(text: str):
    for m in re.finditer(r"(?m)^[ \t]*server[ \t]*\{", text):
        open_idx = text.index("{", m.start())
        end = _find_block_end(text, open_idx)
        yield m.start(), open_idx, end


def _location_root(text: str, open_idx: int, end: int) -> "tuple[int, int] | None":
    """(позиция «{», позиция «}») для «location /» внутри блока server, или None."""
    block = text[open_idx + 1:end]
    for lm in re.finditer(r"(?m)^[ \t]*location\s+/\s*\{", block):
        # совпадение внутри комментария пропускаем
        line_start = block.rfind("\n", 0, lm.start()) + 1
        if "#" in block[line_start:lm.start()]:
            continue
        lo = open_idx + 1 + block.index("{", lm.start())
        return lo, _find_block_end(text, lo)
    return None


def _find_sub_server(text: str, domain: str) -> tuple[int, int, int]:
    dom = domain.strip().lower()
    found = []
    for start, open_idx, end in _server_blocks(text):
        body = text[open_idx + 1:end]
        for line in body.splitlines():
            code = _strip_comments(line).strip()
            m = re.match(r"server_name\s+([^;]+);", code)
            if m and dom in [x.lower() for x in m.group(1).split()]:
                found.append((start, open_idx, end))
                break
    if not found:
        raise NginxXbmError(f"В nginx.conf нет блока server с server_name {domain}")
    # Если блоков несколько (например 80 → редирект и 443), берём тот, где есть location / с proxy_pass
    for blk in found:
        loc = _location_root(text, blk[1], blk[2])
        if loc and re.search(r"(?m)^[ \t]*proxy_pass\s", text[loc[0] + 1:loc[1]]):
            return blk
    raise NginxXbmError(f"В блоке {domain} нет «location /» с proxy_pass — не знаю, куда подключать XBM")


def is_enabled(text: str) -> bool:
    return MARK in text


# Директивы в «location /», с которыми автоматическая правка небезопасна
_UNSUPPORTED = re.compile(r"^\s*(location|resolver|proxy_intercept_errors|error_page|if|return|rewrite|limit_except)\b")


def enable(text: str, domain: str, xbm: str = "blinvpn-xbm:4100") -> str:
    if not re.fullmatch(r"[A-Za-z0-9.-]+(:\d{1,5})?", xbm):
        raise NginxXbmError("Неверный адрес XBM")
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", domain):
        raise NginxXbmError("Неверный домен")
    if is_enabled(text):
        raise NginxXbmError("XBM уже подключён (есть метки BLINVPN-XBM)")
    start, open_idx, end = _find_sub_server(text, domain)
    loc = _location_root(text, open_idx, end)
    if not loc:
        raise NginxXbmError("Не найден «location /» в блоке подписки")
    loc_open, loc_end = loc
    loc_body = text[loc_open + 1:loc_end]

    code_lines = [_strip_comments(l) for l in loc_body.splitlines()]
    for cl in code_lines:
        m = _UNSUPPORTED.match(cl)
        if m:
            raise NginxXbmError(f"В «location /» есть «{m.group(1)}» — автоматически подключить нельзя, правьте вручную")
    passes = [cl for cl in code_lines if re.match(r"^\s*proxy_pass\s", cl)]
    if len(passes) != 1:
        raise NginxXbmError("В «location /» должен быть ровно один proxy_pass")

    pm = re.search(r"(?m)^[ \t]*proxy_pass\s+http://([^;\s]+)\s*;", loc_body)
    if not pm:
        raise NginxXbmError("В «location /» нет proxy_pass http://…")
    orig = pm.group(1)
    if "$" in orig or "/" in orig:
        raise NginxXbmError("proxy_pass с переменной или путём — правьте вручную")
    # Строка proxy_pass целиком (с комментарием, пробелами, \r) — чтобы вернуть её байт в байт
    ls = loc_body.rfind("\n", 0, pm.start()) + 1
    le = loc_body.find("\n", pm.start())
    if le < 0:
        raise NginxXbmError("После proxy_pass нет перевода строки — правьте вручную")
    line = loc_body[ls:le]
    if "{" in _strip_comments(line) or "}" in _strip_comments(line):
        raise NginxXbmError("proxy_pass и скобка на одной строке — правьте вручную")
    indent = re.match(r"[ \t]*", line).group(0)
    rest = line[len(indent):]
    eol = "\r\n" if line.endswith("\r") else "\n"

    new_lines = (
        f"{indent}# {MARK} orig: {rest}\n"
        f"{indent}resolver 127.0.0.11 valid=10s ipv6=off;  # {MARK}{eol}"
        f"{indent}proxy_pass http://{MAP_VAR};  # {MARK}{eol}"
        f"{indent}proxy_intercept_errors on;  # {MARK}{eol}"
        f"{indent}error_page 502 503 504 = @blinvpn_sub_orig;  # {MARK}{eol}"
    )
    new_loc_body = loc_body[:ls] + new_lines + loc_body[le + 1:]

    # Запасной путь — копия исходного location, вставляется ПОСЛЕ строки с его «}»
    after = text.find("\n", loc_end)
    if after < 0:
        raise NginxXbmError("После «location /» нет перевода строки — правьте вручную")
    lstart = text.rfind("\n", 0, loc_open) + 1
    li = re.match(r"[ \t]*", text[lstart:]).group(0)
    fallback = (f"{li}# {MARK} begin-fallback: XBM не ответил — обычная подписка{eol}"
                f"{li}location @blinvpn_sub_orig {{{loc_body}}}{eol}"
                f"{li}# {MARK} end-fallback{eol}")
    header = (f"# {MARK} begin-map: VPN-клиенты → XBM, браузеры → страница подписки{eol}"
              f"map $http_user_agent {MAP_VAR} {{{eol}"
              f"    default {orig};{eol}"
              f"    {UA_RE} {xbm};{eol}"
              f"}}{eol}"
              f"# {MARK} end-map{eol}{eol}")
    return (text[:start] + header + text[start:loc_open + 1] + new_loc_body
            + text[loc_end:after + 1] + fallback + text[after + 1:])


def disable(text: str) -> str:
    if not is_enabled(text):
        return text
    out = re.sub(rf"(?ms)^# {MARK} begin-map[^\n]*\n.*?^# {MARK} end-map[^\n]*\n\r?\n", "", text, count=1)
    out = re.sub(rf"(?ms)^[ \t]*# {MARK} begin-fallback[^\n]*\n.*?^[ \t]*# {MARK} end-fallback[^\n]*\n", "", out, count=1)
    out = re.sub(rf"(?m)^[ \t]*[^#\n]*# {MARK}\r?\n", "", out)
    out = re.sub(rf"(?m)^([ \t]*)# {MARK} orig: ([^\n]*)\n", r"\1\2\n", out)
    if MARK in out:
        raise NginxXbmError("Не удалось аккуратно убрать правку — восстановите из резервной копии")
    return out


def _write(path: str, text: str) -> str:
    """
    Резервная копия и запись НА МЕСТЕ (тот же inode): nginx.conf из docs.rw
    примонтирован в контейнер отдельным файлом, и замена файла через rename
    осталась бы для контейнера невидимой.
    """
    backup = f"{path}.blinvpn-{time.strftime('%Y%m%d-%H%M%S')}.bak"
    shutil.copy2(path, backup)
    with open(path, "r+", encoding="utf-8", newline="") as f:  # newline="" — не трогать CRLF
        f.seek(0)
        f.write(text)
        f.truncate()
        f.flush()
        os.fsync(f.fileno())
    return backup


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="XBM ↔ nginx страницы подписки Remnawave")
    ap.add_argument("action", choices=["status", "enable", "disable"])
    ap.add_argument("--conf", required=True)
    ap.add_argument("--domain", default="")
    ap.add_argument("--xbm", default="blinvpn-xbm:4100")
    a = ap.parse_args(argv)
    try:
        with open(a.conf, encoding="utf-8", newline="") as f:  # CRLF — как есть
            text = f.read()
        if a.action == "status":
            print("enabled" if is_enabled(text) else "disabled")
            return 0 if is_enabled(text) else 3
        if a.action == "enable":
            if not a.domain:
                raise NginxXbmError("Нужен --domain (домен подписки)")
            backup = _write(a.conf, enable(text, a.domain, a.xbm))
        else:
            if not is_enabled(text):
                print("XBM и так не подключён")
                return 0
            backup = _write(a.conf, disable(text))
        print(backup)
        return 0
    except (OSError, NginxXbmError) as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

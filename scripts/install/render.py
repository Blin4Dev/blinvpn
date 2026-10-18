#!/usr/bin/env python3
"""
Подстановка значений в шаблоны конфигов BlinVPN ({{NAME}} → значение).

Почему не envsubst: в nginx-конфигах полно своих $host/$remote_addr — envsubst без
явного списка их стирает. Здесь заменяются только {{NAME}}, а неизвестное имя — ошибка
(никаких «тихо пустых» значений в конфиге).

  render.py <шаблон> <файл> NAME=value [NAME=value ...]
  render.py <шаблон> - NAME=value ...      (в stdout)
"""
from __future__ import annotations

import os
import re
import sys
import tempfile

_PH = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


class RenderError(ValueError):
    pass


def ipv6_available() -> bool:
    """есть ли на сервере IPv6 (иначе listen [::] не даст nginx запуститься)."""
    try:
        with open("/proc/net/if_inet6", encoding="ascii") as f:
            return bool(f.read().strip())
    except OSError:
        return False


def strip_ipv6_listen(text: str) -> str:
    return "\n".join(line for line in text.split("\n") if not re.match(r"^\s*listen \[::\]", line))


def render_text(text: str, values: dict[str, str]) -> str:
    missing = sorted({m.group(1) for m in _PH.finditer(text)} - set(values))
    if missing:
        raise RenderError("не заданы значения: " + ", ".join(missing))

    def sub(m: re.Match) -> str:
        return str(values[m.group(1)])

    return _PH.sub(sub, text)


def render_file(template: str, out: str, values: dict[str, str], mode: int = 0o644,
                ipv6: bool | None = None) -> str:
    with open(template, encoding="utf-8") as f:
        text = render_text(f.read(), values)
    if ipv6 is None:
        ipv6 = ipv6_available()
    if not ipv6:
        text = strip_ipv6_listen(text)
    if out == "-":
        sys.stdout.write(text)
        return text
    d = os.path.dirname(os.path.abspath(out)) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".render-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return text


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    values: dict[str, str] = {}
    for a in argv[3:]:
        if "=" not in a:
            print(f"неверный аргумент: {a}", file=sys.stderr)
            return 2
        k, v = a.split("=", 1)
        if not re.fullmatch(r"[A-Z0-9_]+", k):
            print(f"неверное имя: {k}", file=sys.stderr)
            return 2
        values[k] = v
    try:
        render_file(argv[1], argv[2], values)
    except (OSError, RenderError) as e:
        print(f"render: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

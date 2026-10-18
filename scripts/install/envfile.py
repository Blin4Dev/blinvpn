#!/usr/bin/env python3
"""
Чтение и правка .env без sed (никаких проблем с «/», «&», «|» и т.п. в значениях).

  envfile.py get  <файл> KEY            → значение (код 1, если ключа нет)
  envfile.py set  <файл> KEY=VAL ...    → обновить/добавить (атомарно, права 600)
  envfile.py ensure <файл> KEY=VAL ...  → добавить, только если ключа нет или он пустой
  envfile.py del  <файл> KEY ...        → удалить ключи
"""
from __future__ import annotations

import os
import re
import sys
import tempfile

KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def read(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n").rstrip("\r")
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                k, v = k.strip(), v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[k] = v
    except OSError:
        pass
    return out


def _check(k: str, v: str) -> None:
    if not KEY_RE.fullmatch(k):
        raise ValueError(f"неверное имя переменной: {k!r}")
    if any(c in v for c in "\n\r\x00"):
        raise ValueError(f"перевод строки в значении {k}")


def write(path: str, updates: dict[str, str], only_missing: bool = False, delete: tuple[str, ...] = ()) -> None:
    for k, v in updates.items():
        _check(k, v)
    lines: list[str] = []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        pass
    cur = read(path)
    done: set[str] = set()
    out: list[str] = []
    for line in lines:
        m = re.match(r"^\s*([A-Z][A-Z0-9_]*)\s*=", line)
        if m and m.group(1) in delete:
            continue
        if m and m.group(1) in updates:
            k = m.group(1)
            if only_missing and cur.get(k, "") != "":
                out.append(line)
            else:
                out.append(f"{k}={updates[k]}")
            done.add(k)
            continue
        out.append(line)
    for k, v in updates.items():
        if k not in done:
            out.append(f"{k}={v}")
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".env-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("\n".join(out).rstrip("\n") + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_into_environ(path: str) -> None:
    for k, v in read(path).items():
        os.environ.setdefault(k, v)


def _pairs(args: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for a in args:
        if "=" not in a:
            raise ValueError(f"ожидалось KEY=VALUE: {a!r}")
        k, v = a.split("=", 1)
        out[k] = v
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, path, rest = argv[1], argv[2], argv[3:]
    try:
        if cmd == "get":
            vals = read(path)
            if not rest or rest[0] not in vals:
                return 1
            sys.stdout.write(vals[rest[0]])
            return 0
        if cmd == "set":
            write(path, _pairs(rest))
            return 0
        if cmd == "ensure":
            write(path, _pairs(rest), only_missing=True)
            return 0
        if cmd == "del":
            write(path, {}, delete=tuple(rest))
            return 0
    except ValueError as e:
        print(f"envfile: {e}", file=sys.stderr)
        return 2
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

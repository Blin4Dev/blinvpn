#!/usr/bin/env python3
"""
урезать шрифт Material Symbols до иконок, которые реально встречаются в коде мини-аппа.

полный шрифт (~4 МБ) лежит в scripts/fonts/material-symbols-outlined.full.woff2,
результат — src/app/public/fonts/material-symbols-blin.woff2 (десятки КБ).

запуск после добавления новых иконок:  python3 scripts/subset-icons.py
нужно: pip install fonttools brotli
"""
import hashlib
import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "app"
FULL = ROOT / "scripts" / "fonts" / "material-symbols-outlined.full.woff2"
FONTS_DIR = SRC / "public" / "fonts"
# имя с хешем содержимого: браузер не держит в кеше старый набор иконок
REFS = [SRC / "global.css", SRC / "index.html"]

# иконки, которые приходят не из литералов в коде (например, с сервера) — добавлять сюда
EXTRA: set[str] = set()


def used_names(glyphs: set[str]) -> set[str]:
    found: set[str] = set()
    for p in SRC.rglob("*"):
        if "node_modules" in p.parts or p.suffix not in (".ts", ".tsx"):
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        # любые строковые литералы вида "snake_case" / 'name' / `name`
        for m in re.finditer(r"""["'`]([a-z][a-z0-9_]{1,40})["'`]""", text):
            if m.group(1) in glyphs:
                found.add(m.group(1))
    return found | (EXTRA & glyphs)


def missing_icons(glyphs: set[str]) -> dict[str, set[str]]:
    """иконки, явно указанные в коде (MSIcon name="…", icon="…", словари *_ICON), которых нет в шрифте —
    вместо них на экране будет слово"""
    pat = re.compile(r"""(?:MSIcon name=|icon[=:]\s*|name=\{[^}]*?)["']([a-z][a-z0-9_]+)["']""")
    out: dict[str, set[str]] = {}
    for p in SRC.rglob("*"):
        if "node_modules" in p.parts or p.suffix not in (".ts", ".tsx"):
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        found = [m.group(1) for m in pat.finditer(text)]
        for blk in re.findall(r"_ICON[^=]*=\s*\{([^}]*)\}", text):
            found += re.findall(r'"([a-z_]+)"', blk)
        for n in found:
            if n not in glyphs:
                out.setdefault(n, set()).add(str(p.relative_to(ROOT)))
    return out


def main() -> None:
    font = TTFont(FULL)
    glyphs = set(font.getGlyphOrder())
    for name, files in sorted(missing_icons(glyphs).items()):
        print(f"ВНИМАНИЕ: иконки «{name}» нет в Material Symbols ({', '.join(sorted(files))}) — на экране будет слово")
    names = used_names(glyphs)
    if not names:
        sys.exit("не найдено ни одной иконки — проверьте пути")
    keep = set(names)
    keep |= {f"{n}.fill" for n in names if f"{n}.fill" in glyphs}

    # оставить в GSUB только лигатуры, которые дают нужные иконки
    gsub = font["GSUB"].table
    for lookup in gsub.LookupList.Lookup:
        for st in lookup.SubTable:
            real = st.ExtSubTable if lookup.LookupType == 7 else st
            if getattr(real, "LookupType", None) == 4 or hasattr(real, "ligatures"):
                for first in list(real.ligatures):
                    ligs = [l for l in real.ligatures[first] if l.LigGlyph in keep]
                    if ligs:
                        real.ligatures[first] = ligs
                    else:
                        del real.ligatures[first]

    chars = "".join(sorted(set("".join(names)))) + "abcdefghijklmnopqrstuvwxyz0123456789_ "
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.flavor = "woff2"
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(text=chars, glyphs=sorted(keep))
    sub.subset(font)
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    font.flavor = "woff2"
    tmp = FONTS_DIR / "material-symbols-blin.tmp.woff2"
    font.save(tmp)
    digest = hashlib.sha1(tmp.read_bytes()).hexdigest()[:8]
    for old in FONTS_DIR.glob("material-symbols-blin.*.woff2"):
        if old != tmp:
            old.unlink()
    out = FONTS_DIR / f"material-symbols-blin.{digest}.woff2"
    tmp.rename(out)
    for ref in REFS:
        text = ref.read_text(encoding="utf-8")
        new = re.sub(r"material-symbols-blin\.[0-9a-f]{8}\.woff2", out.name, text)
        if new != text:
            ref.write_text(new, encoding="utf-8")
    print(f"{len(names)} иконок → {out.relative_to(ROOT)} ({out.stat().st_size // 1024} КБ)")
    print(" ".join(sorted(names)))


if __name__ == "__main__":
    main()

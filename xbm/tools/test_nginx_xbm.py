"""Тесты правки nginx для XBM: python3 xbm/tools/test_nginx_xbm.py"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nginx_xbm as nx  # noqa: E402

DOCS_RW = """upstream remnawave {
    server remnawave:3000;
}

upstream remnawave-subscription-page {
    server remnawave-subscription-page:3010;
}

server {
    server_name panel.example.com;
    listen 443 ssl;
    location / {
        proxy_pass http://remnawave;  # панель — её трогать нельзя
    }
}

server {
    server_name sub.example.com;
    listen 443 ssl;
    http2 on;

    location / {
        proxy_http_version 1.1;
        proxy_pass http://remnawave-subscription-page;
        proxy_set_header Host $host;
        # комментарий со скобкой { не ломает разбор
    }

    ssl_stapling on;
    resolver 1.1.1.1 valid=60s;
}

server {
    listen 80;
    server_name sub.example.com;
    return 301 https://$host$request_uri;
}
"""


def run() -> None:
    out = nx.enable(DOCS_RW, "sub.example.com")
    assert nx.is_enabled(out)
    # панель не тронута
    assert "proxy_pass http://remnawave;  # панель" in out
    assert out.count("proxy_pass http://$blinvpn_sub_backend;") == 1
    assert "default remnawave-subscription-page;" in out
    assert "xray-balancer-mw:4100;" in out
    assert "location @blinvpn_sub_orig {" in out
    # правка — в 443-блоке подписки (где есть location /), а не в редиректе с 80
    sub443 = out[out.index("server_name sub.example.com;\n    listen 443"):]
    assert "error_page 502 503 504 = @blinvpn_sub_orig;" in sub443.split("listen 80")[0]
    # обратимо байт в байт
    assert nx.disable(out) == DOCS_RW
    # повторно включить нельзя, выключить невключённое — без изменений
    try:
        nx.enable(out, "sub.example.com")
        raise AssertionError("повторное включение должно падать")
    except nx.NginxXbmError:
        pass
    assert nx.disable(DOCS_RW) == DOCS_RW
    # ошибки
    for bad_domain in ("nope.example.com", "sub.example.com;evil"):
        try:
            nx.enable(DOCS_RW, bad_domain)
            raise AssertionError(bad_domain)
        except nx.NginxXbmError:
            pass
    try:
        nx.enable(DOCS_RW, "sub.example.com", xbm="evil;host")
        raise AssertionError("xbm")
    except nx.NginxXbmError:
        pass
    # байт в байт: комментарий у proxy_pass, лишние пробелы, CRLF, комментарий после «}»
    tricky = DOCS_RW.replace("proxy_pass http://remnawave-subscription-page;",
                             "proxy_pass   http://remnawave-subscription-page:3010;  # note {x}").replace(
        "        # комментарий со скобкой { не ломает разбор\n    }", "        # комментарий со скобкой { не ломает разбор\n    }  # end loc")
    for variant in (tricky, tricky.replace("\n", "\r\n"), DOCS_RW.replace("\n", "\r\n")):
        on = nx.enable(variant, "sub.example.com")
        assert "default remnawave-subscription-page" in on
        assert nx.disable(on) == variant, "отключение должно вернуть файл байт в байт"
    assert "default remnawave-subscription-page:3010;" in nx.enable(tricky, "sub.example.com")
    # небезопасные случаи — отказ с понятным сообщением, файл не трогаем
    loc = "    location / {\n        proxy_http_version 1.1;\n        proxy_pass http://remnawave-subscription-page;"
    for bad, word in ((loc + "\n        resolver 8.8.8.8;", "resolver"),
                      (loc + "\n        location /x { return 200; }", "location"),
                      (loc + "\n        proxy_intercept_errors off;", "proxy_intercept_errors"),
                      ("    location / {\n        if ($x) { return 403; }\n        proxy_pass http://remnawave-subscription-page;", "if"),
                      ("    location / {\n        proxy_pass http://remnawave-subscription-page;}", "")):
        cfg = DOCS_RW.replace(loc, bad, 1) if word or True else DOCS_RW
        if cfg == DOCS_RW:
            cfg = DOCS_RW.replace("        proxy_pass http://remnawave-subscription-page;\n        proxy_set_header Host $host;\n        # комментарий со скобкой { не ломает разбор\n    }",
                                  "        proxy_pass http://remnawave-subscription-page;}")
        try:
            nx.enable(cfg, "sub.example.com")
            raise AssertionError(f"должен отказать: {word or 'одна строка'}")
        except nx.NginxXbmError:
            pass
    print("OK: nginx_xbm")


if __name__ == "__main__":
    run()

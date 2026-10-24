# BlinVPN 3.0 — edge-сервер (мини-апп, подписка, вебхуки).
# Файл генерируется автоматически (установка, смена доменов из панели). Руками не править:
# изменения перезапишутся. Шаблон: deploy/edge/nginx.conf.tpl

# VPN-клиенты → XBM, браузеры → страница подписки
map $http_user_agent $blin_sub_vpn {
    default 0;
    "~*(?:blinvpn|happ|streisand|v2raytun|v2ray|neko|foxray|v2box|xray|invisibleman|incy|clash|mihomo|flclash|flowvy|koala-clash|murge|nyanpasu|rabbithole|prizrak-box|hiddify|singbox|sing-box|karing|^sfa|^sfi|^sfm|^sft|stash|shadowrocket|quantumult|surge|loon|nekobox|nekoray)" 1;
}

limit_req_zone $binary_remote_addr zone=blin_api:20m rate=30r/s;
limit_req_zone $binary_remote_addr zone=blin_hook:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=blin_sub:20m rate=10r/s;
limit_req_status 429;

upstream blin_ingress {
    server {{INGRESS}} max_fails=0;
    keepalive 32;
}
upstream blin_miniapp {
    server 127.0.0.1:{{MINIAPP_PORT}};
    keepalive 16;
}
upstream blin_xbm {
    server 127.0.0.1:{{XBM_PORT}} max_fails=0;
    keepalive 16;
}
upstream blin_subpage {
    server 127.0.0.1:{{SUBPAGE_PORT}} max_fails=0;
    keepalive 16;
}

# запросы по IP и с чужими именами: TLS рвётся, по http — 444
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 444;
    }
}
server {
    listen 443 ssl http2 default_server;
    listen [::]:443 ssl http2 default_server;
    server_name _;
    {{DEFAULT_TLS}}
    return 444;
}

server {
    listen 80;
    listen [::]:80;
    server_name {{APP_DOMAIN}} {{SUB_DOMAIN}} {{HOOK_DOMAIN}};
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

# ── мини-приложение ───────────────────────────────────────────────
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{APP_DOMAIN}};

    ssl_certificate /etc/letsencrypt/live/{{APP_DOMAIN}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{APP_DOMAIN}}/privkey.pem;

    server_tokens off;
    client_max_body_size 1m;
    gzip on;
    gzip_proxied any;
    gzip_types application/json text/plain text/css application/javascript;

    # без x-frame-options: мини-апп открывается внутри Telegram
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    proxy_http_version 1.1;
    error_page 502 503 504 =503 /__blin_down.json;

    location = /__blin_down.json {
        internal;
        default_type application/json;
        add_header Cache-Control "no-store" always;
        # панель не отвечает (туннель/панель выключены): мини-апп покажет страницу техработ
        return 200 '{"detail":{"message":"Идут технические работы. Попробуйте позже"},"error":"Идут технические работы. Попробуйте позже","maintenance":"down"}';
    }

    location = /api/health {
        default_type application/json;
        access_log off;
        return 200 '{"ok":true}';
    }

    location = /api/app/support/upload {
        client_max_body_size 55m;
        limit_req zone=blin_api burst=20 nodelay;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 5s;
        proxy_next_upstream off;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Blin-Client-IP $remote_addr;
        proxy_set_header X-Edge-Token "{{EDGE_TOKEN}}";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Forwarded "";
        proxy_set_header X-Api-Key "";
        proxy_hide_header Server;
        proxy_pass http://blin_ingress;
    }

    # статус для страницы техработ: короткие таймауты, чтобы недоступная панель определялась быстро
    location = /api/app/status {
        limit_req zone=blin_api burst=30 nodelay;
        proxy_read_timeout 6s;
        proxy_connect_timeout 3s;
        proxy_next_upstream off;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Blin-Client-IP $remote_addr;
        proxy_set_header X-Edge-Token "{{EDGE_TOKEN}}";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Forwarded "";
        proxy_set_header X-Api-Key "";
        proxy_hide_header Server;
        proxy_pass http://blin_ingress;
    }

    location /api/app/ {
        limit_req zone=blin_api burst=60 nodelay;
        proxy_read_timeout 60s;
        proxy_connect_timeout 5s;
        proxy_next_upstream off;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Blin-Client-IP $remote_addr;
        proxy_set_header X-Edge-Token "{{EDGE_TOKEN}}";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Forwarded "";
        proxy_set_header X-Api-Key "";
        proxy_hide_header Server;
        proxy_pass http://blin_ingress;
    }

    location /api/support/file/ {
        limit_req zone=blin_api burst=60 nodelay;
        proxy_read_timeout 120s;
        proxy_connect_timeout 5s;
        proxy_next_upstream off;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Blin-Client-IP $remote_addr;
        proxy_set_header X-Edge-Token "{{EDGE_TOKEN}}";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Forwarded "";
        proxy_set_header X-Api-Key "";
        proxy_hide_header Server;
        proxy_pass http://blin_ingress;
    }

    # всё остальное под /api (панель, internal, telegram) с edge недоступно
    location /api/ {
        default_type application/json;
        return 404 '{"detail":{"message":"Not Found"},"error":"Not Found"}';
    }

    location = /redirect.html {
        access_log off;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_pass http://blin_miniapp;
    }

    location / {
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_pass http://blin_miniapp;
    }
}

# ── подписка: VPN-клиенты → XBM, браузеры → страница подписки ────
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{SUB_DOMAIN}};

    ssl_certificate /etc/letsencrypt/live/{{SUB_DOMAIN}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{SUB_DOMAIN}}/privkey.pem;

    server_tokens off;
    client_max_body_size 64k;
    gzip on;
    gzip_proxied any;
    gzip_types application/json text/plain text/css application/javascript text/yaml application/yaml;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;

    proxy_http_version 1.1;
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_next_upstream off;
    proxy_hide_header Server;
    proxy_hide_header X-XBM;

    location ~ "^/(?:sub/)?[A-Za-z0-9_-]{4,128}$" {
        limit_req zone=blin_sub burst=20 nodelay;
        set $blin_up blin_subpage;
        if ($blin_sub_vpn) {
            set $blin_up blin_xbm;
        }
        # XBM не ответил — отдаём обычную подписку через страницу подписки
        proxy_intercept_errors on;
        error_page 502 504 = @blin_subpage;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Blin-Client-IP $remote_addr;
        proxy_set_header X-Edge-Token "";
        proxy_set_header X-Api-Key "";
        proxy_pass http://$blin_up;
    }

    location @blin_subpage {
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Blin-Client-IP $remote_addr;
        proxy_set_header X-Edge-Token "";
        proxy_set_header X-Api-Key "";
        proxy_pass http://blin_subpage;
    }

    location / {
        limit_req zone=blin_sub burst=40 nodelay;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Blin-Client-IP $remote_addr;
        proxy_set_header X-Edge-Token "";
        proxy_set_header X-Api-Key "";
        proxy_pass http://blin_subpage;
    }
}

# ── вебхуки платёжек ──────────────────────────────────────────────
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{HOOK_DOMAIN}};

    ssl_certificate /etc/letsencrypt/live/{{HOOK_DOMAIN}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{HOOK_DOMAIN}}/privkey.pem;

    server_tokens off;
    client_max_body_size 64k;
    add_header Strict-Transport-Security "max-age=31536000" always;

    proxy_http_version 1.1;

    location ~ "^/(?:{{HOOK_RX}})$" {
        limit_req zone=blin_hook burst=30 nodelay;
        default_type application/json;
        # платёжки проверяют адрес GET-запросом — панель для этого не нужна
        if ($request_method = GET) {
            return 200 '{"ok":true}';
        }
        # тело передаётся байт-в-байт: подписи считаются по сырому телу
        proxy_request_buffering on;
        proxy_read_timeout 15s;
        proxy_connect_timeout 5s;
        proxy_next_upstream off;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header Accept-Encoding "";
        proxy_set_header X-Blin-Client-IP $remote_addr;
        proxy_set_header X-Edge-Token "{{EDGE_TOKEN}}";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Forwarded "";
        proxy_set_header X-Api-Key "";
        proxy_hide_header Server;
        proxy_pass http://blin_ingress;
    }

    location / {
        return 404;
    }
}

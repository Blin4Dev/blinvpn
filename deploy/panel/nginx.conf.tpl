# BlinVPN 3.0 — сервер панели.
# Файл генерируется автоматически (install.sh, sudo blinvpn domains). Руками не править.
# Шаблон: deploy/panel/nginx.conf.tpl
#
# Здесь только панель BlinVPN (и, если задан, домен UI Remnawave).
# Мини-приложение, подписка и вебхуки живут на edge-сервере и сюда не приходят никогда.

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
    server_name {{PANEL_DOMAIN}}{{RW_DOMAIN_SP}};
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{PANEL_DOMAIN}};

    ssl_certificate /etc/letsencrypt/live/{{PANEL_DOMAIN}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{PANEL_DOMAIN}}/privkey.pem;

    server_tokens off;
    # вложения поддержки и медиа рассылок: до 50 мб
    client_max_body_size 55m;
    gzip on;
    gzip_proxied any;
    gzip_types application/json text/plain text/css application/javascript application/manifest+json image/svg+xml;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    # no-referrer: адрес панели не уходит сайтам, на которые сотрудник перешёл по ссылке из чата
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" always;

    proxy_http_version 1.1;

    location = /robots.txt {
        default_type text/plain;
        return 200 "User-agent: *\nDisallow: /\n";
    }

    # мини-апп, internal-ручки и вебхук telegram на сервере панели закрыты
    location /api/app/ {
        return 404;
    }
    location /api/internal/ {
        return 404;
    }
    location /api/telegram/ {
        return 404;
    }

    location /api/ {
        proxy_read_timeout 120s;
        proxy_connect_timeout 5s;
        proxy_next_upstream off;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header True-Client-IP "";
        proxy_hide_header Server;
        proxy_pass http://127.0.0.1:{{API_PORT}};
    }

    location / {
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_pass http://127.0.0.1:{{PANEL_PORT}};
    }
}
{{RW_SERVER}}

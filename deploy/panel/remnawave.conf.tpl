
# ── UI Remnawave (по желанию; без этого блока Remnawave доступна только через SSH-туннель) ──
map $http_upgrade $blin_rw_connection {
    default upgrade;
    ""      close;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{RW_DOMAIN}};

    ssl_certificate /etc/letsencrypt/live/{{RW_DOMAIN}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{RW_DOMAIN}}/privkey.pem;

    server_tokens off;
    client_max_body_size 20m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;

    # подписки отдаёт только edge: с домена Remnawave они не открываются
    location /api/sub/ {
        return 404;
    }

    location / {
        proxy_http_version 1.1;
        proxy_read_timeout 120s;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $blin_rw_connection;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_pass http://127.0.0.1:{{RW_PORT}};
    }
}

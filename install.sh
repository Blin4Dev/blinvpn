#!/usr/bin/env bash
set -Eeuo pipefail

GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
RED=$'\033[0;31m'
NC=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'

log_info() { echo -e "${CYAN}$1${NC}"; }
log_warn() { echo -e "${YELLOW}$1${NC}"; }
log_success() { echo -e "${GREEN}$1${NC}"; }
log_error() { echo -e "${RED}$1${NC}" >&2; }

on_error() {
    log_error "Ошибка на строке $1. Установка прервана."
}
trap 'on_error $LINENO' ERR

# UTF-8-локаль: иначе Backspace в терминале стирает русскую букву не целиком (по байту),
# и в .env попадает «половина» символа — docker-compose потом падает с UnicodeDecodeError.
if locale -a 2>/dev/null | grep -qiE '^(C|en_US)\.utf-?8$'; then
    export LC_ALL="$(locale -a 2>/dev/null | grep -iE '^C\.utf-?8$' | head -n1)"
    [[ -z "$LC_ALL" ]] && export LC_ALL="$(locale -a 2>/dev/null | grep -iE '^en_US\.utf-?8$' | head -n1)"
fi

# Убирает битые байты (неполные UTF-8 символы), \r и пробелы по краям.
clean_input() {
    local v="$1"
    if command -v iconv >/dev/null 2>&1; then
        v="$(printf '%s' "$v" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null || printf '%s' "$v")"
    fi
    v="${v//$'\r'/}"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    printf '%s' "$v"
}

prompt() {
    local message="$1"
    local __var="$2"
    local value
    read -r -p "$message" value < /dev/tty
    value="$(clean_input "$value")"
    printf -v "$__var" '%s' "$value"
}

# prompt с проверкой: повторяет вопрос, пока ответ не подойдёт под регулярку.
# Пустой ответ допустим, только если allow_empty=1 (тогда подставится значение по умолчанию).
prompt_valid() {
    local message="$1" __var="$2" regex="$3" hint_text="$4" allow_empty="${5:-0}"
    local value
    while true; do
        read -r -p "$message" value < /dev/tty
        value="$(clean_input "$value")"
        if [[ -z "$value" && "$allow_empty" == "1" ]]; then break; fi
        if [[ "$value" =~ $regex ]]; then break; fi
        log_warn "     ✗ ${hint_text}. Попробуйте ещё раз (проверьте раскладку — нужны латинские буквы)."
    done
    printf -v "$__var" '%s' "$value"
}

# .env должен быть в чистом UTF-8, иначе docker-compose не запустится.
# Битые байты вырезаем (копия исходника сохраняется), строки с ними показываем.
ensure_env_utf8() {
    local f="${1:-.env}"
    [[ -f "$f" ]] || return 0
    command -v iconv >/dev/null 2>&1 || return 0
    if iconv -f UTF-8 -t UTF-8 "$f" >/dev/null 2>&1; then
        return 0
    fi
    local backup="${f}.broken-$(date +%Y%m%d-%H%M%S)"
    cp "$f" "$backup"
    log_warn "⚠️  В ${f} есть повреждённые символы (обычно — русская буква, стёртая наполовину при вводе)."
    log_warn "   Исходный файл сохранён: ${backup}. Проблемные строки:"
    local n=0 line
    while IFS= read -r line || [[ -n "$line" ]]; do
        n=$((n + 1))
        if ! printf '%s' "$line" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then
            # значение не печатаем — там могут быть секреты
            printf '     строка %s: %s\n' "$n" "$(printf '%s' "${line%%=*}" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)"
        fi
    done < "$f"
    iconv -f UTF-8 -t UTF-8 -c "$f" > "${f}.tmp" && cat "${f}.tmp" > "$f" && rm -f "${f}.tmp"
    chmod 600 "$f" 2>/dev/null || true
    log_warn "   Битые символы удалены. Проверьте значения в этих строках: sudo nano ${f}"
}

confirm() {
    local message="$1"
    local reply
    read -r -n1 -p "$message" reply < /dev/tty || true
    echo
    [[ "$reply" =~ ^[Yy]$ ]]
}

sanitize_domain() {
    local input="$1"
    echo "$input" \
        | sed -e 's%^https\?://%%' -e 's%/.*$%%' \
        | tr -cd 'A-Za-z0-9.-' \
        | tr '[:upper:]' '[:lower:]'
}

get_server_ip() {
    local ipv4_re='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
    local ip
    for url in \
        "https://api.ipify.org" \
        "https://ifconfig.co/ip" \
        "https://ipv4.icanhazip.com"; do
        ip=$(curl -fsS "$url" 2>/dev/null | tr -d '\r\n\t ')
        if [[ $ip =~ $ipv4_re ]]; then
            echo "$ip"
            return 0
        fi
    done
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [[ $ip =~ $ipv4_re ]]; then
        echo "$ip"
    fi
}

resolve_domain_ip() {
    local domain="$1"
    local ipv4_re='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
    local ip
    ip=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | head -n1)
    if [[ $ip =~ $ipv4_re ]]; then
        echo "$ip"
        return 0
    fi
    if command -v dig >/dev/null 2>&1; then
        ip=$(dig +short A "$domain" 2>/dev/null | grep -E "$ipv4_re" | head -n1)
        if [[ $ip =~ $ipv4_re ]]; then
            echo "$ip"
            return 0
        fi
    fi
    if command -v nslookup >/dev/null 2>&1; then
        ip=$(nslookup -type=A "$domain" 2>/dev/null | awk '/^Address: /{print $2; exit}')
        if [[ $ip =~ $ipv4_re ]]; then
            echo "$ip"
            return 0
        fi
    fi
    return 1
}

ensure_packages() {
    log_info "\nШаг 1: установка системных зависимостей"
    declare -A packages=(
        [git]='git'
        [docker]='docker.io'
        [nginx]='nginx'
        [curl]='curl'
        [certbot]='certbot'
        [dig]='dnsutils'
        [rsync]='rsync'
    )
    local missing=()
    for cmd in "${!packages[@]}"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            log_warn "«$cmd» не найден — устанавливаем пакет «${packages[$cmd]}»..."
            missing+=("${packages[$cmd]}")
        else
            log_success "✔ $cmd уже установлен."
        fi
    done
    if ((${#missing[@]})); then
        export DEBIAN_FRONTEND=noninteractive
        export DEBCONF_NONINTERACTIVE_SEEN=true
        sudo apt-get update
        sudo apt-get install -y --no-install-recommends "${missing[@]}"
        unset DEBIAN_FRONTEND
        unset DEBCONF_NONINTERACTIVE_SEEN
    else
        log_info "Все необходимые пакеты уже установлены."
    fi
}

# Docker Compose: предпочитаем v2 (`docker compose`). Старый docker-compose 1.29 (python)
# несовместим с новыми версиями Docker и сыпет ошибками вроде «KeyError: 'id'».
ensure_compose() {
    if sudo docker compose version >/dev/null 2>&1; then
        log_success "✔ Docker Compose v2 установлен."
        return 0
    fi
    log_warn "Docker Compose v2 не найден — устанавливаем…"
    export DEBIAN_FRONTEND=noninteractive
    sudo apt-get update -qq || true
    sudo apt-get install -y --no-install-recommends docker-compose-v2 2>/dev/null \
        || sudo apt-get install -y --no-install-recommends docker-compose-plugin 2>/dev/null || true
    unset DEBIAN_FRONTEND
    if ! sudo docker compose version >/dev/null 2>&1; then
        # Последний вариант — официальный бинарник плагина
        local arch; arch="$(uname -m)"; [[ "$arch" == "aarch64" ]] && arch="aarch64" || arch="x86_64"
        sudo mkdir -p /usr/local/lib/docker/cli-plugins
        sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
            -o /usr/local/lib/docker/cli-plugins/docker-compose && sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose || true
    fi
    if sudo docker compose version >/dev/null 2>&1; then
        log_success "✔ Docker Compose v2 установлен."
    elif command -v docker-compose >/dev/null 2>&1; then
        log_warn "Не удалось поставить Compose v2 — работаю через старый docker-compose."
    else
        log_error "Docker Compose не установлен. Установите пакет docker-compose-v2 и запустите снова."
        exit 1
    fi
}

# Обёртка: v2, если есть, иначе старый docker-compose.
dc() {
    if sudo docker compose version >/dev/null 2>&1; then
        sudo docker compose "$@"
    else
        sudo docker-compose "$@"
    fi
}

ensure_services() {
    for service in docker nginx; do
        if ! sudo systemctl is-active --quiet "$service"; then
            log_warn "Сервис $service не запущен — запускаем..."
            sudo systemctl enable "$service"
            sudo systemctl start "$service"
        else
            log_success "✔ сервис $service активен."
        fi
    done
}

ensure_certbot_nginx() {
    log_info "\nПроверка плагина Certbot"

    local has_nginx_plugin=0
    if command -v certbot >/dev/null 2>&1; then
        if certbot plugins 2>/dev/null | grep -qi 'nginx'; then
            has_nginx_plugin=1
        fi
    fi

    if [[ $has_nginx_plugin -eq 1 ]]; then
        log_success "✔ плагин nginx для Certbot найден."
        return
    fi

    if command -v apt-get >/dev/null 2>&1; then
        log_info "Устанавливаю python3-certbot-nginx..."
        export DEBIAN_FRONTEND=noninteractive
        export DEBCONF_NONINTERACTIVE_SEEN=true
        sudo apt-get update
        if sudo apt-get install -y --no-install-recommends python3-certbot-nginx; then
            if certbot plugins 2>/dev/null | grep -qi 'nginx'; then
                log_success "✔ плагин nginx для Certbot установлен (apt)."
                unset DEBIAN_FRONTEND
                unset DEBCONF_NONINTERACTIVE_SEEN
                return
            fi
        fi
        unset DEBIAN_FRONTEND
        unset DEBCONF_NONINTERACTIVE_SEEN
    fi

    log_warn "Пробую установить Certbot через snap..."
    if ! command -v snap >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        sudo apt-get update
        sudo apt-get install -y --no-install-recommends snapd
        unset DEBIAN_FRONTEND
    fi
    sudo snap install core || true
    sudo snap refresh core || true
    sudo snap install --classic certbot
    sudo ln -sf /snap/bin/certbot /usr/bin/certbot

    if certbot plugins 2>/dev/null | grep -qi 'nginx'; then
        log_success "✔ плагин nginx для Certbot доступен (snap)."
        return
    fi

    log_error "Плагин nginx для Certbot недоступен."
    exit 1
}

# Общий блок проксирования webhook → сервис webhook:5000
_webhook_location() {
    local path="$1"
    cat <<EOF
    location ${path} {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
EOF
}

configure_nginx() {
    local miniapp_domain="$1"
    local panel_domain="$2"
    local nginx_conf="$3"
    local nginx_link="$4"

    log_info "\nНастройка Nginx (HTTPS :443)"
    sudo rm -f /etc/nginx/sites-enabled/default

    sudo tee "$nginx_conf" >/dev/null <<EOF
# HTTP → HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name ${miniapp_domain} ${panel_domain};
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

# Мини-приложение + API + payment webhooks
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${miniapp_domain};

    ssl_certificate /etc/letsencrypt/live/${miniapp_domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${miniapp_domain}/privkey.pem;

    # Заголовки безопасности (мини-апп должен открываться внутри Telegram, поэтому без X-Frame-Options)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://127.0.0.1:9741;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
        proxy_connect_timeout 15s;
    }

    location ~* \\.(js|css|woff2?|png|jpg|svg|ico)$ {
        proxy_pass http://127.0.0.1:9741;
        proxy_set_header Host \$host;
        add_header Cache-Control "public, max-age=86400";
    }

    # Внутренние service-to-service ручки недоступны снаружи.
    location /api/internal {
        return 404;
    }

    # API панели доступен только на домене панели.
    location /api/panel {
        return 404;
    }

    # Переходник deep-link: в адресе зашифрованная ссылка на подписку — не пишем в лог.
    location = /redirect.html {
        access_log off;
        proxy_pass http://127.0.0.1:9741;
        proxy_set_header Host \$host;
    }

    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

$(_webhook_location /platega)
}

# Панель управления
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${panel_domain};

    ssl_certificate /etc/letsencrypt/live/${panel_domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${panel_domain}/privkey.pem;

    # Заголовки безопасности панели (кликджекинг, sniffing, HSTS)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api/internal {
        return 404;
    }

    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:9742;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

    sudo rm -f "$nginx_link"
    sudo ln -s "$nginx_conf" "$nginx_link"
    sudo nginx -t
    sudo systemctl reload nginx
    log_success "✔ конфигурация Nginx обновлена."
}

section() {
    local title="$1"
    local width=62
    local pad=$(( (width - ${#title} - 2) / 2 ))
    printf '\n'
    printf "${CYAN}╭%s╮${NC}\n" "$(printf '─%.0s' $(seq 1 $width))"
    printf "${CYAN}│${NC}%*s${BOLD}%s${NC}%*s${CYAN}│${NC}\n" \
        $((pad + 1)) "" "$title" $((width - pad - ${#title} - 1)) ""
    printf "${CYAN}╰%s╯${NC}\n" "$(printf '─%.0s' $(seq 1 $width))"
}

step() {
    printf "  ${GREEN}%s${NC}  %s\n" "$1" "$2"
}

hint() {
    printf "     ${DIM}↳ %s${NC}\n" "$1"
}

gen_secret_hex() {
    openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p
}

# ── Почта: выбор способа отправки (коды входа на сайт и email-рассылки) ──
# Проще всего — через обычный почтовый ящик (Яндекс/Mail.ru/Gmail) по SMTP.
# Прямая отправка со своего сервера требует открытого порта 25 и DNS-записей.
MAIL_ENABLED="0"; MAIL_DOMAIN=""; MAIL_FROM=""; MAIL_FROM_NAME="BlinVPN"
MAIL_SMTP_HOST=""; MAIL_SMTP_PORT=""; MAIL_SMTP_USER=""; MAIL_SMTP_PASSWORD=""
DKIM_SELECTOR="mail"; DKIM_PRIVATE_KEY_PATH=""

# Проверка входа в SMTP (python3 есть в любой Ubuntu/Debian). Печатает ошибку, код 0/1.
smtp_login_test() {
    command -v python3 >/dev/null 2>&1 || return 0
    python3 - "$1" "$2" "$3" "$4" <<'PY'
import smtplib, ssl, sys
host, port, user, pwd = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
try:
    ctx = ssl.create_default_context()
    if port == 465:
        s = smtplib.SMTP_SSL(host, port, timeout=15, context=ctx)
    else:
        s = smtplib.SMTP(host, port, timeout=15); s.ehlo(); s.starttls(context=ctx); s.ehlo()
    s.login(user, pwd); s.quit()
except smtplib.SMTPAuthenticationError:
    print("неверный логин или пароль (нужен именно пароль приложения, а не обычный пароль от почты)"); sys.exit(1)
except Exception as e:
    print(f"{type(e).__name__}: {e}"); sys.exit(1)
PY
}

# Открыт ли исходящий порт 25 (многие хостинги его закрывают).
port25_open() {
    timeout 6 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null
}

choose_mail_mode() {
    local default_domain="$1" choice provider host port user pass err
    section "Почта (коды входа на сайт и email-рассылки)"
    echo -e "  Нужна, чтобы люди могли входить на сайт по почте. Как отправлять письма?"
    step "1)" "Через почтовый ящик — Яндекс, Mail.ru или Gmail ${DIM}(проще всего, рекомендуем)${NC}"
    step "2)" "Напрямую с этого сервера ${DIM}(нужен открытый порт 25 и DNS-записи)${NC}"
    step "3)" "Не отправлять ${DIM}(вход только через Telegram; включить можно позже)${NC}"
    prompt "  Ваш выбор [1/2/3] (Enter = 1): " choice
    choice="${choice:-1}"

    if [[ "$choice" == "3" ]]; then
        MAIL_ENABLED="0"; MAIL_DOMAIN="$default_domain"; MAIL_FROM="no-reply@${default_domain}"
        return 0
    fi

    if [[ "$choice" == "2" ]]; then
        log_info "  Проверяю, открыт ли исходящий порт 25…"
        if ! port25_open; then
            log_warn "  ✗ Порт 25 закрыт хостингом — напрямую письма не дойдут."
            if confirm "  Настроить отправку через почтовый ящик? (y/n): "; then
                choice="1"
            else
                log_warn "  Оставляю прямую отправку. Попросите хостинг открыть порт 25 или позже выберите «Настроить почту»."
            fi
        else
            log_success "  ✔ Порт 25 открыт."
        fi
        if [[ "$choice" == "2" ]]; then
            MAIL_ENABLED="1"
            prompt "  ${BOLD}Домен для писем${NC} (по умолч. ${default_domain}): " MAIL_DOMAIN
            MAIL_DOMAIN="$(sanitize_domain "${MAIL_DOMAIN:-$default_domain}")"; MAIL_DOMAIN="${MAIL_DOMAIN:-$default_domain}"
            MAIL_FROM="no-reply@${MAIL_DOMAIN}"
            DKIM_PRIVATE_KEY_PATH="data/dkim/${MAIL_DOMAIN}.private"
            return 0
        fi
    fi

    # ── Через почтовый ящик (SMTP) ──
    echo
    step "1)" "Яндекс Почта (в т.ч. почта на своём домене в Яндекс 360)"
    step "2)" "Mail.ru"
    step "3)" "Gmail"
    step "4)" "Другой SMTP-сервер"
    prompt "  Где почтовый ящик? [1-4] (Enter = 1): " provider
    provider="${provider:-1}"
    case "$provider" in
        2) host="smtp.mail.ru"; port="465"
           hint "Пароль приложения: Mail.ru → Настройки → Безопасность → «Пароли для внешних приложений»." ;;
        3) host="smtp.gmail.com"; port="465"
           hint "Нужна двухэтапная аутентификация. Пароль приложения: myaccount.google.com/apppasswords" ;;
        4) prompt_valid "  ${BOLD}SMTP-сервер${NC} (например smtp.example.com): " host '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' "Имя сервера вида smtp.example.com"
           prompt_valid "  ${BOLD}Порт${NC} (465 или 587, Enter = 465): " port '^(465|587|25|2525)$' "Порт 465 или 587" 1
           port="${port:-465}" ;;
        *) host="smtp.yandex.ru"; port="465"
           hint "Пароль приложения: id.yandex.ru → Безопасность → «Пароли приложений» → Почта." ;;
    esac
    while true; do
        prompt_valid "  ${BOLD}Адрес почты${NC} (с него уйдут письма): " user '^[^@[:space:]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' "Адрес вида name@yandex.ru"
        read -r -s -p "  ${BOLD}Пароль приложения${NC} (ввод скрыт): " pass < /dev/tty; echo
        pass="$(clean_input "$pass")"; pass="${pass// /}"   # Google показывает пароль с пробелами
        log_info "  Проверяю вход в ${host}…"
        if err="$(smtp_login_test "$host" "$port" "$user" "$pass")"; then
            log_success "  ✔ Вход в почту работает."
            break
        fi
        log_warn "  ✗ Не удалось войти: ${err}"
        confirm "  Ввести заново? (y — да, n — сохранить как есть) " || break
    done
    MAIL_ENABLED="1"
    MAIL_SMTP_HOST="$host"; MAIL_SMTP_PORT="$port"; MAIL_SMTP_USER="$user"; MAIL_SMTP_PASSWORD="$pass"
    MAIL_FROM="$user"; MAIL_DOMAIN="${user##*@}"
    DKIM_PRIVATE_KEY_PATH=""
}

# Для существующей установки: «Настроить почту» из меню install.sh
mail_setup_flow() {
    local d
    d="$(get_env_var MINIAPP_DOMAIN .env 2>/dev/null || true)"
    choose_mail_mode "${d:-example.com}"
    set_env_var MAIL_ENABLED "$MAIL_ENABLED" .env
    set_env_var MAIL_DOMAIN "$MAIL_DOMAIN" .env
    set_env_var MAIL_FROM "$MAIL_FROM" .env
    set_env_var MAIL_FROM_NAME "$MAIL_FROM_NAME" .env
    set_env_var MAIL_SMTP_HOST "$MAIL_SMTP_HOST" .env
    set_env_var MAIL_SMTP_PORT "$MAIL_SMTP_PORT" .env
    set_env_var MAIL_SMTP_USER "$MAIL_SMTP_USER" .env
    set_env_var MAIL_SMTP_PASSWORD "$MAIL_SMTP_PASSWORD" .env
    set_env_var DKIM_SELECTOR "$DKIM_SELECTOR" .env
    set_env_var DKIM_PRIVATE_KEY_PATH "$DKIM_PRIVATE_KEY_PATH" .env
    chmod 600 .env 2>/dev/null || true
    if [[ "$MAIL_ENABLED" == "1" && -z "$MAIL_SMTP_HOST" ]]; then
        setup_mail_server || true
    fi
    ensure_env_utf8 .env
    log_info "Перезапускаю сервисы, чтобы применить настройки почты…"
    dc up -d api webhook bot 2>/dev/null || dc up -d
    log_success "✔ Почта настроена."
    print_mail_dns
}

create_env_file() {
    local domain="$1"
    local panel_domain="$2"
    local email="$3"

    section "Настройка переменных окружения"

    section "Основной Telegram-бот"
    prompt_valid "  ${BOLD}Токен бота${NC}  (основной бот): " TELEGRAM_BOT_TOKEN \
        '^[0-9]{5,}:[A-Za-z0-9_-]{30,}$' "Токен выглядит так: 1234567890:AAH…, его выдаёт @BotFather"
    prompt_valid "  ${BOLD}ID админа${NC}   (ваш Telegram ID): " TELEGRAM_ADMIN_ID \
        '^[0-9]{3,15}$' "ID — только цифры (узнать можно у @userinfobot)"
    prompt_valid "  ${BOLD}Username бота${NC} (без @, по умолч. blinvpn_bot): " BOT_USERNAME_INPUT \
        '^@?[A-Za-z0-9_]{3,32}$' "Username — латиница, цифры и _" 1
    BOT_USERNAME="${BOT_USERNAME_INPUT:-blinvpn_bot}"
    BOT_USERNAME="${BOT_USERNAME#@}"

    # Форум-группа для служебных уведомлений настраивается в ПАНЕЛИ
    # (Настройки → Форум), а не здесь.

    section "Remnawave · панель VPN"
    prompt_valid "  ${BOLD}Panel URL${NC}  (по умолч. http://localhost:3000): " REMWAVE_PANEL_URL_INPUT \
        '^https?://[A-Za-z0-9._:/-]+$' "Адрес вида https://panel.example.com" 1
    REMWAVE_PANEL_URL="${REMWAVE_PANEL_URL_INPUT:-http://localhost:3000}"
    REMWAVE_PANEL_URL="${REMWAVE_PANEL_URL%/}"
    prompt_valid "  ${BOLD}API Token${NC}  (из панели Remnawave): " REMWAVE_API_KEY \
        '^[!-~]{10,}$' "Токен — латинские символы без пробелов (Remnawave → API Tokens)"

    choose_mail_mode "$domain"

    TELEGRAM_WEBHOOK_SECRET="$(gen_secret_hex)"
    PANEL_SETUP_TOKEN="$(gen_secret_hex)"
    INTERNAL_API_SECRET="$(gen_secret_hex)"
    MONITOR_SECRET_KEY="$(gen_secret_hex)"

    cat > .env <<EOF
# ===== Telegram =====
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_ADMIN_ID=${TELEGRAM_ADMIN_ID}
BOT_USERNAME=${BOT_USERNAME}
VITE_BOT_USERNAME=${BOT_USERNAME}

# Форум-группа уведомлений настраивается в панели (Настройки → Форум).

# Ссылка на поддержку
SUPPORT_URL=https://t.me/blinteams
VITE_SUPPORT_URL=https://t.me/blinteams

# ===== Remnawave =====
REMWAVE_PANEL_URL=${REMWAVE_PANEL_URL}
REMWAVE_API_KEY=${REMWAVE_API_KEY}

# ===== Платежи: Platega / Telegram Stars =====
# Ключи можно дописать позже в .env или в панели.

# Platega
PLATEGA_API_URL=https://app.platega.io
PLATEGA_MERCHANT_ID=
PLATEGA_SECRET_KEY=
PLATEGA_RETURN_URL=https://${domain}/payment/waiting
PLATEGA_FAILED_URL=https://${domain}/payment/waiting

# Telegram Stars: bot = polling (рекомендуется), webhook = /api/telegram/webhook
TELEGRAM_STARS_DELIVERY=bot

# ===== Почта (коды входа на сайт и рассылки) =====
# Если задан MAIL_SMTP_HOST — письма уходят через почтовый ящик (SMTP),
# иначе — напрямую на MX получателя с DKIM-подписью (нужен открытый порт 25).
# Перенастроить: sudo bash install.sh → «Настроить почту».
MAIL_ENABLED=${MAIL_ENABLED}
MAIL_DOMAIN=${MAIL_DOMAIN}
MAIL_FROM=${MAIL_FROM}
MAIL_FROM_NAME=${MAIL_FROM_NAME}
MAIL_SMTP_HOST=${MAIL_SMTP_HOST}
MAIL_SMTP_PORT=${MAIL_SMTP_PORT}
MAIL_SMTP_USER=${MAIL_SMTP_USER}
MAIL_SMTP_PASSWORD=${MAIL_SMTP_PASSWORD}
DKIM_SELECTOR=${DKIM_SELECTOR}
DKIM_PRIVATE_KEY_PATH=${DKIM_PRIVATE_KEY_PATH}

# ===== URLs =====
MINIAPP_URL=https://${domain}
PANEL_URL=https://${panel_domain}
WEBHOOK_URL=https://${domain}
API_URL=https://${domain}/api

# Внутренние порты сервисов
API_PORT=8000
WEBHOOK_PORT=5000
MINIAPP_PORT=9741
PANEL_PORT=9742

# Database
DB_PATH=data/data.db

# ===== Security =====
ENV=production
CORS_ORIGINS=https://${domain},https://${panel_domain},https://web.telegram.org
# (сайта нет — лендинг в CORS не добавляется)
TELEGRAM_INITDATA_MAX_AGE=86400
TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}
PANEL_SETUP_TOKEN=${PANEL_SETUP_TOKEN}
INTERNAL_API_SECRET=${INTERNAL_API_SECRET}
# Ключ шифрования секретов нод мониторинга в базе (не менять — иначе ключи нод придётся перевыпустить)
MONITOR_SECRET_KEY=${MONITOR_SECRET_KEY}
MINIAPP_ALLOW_UNAUTH=0

# SSL / домены
SSL_EMAIL=${email}
MINIAPP_DOMAIN=${domain}
PANEL_DOMAIN=${panel_domain}
WEBHOOK_DOMAIN=${domain}
EOF

    # .env содержит все секреты (токены, ключи Platega, INTERNAL_API_SECRET) —
    # доступ только владельцу.
    chmod 600 .env 2>/dev/null || true
    log_success "✔ Файл .env создан (права 600)."
    log_warn "\n⚠️  Логин и пароль панели будут показаны ниже, после запуска (один раз)."
    log_warn "⚠️  Платежи (Platega, Telegram Stars) — ключи в .env или в панели."
}

# ─────────────────────────────────────────────────────────────
# Почтовый сервер: локальный Postfix (send-only) + OpenDKIM.
# Печатает DNS-записи (SPF, DKIM, DMARC), которые нужно добавить.
# Все шаги защищены — сбой почты не роняет установку.
# ─────────────────────────────────────────────────────────────
DKIM_DNS_RECORD=""      # заполняется для финального вывода
MAIL_SERVER_DOMAIN=""

setup_mail_server() {
    local maildomain selector keydir pubkey
    [[ "$(get_env_var MAIL_ENABLED 2>/dev/null || echo 0)" == "1" ]] || return 0
    [[ -z "$(get_env_var MAIL_SMTP_HOST 2>/dev/null || true)" ]] || return 0   # через почтовый ящик DKIM не нужен
    maildomain="$(get_env_var MAIL_DOMAIN 2>/dev/null || true)"
    [[ -n "$maildomain" ]] || { log_warn "MAIL_DOMAIN не задан — почта пропущена."; return 0; }

    section "Почта (DKIM-ключ для прямой отправки)"
    selector="$(get_env_var DKIM_SELECTOR 2>/dev/null || echo mail)"
    # Запускается уже внутри каталога проекта → ключ в ./data/dkim.
    keydir="$(pwd)/data/dkim"
    MAIL_SERVER_DOMAIN="$maildomain"

    mkdir -p "$keydir"
    if [[ ! -f "${keydir}/${maildomain}.private" ]]; then
        log_info "Генерирую DKIM-ключ (openssl, 2048 бит)…"
        openssl genrsa -out "${keydir}/${maildomain}.private" 2048 2>/dev/null || {
            log_warn "openssl genrsa не отработал — почта без подписи."; return 0; }
    fi
    openssl rsa -in "${keydir}/${maildomain}.private" -pubout -out "${keydir}/${maildomain}.public" 2>/dev/null || true
    chmod 600 "${keydir}/${maildomain}.private" 2>/dev/null || true
    # Ключ читает контейнер (том ./data:/app/data), владелец — как у остальной data.
    sudo chown -R 1000:1000 "$keydir" 2>/dev/null || true

    # Публичный ключ в одну строку → значение DKIM TXT-записи.
    pubkey="$(grep -v '^-----' "${keydir}/${maildomain}.public" 2>/dev/null | tr -d '\n\r ' || true)"
    if [[ -n "$pubkey" ]]; then
        DKIM_DNS_RECORD="v=DKIM1; k=rsa; p=${pubkey}"
    fi
    log_success "✔ DKIM-ключ готов: data/dkim/${maildomain}.private"
    return 0
}

print_mail_dns() {
    local maildomain serverip selector
    [[ "$(get_env_var MAIL_ENABLED 2>/dev/null || echo 0)" == "1" ]] || return 0
    if [[ -n "$(get_env_var MAIL_SMTP_HOST 2>/dev/null || true)" ]]; then
        printf "\n  ${GREEN}✔ Почта: письма уходят через %s (%s)${NC}\n" \
            "$(get_env_var MAIL_SMTP_HOST 2>/dev/null)" "$(get_env_var MAIL_SMTP_USER 2>/dev/null)"
        return 0
    fi
    maildomain="$(get_env_var MAIL_DOMAIN 2>/dev/null || true)"
    [[ -n "$maildomain" ]] || return 0
    selector="$(get_env_var DKIM_SELECTOR 2>/dev/null || echo mail)"
    serverip="${SERVER_IP:-$(get_server_ip 2>/dev/null || true)}"

    printf "\n${GREEN}───────────────────────────────────────────────────────────────${NC}\n"
    printf "${BOLD}  DNS-записи для почты (${maildomain}) — добавьте у регистратора${NC}\n"
    printf "${GREEN}───────────────────────────────────────────────────────────────${NC}\n"
    printf "  ${BOLD}SPF${NC}   (TXT, хост @):\n    ${YELLOW}v=spf1 a mx ip4:%s ~all${NC}\n" "${serverip:-ВАШ_IP}"
    printf "  ${BOLD}DMARC${NC} (TXT, хост _dmarc):\n    ${YELLOW}v=DMARC1; p=none; rua=mailto:postmaster@%s${NC}\n" "$maildomain"
    if [[ -n "$DKIM_DNS_RECORD" ]]; then
        printf "  ${BOLD}DKIM${NC}  (TXT, хост %s._domainkey):\n    ${YELLOW}%s${NC}\n" "$selector" "$DKIM_DNS_RECORD"
    else
        printf "  ${BOLD}DKIM${NC}  (TXT, хост %s._domainkey):\n    ${YELLOW}из data/dkim/%s.public${NC}\n" "$selector" "$maildomain"
    fi
    printf "  ${BOLD}PTR${NC}   (обратная запись): попросите хостинг указать %s → mail.%s\n" "${serverip:-ВАШ_IP}" "$maildomain"
    printf "  ${DIM}После добавления записей письма не будут попадать в спам.${NC}\n"
    printf "  ${DIM}Важно: у хостинга должен быть открыт исходящий порт 25.${NC}\n"
}

# Stars по умолчанию через bot polling. Webhook на API — только если TELEGRAM_STARS_DELIVERY=webhook.
register_telegram_webhook() {
    local bot_token="$1"
    local domain="$2"

    if [[ "${TELEGRAM_STARS_DELIVERY:-bot}" == "bot" ]]; then
        log_info "\nTelegram Stars: режим bot (polling) — webhook на API не регистрируется."
        hint "Для webhook-режима: TELEGRAM_STARS_DELIVERY=webhook в .env"
        return 0
    fi

    if [[ -z "$bot_token" ]]; then
        log_warn "TELEGRAM_BOT_TOKEN не задан — регистрация webhook пропущена."
        return 0
    fi

    local webhook_url="https://${domain}/api/telegram/webhook"
    local allowed_updates='["message","callback_query","pre_checkout_query","shipping_query"]'
    local secret_token
    secret_token="$(get_env_var TELEGRAM_WEBHOOK_SECRET .env 2>/dev/null || true)"
    if [[ -z "$secret_token" ]]; then
        secret_token="$(gen_secret_hex)"
        set_env_var TELEGRAM_WEBHOOK_SECRET "$secret_token" .env 2>/dev/null || true
    fi

    log_info "\nРегистрация Telegram webhook (Stars)..."
    log_info "  URL: ${webhook_url}"

    local response http_code body
    local payload
    payload=$(printf '{"url":"%s","allowed_updates":%s,"secret_token":"%s"}' \
        "$webhook_url" "$allowed_updates" "$secret_token")
    response=$(curl -s -w "\n%{http_code}" -X POST \
        "https://api.telegram.org/bot${bot_token}/setWebhook" \
        -H "Content-Type: application/json" \
        -d "${payload}" \
        --max-time 15 2>/dev/null || true)

    body=$(echo "$response" | head -n -1)
    http_code=$(echo "$response" | tail -n1)

    if echo "$body" | grep -q '"ok":true'; then
        log_success "✔ Telegram webhook зарегистрирован."
    else
        log_warn "Не удалось зарегистрировать Telegram webhook (HTTP ${http_code})."
        log_warn "  Ответ: ${body}"
    fi
}

print_payment_webhooks() {
    local domain="$1"
    printf "\n"
    printf "${GREEN}───────────────────────────────────────────────────────────────${NC}\n"
    printf "${BOLD}  Payment webhooks${NC}\n"
    printf "${GREEN}───────────────────────────────────────────────────────────────${NC}\n"
    printf "  Platega:          ${YELLOW}https://%s/platega${NC}\n" "$domain"
    printf "  Telegram Stars:   ${YELLOW}bot polling${NC} (или /api/telegram/webhook)\n"
    printf "\n"
}

get_env_var() {
    local key="$1"
    local file="${2:-.env}"
    [[ -f "$file" ]] || return 1
    local line
    line=$(grep -E "^${key}=" "$file" | tail -n1) || true
    [[ -n "$line" ]] || return 1
    printf '%s' "${line#*=}"
}

set_env_var() {
    local key="$1"
    local val="$2"
    local file="${3:-.env}"
    local esc="$val"
    esc=${esc//\\/\\\\}
    esc=${esc//&/\\&}
    esc=${esc//|/\\|}
    if grep -qE "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${esc}|" "$file"
    else
        printf '%s=%s\n' "$key" "$val" >> "$file"
    fi
}

ensure_env_var() {
    local key="$1"
    local val="$2"
    local file="${3:-.env}"
    local cur=""
    cur="$(get_env_var "$key" "$file" 2>/dev/null || true)"
    if [[ -z "$cur" ]]; then
        set_env_var "$key" "$val" "$file"
        return 0
    fi
    return 1
}

build_cors_origins_from_env() {
    local file="${1:-.env}"
    local origins=()
    local u key
    for key in MINIAPP_URL PANEL_URL; do
        u="$(get_env_var "$key" "$file" 2>/dev/null || true)"
        u="${u%/}"
        if [[ -n "$u" ]]; then
            origins+=("$u")
        fi
    done
    origins+=("https://web.telegram.org")
    local IFS=,
    printf '%s' "${origins[*]}"
}

fix_container_data_permissions() {
    mkdir -p data src/monitoring/logs
    # Даём контейнеру (gid 1000) доступ, но НЕ ослабляем секреты: DKIM-ключ и БД
    # с хэшами/сессиями не должны становиться доступны кому-то ещё на хосте.
    chmod 750 data 2>/dev/null || true
    # Контейнеры теперь работают под uid/gid 1000 — отдаём им владение data.
    sudo chown -R 1000:1000 data src/monitoring/logs 2>/dev/null || chown -R 1000:1000 data src/monitoring/logs 2>/dev/null || true
    chmod -R u+rwX,g+rwX data src/monitoring/logs 2>/dev/null || true
    # Ужесточаем секреты обратно после рекурсивного chmod.
    [ -d data/dkim ] && chmod 700 data/dkim 2>/dev/null || true
    find data/dkim -type f -name '*.private' -exec chmod 600 {} \; 2>/dev/null || true
    [ -f data/data.db ] && chmod 640 data/data.db 2>/dev/null || true
    find data/backups -type f -name '*.db' -exec chmod 640 {} \; 2>/dev/null || true
    chmod o-rwx data 2>/dev/null || true
}

migrate_security_update() {
    local file="${1:-.env}"
    if [[ ! -f "$file" ]]; then
        log_warn "Файл ${file} не найден — миграция пропущена."
        return 0
    fi

    section "Миграция .env"

    local secret
    if ensure_env_var TELEGRAM_INITDATA_MAX_AGE "86400" "$file"; then
        log_info "  + TELEGRAM_INITDATA_MAX_AGE=86400"
    fi

    secret="$(gen_secret_hex)"
    if ensure_env_var TELEGRAM_WEBHOOK_SECRET "$secret" "$file"; then
        log_info "  + TELEGRAM_WEBHOOK_SECRET сгенерирован"
    fi

    secret="$(gen_secret_hex)"
    if ensure_env_var PANEL_SETUP_TOKEN "$secret" "$file"; then
        log_info "  + PANEL_SETUP_TOKEN сгенерирован"
        log_warn "    Сброс пароля панели: https://<панель>/#setup_token=$(get_env_var PANEL_SETUP_TOKEN "$file")&reset=1"
    fi

    secret="$(gen_secret_hex)"
    if ensure_env_var INTERNAL_API_SECRET "$secret" "$file"; then
        log_info "  + INTERNAL_API_SECRET сгенерирован"
    fi

    secret="$(gen_secret_hex)"
    if ensure_env_var MONITOR_SECRET_KEY "$secret" "$file"; then
        log_info "  + MONITOR_SECRET_KEY сгенерирован (шифрование ключей нод мониторинга)"
    fi

    if ensure_env_var TELEGRAM_STARS_DELIVERY "bot" "$file"; then
        log_info "  + TELEGRAM_STARS_DELIVERY=bot"
    fi

    local cors
    cors="$(get_env_var CORS_ORIGINS "$file" 2>/dev/null || true)"
    if [[ -z "$cors" ]]; then
        cors="$(build_cors_origins_from_env "$file")"
        set_env_var CORS_ORIGINS "$cors" "$file"
        log_info "  + CORS_ORIGINS=${cors}"
    fi

    if ensure_env_var ENV "production" "$file"; then
        log_info "  + ENV=production"
    fi

    local unauth
    unauth="$(get_env_var MINIAPP_ALLOW_UNAUTH "$file" 2>/dev/null || true)"
    if [[ "${unauth,,}" =~ ^(1|true|yes)$ ]]; then
        set_env_var MINIAPP_ALLOW_UNAUTH "0" "$file"
        log_warn "  ! MINIAPP_ALLOW_UNAUTH отключён (нельзя в production)"
    fi

    # Убрать устаревшие ключи из прошлых проектов (не критично, если их нет)
    for stale in \
        HELEKET_API_URL HELEKET_MERCHANT HELEKET_API_KEY \
        PAYPEAR_RETURN_URL PAYPEAR_WEBHOOK_URL PAYPEAR_API_KEY PAYPEAR_MERCHANT \
        ROLLYPAY_API_URL ROLLYPAY_API_KEY \
        CRYPTOPAY_API_TOKEN CRYPTOPAY_WEBHOOK_URL \
        SSL_PORT; do
        if grep -qE "^${stale}=" "$file" 2>/dev/null; then
            sed -i "/^${stale}=/d" "$file"
            log_info "  − удалён устаревший ${stale}"
        fi
    done

    fix_container_data_permissions
    log_success "✔ миграция завершена."
}

obtain_certificates() {
    local email="$1"; shift
    local domains=("$@")
    ((${#domains[@]})) || return 0

    local temp_conf="/tmp/blinvpn_certbot_renew.conf"
    local temp_link="/etc/nginx/sites-enabled/blinvpn-acme.conf"

    log_info "Временная Nginx-конфигурация для ACME (порт 80)..."
    sudo mkdir -p /var/www/html/.well-known/acme-challenge

    local blocks="" d
    for d in "${domains[@]}"; do
        blocks+="server {
    listen 80;
    server_name ${d};
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
}
"
    done
    printf '%s' "$blocks" | sudo tee "$temp_conf" >/dev/null
    sudo ln -sf "$temp_conf" "$temp_link"

    if ! sudo nginx -t; then
        log_error "Ошибка проверки Nginx. Замена доменов прервана."
        sudo rm -f "$temp_link" "$temp_conf"
        sudo systemctl reload nginx || true
        exit 1
    fi
    sudo systemctl reload nginx

    for d in "${domains[@]}"; do
        log_info "Выпуск сертификата для ${d}..."
        if sudo certbot certonly --webroot -w /var/www/html -d "$d" \
            --email "$email" --agree-tos --non-interactive --keep-until-expiring; then
            log_success "✔ Сертификат для ${d} получен."
        else
            log_error "Не удалось получить сертификат для ${d}."
            log_error "Проверьте A-запись ${d} и что порт 80 открыт."
            sudo rm -f "$temp_link" "$temp_conf"
            sudo systemctl reload nginx || true
            exit 1
        fi
    done

    sudo rm -f "$temp_link" "$temp_conf"
    sudo systemctl reload nginx || true
}

update_env_domains() {
    local miniapp="$1"
    local panel="$2"

    set_env_var MINIAPP_DOMAIN "$miniapp"
    set_env_var WEBHOOK_DOMAIN "$miniapp"
    set_env_var PANEL_DOMAIN   "$panel"

    set_env_var MINIAPP_URL         "https://${miniapp}"
    set_env_var WEBHOOK_URL         "https://${miniapp}"
    set_env_var API_URL             "https://${miniapp}/api"
    set_env_var PANEL_URL           "https://${panel}"
    set_env_var PLATEGA_RETURN_URL  "https://${miniapp}/success"
    set_env_var PLATEGA_FAILED_URL  "https://${miniapp}/failed"
    set_env_var CORS_ORIGINS        "https://${miniapp},https://${panel},https://web.telegram.org"

    log_success "✔ .env обновлён."
}

replace_domains_flow() {
    section "Замена доменов и перевыпуск сертификатов"

    if [[ ! -f ".env" ]]; then
        log_error "Файл .env не найден в $(pwd)."
        exit 1
    fi

    local cur_miniapp cur_panel cur_email
    cur_miniapp=$(get_env_var MINIAPP_DOMAIN || true)
    cur_panel=$(get_env_var PANEL_DOMAIN || true)
    cur_email=$(get_env_var SSL_EMAIL || true)

    log_info "Текущие домены:"
    printf "  Мини-приложение : ${BOLD}%s${NC}\n" "${cur_miniapp:-—}"
    printf "  Панель          : ${BOLD}%s${NC}\n" "${cur_panel:-—}"
    echo

    if [[ -z "$cur_email" ]]; then
        prompt "Email для Let's Encrypt: " cur_email
        [[ -n "$cur_email" ]] || { log_error "Email обязателен."; exit 1; }
    fi

    local new_miniapp="$cur_miniapp" new_panel="$cur_panel"
    local -a changed=()
    local -a old_domains=()
    local tmp

    if [[ -n "$cur_miniapp" ]] && confirm "Заменить домен мини-приложения (${cur_miniapp})? (y/n): "; then
        prompt "  Новый домен мини-приложения: " tmp
        tmp=$(sanitize_domain "$tmp")
        [[ -n "$tmp" ]] || { log_error "Некорректный домен."; exit 1; }
        new_miniapp="$tmp"; changed+=("$new_miniapp"); old_domains+=("$cur_miniapp")
    fi

    if [[ -n "$cur_panel" ]] && confirm "Заменить домен панели (${cur_panel})? (y/n): "; then
        prompt "  Новый домен панели: " tmp
        tmp=$(sanitize_domain "$tmp")
        [[ -n "$tmp" ]] || { log_error "Некорректный домен."; exit 1; }
        new_panel="$tmp"; changed+=("$new_panel"); old_domains+=("$cur_panel")
    fi

    if ((${#changed[@]} == 0)); then
        log_warn "Ни один домен не выбран. Изменений нет."
        return 0
    fi

    log_info "\nНовые домены:"
    printf "  Мини-приложение : ${BOLD}%s${NC}\n" "$new_miniapp"
    printf "  Панель          : ${BOLD}%s${NC}\n" "$new_panel"
    echo
    confirm "Применить замену? (y/n): " || { log_info "Отменено."; return 0; }

    local server_ip; server_ip=$(get_server_ip || true)
    if [[ -n "$server_ip" ]]; then
        log_info "IP сервера: ${server_ip}"
        local dip
        for tmp in "${changed[@]}"; do
            dip=$(resolve_domain_ip "$tmp" || true)
            if [[ -z "$dip" ]]; then
                log_warn "Не удалось определить A-запись для ${tmp} (нужен ${server_ip})."
                confirm "Продолжить всё равно? (y/n): " || exit 1
            elif [[ "$dip" != "$server_ip" ]]; then
                log_warn "DNS ${tmp} → ${dip} ≠ IP сервера (${server_ip})."
                confirm "Продолжить всё равно? (y/n): " || exit 1
            fi
        done
    fi

    if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q 'Status: active'; then
        log_warn "UFW активен — открываю 80 и 443."
        sudo ufw allow 80/tcp || true
        sudo ufw allow 443/tcp || true
    fi

    section "Выпуск сертификатов Let's Encrypt"
    obtain_certificates "$cur_email" "${changed[@]}"

    section "Обновление Nginx"
    configure_nginx "$new_miniapp" "$new_panel" "$NGINX_CONF" "$NGINX_LINK"

    section "Обновление .env"
    update_env_domains "$new_miniapp" "$new_panel"

    section "Перезапуск Docker"
    ensure_env_utf8 .env
    if [[ -n "$(dc ps -q 2>/dev/null)" ]]; then
        dc down
    fi
    dc up -d --build

    if [[ "$new_miniapp" != "$cur_miniapp" ]]; then
        section "Telegram Stars"
        local bot_token; bot_token=$(get_env_var TELEGRAM_BOT_TOKEN || true)
        TELEGRAM_STARS_DELIVERY="$(get_env_var TELEGRAM_STARS_DELIVERY || true)"
        TELEGRAM_STARS_DELIVERY="${TELEGRAM_STARS_DELIVERY:-bot}"
        register_telegram_webhook "$bot_token" "$new_miniapp"
        print_payment_webhooks "$new_miniapp"
    fi

    if ((${#old_domains[@]})) && confirm "Удалить сертификаты заменённых доменов? (y/n): "; then
        local od
        for od in "${old_domains[@]}"; do
            [[ -n "$od" ]] || continue
            if [[ "$od" == "$new_miniapp" || "$od" == "$new_panel" ]]; then
                continue
            fi
            if [[ -d "/etc/letsencrypt/live/${od}" ]]; then
                if sudo certbot delete --cert-name "$od" --non-interactive 2>/dev/null; then
                    log_info "Сертификат ${od} удалён."
                else
                    log_warn "Не удалось удалить сертификат ${od}."
                fi
            fi
        done
    fi

    section "Замена доменов завершена"
    printf "  Мини-приложение : ${YELLOW}https://%s${NC}\n" "$new_miniapp"
    printf "  Панель          : ${YELLOW}https://%s${NC}\n" "$new_panel"
    if [[ "$new_miniapp" != "$cur_miniapp" ]]; then
        echo
        log_warn "Обновите Web App URL в @BotFather:"
        printf "     ${CYAN}https://%s${NC}\n" "$new_miniapp"
    fi
}

REPO_URL="${BLINVPN_REPO_URL:-https://github.com/Blin4Dev/blinvpn.git}"
REPO_BRANCH="${BLINVPN_BRANCH:-main}"
PROJECT_DIR="blinvpn"
NGINX_CONF="/etc/nginx/sites-available/${PROJECT_DIR}.conf"
NGINX_LINK="/etc/nginx/sites-enabled/${PROJECT_DIR}.conf"

log_success "--- Установка / обновление BlinVPN ---"

# Режим обновления существующей установки
if [[ -f "$NGINX_CONF" ]]; then
    log_info "\nОбнаружена существующая конфигурация BlinVPN."
    if [[ ! -d "$PROJECT_DIR" ]]; then
        log_error "Nginx-конфиг есть, но каталог «${PROJECT_DIR}» отсутствует. Удалите $NGINX_CONF и повторите установку."
        exit 1
    fi
    cd "$PROJECT_DIR"
    ensure_compose

    if [[ "${BLINVPN_POST_UPDATE:-}" == "1" ]]; then
        unset BLINVPN_POST_UPDATE
        section "Пост-обновление"
        migrate_security_update ".env"
        ensure_env_utf8 .env
        dc down --remove-orphans
        fix_container_data_permissions
        dc up -d --build
        fix_container_data_permissions
        dc restart api webhook bot monitor 2>/dev/null || true

        if [[ -f "$NGINX_CONF" ]]; then
            _upd_mini="$(get_env_var MINIAPP_DOMAIN .env 2>/dev/null || get_env_var WEBHOOK_DOMAIN .env 2>/dev/null || true)"
            _upd_panel="$(get_env_var PANEL_DOMAIN .env 2>/dev/null || true)"
            if [[ -n "$_upd_mini" && -n "$_upd_panel" ]]; then
                configure_nginx "$_upd_mini" "$_upd_panel" "$NGINX_CONF" "$NGINX_LINK"
            else
                sudo nginx -t && sudo systemctl reload nginx || true
            fi
        fi

        log_success "\n🎉 Обновление завершено."
        log_info "  • Перелогиньтесь в панели."
        _upd_pst="$(get_env_var PANEL_SETUP_TOKEN .env 2>/dev/null || true)"
        if [[ -n "$_upd_pst" ]]; then
            log_info "  • PANEL_SETUP_TOKEN в .env (сброс пароля панели)."
        fi
        exit 0
    fi

    section "Существующая установка — выберите действие"
    step "1)" "Обновить код и перезапустить контейнеры (по умолчанию)"
    step "2)" "Заменить домен(ы) и перевыпустить сертификаты"
    step "3)" "Настроить почту (коды входа на сайт)"
    step "4)" "Выход"
    echo
    prompt "Ваш выбор [1/2/3/4] (Enter = 1): " ACTION_CHOICE
    ACTION_CHOICE="${ACTION_CHOICE:-1}"

    case "$ACTION_CHOICE" in
        2)
            replace_domains_flow
            exit 0
            ;;
        3)
            mail_setup_flow
            exit 0
            ;;
        4)
            log_info "Выход без изменений."
            exit 0
            ;;
        *)
            log_info "\nОбновление исходного кода..."
            git fetch origin
            git reset --hard origin/"$REPO_BRANCH"
            git checkout "$REPO_BRANCH" 2>/dev/null || git checkout -b "$REPO_BRANCH" --track origin/"$REPO_BRANCH"
            git reset --hard origin/"$REPO_BRANCH"
            log_success "✔ Репозиторий обновлён."

            if [[ ! -f ./install.sh ]]; then
                log_error "После обновления не найден ./install.sh."
                exit 1
            fi
            log_info "\nЗапуск свежего install.sh..."
            export BLINVPN_POST_UPDATE=1
            cd ..
            exec bash "$PROJECT_DIR/install.sh"
            ;;
    esac
fi

# ── Новая установка ──────────────────────────────────────────
log_info "\nСуществующая конфигурация не найдена. Новая установка."

ensure_packages
ensure_services
ensure_compose
ensure_certbot_nginx

log_info "\nШаг 2: клонирование репозитория"
if [[ ! -d "$PROJECT_DIR/.git" ]]; then
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
else
    log_warn "Каталог $PROJECT_DIR уже есть — используем текущую версию."
fi
cd "$PROJECT_DIR"
log_success "✔ Репозиторий BlinVPN готов."

log_info "\nШаг 3: домены и SSL"

prompt "Домен мини-приложения (например app.example.com): " USER_DOMAIN_INPUT
DOMAIN=$(sanitize_domain "$USER_DOMAIN_INPUT")
[[ -n "$DOMAIN" ]] || { log_error "Некорректный домен."; exit 1; }

prompt "Домен панели (например panel.example.com): " USER_PANEL_DOMAIN_INPUT
PANEL_DOMAIN=$(sanitize_domain "$USER_PANEL_DOMAIN_INPUT")
[[ -n "$PANEL_DOMAIN" ]] || { log_error "Некорректный домен панели."; exit 1; }

prompt "Email для Let's Encrypt: " EMAIL
[[ -n "$EMAIL" ]] || { log_error "Email обязателен."; exit 1; }

SERVER_IP=$(get_server_ip || true)
DOMAIN_IP=$(resolve_domain_ip "$DOMAIN" || true)
PANEL_DOMAIN_IP=$(resolve_domain_ip "$PANEL_DOMAIN" || true)

[[ -n "$SERVER_IP" ]] && log_info "IP сервера: ${SERVER_IP}"
[[ -n "$DOMAIN_IP" ]] && log_info "IP ${DOMAIN}: ${DOMAIN_IP}"
[[ -n "$PANEL_DOMAIN_IP" ]] && log_info "IP ${PANEL_DOMAIN}: ${PANEL_DOMAIN_IP}"

if [[ -n "$SERVER_IP" && -n "$DOMAIN_IP" && "$SERVER_IP" != "$DOMAIN_IP" ]]; then
    log_warn "DNS ${DOMAIN} не совпадает с IP сервера."
    confirm "Продолжить? (y/n): " || exit 1
fi
if [[ -n "$SERVER_IP" && -n "$PANEL_DOMAIN_IP" && "$SERVER_IP" != "$PANEL_DOMAIN_IP" ]]; then
    log_warn "DNS ${PANEL_DOMAIN} не совпадает с IP сервера."
    confirm "Продолжить? (y/n): " || exit 1
fi

if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q 'Status: active'; then
    log_warn "UFW активен — открываю порты 80 и 443, закрываю внутренние."
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    # Внутренние сервисы (api/webhook) слушают только 127.0.0.1, но на всякий
    # случай явно запрещаем их снаружи (defence-in-depth).
    sudo ufw deny "${API_PORT:-8000}/tcp" 2>/dev/null || true
    sudo ufw deny "${WEBHOOK_PORT:-5000}/tcp" 2>/dev/null || true
fi

log_info "\nПолучение SSL-сертификатов..."

TEMP_CONF="/tmp/blinvpn_certbot.conf"
sudo tee "$TEMP_CONF" >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN} ${PANEL_DOMAIN};
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

sudo rm -f /etc/nginx/sites-enabled/default
sudo rm -f "$NGINX_LINK"
sudo ln -sf "$TEMP_CONF" "$NGINX_LINK"
sudo nginx -t && sudo systemctl reload nginx
sudo mkdir -p /var/www/html/.well-known/acme-challenge

for d in "$DOMAIN" "$PANEL_DOMAIN"; do
    if [[ -d "/etc/letsencrypt/live/${d}" ]]; then
        log_success "✔ сертификат для ${d} уже есть."
    else
        log_info "Выпуск сертификата для ${d}..."
        sudo certbot certonly --webroot -w /var/www/html -d "$d" \
            --email "$EMAIL" --agree-tos --non-interactive
        log_success "✔ сертификат для ${d} получен."
    fi
done

sudo rm -f "$TEMP_CONF"

log_info "\nШаг 4: Nginx"
configure_nginx "$DOMAIN" "$PANEL_DOMAIN" "$NGINX_CONF" "$NGINX_LINK"

log_info "\nШаг 5: .env"
if [[ -f ".env" ]]; then
    log_warn "Файл .env уже существует."
    if ! confirm "Перезаписать .env? (y/n): "; then
        log_info "Используется существующий .env."
        migrate_security_update ".env"
    else
        create_env_file "$DOMAIN" "$PANEL_DOMAIN" "$EMAIL"
    fi
else
    create_env_file "$DOMAIN" "$PANEL_DOMAIN" "$EMAIL"
fi

log_info "\nШаг 6: Docker"
ensure_env_utf8 .env
fix_container_data_permissions
if [[ -n "$(dc ps -q 2>/dev/null)" ]]; then
    dc down
fi
dc up -d --build
fix_container_data_permissions
dc restart api webhook bot monitor 2>/dev/null || true

log_info "\nШаг 7: Telegram Stars"
TELEGRAM_STARS_DELIVERY="$(get_env_var TELEGRAM_STARS_DELIVERY || true)"
TELEGRAM_STARS_DELIVERY="${TELEGRAM_STARS_DELIVERY:-bot}"
register_telegram_webhook "${TELEGRAM_BOT_TOKEN:-}" "$DOMAIN"

log_info "\nШаг 8: Почта"
setup_mail_server || log_warn "Почта не настроена (можно включить позже)."

# Логин/пароль панели генерируются приложением при первом запуске и
# записываются в data/first_run_credentials.txt. Показываем один раз и удаляем.
log_info "\nШаг 9: Доступ в панель"
PANEL_CREDS_FILE="data/first_run_credentials.txt"
for _i in $(seq 1 30); do
    [[ -f "$PANEL_CREDS_FILE" ]] && break
    sleep 1
done
if [[ -f "$PANEL_CREDS_FILE" ]]; then
    PANEL_LOGIN="$(get_env_var login "$PANEL_CREDS_FILE" 2>/dev/null || true)"
    PANEL_PASS="$(get_env_var password "$PANEL_CREDS_FILE" 2>/dev/null || true)"
    printf "\n${GREEN}───────────────────────────────────────────────────────────────${NC}\n"
    printf "${BOLD}  Доступ в панель — сохраните, повторно НЕ показывается${NC}\n"
    printf "${GREEN}───────────────────────────────────────────────────────────────${NC}\n"
    printf "  Логин:  ${YELLOW}%s${NC}\n" "$PANEL_LOGIN"
    printf "  Пароль: ${YELLOW}%s${NC}\n" "$PANEL_PASS"
    sudo rm -f "$PANEL_CREDS_FILE" 2>/dev/null || rm -f "$PANEL_CREDS_FILE" 2>/dev/null || true
else
    log_warn "Не удалось получить логин/пароль автоматически."
    log_warn "Посмотрите их в логах: ${BOLD}dc logs api | grep -A3 'доступ в панель'${NC}"
fi

printf "\n"
printf "${GREEN}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}\n"
printf "${GREEN}┃${NC}  🎉 ${BOLD}Установка BlinVPN завершена${NC}                              ${GREEN}┃${NC}\n"
printf "${GREEN}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}\n"
printf "\n"
printf "${GREEN}───────────────────────────────────────────────────────────────${NC}\n"
printf "${BOLD}  Адреса${NC}\n"
printf "${GREEN}───────────────────────────────────────────────────────────────${NC}\n"
printf "  Мини-приложение:  ${YELLOW}https://%s${NC}\n" "$DOMAIN"
printf "  Панель:           ${YELLOW}https://%s${NC}\n" "$PANEL_DOMAIN"
printf "  API:              ${YELLOW}https://%s/api${NC}\n" "$DOMAIN"
print_payment_webhooks "$DOMAIN"
print_mail_dns

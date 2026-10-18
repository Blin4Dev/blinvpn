#!/usr/bin/env bash
# Общие функции установщиков BlinVPN 3.0 (панель и edge). Подключается через source.
# shellcheck disable=SC2034

GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
RED=$'\033[0;31m'
NC=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'

BLINVPN_VERSION="3.0.0"
PROJECT_DIR="${PROJECT_DIR:-/opt/blinvpn}"
ENV_FILE="${PROJECT_DIR}/.env"
WG_IFACE="blinvpn"
WG_CONF="/etc/wireguard/${WG_IFACE}.conf"
WG_KEY="/etc/wireguard/${WG_IFACE}.key"
WG_PUB="/etc/wireguard/${WG_IFACE}.pub"

log_info() { printf '%s\n' "${CYAN}$*${NC}"; }
log_warn() { printf '%s\n' "${YELLOW}$*${NC}"; }
log_ok() { printf '%s\n' "${GREEN}$*${NC}"; }
log_error() { printf '%s\n' "${RED}$*${NC}" >&2; }
hint() { printf '     %s\n' "${DIM}↳ $*${NC}"; }

section() {
    printf '\n%s\n' "${CYAN}── ${BOLD}$*${NC}${CYAN} ──────────────────────────────────────────${NC}"
}

die() {
    log_error "✘ $*"
    exit 1
}

require_root() {
    [[ "$(id -u)" -eq 0 ]] || die "Запустите от root: sudo bash install.sh"
}

# utf-8 локаль: иначе backspace ломает русские буквы при вводе
setup_locale() {
    local l
    l="$(locale -a 2>/dev/null | grep -iE '^(C|en_US)\.utf-?8$' | head -n1 || true)"
    if [[ -n "$l" ]]; then
        export LC_ALL="$l"
    fi
}

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

# ask "вопрос" VAR [regex] [подсказка при ошибке] [default]
ask() {
    local message="$1" __var="$2" regex="${3:-}" hint_text="${4:-}" def="${5:-}" value
    while true; do
        if [[ -n "$def" ]]; then
            read -r -p "  ${message} [${def}]: " value </dev/tty || true
        else
            read -r -p "  ${message}: " value </dev/tty || true
        fi
        value="$(clean_input "$value")"
        [[ -z "$value" && -n "$def" ]] && value="$def"
        if [[ -z "$regex" ]] || [[ "$value" =~ $regex ]]; then
            break
        fi
        log_warn "     ✗ ${hint_text:-неверное значение}. Попробуйте ещё раз (проверьте раскладку — нужны латинские буквы)."
    done
    printf -v "$__var" '%s' "$value"
}

# ask_secret "вопрос" VAR — без эха
ask_secret() {
    local message="$1" __var="$2" value=""
    while [[ -z "$value" ]]; do
        read -r -s -p "  ${message}: " value </dev/tty || true
        printf '\n'
        value="$(clean_input "$value")"
    done
    printf -v "$__var" '%s' "$value"
}

confirm() {
    # confirm "вопрос" [Y|N] — по умолчанию N
    local message="$1" def="${2:-N}" reply
    local prompt_suffix="[y/N]"
    [[ "$def" == "Y" ]] && prompt_suffix="[Y/n]"
    read -r -p "  ${message} ${prompt_suffix}: " reply </dev/tty || true
    reply="$(clean_input "$reply")"
    [[ -z "$reply" ]] && reply="$def"
    [[ "$reply" =~ ^[YyДд] ]]
}

DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$'

sanitize_domain() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's%^[a-z]*://%%' -e 's%/.*$%%' -e 's%:.*$%%' | tr -cd 'a-z0-9.-'
}

ask_domain() {
    # ask_domain "вопрос" VAR [default]
    local message="$1" __var="$2" def="${3:-}" raw d
    while true; do
        ask "$message" raw "" "" "$def"
        d="$(sanitize_domain "$raw")"
        if [[ "$d" =~ $DOMAIN_RE ]]; then
            break
        fi
        log_warn "     ✗ Нужен домен вида app.example.com"
    done
    printf -v "$__var" '%s' "$d"
}

# один домен — поддомен (или совпадает) другого
domains_related() {
    local a="$1" b="$2"
    [[ "$a" == "$b" || "$a" == *".$b" || "$b" == *".$a" ]]
}

gen_secret() {
    # 48 символов [A-Za-z0-9]
    local n="${1:-48}"
    python3 -c "import secrets,string; a=string.ascii_letters+string.digits; print(''.join(secrets.choice(a) for _ in range(${n})))"
}

gen_hex() {
    openssl rand -hex "${1:-24}"
}

envget() {
    # envget KEY [файл]
    python3 "${PROJECT_DIR}/scripts/install/envfile.py" get "${2:-$ENV_FILE}" "$1" 2>/dev/null || true
}

envset() {
    # envset KEY=VAL ... (в ENV_FILE)
    python3 "${PROJECT_DIR}/scripts/install/envfile.py" set "$ENV_FILE" "$@" || die "не удалось записать .env"
}

envensure() {
    python3 "${PROJECT_DIR}/scripts/install/envfile.py" ensure "$ENV_FILE" "$@" || die "не удалось записать .env"
}

# ── пакеты, docker ────────────────────────────────────────────────

apt_install() {
    export DEBIAN_FRONTEND=noninteractive
    local i
    for i in 1 2 3; do
        if apt-get install -y -qq --no-install-recommends "$@" >/dev/null; then
            return 0
        fi
        apt-get update -qq >/dev/null 2>&1 || true
        sleep 3
    done
    return 1
}

ensure_packages() {
    # ensure_packages pkg...
    command -v apt-get >/dev/null 2>&1 || die "Нужен Ubuntu/Debian (apt-get)"
    local missing=() p
    for p in "$@"; do
        dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
    done
    if ((${#missing[@]})); then
        log_info "Устанавливаю: ${missing[*]}"
        apt-get update -qq >/dev/null 2>&1 || true
        apt_install "${missing[@]}" || die "Не удалось установить пакеты: ${missing[*]}"
    fi
}

ensure_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        log_info "Устанавливаю Docker…"
        if ! curl -fsSL https://get.docker.com | sh >/dev/null 2>&1; then
            apt_install docker.io || die "Не удалось установить Docker"
        fi
    fi
    systemctl enable --now docker >/dev/null 2>&1 || true
    if ! docker compose version >/dev/null 2>&1; then
        apt_install docker-compose-plugin >/dev/null 2>&1 || apt_install docker-compose-v2 >/dev/null 2>&1 || true
    fi
    if ! docker compose version >/dev/null 2>&1; then
        local arch
        arch="$(uname -m)"
        [[ "$arch" == "aarch64" ]] || arch="x86_64"
        mkdir -p /usr/local/lib/docker/cli-plugins
        curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
            -o /usr/local/lib/docker/cli-plugins/docker-compose && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    fi
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 не установлен"
    log_ok "✔ Docker и Compose готовы"
}

dc() {
    (cd "$PROJECT_DIR" && docker compose "$@")
}

# shellcheck disable=SC2120
dc_build() {
    local i
    for i in 1 2 3; do
        if dc build "$@"; then
            return 0
        fi
        if ((i < 3)); then
            log_warn "Сборка не удалась (попытка ${i} из 3) — обычно это обрыв связи с pypi/npm. Повтор через 20 секунд…"
            sleep 20
        fi
    done
    log_error "Сборка не удалась 3 раза подряд. Работающие контейнеры не тронуты."
    hint "Плохая связь с pypi.org / npm: задайте зеркала PIP_INDEX_URL= и NPM_REGISTRY= в ${ENV_FILE}"
    return 1
}

ensure_time_sync() {
    timedatectl set-ntp true >/dev/null 2>&1 || true
}

# ── сеть ──────────────────────────────────────────────────────────

IPV4_RE='^([0-9]{1,3}\.){3}[0-9]{1,3}$'

public_ipv4() {
    local ip url
    for url in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.co/ip; do
        ip="$(curl -4 -fsS --max-time 6 "$url" 2>/dev/null | tr -d '\r\n\t ')"
        if [[ "$ip" =~ $IPV4_RE ]]; then
            printf '%s' "$ip"
            return 0
        fi
    done
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
    [[ "$ip" =~ $IPV4_RE ]] && printf '%s' "$ip"
}

# все публичные адреса сервера (интерфейсы + внешний), через запятую
all_public_ips() {
    python3 - "$(public_ipv4)" <<'PY'
import ipaddress, socket, subprocess, sys
ips = set()
ext = sys.argv[1].strip()
if ext:
    ips.add(ext)
try:
    out = subprocess.run(["ip", "-o", "addr", "show"], capture_output=True, text=True, timeout=10).stdout
except Exception:
    out = ""
for line in out.splitlines():
    parts = line.split()
    for i, p in enumerate(parts):
        if p in ("inet", "inet6") and i + 1 < len(parts):
            try:
                a = ipaddress.ip_interface(parts[i + 1]).ip
            except ValueError:
                continue
            if a.is_global:
                ips.add(str(a))
print(",".join(sorted(ips)))
PY
}

resolve_ipv4() {
    local ip
    ip="$(getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | head -n1)"
    if [[ ! "$ip" =~ $IPV4_RE ]] && command -v dig >/dev/null 2>&1; then
        ip="$(dig +short A "$1" 2>/dev/null | grep -E "$IPV4_RE" | head -n1)"
    fi
    [[ "$ip" =~ $IPV4_RE ]] && printf '%s' "$ip"
}

ssh_ports() {
    local p
    p="$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | sort -u | tr '\n' ' ')"
    [[ -z "$p" ]] && p="$(ss -ltnpH 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u | tr '\n' ' ')"
    [[ -z "$p" ]] && p="22"
    printf '%s' "$p"
}

port_busy_by_other() {
    # port_busy_by_other 443 → 0 (истина), если порт слушает НЕ системный nginx хоста
    # (контейнер Remnawave-nginx/caddy, docker-proxy и т.п.)
    local port="$1" line pids pid comm
    line="$(ss -ltnpH "sport = :${port}" 2>/dev/null || true)"
    [[ -z "$line" ]] && return 1
    pids="$(printf '%s' "$line" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)"
    [[ -z "$pids" ]] && return 0
    for pid in $pids; do
        comm="$(cat "/proc/${pid}/comm" 2>/dev/null || true)"
        if [[ "$comm" != "nginx" ]] || grep -qE 'docker|containerd|kubepods' "/proc/${pid}/cgroup" 2>/dev/null; then
            return 0
        fi
    done
    return 1
}

# ── nginx и сертификаты ──────────────────────────────────────────

nginx_default_tls() {
    # ssl_reject_handshake (nginx ≥ 1.19.4) или самоподписанная заглушка
    local v
    v="$(nginx -v 2>&1 | sed -n 's%.*nginx/\([0-9.]*\).*%\1%p')"
    if [[ -n "$v" ]] && printf '%s\n%s\n' "1.19.4" "$v" | sort -V -C; then
        printf '%s' "ssl_reject_handshake on;"
        return
    fi
    if [[ ! -f /etc/nginx/blinvpn-dummy.crt ]]; then
        openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=localhost" \
            -keyout /etc/nginx/blinvpn-dummy.key -out /etc/nginx/blinvpn-dummy.crt >/dev/null 2>&1
        chmod 600 /etc/nginx/blinvpn-dummy.key
    fi
    printf '%s' "ssl_certificate /etc/nginx/blinvpn-dummy.crt; ssl_certificate_key /etc/nginx/blinvpn-dummy.key;"
}

issue_certs() {
    # issue_certs email domain... — отдельный сертификат на каждый домен (HTTP-01, webroot)
    local email="$1"
    shift
    local missing=() d
    for d in "$@"; do
        [[ -n "$d" && ! -d "/etc/letsencrypt/live/${d}" ]] && missing+=("$d")
    done
    ((${#missing[@]})) || return 0
    mkdir -p /var/www/html/.well-known/acme-challenge
    local acme=/etc/nginx/sites-enabled/blinvpn-acme.conf
    : >"$acme"
    local l6=""
    [[ -s /proc/net/if_inet6 ]] && l6="    listen [::]:80;"
    for d in "${missing[@]}"; do
        printf 'server {\n    listen 80;\n%s\n    server_name %s;\n    location /.well-known/acme-challenge/ { root /var/www/html; }\n    location / { return 404; }\n}\n' "$l6" "$d" >>"$acme"
    done
    rm -f /etc/nginx/sites-enabled/default
    if ! nginx -t >/dev/null 2>&1; then
        nginx -t || true
        rm -f "$acme"
        die "nginx -t не прошёл перед выпуском сертификатов"
    fi
    systemctl reload nginx || systemctl restart nginx
    local ok=0 email_args=()
    if [[ -n "$email" ]]; then
        email_args=(--email "$email")
    else
        email_args=(--register-unsafely-without-email)
    fi
    for d in "${missing[@]}"; do
        log_info "Сертификат для ${d}…"
        if certbot certonly --webroot -w /var/www/html -d "$d" --agree-tos --non-interactive \
            --keep-until-expiring "${email_args[@]}" >/dev/null 2>&1; then
            log_ok "✔ ${d}"
        else
            log_error "Не удалось получить сертификат для ${d}: A-запись должна указывать на этот сервер, порт 80 открыт."
            ok=1
        fi
    done
    rm -f "$acme"
    systemctl reload nginx || true
    return "$ok"
}

ensure_certbot_timer() {
    systemctl enable --now certbot.timer >/dev/null 2>&1 || true
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/bin/sh\nsystemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/blinvpn-reload-nginx.sh
    chmod +x /etc/letsencrypt/renewal-hooks/deploy/blinvpn-reload-nginx.sh
}

# ── WireGuard ─────────────────────────────────────────────────────

wg_keys() {
    umask 077
    mkdir -p /etc/wireguard
    if [[ ! -s "$WG_KEY" ]]; then
        wg genkey >"$WG_KEY"
    fi
    wg pubkey <"$WG_KEY" >"$WG_PUB"
    chmod 600 "$WG_KEY"
    chmod 644 "$WG_PUB"
}

wg_up() {
    systemctl enable "wg-quick@${WG_IFACE}" >/dev/null 2>&1 || true
    systemctl restart "wg-quick@${WG_IFACE}" || die "WireGuard не поднялся: journalctl -u wg-quick@${WG_IFACE}"
}

wg_handshake_age() {
    # секунд с последнего рукопожатия (большое число — не было)
    local ts now
    ts="$(wg show "$WG_IFACE" latest-handshakes 2>/dev/null | awk '{print $2}' | sort -n | tail -n1)"
    now="$(date +%s)"
    if [[ -z "$ts" || "$ts" == "0" ]]; then
        printf '%s' 999999
    else
        printf '%s' $((now - ts))
    fi
}

docker_after_wg() {
    # docker (а с ним ingress/agent, слушающие адрес туннеля) — после WireGuard
    mkdir -p /etc/systemd/system/docker.service.d
    cat >/etc/systemd/system/docker.service.d/blinvpn-wg.conf <<EOF
[Unit]
After=wg-quick@${WG_IFACE}.service
Wants=wg-quick@${WG_IFACE}.service
EOF
    systemctl daemon-reload
}

# ── файрвол ───────────────────────────────────────────────────────

ufw_setup() {
    # ufw_setup "tcp-порты" "udp-порты" "правило туннеля (allow…)"
    local tcp="$1" udp="$2" tunnel_rule="$3" p
    if ! command -v ufw >/dev/null 2>&1; then
        apt_install ufw >/dev/null 2>&1 || {
            log_warn "UFW не установлен — файрвол не настроен"
            return 0
        }
    fi
    for p in $(ssh_ports); do
        ufw allow "${p}/tcp" >/dev/null
    done
    for p in $tcp; do
        ufw allow "${p}/tcp" >/dev/null
    done
    for p in $udp; do
        ufw allow "${p}/udp" >/dev/null
    done
    # туннель: только нужный порт, остальное из туннеля закрыто (правила — в начало списка)
    ufw delete deny in on "$WG_IFACE" >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    ufw delete $tunnel_rule >/dev/null 2>&1 || true
    ufw insert 1 deny in on "$WG_IFACE" >/dev/null 2>&1 || ufw deny in on "$WG_IFACE" >/dev/null
    # shellcheck disable=SC2086
    ufw insert 1 $tunnel_rule >/dev/null 2>&1 || ufw $tunnel_rule >/dev/null
    if ! ufw status | grep -q 'Status: active'; then
        log_warn "Файрвол UFW выключен. Порты SSH ($(ssh_ports)) уже разрешены."
        if confirm "Включить UFW (рекомендуется)?" Y; then
            ufw --force enable >/dev/null && log_ok "✔ UFW включён"
        else
            log_warn "UFW не включён: сервисы слушают только 127.0.0.1 и адрес туннеля, но файрвол всё же рекомендуется"
        fi
    else
        ufw reload >/dev/null 2>&1 || true
        log_ok "✔ правила UFW обновлены"
    fi
}

# ── установка CLI ─────────────────────────────────────────────────

install_cli() {
    # install_cli имя файл
    ln -sf "$2" "/usr/local/bin/$1"
    chmod +x "$2"
}

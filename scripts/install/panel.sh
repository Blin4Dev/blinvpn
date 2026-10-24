#!/usr/bin/env bash
# BlinVPN 3.0 — установка и обслуживание СЕРВЕРА ПАНЕЛИ.
#
#   panel.sh                 новая установка
#   panel.sh --post-update   после git pull: миграции .env, nginx, пересборка
#   panel.sh --pair          подключить новый edge-сервер (переезд edge на другой сервер)
#   panel.sh --domains       сменить домены (панели и/или edge)
#   panel.sh --endpoint IP[:порт]   edge переехал на другой IP
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
trap 'log_error "Ошибка на строке $LINENO. Установка прервана — повторный запуск продолжит с того же места."' ERR

PANELCTL=(python3 "$HERE/panelctl.py")
NGINX_CONF="/etc/nginx/sites-available/blinvpn-panel.conf"
NGINX_LINK="/etc/nginx/sites-enabled/blinvpn-panel.conf"

WG_NET_DEFAULT="10.213.0.0/24"
WG_PANEL_IP_DEFAULT="10.213.0.1"
WG_EDGE_IP_DEFAULT="10.213.0.11"

# ключи старого .env (BlinVPN 2.x), которые НЕ переносим: адреса и устройство установки
IMPORT_DENY_RE='^(MINIAPP_|PANEL_URL|PANEL_DOMAIN|PANEL_PORT|WEBHOOK_|API_URL|API_PORT|API_PUBLIC_PORT|CORS_ORIGINS|DB_PATH|SSL_EMAIL|REMWAVE_PANEL_URL|REMWAVE_SUB_PUBLIC_URL|XBM_|COMPOSE_|DEPLOY_|EDGE_|WG_|LEAK_GUARD_|INGRESS_|SITE_URL|SERVER_IP|TRUST_CLOUDFLARE|API_ROLE|REPO_)'

# ── WireGuard панели (инициатор: панель сама подключается к edge) ──

write_wg_conf() {
    local endpoint="${1:-}" edge_pub="${2:-}"
    local net panel_ip edge_ip
    net="$(envget WG_NET)"
    panel_ip="$(envget WG_PANEL_IP)"
    edge_ip="$(envget WG_EDGE_IP)"
    local _um
    _um="$(umask)"
    umask 077
    {
        echo "# BlinVPN 3.0 — туннель панель → edge. Генерируется установщиком (sudo blinvpn pair / edge-endpoint)."
        echo "[Interface]"
        echo "Address = ${panel_ip:-$WG_PANEL_IP_DEFAULT}/${net##*/}"
        echo "PrivateKey = $(cat "$WG_KEY")"
        echo "MTU = 1420"
        if [[ -n "$endpoint" && -n "$edge_pub" ]]; then
            echo
            echo "[Peer]"
            echo "# edge-сервер"
            echo "PublicKey = ${edge_pub}"
            echo "AllowedIPs = ${edge_ip:-$WG_EDGE_IP_DEFAULT}/32"
            echo "Endpoint = ${endpoint}"
            echo "PersistentKeepalive = 25"
        fi
    } >"$WG_CONF"
    chmod 600 "$WG_CONF"
    umask "$_um"
}

# ── nginx панели ──────────────────────────────────────────────────

render_nginx() {
    local panel rw rw_block="" rw_sp=""
    panel="$(envget PANEL_DOMAIN)"
    rw="$(envget REMNAWAVE_UI_DOMAIN)"
    [[ "$panel" =~ $DOMAIN_RE ]] || die "PANEL_DOMAIN не задан"
    if [[ -n "$rw" ]]; then
        local rwport
        rwport="$(envget REMWAVE_PANEL_URL | sed -n 's%^https\?://[^:/]*:\([0-9]*\).*%\1%p')"
        rw_block="$(python3 "$HERE/render.py" "$PROJECT_DIR/deploy/panel/remnawave.conf.tpl" - \
            "RW_DOMAIN=$rw" "RW_PORT=${rwport:-3000}")"
        rw_sp=" $rw"
    fi
    local tmp
    tmp="$(mktemp)"
    [[ -f "$NGINX_CONF" ]] && cp "$NGINX_CONF" "$tmp"
    python3 "$HERE/render.py" "$PROJECT_DIR/deploy/panel/nginx.conf.tpl" "$NGINX_CONF" \
        "PANEL_DOMAIN=$panel" "RW_DOMAIN_SP=$rw_sp" "RW_SERVER=$rw_block" \
        "DEFAULT_TLS=$(nginx_default_tls)" \
        "API_PORT=$(envget API_PORT)" "PANEL_PORT=$(envget PANEL_PORT)"
    ln -sf "$NGINX_CONF" "$NGINX_LINK"
    rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/blinvpn.conf /etc/nginx/blinvpn-panel.conf.parked
    if ! nginx -t 2>/dev/null; then
        nginx -t || true
        if [[ -s "$tmp" ]]; then
            cp "$tmp" "$NGINX_CONF"
            log_warn "возвращён прежний конфиг nginx"
        else
            # прежнего нет — не оставляем включённым конфиг, который валит nginx целиком
            rm -f "$NGINX_LINK"
        fi
        rm -f "$tmp"
        die "nginx -t не прошёл"
    fi
    rm -f "$tmp"
    systemctl reload nginx || systemctl restart nginx
    log_ok "✔ nginx панели обновлён"
}

fix_permissions() {
    mkdir -p "$PROJECT_DIR/data"
    chmod 750 "$PROJECT_DIR/data"
    find "$PROJECT_DIR/data" -path "$PROJECT_DIR/data/host" -prune -o -exec chown -h 1000:1000 {} + 2>/dev/null || true
    [[ -d "$PROJECT_DIR/data/dkim" ]] && chmod 700 "$PROJECT_DIR/data/dkim"
    find "$PROJECT_DIR/data/dkim" -type f -name '*.private' -exec chmod 600 {} \; 2>/dev/null || true
    [[ -f "$PROJECT_DIR/data/data.db" ]] && chmod 640 "$PROJECT_DIR/data/data.db"
    chmod 600 "$ENV_FILE"
}

wait_healthy() {
    local svc="$1" i st
    for i in $(seq 1 90); do
        st="$(docker inspect -f '{{.State.Health.Status}}' "$svc" 2>/dev/null || echo none)"
        [[ "$st" == "healthy" ]] && return 0
        sleep 2
    done
    log_error "$svc не стал healthy. Логи: cd $PROJECT_DIR && docker compose logs --tail 80 ${svc#blinvpn-}"
    return 1
}

# ── миграции .env (новые ключи при обновлении) ───────────────────

migrate_env() {
    envensure "DEPLOY_ROLE=panel" "DEPLOY_MODE=split" "COMPOSE_FILE=docker-compose.panel.yml" \
        "API_PORT=8000" "API_PUBLIC_PORT=8001" "WEBHOOK_PORT=5000" "PANEL_PORT=9742" \
        "WG_NET=$WG_NET_DEFAULT" "WG_PANEL_IP=$WG_PANEL_IP_DEFAULT" "WG_EDGE_IP=$WG_EDGE_IP_DEFAULT" \
        "INGRESS_PORT=8443" "EDGE_AGENT_PORT=9443" "ENV=production" "TELEGRAM_INITDATA_MAX_AGE=86400" \
        "MINIAPP_ALLOW_UNAUTH=0" "TELEGRAM_STARS_DELIVERY=bot" "REPO_BRANCH=main" "API_PUBLIC_WORKERS=2"
    envensure "EDGE_AGENT_URL=http://$(envget WG_EDGE_IP):$(envget EDGE_AGENT_PORT)"
    envensure "TELEGRAM_WEBHOOK_SECRET=$(gen_hex 24)" "PANEL_SETUP_TOKEN=$(gen_hex 24)" \
        "INTERNAL_API_SECRET=$(gen_hex 24)" "MONITOR_SECRET_KEY=$(gen_hex 24)" \
        "EDGE_TOKEN=$(gen_secret 48)" "EDGE_AGENT_KEY=$(gen_secret 48)"
    # режим вебхука Telegram для звёзд не используется: бот работает через polling
    envset "TELEGRAM_STARS_DELIVERY=bot"
}

# ── перенос данных со старого сервера ────────────────────────────

restore_data() {
    section "Перенос данных (если переезжаете со старого сервера)"
    hint "Архив/папка data со старого сервера (data.db, dkim, вложения) и его .env."
    hint "Без старого .env не расшифруются ключи платёжек, капчи, почты и S3 (они шифруются MONITOR_SECRET_KEY)."
    local src="" oldenv=""
    ask "Путь к архиву .tar.gz, папке data или файлу data.db (Enter — новая установка)" src
    [[ -z "$src" ]] && return 0
    [[ -e "$src" ]] || die "не найдено: $src"
    local tmp
    tmp="$(mktemp -d)"
    if [[ -d "$src" ]]; then
        cp -a "$src/." "$tmp/"
    elif [[ "$src" == *.db ]]; then
        cp -a "$src" "$tmp/data.db"
    else
        tar -xzf "$src" -C "$tmp" || die "не удалось распаковать $src"
    fi
    local db
    db="$(find "$tmp" -name data.db -type f | head -n1)"
    [[ -n "$db" ]] || die "в $src нет data.db"
    local root
    root="$(dirname "$db")"
    if [[ -f "$PROJECT_DIR/data/data.db" ]]; then
        confirm "В $PROJECT_DIR/data уже есть база. Заменить её перенесённой?" N || {
            rm -rf "$tmp"
            return 0
        }
        mv "$PROJECT_DIR/data" "$PROJECT_DIR/data.before-restore-$(date +%Y%m%d-%H%M%S)"
    fi
    mkdir -p "$PROJECT_DIR/data"
    cp -a "$root/." "$PROJECT_DIR/data/"
    rm -f "$PROJECT_DIR/data/data.db-wal" "$PROJECT_DIR/data/data.db-shm" "$PROJECT_DIR/data/first_run_credentials.txt"
    rm -rf "$PROJECT_DIR/data/host" "$PROJECT_DIR/data/xbm/templates-cache.json"
    local found_env
    found_env="$(find "$tmp" -maxdepth 3 -name .env -type f | head -n1)"
    rm -rf "$tmp"
    log_ok "✔ данные перенесены"

    ask "Путь к .env старого сервера (Enter — ${found_env:-пропустить})" oldenv "" "" "${found_env:-}"
    if [[ -n "$oldenv" ]]; then
        [[ -f "$oldenv" ]] || die "не найден $oldenv"
        python3 - "$oldenv" "$IMPORT_DENY_RE" <<PY
import re, subprocess, sys
sys.path.insert(0, "$HERE")
import envfile
old = envfile.read(sys.argv[1])
deny = re.compile(sys.argv[2])
take = {k: v for k, v in old.items() if not deny.match(k) and re.fullmatch(r"[A-Z][A-Z0-9_]*", k) and v}
envfile.write("$ENV_FILE", take)
print(f"  перенесено ключей из старого .env: {len(take)}")
PY
        log_ok "✔ ключи шифрования и настройки старого сервера перенесены"
    else
        log_warn "⚠ Старый .env не указан: ключи платёжек/капчи/почты/S3 в базе придётся ввести в панели заново."
    fi
}

# ── сопряжение с edge ─────────────────────────────────────────────

pair_flow() {
    local rotate="${1:-0}"
    section "Сопряжение с edge-сервером"
    if [[ "$rotate" == "1" ]]; then
        log_info "Выпускаю новые ключи edge (старый edge-сервер потеряет доступ к панели)…"
        envset "EDGE_TOKEN=$(gen_secret 48)" "EDGE_AGENT_KEY=$(gen_secret 48)"
        dc up -d >/dev/null
        wait_healthy blinvpn-api-public || true
    fi
    local code
    code="$("${PANELCTL[@]}" pair-code)" || die "не удалось сформировать код сопряжения"
    printf '\n%s\n' "  ${BOLD}1.${NC} На edge-сервере выполните:"
    printf '     %s\n' "${YELLOW}curl -fsSL $(envget REPO_URL | sed 's%\.git$%%;s%github.com%raw.githubusercontent.com%')/$(envget REPO_BRANCH)/install.sh -o install.sh && sudo bash install.sh${NC}"
    hint "или скопируйте install.sh из репозитория и запустите: sudo bash install.sh → «edge»"
    printf '%s\n' "  ${BOLD}2.${NC} Когда установщик edge попросит код, вставьте (это секрет, не пересылайте через мессенджеры):"
    printf '\n%s\n\n' "${GREEN}${code}${NC}"
    printf '%s\n' "  ${BOLD}3.${NC} В конце edge покажет ответный код BLINEDGE1… — вставьте его сюда."
    local reply parsed
    while true; do
        read -r -p "  Ответный код edge (Enter — позже: sudo blinvpn pair): " reply </dev/tty || true
        reply="$(clean_input "$reply")"
        if [[ -z "$reply" ]]; then
            log_warn "Сопряжение отложено. Продолжить: sudo blinvpn pair"
            return 0
        fi
        if parsed="$("${PANELCTL[@]}" parse-reply "$reply")"; then
            break
        fi
    done
    local R_EDGE_PUB="" R_ENDPOINT=""
    eval "$parsed"
    envset "EDGE_PUBKEY=$R_EDGE_PUB" "EDGE_ENDPOINT=$R_ENDPOINT"
    write_wg_conf "$R_ENDPOINT" "$R_EDGE_PUB"
    wg_up
    log_info "Жду рукопожатие WireGuard…"
    local _i
    for _i in $(seq 1 30); do
        (($(wg_handshake_age) < 180)) && break
        sleep 2
    done
    if (($(wg_handshake_age) >= 180)); then
        log_error "Нет рукопожатия с edge (${R_ENDPOINT})."
        hint "Проверьте: на edge открыт UDP-порт ${R_ENDPOINT##*:} (ufw), edge-установщик дошёл до конца."
        hint "Повторить: sudo blinvpn pair"
        return 1
    fi
    log_ok "✔ туннель поднят"
    "${PANELCTL[@]}" wait-agent 180 || {
        hint "edge-agent не отвечает: на edge — sudo systemctl status blinvpn-agent"
        return 1
    }
    "${PANELCTL[@]}" leaktest || log_warn "⚠ проверка сканера утечек не прошла — см. выше"
    "${PANELCTL[@]}" status || true
    log_ok "✔ edge подключён"
}

# ── Remnawave ─────────────────────────────────────────────────────

remnawave_checks() {
    local url="$1" token="$2" sub="$3"
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        -H "Authorization: Bearer ${token}" -H 'X-Forwarded-For: 127.0.0.1' -H 'X-Forwarded-Proto: https' \
        "${url%/}/api/system/metadata" || true)"
    if [[ "$code" == "200" ]]; then
        log_ok "✔ Remnawave отвечает, токен принят"
    else
        log_warn "⚠ Remnawave ответила HTTP ${code:-нет ответа} на ${url%/}/api/system/metadata — проверьте адрес и токен"
        confirm "Продолжить всё равно?" N || exit 1
    fi
    local bind
    bind="$(ss -ltnH 'sport = :3000' 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
    if printf '%s' "$bind" | grep -qE '(^| )(0\.0\.0\.0|\*|\[::\]):3000'; then
        log_warn "⚠ Remnawave слушает порт 3000 на всех адресах (${bind}). Её API доступен из интернета!"
        hint "В /opt/remnawave/docker-compose.yml укажите ports: - '127.0.0.1:3000:3000' и перезапустите Remnawave."
    fi
    local rwenv=/opt/remnawave/.env
    if [[ -f "$rwenv" ]]; then
        local cur
        cur="$(python3 "$HERE/envfile.py" get "$rwenv" SUB_PUBLIC_DOMAIN 2>/dev/null || true)"
        if [[ "$cur" != "$sub" ]]; then
            log_warn "В Remnawave SUB_PUBLIC_DOMAIN=${cur:-пусто}, а нужен ${sub} (ссылки подписки должны вести на edge)."
            if confirm "Исправить в ${rwenv} и перезапустить Remnawave?" Y; then
                cp "$rwenv" "${rwenv}.bak-$(date +%Y%m%d-%H%M%S)"
                python3 "$HERE/envfile.py" set "$rwenv" "SUB_PUBLIC_DOMAIN=$sub"
                (cd /opt/remnawave && docker compose up -d >/dev/null 2>&1) || log_warn "перезапустите Remnawave вручную"
                log_ok "✔ SUB_PUBLIC_DOMAIN=${sub}"
            fi
        else
            log_ok "✔ SUB_PUBLIC_DOMAIN в Remnawave = ${sub}"
        fi
    else
        log_warn "Не нашёл /opt/remnawave/.env. Проверьте сами: SUB_PUBLIC_DOMAIN=${sub} в .env Remnawave."
    fi
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'remnawave-subscription-page'; then
        log_warn "На сервере панели работает remnawave-subscription-page — теперь она живёт на edge."
        if confirm "Остановить её здесь?" Y; then
            docker stop remnawave-subscription-page >/dev/null 2>&1 || true
            docker update --restart=no remnawave-subscription-page >/dev/null 2>&1 || true
        fi
    fi
}

# ── домены ────────────────────────────────────────────────────────

check_domains() {
    # check_domains panel rw app sub hook
    local panel="$1" rw="$2" app="$3" sub="$4" hook="$5" d e
    local -a edge=("$app" "$sub" "$hook")
    [[ "$app" != "$sub" && "$app" != "$hook" && "$sub" != "$hook" ]] || die "домены мини-аппа, подписки и вебхуков должны различаться"
    for d in "${edge[@]}"; do
        domains_related "$d" "$panel" && die "домен ${d} связан с доменом панели ${panel} — так IP панели легко найти. Возьмите независимые домены."
        [[ -n "$rw" ]] && domains_related "$d" "$rw" && die "домен ${d} связан с доменом Remnawave ${rw}"
    done
    local my_ips ip
    my_ips=",$(all_public_ips),"
    ip="$(resolve_ipv4 "$panel" || true)"
    if [[ -z "$ip" ]]; then
        log_warn "⚠ ${panel} пока не резолвится — нужна A-запись на этот сервер"
    elif [[ "$my_ips" != *",${ip},"* ]]; then
        log_warn "⚠ ${panel} → ${ip}, а у сервера ${my_ips//,/ }"
        confirm "Продолжить?" N || exit 1
    fi
    for e in "${edge[@]}"; do
        ip="$(resolve_ipv4 "$e" || true)"
        if [[ -n "$ip" && "$my_ips" == *",${ip},"* ]]; then
            die "${e} указывает на ЭТОТ сервер (${ip}). Домены мини-аппа, подписки и вебхуков должны указывать на edge — иначе IP панели раскрыт."
        fi
        [[ -z "$ip" ]] && log_warn "⚠ ${e} пока не резолвится (нужна A-запись на edge-сервер)"
    done
    return 0
}

do_domains() {
    require_root
    [[ -f "$ENV_FILE" ]] || die "панель не установлена"
    section "Смена доменов"
    local panel rw app sub hook email
    panel="$(envget PANEL_DOMAIN)"
    rw="$(envget REMNAWAVE_UI_DOMAIN)"
    app="$(envget MINIAPP_DOMAIN)"
    sub="$(envget SUB_DOMAIN)"
    hook="$(envget WEBHOOK_DOMAIN)"
    hint "Enter — оставить как есть."
    ask_domain "Домен панели" panel "$panel"
    ask "Домен UI Remnawave (- чтобы убрать)" rw "" "" "${rw:--}"
    [[ "$rw" == "-" ]] && rw=""
    [[ -z "$rw" || "$rw" =~ $DOMAIN_RE ]] || die "неверный домен Remnawave"
    ask_domain "Домен мини-приложения (edge)" app "$app"
    ask_domain "Домен подписки (edge)" sub "$sub"
    ask_domain "Домен вебхуков (edge)" hook "$hook"
    check_domains "$panel" "$rw" "$app" "$sub" "$hook"
    email="$(envget SSL_EMAIL)"
    issue_certs "$email" "$panel" ${rw:+"$rw"} || die "сертификаты не выпущены — домены не изменены"
    local old_sub
    old_sub="$(envget SUB_DOMAIN)"
    envset "PANEL_DOMAIN=$panel" "PANEL_URL=https://$panel" "REMNAWAVE_UI_DOMAIN=$rw" \
        "MINIAPP_DOMAIN=$app" "MINIAPP_URL=https://$app" "SUB_DOMAIN=$sub" "REMWAVE_SUB_PUBLIC_URL=https://$sub" \
        "WEBHOOK_DOMAIN=$hook" "WEBHOOK_URL=https://$hook"
    "${PANELCTL[@]}" check-urls || die "адреса не прошли проверку"
    render_nginx
    dc up -d >/dev/null
    wait_healthy blinvpn-api || true
    if [[ "$sub" != "$old_sub" ]]; then
        remnawave_checks "$(envget REMWAVE_PANEL_URL)" "$(envget REMWAVE_API_KEY)" "$sub"
    fi
    log_info "Применяю домены на edge (сертификаты, nginx)…"
    if "${PANELCTL[@]}" apply-edge; then
        log_ok "✔ edge обновлён"
    else
        log_warn "⚠ edge не обновился. Проверьте A-записи новых доменов (→ IP edge) и повторите: sudo blinvpn domains"
    fi
    print_summary
}

do_endpoint() {
    require_root
    local ep="${1:-}"
    [[ -n "$ep" ]] || ask "Новый IP edge (или IP:порт)" ep
    local port
    port="$(envget EDGE_ENDPOINT)"
    port="${port##*:}"
    [[ "$ep" == *:* ]] || ep="${ep}:${port}"
    local pub
    pub="$(envget EDGE_PUBKEY)"
    [[ -n "$pub" ]] || die "edge ещё не подключён: sudo blinvpn pair"
    python3 - "$ep" <<PY || die "неверный адрес"
import sys
sys.path.insert(0, "$HERE")
import pairing
pairing.validate_reply({"proto": pairing.PROTOCOL, "edge_pub": "$pub", "endpoint": sys.argv[1]})
PY
    envset "EDGE_ENDPOINT=$ep"
    write_wg_conf "$ep" "$pub"
    wg_up
    sleep 3
    "${PANELCTL[@]}" wait-agent 60 && log_ok "✔ туннель переключён на ${ep}"
}

print_summary() {
    local app sub hook panel
    panel="$(envget PANEL_DOMAIN)"
    app="$(envget MINIAPP_DOMAIN)"
    sub="$(envget SUB_DOMAIN)"
    hook="$(envget WEBHOOK_DOMAIN)"
    section "Готово"
    printf '  Панель:           %s\n' "${YELLOW}https://${panel}${NC}"
    [[ -n "$(envget REMNAWAVE_UI_DOMAIN)" ]] && printf '  Remnawave:        %s\n' "${YELLOW}https://$(envget REMNAWAVE_UI_DOMAIN)${NC}"
    printf '  Мини-приложение:  %s  (edge)\n' "${YELLOW}https://${app}${NC}"
    printf '  Подписка:         %s  (edge)\n' "${YELLOW}https://${sub}${NC}"
    printf '\n  %s\n' "${BOLD}Вебхуки платёжек${NC} (домен ${hook}):"
    local p
    for p in platega cispay yookassa paypalych rollypay wata; do
        printf '    %-10s %s\n' "$p" "https://${hook}/${p}   ← вписать в кабинет"
    done
    for p in lava heleket 2328; do
        printf '    %-10s %s\n' "$p" "https://${hook}/${p}   (передаётся в каждом счёте сам)"
    done
    printf '\n  %s\n' "${BOLD}@BotFather${NC}: Web App URL и /setdomain → ${app}"
    printf '\n  %s\n' "${BOLD}Правила, чтобы IP панели не утёк${NC}:"
    hint "домены мини-аппа/подписки/вебхуков — только на edge; домен панели не связан с ними"
    hint "не заходите по SSH с панели на edge и обратно (адрес останется в логах) — только со своего компьютера"
    hint "не добавляйте сервер панели хостом/нодой в Remnawave"
    printf '\n  Команды: %s\n' "${CYAN}sudo blinvpn status | domains | edge-endpoint <IP> | pair | update | logs${NC}"
}

# ── новая установка ───────────────────────────────────────────────

do_install() {
    require_root
    setup_locale
    printf '\n%s\n' "${GREEN}${BOLD}BlinVPN ${BLINVPN_VERSION} — установка сервера панели${NC}"

    section "1. Проверки и пакеты"
    ensure_time_sync
    local p
    for p in 80 443; do
        if port_busy_by_other "$p"; then
            log_error "Порт ${p} занят другим сервисом:"
            ss -ltnp "sport = :${p}" || true
            hint "Обычно это nginx/caddy из установки Remnawave. Панель BlinVPN сама отдаёт домены панели и Remnawave —"
            hint "уберите их reverse-proxy с 80/443 (Remnawave должна слушать 127.0.0.1:3000) и запустите снова."
            exit 1
        fi
    done
    ensure_packages git curl ca-certificates nginx certbot wireguard-tools python3 openssl dnsutils iproute2 iputils-ping
    ensure_docker
    systemctl enable --now nginx >/dev/null 2>&1 || true

    mkdir -p "$PROJECT_DIR/data"
    [[ -f "$ENV_FILE" ]] || (umask 077 && : >"$ENV_FILE")
    chmod 600 "$ENV_FILE"

    restore_data

    section "2. Домены"
    hint "Панель — на ЭТОМ сервере. Мини-апп, подписка и вебхуки — на edge (их A-записи → IP edge)."
    hint "Домен панели лучше взять на отдельном домене, не похожем на бренд."
    local panel rw app sub hook email
    ask_domain "Домен панели BlinVPN (A-запись → этот сервер)" panel "$(envget PANEL_DOMAIN)"
    ask "Домен UI Remnawave на этом сервере (Enter — без домена, доступ через SSH-туннель)" rw "" "" "$(envget REMNAWAVE_UI_DOMAIN)"
    rw="$(sanitize_domain "$rw")"
    [[ -z "$rw" || "$rw" =~ $DOMAIN_RE ]] || die "неверный домен Remnawave"
    ask_domain "Домен мини-приложения (edge)" app "$(envget MINIAPP_DOMAIN)"
    ask_domain "Домен подписки (edge)" sub "$(envget SUB_DOMAIN)"
    ask_domain "Домен вебхуков платёжек (edge, лучше отдельный домен)" hook "$(envget WEBHOOK_DOMAIN)"
    ask "Email для Let's Encrypt" email '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' "нужен email" "$(envget SSL_EMAIL)"
    check_domains "$panel" "$rw" "$app" "$sub" "$hook"

    section "3. Telegram-бот"
    local token admin bot
    ask "Токен бота" token '^[0-9]{5,}:[A-Za-z0-9_-]{30,}$' "токен вида 1234567890:AAH… от @BotFather" "$(envget TELEGRAM_BOT_TOKEN)"
    ask "Ваш Telegram ID (админ)" admin '^[0-9]{3,15}$' "только цифры (@userinfobot)" "$(envget TELEGRAM_ADMIN_ID)"
    ask "Username бота (без @)" bot '^@?[A-Za-z0-9_]{3,32}$' "латиница, цифры и _" "$(envget BOT_USERNAME)"
    bot="${bot#@}"

    section "4. Remnawave (на этом сервере)"
    local rwurl rwtok subtok="" rwdef
    rwdef="$(envget REMWAVE_PANEL_URL)"
    [[ -n "$rwdef" ]] || rwdef="http://127.0.0.1:3000"
    ask "Адрес Remnawave" rwurl '^https?://[A-Za-z0-9._:-]+/?$' "например http://127.0.0.1:3000" "$rwdef"
    rwurl="${rwurl%/}"
    if [[ -n "$(envget REMWAVE_API_KEY)" ]] && confirm "Оставить сохранённый API-токен Remnawave?" Y; then
        rwtok="$(envget REMWAVE_API_KEY)"
    else
        ask_secret "API-токен Remnawave (Remnawave → Settings → API Tokens)" rwtok
    fi
    hint "Для страницы подписки можно выпустить отдельный токен только на чтение (scopes: subscriptions, subscription-pages, metadata)."
    hint "Он хранится только здесь, на edge его нет. Enter — использовать основной."
    read -r -s -p "  Токен для страницы подписки (Enter — основной): " subtok </dev/tty || true
    printf '\n'
    subtok="$(clean_input "$subtok")"
    remnawave_checks "$rwurl" "$rwtok" "$sub"

    section "5. Настройки"
    local repo
    repo="$(cd "$PROJECT_DIR" && git config --get remote.origin.url 2>/dev/null || echo "${BLINVPN_REPO_URL:-https://github.com/Blin4Dev/blinvpn.git}")"
    envset "PANEL_DOMAIN=$panel" "PANEL_URL=https://$panel" "REMNAWAVE_UI_DOMAIN=$rw" \
        "MINIAPP_DOMAIN=$app" "MINIAPP_URL=https://$app" \
        "SUB_DOMAIN=$sub" "REMWAVE_SUB_PUBLIC_URL=https://$sub" \
        "WEBHOOK_DOMAIN=$hook" "WEBHOOK_URL=https://$hook" "SSL_EMAIL=$email" \
        "TELEGRAM_BOT_TOKEN=$token" "TELEGRAM_ADMIN_ID=$admin" "BOT_USERNAME=$bot" "VITE_BOT_USERNAME=$bot" \
        "REMWAVE_PANEL_URL=$rwurl" "REMWAVE_API_KEY=$rwtok" "REPO_URL=$repo"
    [[ -n "$subtok" ]] && envset "REMNAWAVE_SUBPAGE_TOKEN=$subtok"
    migrate_env
    local ips
    ips="$(all_public_ips)"
    log_info "Публичные адреса этого сервера: ${ips:-не определены}"
    hint "Они в чёрном списке: если какой-то из них окажется в ответе пользователю — ответ будет заблокирован."
    envset "LEAK_GUARD_IPS=$ips"
    envensure "LEAK_GUARD_EXTRA="
    "${PANELCTL[@]}" check-urls || die "адреса не прошли проверку"
    log_ok "✔ .env готов (права 600)"

    section "6. Туннель WireGuard"
    wg_keys
    if [[ -n "$(envget EDGE_PUBKEY)" && -n "$(envget EDGE_ENDPOINT)" ]]; then
        write_wg_conf "$(envget EDGE_ENDPOINT)" "$(envget EDGE_PUBKEY)"
    else
        write_wg_conf
    fi
    docker_after_wg
    wg_up
    log_ok "✔ интерфейс ${WG_IFACE}: $(envget WG_PANEL_IP)"

    section "7. Сертификаты и nginx"
    issue_certs "$email" "$panel" ${rw:+"$rw"} || die "сертификаты не выпущены"
    ensure_certbot_timer
    render_nginx

    section "8. Файрвол"
    ufw_setup "80 443" "" "allow in on ${WG_IFACE} proto tcp from $(envget WG_NET) to $(envget WG_PANEL_IP) port $(envget INGRESS_PORT)"

    section "9. Сборка и запуск"
    # сервис-помощник 2.x (мастер XBM) больше не нужен: XBM живёт на edge
    if systemctl list-unit-files blinvpn-host.service >/dev/null 2>&1; then
        systemctl disable --now blinvpn-host.service >/dev/null 2>&1 || true
    fi
    fix_permissions
    dc_build || exit 1
    dc up -d --remove-orphans
    wait_healthy blinvpn-api
    wait_healthy blinvpn-api-public || true
    fix_permissions
    install_cli blinvpn "$HERE/blinvpn.sh"

    local creds="$PROJECT_DIR/data/first_run_credentials.txt"
    for _ in $(seq 1 20); do
        [[ -f "$creds" ]] && break
        sleep 1
    done
    if [[ -f "$creds" ]]; then
        section "Доступ в панель (показывается один раз)"
        printf '  Логин:  %s\n' "${YELLOW}$(python3 "$HERE/envfile.py" get "$creds" login)${NC}"
        printf '  Пароль: %s\n' "${YELLOW}$(python3 "$HERE/envfile.py" get "$creds" password)${NC}"
        rm -f "$creds"
    fi

    if [[ -n "$(envget EDGE_PUBKEY)" ]] && "${PANELCTL[@]}" wait-agent 20 >/dev/null 2>&1; then
        log_ok "✔ edge уже подключён"
    else
        pair_flow 0 || true
    fi
    print_summary
}

do_post_update() {
    require_root
    setup_locale
    section "Обновление панели до ${BLINVPN_VERSION}"
    migrate_env
    if [[ -z "$(envget LEAK_GUARD_IPS)" ]]; then
        envset "LEAK_GUARD_IPS=$(all_public_ips)"
    fi
    systemctl disable --now blinvpn-host.service >/dev/null 2>&1 || true
    render_nginx
    fix_permissions
    dc_build || exit 1
    dc up -d --remove-orphans
    wait_healthy blinvpn-api || true
    fix_permissions
    install_cli blinvpn "$HERE/blinvpn.sh"
    log_ok "✔ панель обновлена"
    if [[ -n "$(envget EDGE_PUBKEY)" ]]; then
        if confirm "Обновить и edge-сервер (код и контейнеры)?" Y; then
            if "${PANELCTL[@]}" update-edge "$(envget REPO_BRANCH)"; then
                log_ok "✔ edge обновлён"
            else
                log_warn "⚠ edge не обновился — на edge: sudo blinvpn-edge update"
            fi
        fi
    fi
    "${PANELCTL[@]}" status || true
}

case "${1:-}" in
    --post-update) do_post_update ;;
    --pair)
        require_root
        pair_flow 1
        ;;
    --domains) do_domains ;;
    --endpoint) do_endpoint "${2:-}" ;;
    "") do_install ;;
    *)
        echo "panel.sh [--post-update|--pair|--domains|--endpoint IP[:порт]]"
        exit 2
        ;;
esac

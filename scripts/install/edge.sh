#!/usr/bin/env bash
# BlinVPN 3.0 — установка и обслуживание EDGE-сервера (мини-апп, подписка, вебхуки).
#
#   edge.sh                 новая установка (нужен код сопряжения с панели)
#   edge.sh --post-update   после git pull: пересборка, nginx, агент
#
# На edge нет ни адреса, ни домена панели, ни её секретов: панель сама подключается сюда
# по WireGuard, а здесь хранится только её открытый ключ.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
trap 'log_error "Ошибка на строке $LINENO. Установка прервана — повторный запуск продолжит с того же места."' ERR

AGENT=(python3 "$PROJECT_DIR/edge/agent/agent.py")
AGENT_UNIT=/etc/systemd/system/blinvpn-agent.service

write_wg_conf() {
    local port="$1" panel_pub="$2" panel_ip="$3" edge_ip="$4" net="$5"
    umask 077
    cat >"$WG_CONF" <<EOF
# BlinVPN 3.0 — туннель панель → edge. Генерируется установщиком.
# У панели нет Endpoint: панель подключается сама, адрес панели здесь не хранится.
[Interface]
Address = ${edge_ip}/${net##*/}
ListenPort = ${port}
PrivateKey = $(cat "$WG_KEY")
MTU = 1420

[Peer]
# панель
PublicKey = ${panel_pub}
AllowedIPs = ${panel_ip}/32
EOF
    chmod 600 "$WG_CONF"
}

install_agent_unit() {
    cat >"$AGENT_UNIT" <<EOF
[Unit]
Description=BlinVPN edge-agent (команды панели по туннелю)
After=network-online.target wg-quick@${WG_IFACE}.service docker.service
Wants=network-online.target wg-quick@${WG_IFACE}.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 ${PROJECT_DIR}/edge/agent/agent.py serve
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable blinvpn-agent.service >/dev/null 2>&1 || true
    systemctl restart blinvpn-agent.service
}

xbm_state_dir() {
    mkdir -p "$PROJECT_DIR/data/xbm"
    chmod 755 "$PROJECT_DIR/data" "$PROJECT_DIR/data/xbm"
    if [[ ! -f "$PROJECT_DIR/data/xbm/panel.json" ]]; then
        printf '{}\n' >"$PROJECT_DIR/data/xbm/panel.json"
    fi
    chmod 644 "$PROJECT_DIR/data/xbm/panel.json"
}

do_install() {
    require_root
    setup_locale
    printf '\n%s\n' "${GREEN}${BOLD}BlinVPN ${BLINVPN_VERSION} — установка edge-сервера${NC}"

    section "1. Проверки и пакеты"
    ensure_time_sync
    local p
    for p in 80 443; do
        if port_busy_by_other "$p"; then
            log_error "Порт ${p} занят другим сервисом:"
            ss -ltnp "sport = :${p}" || true
            die "освободите порт ${p} и запустите снова"
        fi
    done
    ensure_packages git curl ca-certificates nginx certbot wireguard-tools python3 python3-dnspython openssl dnsutils iproute2
    ensure_docker
    systemctl enable --now nginx >/dev/null 2>&1 || true

    section "2. Код сопряжения с панели"
    hint "Его показал установщик панели (или: sudo blinvpn pair на панели). Строка начинается с BLINPAIR1."
    local code parsed
    while true; do
        read -r -p "  Код сопряжения: " code </dev/tty || true
        code="$(clean_input "$code")"
        [[ -z "$code" ]] && continue
        if parsed="$(python3 "$HERE/pairing.py" decode-pair "$code")"; then
            break
        fi
    done
    local P_PANEL_PUB="" P_PANEL_IP="" P_EDGE_IP="" P_NET="" P_INGRESS_PORT="" P_AGENT_PORT="" P_EDGE_TOKEN=""
    local P_AGENT_KEY="" P_APP="" P_SUB="" P_HOOK="" P_BOT="" P_EMAIL="" P_REPO="" P_BRANCH="" P_HOOKS=""
    eval "$parsed"
    log_ok "✔ код принят: мини-апп ${P_APP}, подписка ${P_SUB}, вебхуки ${P_HOOK}"

    section "3. DNS"
    local my_ip d ip
    my_ip="$(public_ipv4)"
    [[ -n "$my_ip" ]] || die "не удалось определить публичный IP этого сервера"
    log_info "IP этого сервера: ${my_ip}"
    for d in "$P_APP" "$P_SUB" "$P_HOOK"; do
        ip="$(resolve_ipv4 "$d" || true)"
        if [[ "$ip" != "$my_ip" ]]; then
            log_warn "⚠ ${d} → ${ip:-не резолвится}, а нужно ${my_ip}"
            confirm "Продолжить (сертификат для ${d} не выпустится, пока A-запись не исправлена)?" N || exit 1
        else
            log_ok "✔ ${d} → ${my_ip}"
        fi
    done

    section "4. Настройки"
    mkdir -p "$PROJECT_DIR/data"
    [[ -f "$ENV_FILE" ]] || (umask 077 && : >"$ENV_FILE")
    local wg_port
    wg_port="$(envget WG_LISTEN_PORT)"
    [[ -n "$wg_port" ]] || wg_port="$(shuf -i 20000-60000 -n 1)"
    envset "DEPLOY_ROLE=edge" "COMPOSE_FILE=docker-compose.edge.yml" \
        "APP_DOMAIN=$P_APP" "SUB_DOMAIN=$P_SUB" "HOOK_DOMAIN=$P_HOOK" "HOOK_PATHS=$P_HOOKS" \
        "SSL_EMAIL=$P_EMAIL" "BOT_USERNAME=$P_BOT" \
        "WG_NET=$P_NET" "PANEL_WG_IP=$P_PANEL_IP" "EDGE_WG_IP=$P_EDGE_IP" "WG_LISTEN_PORT=$wg_port" \
        "INGRESS_ADDR=${P_PANEL_IP}:${P_INGRESS_PORT}" "EDGE_AGENT_BIND=${P_EDGE_IP}:${P_AGENT_PORT}" \
        "EDGE_TOKEN=$P_EDGE_TOKEN" "EDGE_AGENT_KEY=$P_AGENT_KEY" "EDGE_PUBLIC_IP=$my_ip" \
        "REPO_BRANCH=$P_BRANCH"
    [[ -n "$P_REPO" ]] && envset "REPO_URL=$P_REPO"
    envensure "MINIAPP_PORT=9741" "XBM_PORT=4100" "SUBPAGE_PORT=3010"
    chmod 600 "$ENV_FILE"
    log_ok "✔ .env готов"

    section "5. Туннель WireGuard"
    wg_keys
    write_wg_conf "$wg_port" "$P_PANEL_PUB" "$P_PANEL_IP" "$P_EDGE_IP" "$P_NET"
    docker_after_wg
    wg_up
    log_ok "✔ интерфейс ${WG_IFACE}: ${P_EDGE_IP}, UDP ${wg_port}"

    section "6. Файрвол"
    ufw_setup "80 443" "$wg_port" "allow in on ${WG_IFACE} proto tcp from ${P_PANEL_IP} to ${P_EDGE_IP} port ${P_AGENT_PORT}"

    section "7. Сертификаты и nginx"
    ensure_certbot_timer
    "${AGENT[@]}" certs || log_warn "⚠ не все сертификаты выпущены — после исправления DNS: sudo blinvpn-edge certs"
    if "${AGENT[@]}" render-nginx; then
        log_ok "✔ nginx edge настроен"
    else
        log_warn "⚠ nginx не настроен (нет сертификатов). После исправления DNS: sudo blinvpn-edge certs"
    fi

    section "8. Сборка и запуск"
    xbm_state_dir
    dc pull subpage || log_warn "⚠ не удалось скачать образ страницы подписки — повторю при запуске"
    dc_build || exit 1
    dc up -d --remove-orphans
    install_agent_unit
    install_cli blinvpn-edge "$HERE/blinvpn-edge.sh"

    section "9. Ответный код для панели"
    local reply
    reply="$(python3 "$HERE/pairing.py" encode-reply "$(cat "$WG_PUB")" "${my_ip}:${wg_port}")" || die "не удалось сформировать ответный код"
    printf '\n  Вставьте этот код в установщик панели:\n\n%s\n\n' "${GREEN}${reply}${NC}"
    log_info "Жду подключения панели (до 10 минут)…"
    local _i
    for _i in $(seq 1 300); do
        (($(wg_handshake_age) < 180)) && break
        sleep 2
    done
    if (($(wg_handshake_age) < 180)); then
        log_ok "✔ панель подключилась"
        sleep 5
        dc up -d >/dev/null 2>&1 || true
    else
        log_warn "Панель пока не подключилась. Когда вставите код в панель, всё заработает само."
        hint "Проверка: sudo blinvpn-edge status"
    fi
    section "Готово"
    printf '  Мини-приложение:  %s\n' "${YELLOW}https://${P_APP}${NC}"
    printf '  Подписка:         %s\n' "${YELLOW}https://${P_SUB}${NC}"
    printf '  Вебхуки:          %s\n' "${YELLOW}https://${P_HOOK}/<платёжка>${NC}"
    hint "Сменить домены/обновить — с панели: sudo blinvpn domains / sudo blinvpn update"
    hint "Не заходите по SSH на этот сервер с сервера панели (адрес панели останется в логах)."
}

do_post_update() {
    require_root
    setup_locale
    section "Обновление edge до ${BLINVPN_VERSION}"
    envensure "MINIAPP_PORT=9741" "XBM_PORT=4100" "SUBPAGE_PORT=3010" "COMPOSE_FILE=docker-compose.edge.yml"
    xbm_state_dir
    dc_build || exit 1
    dc up -d --remove-orphans
    "${AGENT[@]}" render-nginx || log_warn "⚠ nginx не обновлён"
    install_agent_unit
    install_cli blinvpn-edge "$HERE/blinvpn-edge.sh"
    log_ok "✔ edge обновлён"
}

case "${1:-}" in
    --post-update) do_post_update ;;
    "") do_install ;;
    *)
        echo "edge.sh [--post-update]"
        exit 2
        ;;
esac

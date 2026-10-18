#!/usr/bin/env bash
# sudo blinvpn — управление СЕРВЕРОМ ПАНЕЛИ BlinVPN 3.0
set -Eeuo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SELF")" && pwd)"
PROJECT_DIR="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
    cat <<EOF
BlinVPN ${BLINVPN_VERSION} — сервер панели

  sudo blinvpn status                 состояние панели, туннеля и edge
  sudo blinvpn domains                сменить домены (панели, мини-аппа, подписки, вебхуков)
  sudo blinvpn edge-endpoint <IP>     edge переехал на новый IP (порт WireGuard прежний)
  sudo blinvpn pair                   подключить новый edge-сервер (старый потеряет доступ)
  sudo blinvpn update                 обновить панель (и edge)
  sudo blinvpn restart                перезапустить сервисы панели
  sudo blinvpn logs [сервис]          логи (api, api-public, webhook, ingress, bot, monitor)

Панель сменила IP? Ничего делать не нужно: панель сама подключается к edge.
Обновите только A-запись домена панели.
EOF
}

cmd="${1:-}"
if [[ -n "$cmd" ]]; then shift; fi
case "$cmd" in
    status)
        require_root
        printf '%s\n' "${BOLD}Контейнеры${NC}"
        dc ps --format 'table {{.Name}}\t{{.Status}}' || true
        printf '\n%s\n' "${BOLD}Туннель${NC}"
        age="$(wg_handshake_age)"
        if ((age < 180)); then
            log_ok "  ✔ рукопожатие ${age} с назад ($(envget EDGE_ENDPOINT))"
        else
            log_warn "  ✘ рукопожатия нет (edge: $(envget EDGE_ENDPOINT))"
        fi
        printf '\n'
        python3 "$HERE/panelctl.py" status || true
        ;;
    domains) bash "$HERE/panel.sh" --domains ;;
    edge-endpoint) bash "$HERE/panel.sh" --endpoint "${1:-}" ;;
    pair) bash "$HERE/panel.sh" --pair ;;
    update)
        require_root
        cd "$PROJECT_DIR"
        br="$(envget REPO_BRANCH)"
        br="${br:-main}"
        git fetch origin "$br"
        git reset --hard "origin/$br"
        exec bash "$HERE/panel.sh" --post-update
        ;;
    restart)
        require_root
        dc restart
        ;;
    logs)
        require_root
        dc logs --tail 200 -f "$@"
        ;;
    *) usage ;;
esac

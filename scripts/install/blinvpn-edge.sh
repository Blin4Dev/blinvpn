#!/usr/bin/env bash
# sudo blinvpn-edge — управление EDGE-сервером BlinVPN 3.0
set -Eeuo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SELF")" && pwd)"
PROJECT_DIR="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
    cat <<EOF
BlinVPN ${BLINVPN_VERSION} — edge-сервер

  sudo blinvpn-edge status        состояние (nginx, XBM, страница подписки, туннель)
  sudo blinvpn-edge certs         выпустить недостающие сертификаты и обновить nginx
  sudo blinvpn-edge update        обновить код edge
  sudo blinvpn-edge logs [сервис] логи (miniapp, xbm, subpage)
  sudo blinvpn-edge agent-logs    логи edge-agent

Домены и обновления удобнее менять с панели: sudo blinvpn domains / sudo blinvpn update
EOF
}

cmd="${1:-}"
if [[ -n "$cmd" ]]; then shift; fi
case "$cmd" in
    status)
        require_root
        dc ps --format 'table {{.Name}}\t{{.Status}}' || true
        age="$(wg_handshake_age)"
        if ((age < 180)); then
            log_ok "туннель: ✔ рукопожатие ${age} с назад"
        else
            log_warn "туннель: ✘ панель не подключена"
        fi
        if systemctl is-active --quiet blinvpn-agent; then
            log_ok "edge-agent: ✔"
        else
            log_warn "edge-agent: ✘ (sudo blinvpn-edge agent-logs)"
        fi
        python3 "$PROJECT_DIR/edge/agent/agent.py" status
        ;;
    certs)
        require_root
        python3 "$PROJECT_DIR/edge/agent/agent.py" certs || true
        python3 "$PROJECT_DIR/edge/agent/agent.py" render-nginx
        ;;
    update)
        require_root
        cd "$PROJECT_DIR"
        br="$(envget REPO_BRANCH)"
        br="${br:-main}"
        git fetch --depth 50 origin "$br"
        git reset --hard "origin/$br"
        exec bash "$HERE/edge.sh" --post-update
        ;;
    logs)
        require_root
        dc logs --tail 200 -f "$@"
        ;;
    agent-logs)
        journalctl -u blinvpn-agent -n 200 -f
        ;;
    *) usage ;;
esac

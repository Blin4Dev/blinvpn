#!/usr/bin/env bash
# BlinVPN 3.0 — установщик.
#
#   sudo bash install.sh            выбрать роль сервера и установить / обновить
#   sudo bash install.sh panel      сервер панели (бот, панель, Remnawave, база)
#   sudo bash install.sh edge       edge-сервер (мини-апп, подписка, вебхуки)
#
# Два сервера: пользователи видят только edge. Панель подключается к edge сама
# по WireGuard, поэтому edge не знает ни адреса, ни домена панели.
set -Eeuo pipefail

GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
RED=$'\033[0;31m'
NC=$'\033[0m'
BOLD=$'\033[1m'

PROJECT_DIR="${BLINVPN_DIR:-/opt/blinvpn}"
REPO_URL="${BLINVPN_REPO_URL:-https://github.com/Blin4Dev/blinvpn.git}"
REPO_BRANCH="${BLINVPN_BRANCH:-main}"

die() {
    printf '%s\n' "${RED}✘ $*${NC}" >&2
    exit 1
}

[[ "$(id -u)" -eq 0 ]] || die "Запустите от root: sudo bash install.sh"
command -v apt-get >/dev/null 2>&1 || die "Нужен Ubuntu 22.04+/Debian 12+"

if ! command -v git >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq --no-install-recommends git python3 curl ca-certificates >/dev/null || die "не удалось установить git/python3/curl"
fi

existing_role() {
    [[ -f "$PROJECT_DIR/.env" ]] || return 0
    python3 - "$PROJECT_DIR/.env" <<'PY'
import sys
for line in open(sys.argv[1], encoding="utf-8"):
    if line.startswith("DEPLOY_ROLE="):
        print(line.split("=", 1)[1].strip())
        break
PY
}

clone_repo() {
    local role="$1"
    if [[ -d "$PROJECT_DIR/.git" ]]; then
        return 0
    fi
    if [[ -e "$PROJECT_DIR" && -n "$(ls -A "$PROJECT_DIR" 2>/dev/null)" ]]; then
        die "$PROJECT_DIR уже существует и не пуст (а не репозиторий BlinVPN). Перенесите его и запустите снова."
    fi
    printf '%s\n' "${CYAN}Скачиваю BlinVPN (${REPO_BRANCH})…${NC}"
    if [[ "$role" == "edge" ]]; then
        # на edge — только то, что нужно edge (без исходников панели и бота)
        git clone --filter=blob:none --sparse --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
        git -C "$PROJECT_DIR" sparse-checkout set src/app src/site assets edge xbm deploy/edge scripts/install docker
    else
        git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
    fi
}

role="${1:-}"
current="$(existing_role)"

if [[ -n "$current" ]]; then
    printf '\n%s\n' "${GREEN}${BOLD}BlinVPN — найдена установка: ${current}${NC}"
    if [[ "$current" == "panel" ]]; then
        echo "  1) Обновить (по умолчанию)"
        echo "  2) Состояние"
        echo "  3) Сменить домены"
        echo "  4) Подключить новый edge-сервер"
        echo "  5) Выход"
        read -r -p "  Выбор [1-5]: " choice </dev/tty || true
        case "${choice:-1}" in
            2) exec bash "$PROJECT_DIR/scripts/install/blinvpn.sh" status ;;
            3) exec bash "$PROJECT_DIR/scripts/install/panel.sh" --domains ;;
            4) exec bash "$PROJECT_DIR/scripts/install/panel.sh" --pair ;;
            5) exit 0 ;;
            *) exec bash "$PROJECT_DIR/scripts/install/blinvpn.sh" update ;;
        esac
    else
        echo "  1) Обновить (по умолчанию)"
        echo "  2) Состояние"
        echo "  3) Выход"
        read -r -p "  Выбор [1-3]: " choice </dev/tty || true
        case "${choice:-1}" in
            2) exec bash "$PROJECT_DIR/scripts/install/blinvpn-edge.sh" status ;;
            3) exit 0 ;;
            *) exec bash "$PROJECT_DIR/scripts/install/blinvpn-edge.sh" update ;;
        esac
    fi
fi

if [[ -z "$role" ]]; then
    printf '\n%s\n\n' "${GREEN}${BOLD}BlinVPN 3.0 — какой это сервер?${NC}"
    echo "  1) Панель   — бот, панель управления, Remnawave, база (ставится первой)"
    echo "  2) Edge     — мини-приложение, страница подписки, вебхуки (то, что видят пользователи)"
    printf '\n'
    read -r -p "  Выбор [1-2]: " choice </dev/tty || true
    case "$choice" in
        1) role="panel" ;;
        2) role="edge" ;;
        *) die "выберите 1 или 2" ;;
    esac
fi
[[ "$role" == "panel" || "$role" == "edge" ]] || die "роль: panel или edge"

clone_repo "$role"
[[ -f "$PROJECT_DIR/scripts/install/${role}.sh" ]] || die "в репозитории нет scripts/install/${role}.sh — проверьте ветку ${REPO_BRANCH}"
printf '%s\n' "${YELLOW}Каталог установки: ${PROJECT_DIR}${NC}"
exec bash "$PROJECT_DIR/scripts/install/${role}.sh"

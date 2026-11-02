#!/usr/bin/env bash
#
# Идемпотентный деплой Wired на сервер.
#
#   DEPLOY_PATH=/home/Wired bash deploy-remote.sh [ref]
#
# Переменные:
#   DEPLOY_PATH  каталог деплоя (по умолчанию /home/Wired)
#   GIT_REMOTE   origin репозитория
#   DRY_RUN=1    печатать команды вместо выполнения (docker не требуется)
#
# Коды выхода: 2 — preflight (нет прав, нет sudo/docker), 3 — каталог не git,
#              4 — отсутствует или неполный .env.

set -Eeuo pipefail

REF="${1:-main}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/Wired}"
GIT_REMOTE="${GIT_REMOTE:-https://github.com/AshenHermit/Wired.git}"
DRY_RUN="${DRY_RUN:-0}"

REQUIRED_KEYS="DB_HOST DB_PORT DB_USER DB_NAME DB_PASSWORD AUTH_SECRET COMMON_DOMAIN SITE_HOST WIRED_GAME_TICKET_SECRET NEXT_PUBLIC_HASHIDS_SALT NEXT_PUBLIC_API_URL NEXT_PUBLIC_BACKEND_URL NEXT_PUBLIC_WEBSOCKET_URL"

SUDO=""
DOCKER="docker"

export GIT_TERMINAL_PROMPT=0

log() { printf '[deploy] %s\n' "$*"; }

die() {
  local message="$1"
  local code="${2:-1}"
  printf '[deploy] ОШИБКА: %s\n' "$message" >&2
  exit "$code"
}

run() {
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: $*"
    return 0
  fi
  "$@"
}

detect_sudo() {
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: проверка sudo пропущена"
    return 0
  fi
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
    return 0
  fi
  if sudo -n true 2>/dev/null; then
    SUDO="sudo"
    return 0
  fi
  die "пользователю $(id -un) нужен sudo без пароля (NOPASSWD)" 2
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "docker и docker compose уже установлены"
  else
    log "устанавливаю docker через get.docker.com"
    if [ "$DRY_RUN" = "1" ]; then
      log "dry-run: $SUDO sh -c 'curl -fsSL https://get.docker.com | sh'"
      log "dry-run: $SUDO usermod -aG docker $(id -un)"
      return 0
    fi
    $SUDO sh -c 'curl -fsSL https://get.docker.com | sh'
    $SUDO usermod -aG docker "$(id -un)" || true
  fi

  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi

  if ! docker info >/dev/null 2>&1; then
    if [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
      # Группа docker ещё не активна в текущей сессии (только что добавили).
      DOCKER="$SUDO docker"
    else
      die "docker daemon недоступен" 2
    fi
  fi

  $DOCKER compose version >/dev/null 2>&1 || die "docker compose недоступен" 2
}

ensure_network() {
  if $DOCKER network inspect shared-net >/dev/null 2>&1; then
    log "сеть shared-net уже есть"
  else
    log "создаю сеть shared-net"
    run $DOCKER network create shared-net
  fi
}

sync_code() {
  if [ -d "$DEPLOY_PATH/.git" ]; then
    git config --global --add safe.directory "$DEPLOY_PATH" >/dev/null 2>&1 || true
    if [ "$DRY_RUN" != "1" ] && [ ! -w "$DEPLOY_PATH/.git" ]; then
      die "нет прав на запись в $DEPLOY_PATH/.git; выполните: $SUDO chown -R $(id -un) $DEPLOY_PATH" 2
    fi
    log "обновляю код в $DEPLOY_PATH до $REF"
    run git -C "$DEPLOY_PATH" fetch --depth 1 origin "$REF"
    run git -C "$DEPLOY_PATH" reset --hard FETCH_HEAD
  elif [ -e "$DEPLOY_PATH" ]; then
    die "$DEPLOY_PATH существует, но это не git-репозиторий; освободите каталог вручную" 3
  else
    log "клонирую $GIT_REMOTE ($REF) в $DEPLOY_PATH"
    run git clone --depth 1 --branch "$REF" "$GIT_REMOTE" "$DEPLOY_PATH"
  fi
}

normalize_env() {
  local env_file="$DEPLOY_PATH/.env"
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: нормализую $env_file (CRLF -> LF)"
    return 0
  fi
  [ -f "$env_file" ] || die "нет $env_file: workflow пишет его из секрета PROD_ENV" 4
  sed -i 's/\r$//' "$env_file"
  chmod 600 "$env_file" 2>/dev/null || true
}

validate_env() {
  local env_file="$DEPLOY_PATH/.env"
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: проверяю обязательные ключи в $env_file"
    return 0
  fi
  local missing=""
  local key
  for key in $REQUIRED_KEYS; do
    local value
    value=$(awk -F= -v k="$key" '$0 ~ "^" k "=" { print substr($0, index($0, "=") + 1); exit }' "$env_file")
    if [ -z "$value" ]; then
      missing="$missing $key"
    fi
  done
  if [ -n "$missing" ]; then
    die "в $env_file пустые обязательные ключи:$missing" 4
  fi
}

compose() {
  run $DOCKER compose \
    --project-directory "$DEPLOY_PATH" \
    --env-file "$DEPLOY_PATH/.env" \
    -f "$DEPLOY_PATH/docker-compose.yml" \
    "$@"
}

main() {
  log "деплой $REF в $DEPLOY_PATH (dry-run=$DRY_RUN)"
  detect_sudo
  ensure_docker
  ensure_network
  sync_code
  normalize_env
  validate_env
  compose build --pull
  compose up -d --force-recreate --wait
  run $DOCKER image prune -f
  log "готово"
}

if [ "${DEPLOY_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi

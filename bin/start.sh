#!/usr/bin/env bash
# =============================================================================
#  Secure Password Generator - stack control
#
#  One entry point for the whole Docker stack:
#    app              Next.js 16 UI + API (dev server or standalone production)
#    secrets-manager  AWS Secrets Manager compatible endpoint (SigV4 + JSON 1.1)
#
#  Supported environments (file suffixes): dev, prd
#    .env.dev / docker-compose.dev.yml / Dockerfile.password.dev
#    .env.prd / docker-compose.prd.yml / Dockerfile.password.prd
#
#  Run without arguments for the interactive menu:
#    ./bin/start.sh
#
#  Or use a command directly:
#    ./bin/start.sh up dev
#    ./bin/start.sh backup prd
#    ./bin/start.sh restore prd backups/prd/backup-prd-20250101T000000Z.tar.gz
#    ./bin/start.sh secrets test
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR" || exit 1

# Backups contain the encryption key and every secret. Keep everything this
# script creates private to the invoking user.
umask 077

# Read-only host checks (nginx) may need root. Prefer passwordless sudo when
# this script is not running as root; Docker access is handled separately.
if [ "$(id -u)" -eq 0 ]; then
  S=""
elif sudo -n true 2>/dev/null; then
  S="sudo -n"
else
  S=""
fi

VERSION="1.0.0"
DEFAULT_ENV="dev"
SUPPORTED_ENVS="dev prd"
BACKUP_ROOT="$ROOT_DIR/backups"
RUN_DIR="$ROOT_DIR/.run"

APP_SERVICE="app"
SECRETS_SERVICE="secrets-manager"

REQUESTED_ENV=""
APP_ENV_RESOLVED=""
ENV_FILE=""
COMPOSE_FILE=""
PROJECT=""
APP_PORT=""
APP_DEBUG_PORT=""
APP_BIND_ADDRESS=""
APP_HOST=""
SECRETS_MANAGER_HOST=""
APP_PUBLIC_URL=""
SECRETS_MANAGER_PUBLIC_URL=""
PUBLIC_HTTPS_PORT=""
SECRETS_MANAGER_PORT=""
SECRETS_MANAGER_BIND_ADDRESS=""
SECRETS_MANAGER_REGION=""
SECRETS_MANAGER_ACCESS_KEY_ID=""
SECRETS_MANAGER_SECRET_ACCESS_KEY=""
SECRETS_MANAGER_MASTER_KEY=""
APP_CONFIG_SECRET_ID=""
INTEGRITY_SECRET_ID=""
PASSWORD_GENERATOR_SCRIPT=""
WORDLIST_PATH=""
BACKUP_RETENTION="7"
BACKUP_TAR_IMAGE="alpine:3.20"
TAR_IMAGE=""

ASSUME_YES=false

BACKUP_LIVE=false
BACKUP_ALL_VOLUMES=false
BACKUP_KEEP_STAGING=false
BACKUP_REASON="manual"
BACKUP_SM_STOPPED=false
LAST_STAGING=""
LAST_TIMESTAMP=""

RESTORE_SNAPSHOT=true
RESTORE_MERGE=false
RESTORE_VOLUME=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  BOLD=""
  RESET=""
fi

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
hr() { printf '%s\n' "================================================================================"; }
section() { printf '\n%s\n' "${BOLD}== $* ==${RESET}"; }
info() { printf '%s\n' "$*"; }
ok() { printf '%s%s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
err() { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; }
die() { err "$*"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Secure Password Generator - stack control

Usage:
  ./bin/start.sh                          Interactive menu
  ./bin/start.sh <command> [dev|prd] [options]

Host ports (identical for dev and prd; run one environment per host):
  app 18000 | secrets manager 18001 | debug 18002 | public HTTP/HTTPS 80/443 (host nginx)

Production public endpoints:
  https://password.agiolab.com
  https://secrets.agiolab.com

Commands:
  up, start            Build (cached) and start the stack
  down, stop           Stop the stack (volumes preserved)
  restart              Restart containers without rebuilding
  recreate             Recreate containers to apply .env / compose changes
  rebuild              Force rebuild without cache, then recreate
  status               Services, ports, volumes and latest backup
  logs [service]       Logs for app / secrets-manager (--follow, --tail N)
  health [--strict]    App and Secrets Manager health
  smoke                End-to-end test (API, policy, AWS protocol)
  backup               Full Docker volume backup to .tar.gz
  restore <path>       Restore a bundle (.tar.gz) or staging directory
  backups <sub>        list | verify | prune
  cleanup <scope>      containers | volumes | images | backups | all | dangling
  secrets <sub>        list | get | put | create | describe | delete |
                       seed | test | verify | endpoint | random | raw
  shell [service]      Shell in app (default) or secrets-manager
  exec <cmd...>        Run a command in the app container
  test-cli             Test password_generator.py (host or container)
  config               Resolved configuration (secrets redacted)
  check-env            Verify .env.example / .env.dev / .env.prd parity
  doctor               Prerequisites and consistency checks
  help                 This help

Options:
  --build              Rebuild images (cached) before starting
  --no-build           Do not build before starting
  --force-rebuild      Rebuild without cache, pull base images, recreate
  --attach             Follow app logs after starting
  --live               Back up without stopping the Secrets Manager
  --all-volumes        Back up every project volume (not only labelled ones)
  --retention N        Keep the N newest backups (0 = keep all)
  --keep-staging       Keep the per-volume staging directory
  --yes                Skip confirmation prompts (automation)
  --no-snapshot        Do not take a pre-restore safety snapshot
  --merge              Merge into volumes instead of replacing their contents
  --volume NAME        Target volume when restoring a single-volume archive
  --force              Overwrite existing secrets when seeding
  --strict             Treat a degraded readiness probe as a failure

Examples:
  ./bin/start.sh up dev
  ./bin/start.sh rebuild prd
  ./bin/start.sh backup prd --retention 10
  ./bin/start.sh restore prd backups/prd/backup-prd-20250101T000000Z.tar.gz
  ./bin/start.sh secrets prd test
  ./bin/start.sh secrets dev verify --sdk --boto3
  ./bin/start.sh check-env
  ./bin/start.sh cleanup dev volumes --yes

Environment selection: the token "dev" or "prd" may appear anywhere on the
command line. Without it, APP_ENV from the shell or "dev" is used.
EOF
}

# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------
is_env_token() {
  case "$1" in
    dev|development|prd|prod|production) return 0 ;;
    *) return 1 ;;
  esac
}

has_sha256() {
  has sha256sum || has shasum || has openssl
}

sha256_file() {
  local file="$1"
  if has sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  elif has shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif has openssl; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    return 1
  fi
}

write_checksum_file() {
  local file="$1" sum base
  sum="$(sha256_file "$file")" || return 1
  base="$(basename "$file")"
  printf '%s  %s\n' "$sum" "$base" > "$file.sha256" || return 1
  return 0
}

verify_file_checksum() {
  local file="$1" dir base
  dir="$(dirname "$file")"
  base="$(basename "$file")"
  if [ ! -f "$file.sha256" ]; then
    return 1
  fi
  (
    cd "$dir" || exit 1
    if has sha256sum; then
      sha256sum -c "$base.sha256" >/dev/null 2>&1
    elif has shasum; then
      shasum -a 256 -c "$base.sha256" >/dev/null 2>&1
    else
      exit 1
    fi
  )
}

verify_checksums() {
  local dir="$1"
  [ -f "$dir/checksums.sha256" ] || return 1
  (
    cd "$dir" || exit 1
    if has sha256sum; then
      sha256sum -c checksums.sha256 >/dev/null 2>&1
    elif has shasum; then
      shasum -a 256 -c checksums.sha256 >/dev/null 2>&1
    else
      exit 1
    fi
  )
}

human_bytes() {
  awk -v bytes="$1" 'BEGIN {
    split("B KB MB GB TB", units, " ");
    unit = 1;
    while (bytes >= 1024 && unit < 5) { bytes /= 1024; unit++ }
    printf "%.1f%s", bytes, units[unit];
  }'
}

redact() {
  local value="${1:-}" length
  length=${#value}
  if [ "$length" -le 8 ]; then
    printf '***'
  else
    printf '%s***%s' "${value:0:4}" "${value: -4}"
  fi
}

pause() {
  if [ -t 0 ]; then
    printf '\nPress Enter to continue...' >&2
    read -r _ || true
  fi
}

confirm() {
  local prompt="$1" default="${2:-no}" answer
  if [ "$ASSUME_YES" = true ]; then
    return 0
  fi
  [ -t 0 ] || return 1
  case "$default" in
    yes|y) prompt="$prompt [Y/n]: " ;;
    *) prompt="$prompt [y/N]: " ;;
  esac
  printf '%s' "$prompt" >&2
  read -r answer || return 1
  case "$answer" in
    "") case "$default" in yes|y) return 0 ;; *) return 1 ;; esac ;;
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

confirm_typed() {
  local expected="$1" prompt="$2" answer=""
  if [ "$ASSUME_YES" = true ]; then
    return 0
  fi
  [ -t 0 ] || return 1
  printf '%s' "$prompt" >&2
  read -r answer || return 1
  [ "$answer" = "$expected" ]
}

ensure_docker_config() {
  local docker_config="${DOCKER_CONFIG:-${HOME:-$ROOT_DIR}/.docker}"
  if [ -d "$docker_config" ] && [ -w "$docker_config" ]; then
    return 0
  fi
  if [ ! -e "$docker_config" ] && mkdir -p "$docker_config" 2>/dev/null; then
    return 0
  fi
  local fallback="$RUN_DIR/docker-config"
  mkdir -p "$fallback" || return 1
  if [ -f "$docker_config/config.json" ] && [ ! -f "$fallback/config.json" ]; then
    cp "$docker_config/config.json" "$fallback/config.json" 2>/dev/null || true
  fi
  export DOCKER_CONFIG="$fallback"
  warn "Docker config directory '$docker_config' is not writable; using '$fallback' for this session."
  return 0
}

require_docker() {
  ensure_docker_config
  if ! has docker; then
    err "docker is not installed or not on PATH."
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "The Docker daemon is not reachable. Is it running?"
    return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 is required ('docker compose')."
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Environment resolution
# ---------------------------------------------------------------------------
resolve_env() {
  local requested="${1:-${APP_ENV:-$DEFAULT_ENV}}" candidate

  candidate="$(printf '%s' "$requested" | tr '[:upper:]' '[:lower:]')"
  case "$candidate" in
    dev|development) candidate="dev" ;;
    prd|prod|production) candidate="prd" ;;
    *) err "Unknown environment '$requested'. Use: dev or prd."; return 1 ;;
  esac

  APP_ENV_RESOLVED="$candidate"
  ENV_FILE="$ROOT_DIR/.env.$candidate"
  COMPOSE_FILE="$ROOT_DIR/docker-compose.$candidate.yml"

  if [ ! -f "$ENV_FILE" ]; then
    err "Missing environment file: $ENV_FILE"
    return 1
  fi
  if [ ! -f "$COMPOSE_FILE" ]; then
    err "Missing compose file: $COMPOSE_FILE"
    return 1
  fi

  # Clear previously sourced values so switching environments cannot leak.
  for name in \
    APP_ENV COMPOSE_PROJECT_NAME \
    APP_BIND_ADDRESS APP_PORT APP_DEBUG_BIND_ADDRESS APP_DEBUG_PORT \
    APP_HOST SECRETS_MANAGER_HOST APP_PUBLIC_URL SECRETS_MANAGER_PUBLIC_URL \
    PUBLIC_HTTPS_PORT SECRETS_MANAGER_BIND_ADDRESS SECRETS_MANAGER_PORT SECRETS_MANAGER_REGION \
    SECRETS_MANAGER_ACCOUNT_ID SECRETS_MANAGER_ACCESS_KEY_ID \
    SECRETS_MANAGER_SECRET_ACCESS_KEY SECRETS_MANAGER_SESSION_TOKEN \
    SECRETS_MANAGER_MASTER_KEY SECRETS_MANAGER_ENABLED SECRETS_MANAGER_ENDPOINT \
    APP_CONFIG_SECRET_ID INTEGRITY_SECRET_ID SECRETS_CACHE_TTL_MS \
    PASSWORD_GENERATOR_SCRIPT WORDLIST_PATH PYTHON_BIN LOG_LEVEL TZ \
    BACKUP_TAR_IMAGE BACKUP_RETENTION APP_VERSION; do
    unset "$name" 2>/dev/null || true
  done

  # shellcheck disable=SC1090
  set -a
  if ! . "$ENV_FILE"; then
    set +a
    err "Could not load $ENV_FILE (check its syntax)."
    return 1
  fi
  set +a

  PROJECT="${COMPOSE_PROJECT_NAME:-passwordgenerator_$candidate}"
  APP_PORT="${APP_PORT:-18000}"
  APP_DEBUG_PORT="${APP_DEBUG_PORT:-18002}"
  APP_BIND_ADDRESS="${APP_BIND_ADDRESS:-127.0.0.1}"
  APP_HOST="${APP_HOST:-password.agiolab.com}"
  SECRETS_MANAGER_HOST="${SECRETS_MANAGER_HOST:-secrets.agiolab.com}"
  PUBLIC_HTTPS_PORT="${PUBLIC_HTTPS_PORT:-443}"
  APP_PUBLIC_URL="${APP_PUBLIC_URL:-}"
  SECRETS_MANAGER_PUBLIC_URL="${SECRETS_MANAGER_PUBLIC_URL:-}"
  if [ -z "$APP_PUBLIC_URL" ]; then
    if [ "$PUBLIC_HTTPS_PORT" = "443" ]; then
      APP_PUBLIC_URL="https://$APP_HOST"
    else
      APP_PUBLIC_URL="https://$APP_HOST:$PUBLIC_HTTPS_PORT"
    fi
  fi
  if [ -z "$SECRETS_MANAGER_PUBLIC_URL" ]; then
    if [ "$PUBLIC_HTTPS_PORT" = "443" ]; then
      SECRETS_MANAGER_PUBLIC_URL="https://$SECRETS_MANAGER_HOST"
    else
      SECRETS_MANAGER_PUBLIC_URL="https://$SECRETS_MANAGER_HOST:$PUBLIC_HTTPS_PORT"
    fi
  fi
  SECRETS_MANAGER_PORT="${SECRETS_MANAGER_PORT:-18001}"
  SECRETS_MANAGER_BIND_ADDRESS="${SECRETS_MANAGER_BIND_ADDRESS:-127.0.0.1}"
  SECRETS_MANAGER_REGION="${SECRETS_MANAGER_REGION:-us-east-1}"
  SECRETS_MANAGER_ACCESS_KEY_ID="${SECRETS_MANAGER_ACCESS_KEY_ID:-}"
  SECRETS_MANAGER_SECRET_ACCESS_KEY="${SECRETS_MANAGER_SECRET_ACCESS_KEY:-}"
  SECRETS_MANAGER_MASTER_KEY="${SECRETS_MANAGER_MASTER_KEY:-}"
  APP_CONFIG_SECRET_ID="${APP_CONFIG_SECRET_ID:-password-generator/$candidate/app-config}"
  INTEGRITY_SECRET_ID="${INTEGRITY_SECRET_ID:-password-generator/$candidate/integrity}"
  PASSWORD_GENERATOR_SCRIPT="${PASSWORD_GENERATOR_SCRIPT:-}"
  WORDLIST_PATH="${WORDLIST_PATH:-}"
  BACKUP_RETENTION="${BACKUP_RETENTION:-7}"
  BACKUP_TAR_IMAGE="${BACKUP_TAR_IMAGE:-alpine:3.20}"

  case "$APP_PORT" in
    ''|*[!0-9]*) err "APP_PORT must be a number (found '$APP_PORT' in $ENV_FILE)."; return 1 ;;
  esac
  case "$SECRETS_MANAGER_PORT" in
    ''|*[!0-9]*) err "SECRETS_MANAGER_PORT must be a number (found '$SECRETS_MANAGER_PORT')."; return 1 ;;
  esac
  case "$APP_DEBUG_PORT" in
    ''|*[!0-9]*) err "APP_DEBUG_PORT must be a number (found '$APP_DEBUG_PORT')."; return 1 ;;
  esac
  case "$PUBLIC_HTTPS_PORT" in
    ''|*[!0-9]*) err "PUBLIC_HTTPS_PORT must be a number (found '$PUBLIC_HTTPS_PORT')."; return 1 ;;
  esac
  if [ -z "$SECRETS_MANAGER_ACCESS_KEY_ID" ] || [ -z "$SECRETS_MANAGER_SECRET_ACCESS_KEY" ]; then
    err "SECRETS_MANAGER_ACCESS_KEY_ID / SECRETS_MANAGER_SECRET_ACCESS_KEY are required in $ENV_FILE."
    return 1
  fi

  # The reference file and both environment files must stay line-aligned.
  if ! bash "$ROOT_DIR/bin/check-env-parity.sh" --quiet; then
    err "Environment parity check failed."
    err "Run: ./bin/check-env-parity.sh"
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Docker Compose helpers
# ---------------------------------------------------------------------------
compose() {
  docker compose --project-directory "$ROOT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

validate_compose() {
  if ! compose config -q >/dev/null 2>&1; then
    err "The Compose configuration for '$APP_ENV_RESOLVED' is invalid:"
    compose config >/dev/null
    return 1
  fi
  return 0
}

project_for_env() {
  local env="$1" project
  project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$ROOT_DIR/.env.$env" 2>/dev/null | head -n 1 | tr -d '\"')"
  printf '%s' "${project:-passwordgenerator_$env}"
}

service_id() {
  compose ps -a -q "$1" 2>/dev/null | head -n 1
}

service_state() {
  local id
  id="$(service_id "$1")"
  if [ -z "$id" ]; then
    printf 'missing'
    return 0
  fi
  docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || printf 'unknown'
}

service_health() {
  local id
  id="$(service_id "$1")"
  if [ -z "$id" ]; then
    printf 'n/a'
    return 0
  fi
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$id" 2>/dev/null || printf 'unknown'
}

is_running() {
  local id
  id="$(service_id "$1")"
  [ -n "$id" ] || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = "true" ]
}

wait_for_healthy() {
  local service="$1" timeout="${2:-180}" elapsed=0 status
  info "Waiting for $service to become healthy (timeout ${timeout}s)..."
  while [ "$elapsed" -lt "$timeout" ]; do
    status="$(service_health "$service")"
    case "$status" in
      healthy)
        ok "$service is healthy."
        return 0
        ;;
      unhealthy)
        err "$service reported unhealthy."
        return 1
        ;;
    esac
    if [ "$(service_state "$service")" = "exited" ]; then
      err "$service exited."
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  err "Timed out waiting for $service."
  return 1
}

loopback_address() {
  case "$1" in
    0.0.0.0|::|"") printf '127.0.0.1' ;;
    *) printf '%s' "$1" ;;
  esac
}

app_url() {
  printf 'http://%s:%s' "$(loopback_address "$APP_BIND_ADDRESS")" "$APP_PORT"
}

sm_url() {
  printf 'http://%s:%s' "$(loopback_address "$SECRETS_MANAGER_BIND_ADDRESS")" "$SECRETS_MANAGER_PORT"
}

app_public_url() {
  printf '%s' "${APP_PUBLIC_URL:-https://$APP_HOST}"
}

sm_public_url() {
  printf '%s' "${SECRETS_MANAGER_PUBLIC_URL:-https://$SECRETS_MANAGER_HOST}"
}

require_service_running() {
  if ! is_running "$1"; then
    err "'$1' is not running. Start the stack first: ./bin/start.sh up $APP_ENV_RESOLVED"
    return 1
  fi
  return 0
}

fetch_http() {
  local url="$1" output status_code
  output="$(curl -sS --max-time 20 -w '\n%{http_code}' "$url" 2>&1)"
  if [ $? -ne 0 ]; then
    HTTP_CODE="000"
    HTTP_BODY="$output"
    return 1
  fi
  status_code="$(printf '%s' "$output" | tail -n 1)"
  HTTP_CODE="$status_code"
  HTTP_BODY="$(printf '%s' "$output" | sed '$d')"
  if [ "$status_code" = "000" ]; then
    return 1
  fi
  return 0
}

fetch_https() {
  local url="$1" host="$2" output status_code
  local args=(-sS --max-time 20 --resolve "$host:${PUBLIC_HTTPS_PORT}:127.0.0.1" -w '\n%{http_code}')
  output="$(curl "${args[@]}" "$url" 2>&1)"
  if [ $? -ne 0 ]; then
    HTTP_CODE="000"
    HTTP_BODY="$output"
    return 1
  fi
  status_code="$(printf '%s' "$output" | tail -n 1)"
  HTTP_CODE="$status_code"
  HTTP_BODY="$(printf '%s' "$output" | sed '$d')"
  [ "$status_code" != "000" ]
}

wait_for_public_https() {
  local url="$1" host="$2" timeout="${3:-120}" elapsed=0
  info "Waiting for public endpoint $url ..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if fetch_https "$url" "$host" && [ "$HTTP_CODE" = "200" ]; then
      ok "Public endpoint is ready: $url"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  err "Timed out waiting for $url (HTTP ${HTTP_CODE:-000})."
  return 1
}

check_other_environment_stopped() {
  local other_env other_project running
  if [ "$APP_ENV_RESOLVED" = "dev" ]; then
    other_env="prd"
  else
    other_env="dev"
  fi
  other_project="$(project_for_env "$other_env")"
  running="$(docker ps -q --filter "label=com.docker.compose.project=$other_project" 2>/dev/null | head -n 1)"
  if [ -n "$running" ]; then
    err "The '$other_env' environment is running and uses the same host ports:"
    err "  app $APP_PORT | secrets $SECRETS_MANAGER_PORT | debug $APP_DEBUG_PORT | public $PUBLIC_HTTPS_PORT"
    err "Only one environment can run per host. Stop it first:"
    err "  ./bin/start.sh down $other_env"
    return 1
  fi
  return 0
}

check_host_nginx() {
  [ "$APP_ENV_RESOLVED" = "prd" ] || return 0

  if ! has nginx; then
    err "Host nginx is required in production but was not found."
    err "Install nginx and deploy/nginx/agiolab.conf; see deploy/nginx/README.md."
    return 1
  fi
  if ! port_in_use "$PUBLIC_HTTPS_PORT"; then
    err "Host nginx is not listening on port $PUBLIC_HTTPS_PORT."
    err "Start/reload nginx after installing deploy/nginx/agiolab.conf."
    return 1
  fi

  local nginx_conf="" host
  if $S nginx -T >/dev/null 2>&1; then
    nginx_conf="$($S nginx -T 2>/dev/null)"
  else
    # Certificate-key permissions commonly make `nginx -T` fail for non-root.
    # The enabled server_name lines are enough for this preflight.
    nginx_conf="$($S grep -Rhs "server_name" /etc/nginx/conf.d /etc/nginx/sites-enabled 2>/dev/null || true)"
  fi
  for host in "$APP_HOST" "$SECRETS_MANAGER_HOST"; do
    if ! printf '%s\n' "$nginx_conf" | grep -Fq "$host"; then
      err "Host nginx does not declare server_name $host."
      err "Install deploy/nginx/agiolab.conf (see deploy/nginx/README.md), run nginx -t, and reload nginx."
      return 1
    fi
  done
  return 0
}

preflight_start() {
  check_other_environment_stopped || return 1
  check_host_nginx || return 1
  return 0
}

wait_for_public_nginx() {
  [ "$APP_ENV_RESOLVED" = "prd" ] || return 0
  info "Waiting for public HTTPS through host nginx..."
  if ! wait_for_public_https "$(app_public_url)/api/health" "$APP_HOST" 120; then
    err "Public app endpoint is not reachable through host nginx."
    err "Check: sudo nginx -t && sudo systemctl reload nginx"
    err "Config: deploy/nginx/agiolab.conf"
    return 1
  fi
  if ! wait_for_public_https "$(sm_public_url)/healthz" "$SECRETS_MANAGER_HOST" 120; then
    err "Public Secrets Manager endpoint is not reachable through host nginx."
    err "Check: sudo nginx -t && sudo systemctl reload nginx"
    err "Config: deploy/nginx/agiolab.conf"
    return 1
  fi
  return 0
}

post_json() {
  local url="$1" payload="$2" output status_code
  output="$(curl -sS --max-time 30 -X POST \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" \
    -w '\n%{http_code}' "$url" 2>&1)"
  if [ $? -ne 0 ]; then
    HTTP_CODE="000"
    HTTP_BODY="$output"
    return 1
  fi
  status_code="$(printf '%s' "$output" | tail -n 1)"
  HTTP_CODE="$status_code"
  HTTP_BODY="$(printf '%s' "$output" | sed '$d')"
  if [ "$status_code" = "000" ]; then
    return 1
  fi
  return 0
}

pretty_json() {
  if has jq; then
    jq . 2>/dev/null || cat
  else
    cat
  fi
}

extract_password() {
  printf '%s' "$1" | sed -n 's/.*"password":"\([^"]*\)".*/\1/p'
}

extract_json_string() {
  local key="$1" body="$2"
  printf '%s' "$body" | sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p"
}

# ---------------------------------------------------------------------------
# Secrets Manager helpers
# ---------------------------------------------------------------------------
aws_sm() {
  (
    export AWS_ACCESS_KEY_ID="$SECRETS_MANAGER_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$SECRETS_MANAGER_SECRET_ACCESS_KEY"
    export AWS_REGION="$SECRETS_MANAGER_REGION"
    export AWS_DEFAULT_REGION="$SECRETS_MANAGER_REGION"
    export AWS_PAGER=""
    if [ -n "${SECRETS_MANAGER_SESSION_TOKEN:-}" ]; then
      export AWS_SESSION_TOKEN="$SECRETS_MANAGER_SESSION_TOKEN"
    fi
    aws --endpoint-url "$(sm_url)" --region "$SECRETS_MANAGER_REGION" secretsmanager "$@"
  )
}

sm_cli() {
  compose exec -T secrets-manager node cli.mjs "$@"
}

require_sm_running() {
  if is_running "$SECRETS_SERVICE"; then
    return 0
  fi
  warn "The Secrets Manager is not running."
  if ! confirm "Start the Secrets Manager now?" yes; then
    return 1
  fi
  compose up -d "$SECRETS_SERVICE" || return 1
  wait_for_healthy "$SECRETS_SERVICE" 90
}

seed_secrets() {
  local force="${1:-false}" flag="false"
  if [ "$force" = true ] || [ "$force" = "--force" ]; then
    flag="true"
  fi
  require_sm_running || return 1
  info "Seeding application secrets (environment: $APP_ENV_RESOLVED)..."
  if compose exec -T \
    -e "SEED_ENV=$APP_ENV_RESOLVED" \
    -e "SEED_FORCE=$flag" \
    "$SECRETS_SERVICE" node seed.mjs; then
    ok "Application secrets are present."
    return 0
  fi
  err "Secret seeding failed."
  return 1
}

# ---------------------------------------------------------------------------
# Volumes and tar streaming
# ---------------------------------------------------------------------------
project_volumes() {
  docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null | sort
}

select_backup_volumes() {
  local volume label labelled="" all="" filtered=""
  all="$(project_volumes)"
  if [ -z "$all" ]; then
    return 0
  fi
  for volume in $all; do
    label="$(docker volume inspect -f '{{ index .Labels "com.pwdgen.backup" }}' "$volume" 2>/dev/null || true)"
    if [ "$label" = "true" ]; then
      labelled="$labelled $volume"
    fi
  done
  if [ "$BACKUP_ALL_VOLUMES" = true ] || [ -z "$labelled" ]; then
    filtered="$all"
  else
    filtered="$labelled"
  fi
  printf '%s\n' "$filtered" | tr ' ' '\n' | sed '/^$/d'
}

ensure_tar_image() {
  if [ -n "$TAR_IMAGE" ] && docker image inspect "$TAR_IMAGE" >/dev/null 2>&1; then
    return 0
  fi
  if [ -n "${BACKUP_TAR_IMAGE:-}" ] && docker image inspect "$BACKUP_TAR_IMAGE" >/dev/null 2>&1; then
    TAR_IMAGE="$BACKUP_TAR_IMAGE"
    return 0
  fi
  if docker image inspect "password_secrets_manager:$APP_ENV_RESOLVED" >/dev/null 2>&1; then
    TAR_IMAGE="password_secrets_manager:$APP_ENV_RESOLVED"
    return 0
  fi
  if docker image inspect "alpine:3.20" >/dev/null 2>&1; then
    TAR_IMAGE="alpine:3.20"
    return 0
  fi
  info "Pulling alpine:3.20 (needed to stream volume archives)..."
  if docker pull "alpine:3.20" >/dev/null 2>&1; then
    TAR_IMAGE="alpine:3.20"
    return 0
  fi
  err "No tar-capable image available for backups."
  return 1
}

ensure_volume() {
  local volume="$1"
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    return 0
  fi
  info "Creating Docker volume $volume..."
  docker volume create \
    --label "com.docker.compose.project=$PROJECT" \
    --label "com.pwdgen.backup=true" \
    --label "com.pwdgen.description=restored by bin/start.sh" \
    "$volume" >/dev/null
}

write_manifest() {
  local staging="$1" reason="$2" entries="$3" git_commit="unknown" compose_sha env_sha wordlist_sha="" wordlist_file
  if has git && git rev-parse --git-dir >/dev/null 2>&1; then
    git_commit="$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
  fi
  compose_sha="$(sha256_file "$COMPOSE_FILE" 2>/dev/null || printf 'unknown')"
  env_sha="$(sha256_file "$ENV_FILE" 2>/dev/null || printf 'unknown')"
  wordlist_file="$ROOT_DIR/eff_short_wordlist_1.txt"
  if [ ! -f "$wordlist_file" ] && [ -n "${WORDLIST_PATH:-}" ]; then
    wordlist_file="$WORDLIST_PATH"
  fi
  if [ -f "$wordlist_file" ]; then
    wordlist_sha="$(sha256_file "$wordlist_file" 2>/dev/null || true)"
  fi

  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "environment": "%s",\n' "$APP_ENV_RESOLVED"
    printf '  "project": "%s",\n' "$PROJECT"
    printf '  "reason": "%s",\n' "$reason"
    printf '  "createdAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "createdBy": "bin/start.sh %s",\n' "$VERSION"
    printf '  "gitCommit": "%s",\n' "$git_commit"
    printf '  "composeFile": "%s",\n' "$(basename "$COMPOSE_FILE")"
    printf '  "composeSha256": "%s",\n' "$compose_sha"
    printf '  "envFileSha256": "%s",\n' "$env_sha"
    printf '  "wordlistSha256": "%s",\n' "$wordlist_sha"
    printf '  "volumes": [\n'
    if [ -s "$entries" ]; then
      sed '$!s/$/,/' "$entries"
    fi
    printf '  ]\n'
    printf '}\n'
  } > "$staging/manifest.json"
}

create_archive_set() {
  local reason="${1:-manual}" volumes timestamp staging entries volume archive bytes sha labels_json
  LAST_STAGING=""
  LAST_TIMESTAMP=""

  has tar || { err "tar is required for backups."; return 1; }
  has_sha256 || { err "A SHA-256 tool is required (sha256sum, shasum or openssl)."; return 1; }

  volumes="$(select_backup_volumes)"
  if [ -z "$volumes" ]; then
    err "No Docker volumes found for project '$PROJECT'."
    err "Start the stack once so the Secrets Manager volume is created."
    return 1
  fi

  ensure_tar_image || return 1

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  staging="$BACKUP_ROOT/$APP_ENV_RESOLVED/$timestamp"
  rm -rf "$staging"
  mkdir -p "$staging/volumes" || return 1
  entries="$staging/.volume-entries"
  : > "$entries"

  for volume in $volumes; do
    info "Archiving volume $volume ..."
    archive="$staging/volumes/$volume.tar.gz"
    if ! docker run --rm --network none \
      -v "$volume:/volume:ro" \
      "$TAR_IMAGE" tar -czf - -C /volume . > "$archive"; then
      err "Failed to archive volume $volume."
      rm -rf "$staging"
      return 1
    fi
    if [ ! -s "$archive" ]; then
      err "The archive for $volume is empty."
      rm -rf "$staging"
      return 1
    fi
    if ! tar -tzf "$archive" >/dev/null 2>&1; then
      err "The archive for $volume is not a valid gzip stream."
      rm -rf "$staging"
      return 1
    fi
    bytes="$(wc -c < "$archive" | tr -d ' ')"
    if ! sha="$(sha256_file "$archive")"; then
      err "No SHA-256 tool found (sha256sum, shasum or openssl)."
      rm -rf "$staging"
      return 1
    fi
    labels_json="$(docker volume inspect -f '{{json .Labels}}' "$volume" 2>/dev/null || true)"
    if [ -z "$labels_json" ] || [ "$labels_json" = "null" ]; then
      labels_json="{}"
    fi
    printf '    {"name": "%s", "archive": "volumes/%s.tar.gz", "bytes": %s, "sha256": "%s", "labels": %s}\n' \
      "$volume" "$volume" "$bytes" "$sha" "$labels_json" >> "$entries"
    ok "  $volume  ($(human_bytes "$bytes"))"
  done

  if ! write_manifest "$staging" "$reason" "$entries"; then
    err "Could not write the backup manifest."
    rm -rf "$staging"
    return 1
  fi

  (
    cd "$staging" || exit 1
    : > checksums.sha256
    for archive in volumes/*.tar.gz; do
      [ -e "$archive" ] || continue
      printf '%s  %s\n' "$(sha256_file "$archive")" "$archive" >> checksums.sha256
    done
    printf '%s  %s\n' "$(sha256_file manifest.json)" "manifest.json" >> checksums.sha256
  ) || {
    err "Could not write backup checksums."
    rm -rf "$staging"
    return 1
  }

  rm -f "$entries"
  LAST_STAGING="$staging"
  LAST_TIMESTAMP="$timestamp"
  ok "Staged backup: $staging"
  return 0
}

bundle_staging() {
  local prefix="$1" staging="$2" timestamp="$3" dir bundle
  dir="$BACKUP_ROOT/$APP_ENV_RESOLVED"
  mkdir -p "$dir" || return 1
  bundle="$dir/$prefix-$APP_ENV_RESOLVED-$timestamp.tar.gz"
  printf 'Creating full-volume .tar.gz bundle...\n' >&2
  if ! tar -czf "$bundle" -C "$staging" .; then
    rm -f "$bundle"
    return 1
  fi
  if ! write_checksum_file "$bundle"; then
    rm -f "$bundle" "$bundle.sha256"
    return 1
  fi
  printf '%s\n' "$bundle"
}

prune_backups() {
  local keep="${1:-0}" dir count=0 file
  dir="$BACKUP_ROOT/$APP_ENV_RESOLVED"
  case "$keep" in
    ''|*[!0-9]*) warn "Invalid retention '$keep'; keeping all backups."; return 0 ;;
  esac
  if [ "$keep" -le 0 ]; then
    return 0
  fi
  [ -d "$dir" ] || return 0
  for file in $(ls -1t "$dir"/backup-*.tar.gz 2>/dev/null); do
    count=$((count + 1))
    if [ "$count" -gt "$keep" ]; then
      rm -f "$file" "$file.sha256"
      info "Pruned $(basename "$file")"
    fi
  done
}

restore_sm_after_backup() {
  if [ "$BACKUP_SM_STOPPED" = true ]; then
    BACKUP_SM_STOPPED=false
    info "Restarting the Secrets Manager..."
    if compose start "$SECRETS_SERVICE" >/dev/null 2>&1; then
      wait_for_healthy "$SECRETS_SERVICE" 90 || warn "The Secrets Manager is not healthy yet."
    else
      warn "Could not restart the Secrets Manager."
    fi
  fi
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
action_build() {
  local mode="${1:-cached}"
  require_docker || return 1
  validate_compose || return 1
  if [ "$mode" = "force" ]; then
    info "Rebuilding images without cache and pulling base images..."
    compose build --no-cache --pull || { err "Docker build failed."; return 1; }
  else
    info "Building images (Docker cache enabled)..."
    compose build || { err "Docker build failed."; return 1; }
  fi
  ok "Images are ready."
  return 0
}

action_up() {
  local build="${1:-cached}" attach="${2:-false}" recreate_flag="" up_flag=""
  require_docker || return 1
  validate_compose || return 1
  preflight_start || return 1

  case "$build" in
    force)
      action_build force || return 1
      recreate_flag="--force-recreate"
      ;;
    no)
      info "Skipping image build (--no-build)."
      up_flag="--no-build"
      ;;
    *)
      action_build cached || return 1
      ;;
  esac

  info "Starting the Secrets Manager..."
  compose up -d --remove-orphans $recreate_flag $up_flag "$SECRETS_SERVICE" || {
    err "Could not start the Secrets Manager."
    return 1
  }
  if ! wait_for_healthy "$SECRETS_SERVICE" 120; then
    err "Secrets Manager logs:"
    compose logs --tail=80 "$SECRETS_SERVICE" 2>/dev/null | tail -n 80
    return 1
  fi

  seed_secrets false || warn "Continuing without seeded secrets; the app will use its built-in defaults."

  info "Starting the application..."
  if ! compose up -d --remove-orphans $recreate_flag $up_flag; then
    err "Could not start the stack."
    return 1
  fi

  if ! wait_for_healthy "$APP_SERVICE" 300; then
    err "Application logs:"
    compose logs --tail=120 "$APP_SERVICE" 2>/dev/null | tail -n 120
    return 1
  fi

  wait_for_public_nginx || return 1

  print_access_summary

  if [ "$attach" = true ]; then
    info "Following app logs (Ctrl+C to exit)..."
    compose logs -f --tail=50 "$APP_SERVICE"
  fi
  return 0
}

action_down() {
  require_docker || return 1
  validate_compose || return 1
  compose down --remove-orphans || { err "Could not stop the stack."; return 1; }
  ok "Stack stopped. Volumes and backups were preserved."
  return 0
}

action_restart() {
  require_docker || return 1
  validate_compose || return 1
  compose restart || { err "Could not restart the stack."; return 1; }
  wait_for_healthy "$SECRETS_SERVICE" 120 || warn "The Secrets Manager is not healthy yet."
  wait_for_healthy "$APP_SERVICE" 240 || warn "The app is not healthy yet."
  wait_for_public_nginx || return 1
  return 0
}

action_recreate() {
  require_docker || return 1
  validate_compose || return 1
  preflight_start || return 1
  info "Recreating containers from the current images and .env.$APP_ENV_RESOLVED ..."
  compose up -d --force-recreate --remove-orphans || { err "Could not recreate the stack."; return 1; }
  wait_for_healthy "$SECRETS_SERVICE" 120 || warn "The Secrets Manager is not healthy yet."
  seed_secrets false || warn "Secret seeding failed."
  wait_for_healthy "$APP_SERVICE" 300 || return 1
  wait_for_public_nginx || return 1
  print_access_summary
  return 0
}

action_rebuild() {
  require_docker || return 1
  validate_compose || return 1
  preflight_start || return 1
  action_build force || return 1
  compose up -d --force-recreate --remove-orphans || { err "Could not start the rebuilt stack."; return 1; }
  wait_for_healthy "$SECRETS_SERVICE" 120 || return 1
  seed_secrets false || warn "Secret seeding failed."
  wait_for_healthy "$APP_SERVICE" 300 || return 1
  wait_for_public_nginx || return 1
  print_access_summary
  return 0
}

print_access_summary() {
  section "Stack ready ($APP_ENV_RESOLVED)"
  printf '  App (internal):      %s\n' "$(app_url)"
  printf '  Health (internal):   %s/api/health\n' "$(app_url)"
  printf '  Secrets (internal):  %s\n' "$(sm_url)"
  if [ "$APP_ENV_RESOLVED" = "prd" ]; then
    printf '  Public app:          %s\n' "$(app_public_url)"
    printf '  Public secrets:      %s\n' "$(sm_public_url)"
    printf '  Host nginx:          port %s\n' "$PUBLIC_HTTPS_PORT"
  fi
  printf '  Policy secret:       %s\n' "$APP_CONFIG_SECRET_ID"
  printf '  Integrity:           %s\n' "$INTEGRITY_SECRET_ID"
  printf '  Backups:             %s\n' "$BACKUP_ROOT/$APP_ENV_RESOLVED"
  printf '\n  Logs:   ./bin/start.sh logs %s --follow\n' "$APP_ENV_RESOLVED"
  printf '  Stop:   ./bin/start.sh down %s\n' "$APP_ENV_RESOLVED"
}

action_status() {
  require_docker || return 1
  validate_compose || return 1
  section "Stack status ($APP_ENV_RESOLVED)"
  printf '  Project:     %s\n' "$PROJECT"
  printf '  Compose:     %s\n' "$(basename "$COMPOSE_FILE")"
  printf '  Environment: %s\n' "$(basename "$ENV_FILE")"
  printf '  App:         %s\n' "$(app_url)"
  printf '  Secrets:     %s\n' "$(sm_url)"
  if [ "$APP_ENV_RESOLVED" = "prd" ]; then
    printf '  Public app:  %s\n' "$(app_public_url)"
    printf '  Public SM:   %s\n' "$(sm_public_url)"
    printf '  Host nginx:  %s (port %s)\n' "$($S systemctl is-active nginx 2>/dev/null || echo unknown)" "$PUBLIC_HTTPS_PORT"
  fi
  printf '\n'
  compose ps
  printf '\nContainer health:\n'
  printf '  %-18s %-10s %s\n' "SERVICE" "STATE" "HEALTH"
  printf '  %-18s %-10s %s\n' "$SECRETS_SERVICE" "$(service_state "$SECRETS_SERVICE")" "$(service_health "$SECRETS_SERVICE")"
  printf '  %-18s %-10s %s\n' "$APP_SERVICE" "$(service_state "$APP_SERVICE")" "$(service_health "$APP_SERVICE")"
  printf '\nVolumes (project %s):\n' "$PROJECT"
  local volumes volume found=0
  volumes="$(project_volumes)"
  if [ -z "$volumes" ]; then
    printf '  (none)\n'
  else
    for volume in $volumes; do
      printf '  - %s\n' "$volume"
      found=1
    done
  fi
  printf '\nLatest backup:\n'
  if [ -f "$BACKUP_ROOT/$APP_ENV_RESOLVED/LATEST" ]; then
    printf '  %s\n' "$(cat "$BACKUP_ROOT/$APP_ENV_RESOLVED/LATEST")"
  else
    printf '  (none)\n'
  fi
  return 0
}

action_logs() {
  local service="${1:-}" follow="${2:-false}" tail="${3:-200}"
  require_docker || return 1
  validate_compose || return 1
  if [ -n "$service" ]; then
    case "$service" in
      app|password) service="app" ;;
      secrets|secrets-manager|secrets_manager) service="secrets-manager" ;;
      *) err "Unknown service '$service' (use app or secrets-manager)."; return 1 ;;
    esac
  fi
  if [ "$follow" = true ]; then
    if [ -n "$service" ]; then
      compose logs -f --tail="$tail" "$service"
    else
      compose logs -f --tail="$tail"
    fi
  else
    if [ -n "$service" ]; then
      compose logs --tail="$tail" "$service"
    else
      compose logs --tail="$tail"
    fi
  fi
}

action_health() {
  local strict="${1:-false}" failures=0
  section "Application health"
  if fetch_http "$(app_url)/api/health"; then
    printf 'GET /api/health -> HTTP %s\n' "$HTTP_CODE"
    printf '%s' "$HTTP_BODY" | pretty_json
    case "$HTTP_CODE" in
      2*) ok "Application health endpoint is up." ;;
      *) err "Application health endpoint returned $HTTP_CODE."; failures=$((failures + 1)) ;;
    esac
  else
    err "Application is unreachable at $(app_url)."
    failures=$((failures + 1))
  fi

  section "Readiness"
  if fetch_http "$(app_url)/api/ready"; then
    printf 'GET /api/ready -> HTTP %s\n' "$HTTP_CODE"
    printf '%s' "$HTTP_BODY" | pretty_json
    if [ "$HTTP_CODE" != "200" ]; then
      if [ "$strict" = true ]; then
        err "Readiness probe failed."
        failures=$((failures + 1))
      else
        warn "Readiness is degraded (the app is still serving with fallback policy)."
      fi
    fi
  else
    err "Readiness endpoint is unreachable."
    failures=$((failures + 1))
  fi

  section "Secrets Manager"
  if fetch_http "$(sm_url)/healthz"; then
    printf 'GET /healthz -> HTTP %s\n' "$HTTP_CODE"
    printf '%s' "$HTTP_BODY" | pretty_json
    case "$HTTP_CODE" in
      2*) ok "Secrets Manager is up." ;;
      *) err "Secrets Manager health returned $HTTP_CODE."; failures=$((failures + 1)) ;;
    esac
  else
    err "Secrets Manager is unreachable at $(sm_url)."
    failures=$((failures + 1))
  fi

  if [ "$APP_ENV_RESOLVED" = "prd" ]; then
    section "Public host nginx edge"
    printf '  Host nginx: %s (port %s)\n' "$($S systemctl is-active nginx 2>/dev/null || echo unknown)" "$PUBLIC_HTTPS_PORT"

    if fetch_https "$(app_public_url)/api/health" "$APP_HOST"; then
      printf 'GET %s/api/health -> HTTP %s\n' "$(app_public_url)" "$HTTP_CODE"
      printf '%s' "$HTTP_BODY" | pretty_json
      case "$HTTP_CODE" in
        2*) ok "Public application health is up." ;;
        *) err "Public application health returned $HTTP_CODE."; failures=$((failures + 1)) ;;
      esac
    else
      err "Public application is unreachable at $(app_public_url)."
      failures=$((failures + 1))
    fi

    if fetch_https "$(sm_public_url)/healthz" "$SECRETS_MANAGER_HOST"; then
      printf 'GET %s/healthz -> HTTP %s\n' "$(sm_public_url)" "$HTTP_CODE"
      printf '%s' "$HTTP_BODY" | pretty_json
      case "$HTTP_CODE" in
        2*) ok "Public Secrets Manager health is up." ;;
        *) err "Public Secrets Manager health returned $HTTP_CODE."; failures=$((failures + 1)) ;;
      esac
    else
      err "Public Secrets Manager is unreachable at $(sm_public_url)."
      failures=$((failures + 1))
    fi
  fi

  if [ "$failures" -gt 0 ]; then
    return 1
  fi
  ok "All health checks passed."
  return 0
}

smoke_pass() {
  passes=$((passes + 1))
  ok "PASS  $1"
}

smoke_fail() {
  failures=$((failures + 1))
  err "FAIL  $1"
}

action_smoke() {
  local passes=0 failures=0
  section "Smoke test ($APP_ENV_RESOLVED)"

  if fetch_http "$(app_url)/api/health"; then
    if [ "$HTTP_CODE" = "200" ]; then
      smoke_pass "GET /api/health"
    else
      smoke_fail "GET /api/health returned $HTTP_CODE"
    fi
  else
    smoke_fail "GET /api/health (unreachable)"
  fi

  post_json "$(app_url)/api/generate" \
    '{"mode":"characters","length":24,"specialCount":3,"digitCount":3,"mixedCaseCount":6}'
  if [ "$HTTP_CODE" = "200" ]; then
    local password charset_body
    password="$(extract_password "$HTTP_BODY")"
    if [ "${#password}" -eq 24 ]; then
      smoke_pass "character password has the requested length (24)"
    else
      smoke_fail "character password length is ${#password}, expected 24"
    fi
    if printf '%s' "$password" | grep -Eq '^[A-Za-z0-9$%^@!&*]+$'; then
      smoke_pass "character password uses the expected character set"
    else
      smoke_fail "character password contains unexpected characters"
    fi
    charset_body="$HTTP_BODY"
  else
    smoke_fail "POST /api/generate (characters) returned $HTTP_CODE"
    charset_body=""
  fi

  post_json "$(app_url)/api/generate" \
    '{"mode":"words","wordCount":4,"wordSeparator":"-","passphraseDigitCount":2,"passphraseSpecialCount":1,"passphraseMixedCount":2,"randomizeWordCapitalization":true}'
  if [ "$HTTP_CODE" = "200" ]; then
    local passphrase
    passphrase="$(extract_password "$HTTP_BODY")"
    if [ -n "$passphrase" ]; then
      smoke_pass "passphrase generated"
    else
      smoke_fail "passphrase response did not contain a password"
    fi
    case "$passphrase" in
      *-*) smoke_pass "passphrase uses the requested separator" ;;
      *) smoke_fail "passphrase is missing the separator" ;;
    esac
  else
    smoke_fail "POST /api/generate (passphrase) returned $HTTP_CODE"
  fi

  post_json "$(app_url)/api/generate" \
    '{"mode":"characters","length":8,"specialCount":10,"digitCount":10,"mixedCaseCount":10}'
  if [ "$HTTP_CODE" = "400" ]; then
    smoke_pass "invalid character counts are rejected with 400"
  else
    smoke_fail "invalid character counts returned $HTTP_CODE instead of 400"
  fi

  if printf '%s' "${charset_body:-}" | grep -q '"source":"secretsmanager"'; then
    smoke_pass "runtime policy was loaded from the Secrets Manager"
  elif [ "${SECRETS_MANAGER_ENABLED:-false}" = "true" ]; then
    smoke_fail "runtime policy fell back to defaults while the Secrets Manager is enabled"
  else
    smoke_pass "Secrets Manager disabled by configuration; defaults in use"
  fi

  if has aws; then
    if aws_sm list-secrets >/dev/null 2>&1; then
      smoke_pass "aws secretsmanager list-secrets (AWS protocol)"
    else
      smoke_fail "aws secretsmanager list-secrets failed"
    fi
    if aws_sm describe-secret --secret-id "$APP_CONFIG_SECRET_ID" >/dev/null 2>&1; then
      smoke_pass "application policy secret exists ($APP_CONFIG_SECRET_ID)"
    else
      smoke_fail "application policy secret is missing ($APP_CONFIG_SECRET_ID)"
    fi
  else
    warn "AWS CLI not installed; testing the protocol with the bundled SigV4 client."
    if sm_cli ping >/dev/null 2>&1; then
      smoke_pass "bundled SigV4 Secrets Manager client"
    else
      smoke_fail "bundled SigV4 Secrets Manager client"
    fi
  fi

  if fetch_http "$(app_url)/api/ready"; then
    if [ "$HTTP_CODE" = "200" ]; then
      smoke_pass "readiness probe"
    else
      smoke_fail "readiness probe returned $HTTP_CODE"
    fi
  else
    smoke_fail "readiness probe (unreachable)"
  fi

  section "Smoke test result"
  printf '  Passed: %s\n  Failed: %s\n' "$passes" "$failures"
  if [ "$failures" -gt 0 ]; then
    err "Smoke test failed."
    return 1
  fi
  ok "Smoke test passed."
  return 0
}

action_backup() {
  require_docker || return 1
  validate_compose || return 1
  has tar || { err "tar is required for backups."; return 1; }
  has_sha256 || { err "A SHA-256 tool is required (sha256sum, shasum or openssl)."; return 1; }
  mkdir -p "$BACKUP_ROOT/$APP_ENV_RESOLVED"
  chmod 700 "$BACKUP_ROOT/$APP_ENV_RESOLVED" 2>/dev/null || true

  BACKUP_SM_STOPPED=false
  local bundle size
  trap 'restore_sm_after_backup; exit 130' INT TERM

  if is_running "$SECRETS_SERVICE" && [ "$BACKUP_LIVE" != true ]; then
    info "Quiescing the Secrets Manager for a consistent snapshot..."
    if compose stop "$SECRETS_SERVICE" >/dev/null 2>&1; then
      BACKUP_SM_STOPPED=true
    else
      warn "Could not stop the Secrets Manager; continuing with a live backup."
    fi
  fi

  if ! create_archive_set "$BACKUP_REASON"; then
    restore_sm_after_backup
    trap - INT TERM
    return 1
  fi

  bundle="$(bundle_staging backup "$LAST_STAGING" "$LAST_TIMESTAMP")"
  if [ -z "$bundle" ] || [ ! -f "$bundle" ]; then
    err "Failed to create the backup bundle."
    restore_sm_after_backup
    trap - INT TERM
    return 1
  fi

  printf '%s\n' "$bundle" > "$BACKUP_ROOT/$APP_ENV_RESOLVED/LATEST"

  if [ "$BACKUP_KEEP_STAGING" = true ]; then
    info "Keeping staging directory: $LAST_STAGING"
  else
    rm -rf "$LAST_STAGING"
  fi

  prune_backups "$BACKUP_RETENTION"
  restore_sm_after_backup

  size="$(wc -c < "$bundle" | tr -d ' ')"
  section "Backup complete"
  printf '  File: %s\n' "$bundle"
  printf '  Size: %s\n' "$(human_bytes "$size")"
  printf '  SHA:  %s\n' "$(sha256_file "$bundle")"
  printf '  Checksum: %s.sha256\n' "$bundle"
  trap - INT TERM
  ok "Full Docker volume backup created."
  return 0
}

action_restore() {
  local source="${1:-}" timestamp tmp="" src="" single_volume="" volume_lines="" manifest_env=""
  local volume archive restore_failed=0

  require_docker || return 1
  validate_compose || return 1
  preflight_start || return 1
  has tar || { err "tar is required for restores."; return 1; }

  if [ -z "$source" ]; then
    err "Provide a backup bundle (.tar.gz) or staging directory."
    return 1
  fi
  if [ ! -e "$source" ]; then
    err "Backup not found: $source"
    return 1
  fi
  case "$source" in
    /*) ;;
    *) source="$ROOT_DIR/$source" ;;
  esac

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$RUN_DIR" "$BACKUP_ROOT/$APP_ENV_RESOLVED"
  chmod 700 "$BACKUP_ROOT/$APP_ENV_RESOLVED" 2>/dev/null || true

  if [ -f "$source.sha256" ]; then
    if verify_file_checksum "$source"; then
      ok "Bundle checksum verified."
    else
      err "Bundle checksum verification failed: $source"
      return 1
    fi
  fi

  if [ -d "$source" ]; then
    src="$source"
    if [ ! -f "$src/manifest.json" ] && [ ! -d "$src/volumes" ]; then
      err "Not a valid backup directory: $source"
      return 1
    fi
  elif [ -f "$source" ]; then
    case "$source" in
      *.tar.gz|*.tgz) ;;
      *) err "Expected a .tar.gz bundle or a backup directory."; return 1 ;;
    esac
    if ! tar -tzf "$source" >/dev/null 2>&1; then
      err "Not a valid gzip tarball: $source"
      return 1
    fi
    if tar -tzf "$source" 2>/dev/null | grep -qE '(^|/)manifest\.json$'; then
      tmp="$RUN_DIR/restore-$timestamp"
      rm -rf "$tmp"
      mkdir -p "$tmp"
      info "Extracting bundle..."
      if ! tar -xzf "$source" -C "$tmp"; then
        err "Could not extract the bundle."
        rm -rf "$tmp"
        return 1
      fi
      src="$tmp"
    else
      single_volume="${RESTORE_VOLUME:-$(basename "$source" .tar.gz)}"
      if [ -z "$single_volume" ]; then
        err "Could not infer the target volume; use --volume NAME."
        return 1
      fi
    fi
  else
    err "Unsupported backup source: $source"
    return 1
  fi

  if [ -n "$src" ] && [ -f "$src/checksums.sha256" ]; then
    if verify_checksums "$src"; then
      ok "Backup volume checksums verified."
    else
      err "Backup volume checksum verification failed."
      [ -n "$tmp" ] && rm -rf "$tmp"
      return 1
    fi
  fi

  if [ -n "$src" ] && [ -f "$src/manifest.json" ]; then
    manifest_env="$(sed -n 's/.*"environment": *"\([^"]*\)".*/\1/p' "$src/manifest.json" | head -n 1)"
    volume_lines="$(sed -n 's/^.*"name": "\([^"]*\)".*"archive": "\([^"]*\)".*$/\1|\2/p' "$src/manifest.json")"
  fi
  if [ -z "$volume_lines" ] && [ -n "$src" ] && [ -d "$src/volumes" ]; then
    for archive in "$src"/volumes/*.tar.gz; do
      [ -e "$archive" ] || continue
      volume_lines="$volume_lines$(basename "$archive" .tar.gz)|volumes/$(basename "$archive")
"
    done
  fi
  if [ -n "$single_volume" ]; then
    volume_lines="$single_volume|$source"
  fi
  if [ -z "$volume_lines" ]; then
    err "No volume archives found in the backup."
    [ -n "$tmp" ] && rm -rf "$tmp"
    return 1
  fi

  section "Restore plan ($APP_ENV_RESOLVED)"
  printf '%s\n' "$volume_lines" | sed 's/|/  <-  /' | sed 's/^/  /'
  if [ -n "$manifest_env" ] && [ "$manifest_env" != "$APP_ENV_RESOLVED" ]; then
    warn "This backup was created for '$manifest_env' but is being restored into '$APP_ENV_RESOLVED'."
    if ! confirm "Continue across environments?" no; then
      info "Restore cancelled."
      [ -n "$tmp" ] && rm -rf "$tmp"
      return 1
    fi
  fi
  if ! confirm_typed "RESTORE" "This replaces Docker volume contents. Type RESTORE to continue: "; then
    info "Restore cancelled."
    [ -n "$tmp" ] && rm -rf "$tmp"
    return 1
  fi

  info "Stopping services before restore..."
  compose stop >/dev/null 2>&1 || warn "The stack was not running."

  if [ "$RESTORE_SNAPSHOT" = true ]; then
    info "Creating a pre-restore safety snapshot..."
    if create_archive_set "pre-restore"; then
      local snapshot
      snapshot="$(bundle_staging pre-restore "$LAST_STAGING" "$LAST_TIMESTAMP")"
      if [ -n "$snapshot" ] && [ -f "$snapshot" ]; then
        ok "Safety snapshot: $snapshot"
      else
        warn "Could not create the safety snapshot bundle."
      fi
      rm -rf "$LAST_STAGING"
    else
      warn "No current volumes to snapshot; continuing."
    fi
  fi

  ensure_tar_image || { [ -n "$tmp" ] && rm -rf "$tmp"; return 1; }

  while IFS='|' read -r volume archive; do
    [ -n "$volume" ] || continue
    if [ -n "$src" ]; then
      archive="$src/$archive"
    fi
    if [ ! -f "$archive" ]; then
      err "Missing archive for $volume: $archive"
      restore_failed=1
      continue
    fi
    info "Restoring volume $volume ..."
    if ! ensure_volume "$volume"; then
      err "Could not create volume $volume."
      restore_failed=1
      continue
    fi
    if [ "$RESTORE_MERGE" = true ]; then
      if ! docker run --rm -i --network none -v "$volume:/volume" "$TAR_IMAGE" \
        sh -c 'tar -xzf - -C /volume' < "$archive"; then
        err "Failed to extract $archive into $volume."
        restore_failed=1
        continue
      fi
    else
      if ! docker run --rm -i --network none -v "$volume:/volume" "$TAR_IMAGE" \
        sh -c 'set -e; for entry in /volume/* /volume/.[!.]*; do [ -e "$entry" ] || continue; rm -rf "$entry"; done; tar -xzf - -C /volume' < "$archive"; then
        err "Failed to extract $archive into $volume."
        restore_failed=1
        continue
      fi
    fi
    ok "Restored $volume."
  done <<EOF
$volume_lines
EOF

  [ -n "$tmp" ] && rm -rf "$tmp"

  if [ "$restore_failed" -ne 0 ]; then
    err "Restore completed with errors. The stack was left stopped to avoid serving partial data."
    err "Fix the issue or use the pre-restore snapshot in $BACKUP_ROOT/$APP_ENV_RESOLVED."
    return 1
  fi

  info "Starting the stack after restore..."
  compose up -d --remove-orphans || { err "Could not start the stack after restore."; return 1; }
  wait_for_healthy "$SECRETS_SERVICE" 120 || warn "The Secrets Manager is not healthy yet."
  seed_secrets false || warn "Secret seeding failed (existing secrets may already be present)."
  wait_for_healthy "$APP_SERVICE" 300 || { err "The app is not healthy after restore."; return 1; }
  wait_for_public_nginx || return 1
  ok "Restore complete."
  print_access_summary
  return 0
}

action_backups_list() {
  local dir="$BACKUP_ROOT/$APP_ENV_RESOLVED" file directory
  section "Backups ($APP_ENV_RESOLVED)"
  if [ ! -d "$dir" ]; then
    info "No backups for $APP_ENV_RESOLVED yet."
    return 0
  fi
  for file in "$dir"/backup-*.tar.gz "$dir"/pre-restore-*.tar.gz; do
    [ -e "$file" ] || continue
    printf '  %-10s %s\n' "$(human_bytes "$(wc -c < "$file" | tr -d ' ')")" "$(basename "$file")"
  done
  for directory in "$dir"/[0-9]*; do
    [ -d "$directory" ] || continue
    printf '  %-10s %s\n' "staging" "$(basename "$directory")"
  done
  if [ -f "$dir/LATEST" ]; then
    printf '\n  Latest: %s\n' "$(cat "$dir/LATEST")"
  fi
  return 0
}

action_backups_verify() {
  local dir="$BACKUP_ROOT/$APP_ENV_RESOLVED" file failed=0 checked=0
  section "Verify backups ($APP_ENV_RESOLVED)"
  if [ ! -d "$dir" ]; then
    info "No backups to verify."
    return 0
  fi
  for file in "$dir"/backup-*.tar.gz "$dir"/pre-restore-*.tar.gz; do
    [ -e "$file" ] || continue
    checked=$((checked + 1))
    if [ ! -f "$file.sha256" ]; then
      warn "No checksum file for $(basename "$file")"
      continue
    fi
    if verify_file_checksum "$file"; then
      ok "OK   $(basename "$file")"
    else
      err "FAIL $(basename "$file")"
      failed=$((failed + 1))
    fi
  done
  if [ "$checked" -eq 0 ]; then
    info "No bundles found."
  fi
  if [ "$failed" -gt 0 ]; then
    return 1
  fi
  return 0
}

action_backups_prune() {
  local keep="${1:-$BACKUP_RETENTION}"
  section "Prune backups ($APP_ENV_RESOLVED, keep $keep)"
  if ! confirm "Delete older backups beyond the $keep newest?" no; then
    info "Cancelled."
    return 1
  fi
  prune_backups "$keep"
  ok "Prune complete."
  return 0
}

remove_project_images() {
  local images image
  images="$(compose config --images 2>/dev/null || true)"
  if [ -z "$images" ]; then
    images="password_app_$APP_ENV_RESOLVED:latest password_secrets_manager:$APP_ENV_RESOLVED"
  fi
  for image in $images; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      info "Removing image $image ..."
      docker image rm -f "$image" >/dev/null 2>&1 || warn "Could not remove $image (a container may still use it)."
    fi
  done
}

action_cleanup() {
  local scope="${1:-}" volume
  require_docker || return 1
  case "$scope" in
    containers)
      compose down --remove-orphans || { err "Could not remove the containers."; return 1; }
      ok "Containers and networks removed. Volumes preserved."
      ;;
    volumes)
      warn "This permanently deletes the Docker volumes for $PROJECT."
      warn "The Secrets Manager store and its encryption key will be lost."
      if ! confirm_typed "DELETE" "Type DELETE to remove all volumes: "; then
        info "Cancelled."
        return 1
      fi
      compose down --volumes --remove-orphans >/dev/null 2>&1 || true
      for volume in $(project_volumes); do
        docker volume rm -f "$volume" >/dev/null 2>&1 || true
      done
      ok "Volumes removed."
      ;;
    images)
      remove_project_images
      ok "Images removed."
      ;;
    backups)
      if [ ! -d "$BACKUP_ROOT/$APP_ENV_RESOLVED" ]; then
        info "No backups for $APP_ENV_RESOLVED."
        return 0
      fi
      if ! confirm_typed "DELETE" "Type DELETE to remove all backups for $APP_ENV_RESOLVED: "; then
        info "Cancelled."
        return 1
      fi
      rm -rf "$BACKUP_ROOT/$APP_ENV_RESOLVED"
      ok "Backups removed."
      ;;
    all)
      warn "This removes containers, volumes (including secrets), images and backups for $APP_ENV_RESOLVED."
      if ! confirm_typed "DELETE" "Type DELETE to continue: "; then
        info "Cancelled."
        return 1
      fi
      compose down --volumes --remove-orphans >/dev/null 2>&1 || true
      for volume in $(project_volumes); do
        docker volume rm -f "$volume" >/dev/null 2>&1 || true
      done
      remove_project_images
      rm -rf "$BACKUP_ROOT/$APP_ENV_RESOLVED"
      ok "Environment $APP_ENV_RESOLVED cleaned."
      ;;
    dangling)
      warn "This prunes unused images and build cache for ALL Docker projects on this host."
      if ! confirm "Continue?" no; then
        info "Cancelled."
        return 1
      fi
      docker image prune -f
      docker builder prune -f
      ok "Dangling images and build cache pruned."
      ;;
    *)
      err "Unknown cleanup scope '$scope'."
      err "Use: containers | volumes | images | backups | all | dangling"
      return 1
      ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# Secrets actions
# ---------------------------------------------------------------------------
action_secrets_list() {
  require_sm_running || return 1
  sm_cli list-secrets
}

action_secrets_get() {
  local secret_id="$1" stage="${2:-}" json="${3:-false}"
  if [ -z "$secret_id" ]; then
    err "Usage: secrets get <secret-id> [--stage STAGE] [--json]"
    return 1
  fi
  require_sm_running || return 1
  if [ "$json" = true ]; then
    if [ -n "$stage" ]; then
      sm_cli get-secret-value "$secret_id" --stage "$stage" --json
    else
      sm_cli get-secret-value "$secret_id" --json
    fi
  else
    if [ -n "$stage" ]; then
      sm_cli get-secret-value "$secret_id" --stage "$stage"
    else
      sm_cli get-secret-value "$secret_id"
    fi
  fi
}

action_secrets_describe() {
  local secret_id="$1"
  if [ -z "$secret_id" ]; then
    err "Usage: secrets describe <secret-id>"
    return 1
  fi
  require_sm_running || return 1
  sm_cli describe-secret "$secret_id"
}

action_secrets_put() {
  local secret_id="$1" file="${2:-}" value=""
  require_sm_running || return 1
  if [ -n "$file" ]; then
    if [ ! -f "$file" ]; then
      err "File not found: $file"
      return 1
    fi
    sm_cli put-secret-value "$secret_id" --stdin < "$file"
    return $?
  fi
  printf 'Value for %s: ' "$secret_id" >&2
  if ! read -r -s value; then
    err "Aborted."
    return 1
  fi
  printf '\n' >&2
  if [ -z "$value" ]; then
    err "Refusing to store an empty value."
    return 1
  fi
  printf '%s' "$value" | sm_cli put-secret-value "$secret_id" --stdin
}

action_secrets_create() {
  local name="$1" description="${2:-}" value=""
  require_sm_running || return 1
  printf 'Value for new secret %s: ' "$name" >&2
  if ! read -r -s value; then
    err "Aborted."
    return 1
  fi
  printf '\n' >&2
  if [ -z "$value" ]; then
    err "Refusing to create a secret with an empty value."
    return 1
  fi
  if [ -n "$description" ]; then
    printf '%s' "$value" | sm_cli create-secret "$name" --stdin --description "$description"
  else
    printf '%s' "$value" | sm_cli create-secret "$name" --stdin
  fi
}

action_secrets_delete() {
  local secret_id="$1" force="${2:-false}"
  require_sm_running || return 1
  if ! confirm "Delete secret '$secret_id'? Soft delete can be restored within the recovery window; --force removes it immediately." no; then
    info "Cancelled."
    return 1
  fi
  if [ "$force" = true ]; then
    sm_cli delete-secret "$secret_id" --force
  else
    sm_cli delete-secret "$secret_id"
  fi
}

action_secrets_test() {
  local failures=0
  require_sm_running || return 1
  section "Secrets Manager connectivity ($APP_ENV_RESOLVED)"
  printf '  Endpoint: %s\n  Region:   %s\n\n' "$(sm_url)" "$SECRETS_MANAGER_REGION"

  if fetch_http "$(sm_url)/healthz"; then
    if [ "$HTTP_CODE" = "200" ]; then
      ok "PASS  GET /healthz"
    else
      err "FAIL  GET /healthz -> $HTTP_CODE"
      failures=$((failures + 1))
    fi
  else
    err "FAIL  GET /healthz (unreachable)"
    failures=$((failures + 1))
  fi

  if has aws; then
    if aws_sm list-secrets >/dev/null 2>&1; then
      ok "PASS  aws secretsmanager list-secrets"
    else
      err "FAIL  aws secretsmanager list-secrets"
      failures=$((failures + 1))
    fi
    if aws_sm describe-secret --secret-id "$APP_CONFIG_SECRET_ID" >/dev/null 2>&1; then
      ok "PASS  aws secretsmanager describe-secret ($APP_CONFIG_SECRET_ID)"
    else
      warn "WARN  policy secret not found yet; run: ./bin/start.sh secrets $APP_ENV_RESOLVED seed"
    fi
  else
    warn "WARN  AWS CLI not installed; protocol is tested with the bundled SigV4 client."
  fi

  if sm_cli ping; then
    ok "PASS  bundled SigV4 client"
  else
    err "FAIL  bundled SigV4 client"
    failures=$((failures + 1))
  fi

  if [ "$failures" -gt 0 ]; then
    return 1
  fi
  ok "Secrets Manager test passed."
  return 0
}

action_secrets_verify() {
  local with_sdk="${1:-false}" with_boto3="${2:-false}" script="$ROOT_DIR/bin/verify-secrets-manager.sh"
  if [ ! -f "$script" ]; then
    err "Missing $script"
    return 1
  fi
  require_sm_running || return 1
  local args=(--env "$APP_ENV_RESOLVED")
  if [ "$with_sdk" = true ]; then
    args+=(--sdk)
  fi
  if [ "$with_boto3" = true ]; then
    args+=(--boto3)
  fi
  bash "$script" "${args[@]}"
}

action_secrets_endpoint() {
  section "AWS-compatible Secrets Manager endpoint ($APP_ENV_RESOLVED)"
  printf '  Endpoint:   %s\n' "$(sm_url)"
  printf '  Region:     %s\n' "$SECRETS_MANAGER_REGION"
  printf '  Access key: %s\n' "$SECRETS_MANAGER_ACCESS_KEY_ID"
  printf '  Secret key: %s  (stored in %s)\n' "$(redact "$SECRETS_MANAGER_SECRET_ACCESS_KEY")" "$(basename "$ENV_FILE")"
  printf '  Policy:     %s\n' "$APP_CONFIG_SECRET_ID"
  printf '  Integrity:  %s\n' "$INTEGRITY_SECRET_ID"
  cat <<EOF

  Use it with the AWS CLI (credentials are injected automatically):
    ./bin/start.sh secrets $APP_ENV_RESOLVED test
    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \\
      aws --endpoint-url $(sm_url) --region $SECRETS_MANAGER_REGION \\
      secretsmanager list-secrets

  Or point an SDK at it:
    export AWS_ENDPOINT_URL_SECRETSMANAGER=$(sm_url)
    export AWS_ACCESS_KEY_ID=<value from $(basename "$ENV_FILE")>
    export AWS_SECRET_ACCESS_KEY=<value from $(basename "$ENV_FILE")>
    export AWS_REGION=$SECRETS_MANAGER_REGION
EOF
}

action_secrets_random() {
  local length="${1:-32}"
  require_sm_running || return 1
  sm_cli get-random-password --length "$length"
}

action_secrets_raw() {
  local operation="$1" payload="${2:-}"
  if [ -z "$operation" ]; then
    err "Usage: secrets raw <Operation> [json]"
    return 1
  fi
  if [ -z "$payload" ]; then
    payload="{}"
  fi
  require_sm_running || return 1
  sm_cli raw "$operation" "$payload"
}

# ---------------------------------------------------------------------------
# Misc actions
# ---------------------------------------------------------------------------
action_shell() {
  local service="${1:-app}"
  require_docker || return 1
  validate_compose || return 1
  case "$service" in
    app|password) service="app" ;;
    secrets|secrets-manager|secrets_manager) service="secrets-manager" ;;
    *) err "Unknown service '$service' (use app or secrets-manager)."; return 1 ;;
  esac
  require_service_running "$service" || return 1
  if [ -t 0 ]; then
    compose exec "$service" sh
  else
    compose exec -T "$service" sh
  fi
}

action_exec() {
  if [ "$#" -eq 0 ]; then
    err "exec requires a command, for example: ./bin/start.sh exec -- env"
    return 1
  fi
  require_docker || return 1
  validate_compose || return 1
  require_service_running app || return 1
  if [ -t 0 ]; then
    compose exec app "$@"
  else
    compose exec -T app "$@"
  fi
}

action_test_cli() {
  local output last rc=0 source="host"
  section "Python CLI test"
  if has python3; then
    output="$(python3 "$ROOT_DIR/password_generator.py" \
      --non-interactive --length 24 --special-count 3 --digit-count 3 \
      --mixed-case-count 6 2>&1)"
    rc=$?
  elif is_running app; then
    source="container"
    output="$(compose exec -T app python3 "$PASSWORD_GENERATOR_SCRIPT" \
      --non-interactive --length 24 --special-count 3 --digit-count 3 \
      --mixed-case-count 6 2>&1)"
    rc=$?
  else
    err "python3 is not installed on the host and the app container is not running."
    return 1
  fi

  last="$(printf '%s\n' "$output" | tail -n 1)"
  if [ "$rc" -eq 0 ] && [ "${#last}" -eq 24 ] && printf '%s' "$last" | grep -Eq '^[A-Za-z0-9$%^@!&*]+$'; then
    ok "Generator test passed ($source, 24 characters)."
    return 0
  fi
  err "Generator test failed ($source). Output:"
  printf '%s\n' "$output" | tail -n 20
  return 1
}

action_config() {
  section "Configuration ($APP_ENV_RESOLVED)"
  printf '  Environment:       %s\n' "$APP_ENV_RESOLVED"
  printf '  Project:           %s\n' "$PROJECT"
  printf '  Compose file:      %s\n' "$COMPOSE_FILE"
  printf '  Env file:          %s\n' "$ENV_FILE"
  printf '  App URL:           %s\n' "$(app_url)"
  printf '  Secrets endpoint:  %s\n' "$(sm_url)"
  printf '  Public app:        %s\n' "$(app_public_url)"
  printf '  Public secrets:    %s\n' "$(sm_public_url)"
  printf '  Public HTTPS port: %s\n' "$PUBLIC_HTTPS_PORT"
  printf '  Host nginx config: deploy/nginx/agiolab.conf\n'
  printf '  AWS region:        %s\n' "$SECRETS_MANAGER_REGION"
  printf '  Access key id:     %s\n' "$SECRETS_MANAGER_ACCESS_KEY_ID"
  printf '  Secret access key: %s\n' "$(redact "$SECRETS_MANAGER_SECRET_ACCESS_KEY")"
  printf '  Master key:        %s\n' "$([ -n "$SECRETS_MANAGER_MASTER_KEY" ] && printf 'from environment' || printf 'auto-generated in volume')"
  printf '  Policy secret:     %s\n' "$APP_CONFIG_SECRET_ID"
  printf '  Integrity secret:  %s\n' "$INTEGRITY_SECRET_ID"
  printf '  Generator script:  %s\n' "${PASSWORD_GENERATOR_SCRIPT:-<auto>}"
  printf '  Word list:         %s\n' "${WORDLIST_PATH:-<auto>}"
  printf '  Backups:           %s\n' "$BACKUP_ROOT/$APP_ENV_RESOLVED"
  printf '  Volumes:\n'
  local volumes volume
  volumes="$(project_volumes 2>/dev/null || true)"
  if [ -z "$volumes" ]; then
    printf '    (none yet)\n'
  else
    for volume in $volumes; do
      printf '    - %s\n' "$volume"
    done
  fi
}

port_in_use() {
  local port="$1"
  if has ss; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN
  elif has lsof; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif has netstat; then
    netstat -ltn 2>/dev/null | grep -Eq "[:.]$port[[:space:]]"
  else
    return 1
  fi
}

doctor_pass() { ok "PASS  $1"; }
doctor_warn() { warn "WARN  $1"; warnings=$((warnings + 1)); }
doctor_fail() { err "FAIL  $1"; failures=$((failures + 1)); }

action_doctor() {
  local failures=0 warnings=0 file

  section "Environment doctor"

  if has docker; then doctor_pass "docker is installed"; else doctor_fail "docker is not installed"; fi
  if docker compose version >/dev/null 2>&1; then doctor_pass "docker compose v2 is available"; else doctor_fail "docker compose v2 is missing"; fi
  if docker info >/dev/null 2>&1; then doctor_pass "docker daemon is reachable"; else doctor_fail "docker daemon is not reachable"; fi
  if has curl; then doctor_pass "curl is installed"; else doctor_fail "curl is required for health checks"; fi
  if has tar; then doctor_pass "tar is installed"; else doctor_fail "tar is required for backups"; fi
  if has_sha256; then doctor_pass "a SHA-256 tool is available"; else doctor_fail "sha256sum, shasum or openssl is required"; fi

  for file in "$ENV_FILE" "$COMPOSE_FILE" "$ROOT_DIR/bin/start.sh"; do
    if [ -f "$file" ]; then
      if grep -q $'\r' "$file" 2>/dev/null; then
        doctor_fail "$(basename "$file") has CRLF line endings"
      else
        doctor_pass "$(basename "$file") exists with LF line endings"
      fi
    else
      doctor_fail "$file is missing"
    fi
  done

  if [ -n "$SECRETS_MANAGER_ACCESS_KEY_ID" ] && [ -n "$SECRETS_MANAGER_SECRET_ACCESS_KEY" ]; then
    doctor_pass "Secrets Manager credentials are configured"
  else
    doctor_fail "Secrets Manager credentials are missing in $(basename "$ENV_FILE")"
  fi

  if validate_compose; then
    doctor_pass "Compose configuration is valid"
  else
    doctor_fail "Compose configuration is invalid"
  fi

  if bash "$ROOT_DIR/bin/check-env-parity.sh" --quiet; then
    doctor_pass "environment parity (.env.example / .env.dev / .env.prd)"
  else
    doctor_fail "environment parity check failed"
  fi

  if is_running "$SECRETS_SERVICE" || is_running app; then
    doctor_pass "the stack is running"
  elif port_in_use "$APP_PORT"; then
    doctor_fail "port $APP_PORT is already in use (APP_PORT)"
  else
    doctor_pass "port $APP_PORT is free"
  fi
  if is_running "$SECRETS_SERVICE"; then
    doctor_pass "Secrets Manager is running"
  elif port_in_use "$SECRETS_MANAGER_PORT"; then
    doctor_fail "port $SECRETS_MANAGER_PORT is already in use (SECRETS_MANAGER_PORT)"
  else
    doctor_pass "port $SECRETS_MANAGER_PORT is free"
  fi

  other_env="prd"
  [ "$APP_ENV_RESOLVED" = "prd" ] && other_env="dev"
  other_project="$(project_for_env "$other_env")"
  other_running=false
  if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$other_project" 2>/dev/null | head -n 1)" ]; then
    other_running=true
    doctor_warn "the '$other_env' environment is running; host ports are shared, so only one environment can run"
  fi

  if [ "$APP_ENV_RESOLVED" = "prd" ]; then
    if ! has nginx; then
      doctor_fail "host nginx is not installed"
    else
      doctor_pass "host nginx is installed"
      if port_in_use "$PUBLIC_HTTPS_PORT"; then
        doctor_pass "host nginx is listening on port $PUBLIC_HTTPS_PORT"
      else
        doctor_fail "host nginx is not listening on port $PUBLIC_HTTPS_PORT"
      fi

      local nginx_conf="" host
      if $S nginx -T >/dev/null 2>&1; then
        nginx_conf="$($S nginx -T 2>/dev/null)"
      else
        nginx_conf="$($S grep -Rhs "server_name" /etc/nginx/conf.d /etc/nginx/sites-enabled 2>/dev/null || true)"
      fi
      for host in "$APP_HOST" "$SECRETS_MANAGER_HOST"; do
        if printf '%s\n' "$nginx_conf" | grep -Fq "$host"; then
          doctor_pass "host nginx declares $host"
        else
          doctor_fail "host nginx is missing server_name $host (install deploy/nginx/agiolab.conf)"
        fi
      done
    fi
  fi

  if has aws; then doctor_pass "AWS CLI is available"; else doctor_warn "AWS CLI is not installed (optional; the bundled client works)"; fi
  if has python3; then doctor_pass "python3 is available on the host"; else doctor_warn "python3 is not on the host (only needed for CLI tests outside Docker)"; fi
  if has git; then doctor_pass "git is available"; else doctor_warn "git is not installed (backup metadata will say unknown)"; fi
  if [ -f "$ROOT_DIR/eff_short_wordlist_1.txt" ]; then doctor_pass "word list is present"; else doctor_fail "eff_short_wordlist_1.txt is missing"; fi
  if [ -f "$ROOT_DIR/password_generator.py" ]; then doctor_pass "password_generator.py is present"; else doctor_fail "password_generator.py is missing"; fi

  section "Doctor result"
  printf '  Warnings: %s\n  Failures: %s\n' "$warnings" "$failures"
  if [ "$failures" -gt 0 ]; then
    err "Doctor found blocking problems."
    return 1
  fi
  ok "Doctor checks passed."
  return 0
}

# ---------------------------------------------------------------------------
# Menus
# ---------------------------------------------------------------------------
print_menu() {
  printf '\n'
  hr
  printf ' %sSecure Password Generator%s - stack control  (v%s)\n' "$BOLD" "$RESET" "$VERSION"
  printf ' Environment: %s%s%s   Project: %s\n' "$BOLD" "$APP_ENV_RESOLVED" "$RESET" "$PROJECT"
  printf ' App: %s\n Secrets: %s\n' "$(app_url)" "$(sm_url)"
  hr
  cat <<'EOF'
  1) Start stack (build with cache, seed secrets, wait for health)
  2) Stop stack (keep volumes)
  3) Restart stack
  4) Force rebuild (no cache + pull) and recreate
  5) Recreate containers (apply .env / compose changes)
  6) Status
  7) Logs
  8) Health check
  9) Smoke test (end-to-end)
 10) Backup Docker volumes -> full .tar.gz
 11) Restore from backup
 12) Backups: list / verify / prune
 13) Cleanup
 14) Secrets Manager
 15) Shell / exec
 16) Test Python CLI
 17) Show configuration
 18) Doctor
 19) Switch environment (dev / prd)
  0) Exit
EOF
}

menu_logs() {
  local choice service follow
  printf 'Service (1=app, 2=secrets-manager, 3=both) [1]: '
  read -r choice || return 0
  case "$choice" in
    1|"") service="app" ;;
    2) service="secrets-manager" ;;
    3) service="" ;;
    *) service="app" ;;
  esac
  printf 'Follow logs? (y/N): '
  read -r follow || return 0
  case "$follow" in
    y|Y|yes) action_logs "$service" true 200 ;;
    *) action_logs "$service" false 200 ;;
  esac
}

menu_backups() {
  local choice keep
  cat <<'EOF'

Backups:
  1) List backups
  2) Verify checksums
  3) Prune old backups
  4) Create a backup now
  0) Back
EOF
  printf 'Select: '
  read -r choice || return 0
  case "$choice" in
    1) action_backups_list ;;
    2) action_backups_verify ;;
    3)
      printf 'Keep how many backups? [%s]: ' "$BACKUP_RETENTION"
      read -r keep || return 0
      [ -z "$keep" ] && keep="$BACKUP_RETENTION"
      action_backups_prune "$keep"
      ;;
    4)
      BACKUP_LIVE=false
      BACKUP_ALL_VOLUMES=false
      BACKUP_KEEP_STAGING=false
      BACKUP_REASON="manual"
      action_backup
      ;;
    0|"") return 0 ;;
    *) warn "Invalid option." ;;
  esac
}

menu_restore() {
  local path choice
  action_backups_list
  printf '\nBundle or staging directory [latest]: '
  read -r path || return 0
  if [ -z "$path" ]; then
    if [ -f "$BACKUP_ROOT/$APP_ENV_RESOLVED/LATEST" ]; then
      path="$(cat "$BACKUP_ROOT/$APP_ENV_RESOLVED/LATEST")"
    else
      err "No LATEST backup recorded. Provide a path."
      return 1
    fi
  fi
  printf 'Merge into existing volumes instead of replacing? (y/N): '
  read -r choice || return 0
  case "$choice" in
    y|Y|yes) RESTORE_MERGE=true ;;
    *) RESTORE_MERGE=false ;;
  esac
  RESTORE_SNAPSHOT=true
  RESTORE_VOLUME=""
  action_restore "$path"
}

menu_cleanup() {
  local choice
  cat <<'EOF'

Cleanup:
  1) Remove containers (keep volumes)
  2) Remove containers AND volumes (data loss)
  3) Remove images
  4) Remove backups for this environment
  5) Remove everything for this environment
  6) Prune unused Docker images and build cache (global)
  0) Back
EOF
  printf 'Select: '
  read -r choice || return 0
  case "$choice" in
    1) action_cleanup containers ;;
    2) action_cleanup volumes ;;
    3) action_cleanup images ;;
    4) action_cleanup backups ;;
    5) action_cleanup all ;;
    6) action_cleanup dangling ;;
    0|"") return 0 ;;
    *) warn "Invalid option." ;;
  esac
}

menu_secrets() {
  local choice secret_id description file length sdk_choice boto3_choice with_sdk with_boto3
  cat <<'EOF'

Secrets Manager:
  1) List secrets
  2) Get a secret value
  3) Describe a secret
  4) Put (rotate) a secret value
  5) Create a secret
  6) Delete a secret
  7) Seed application secrets (app-config + integrity)
  8) Test endpoint (AWS CLI + bundled client)
  9) Show endpoint information
 10) Generate a random password
 11) Full AWS-substitute verification (lifecycle + optional AWS SDKs)
  0) Back
EOF
  printf 'Select: '
  read -r choice || return 0
  case "$choice" in
    1) action_secrets_list ;;
    2)
      printf 'Secret id: '
      read -r secret_id || return 0
      [ -n "$secret_id" ] && action_secrets_get "$secret_id"
      ;;
    3)
      printf 'Secret id: '
      read -r secret_id || return 0
      [ -n "$secret_id" ] && action_secrets_describe "$secret_id"
      ;;
    4)
      printf 'Secret id: '
      read -r secret_id || return 0
      [ -n "$secret_id" ] && action_secrets_put "$secret_id"
      ;;
    5)
      printf 'New secret name: '
      read -r secret_id || return 0
      printf 'Description (optional): '
      read -r description || return 0
      [ -n "$secret_id" ] && action_secrets_create "$secret_id" "$description"
      ;;
    6)
      printf 'Secret id: '
      read -r secret_id || return 0
      [ -n "$secret_id" ] && action_secrets_delete "$secret_id"
      ;;
    7) seed_secrets true ;;
    8) action_secrets_test ;;
    9) action_secrets_endpoint ;;
    10)
      printf 'Length [32]: '
      read -r length || return 0
      [ -z "$length" ] && length=32
      action_secrets_random "$length"
      ;;
    11)
      with_sdk=false
      with_boto3=false
      printf 'Include the AWS SDK v3 (Node) client test? Requires npm network (y/N): '
      read -r sdk_choice || sdk_choice=""
      case "$sdk_choice" in y|Y|yes) with_sdk=true ;; esac
      printf 'Include the boto3 (Python) client test? Requires PyPI network (y/N): '
      read -r boto3_choice || boto3_choice=""
      case "$boto3_choice" in y|Y|yes) with_boto3=true ;; esac
      action_secrets_verify "$with_sdk" "$with_boto3"
      ;;
    0|"") return 0 ;;
    *) warn "Invalid option." ;;
  esac
}

menu_switch_env() {
  local choice
  printf 'Environment (dev/prd) [%s]: ' "$APP_ENV_RESOLVED"
  read -r choice || return 0
  [ -z "$choice" ] && return 0
  if resolve_env "$choice"; then
    ok "Switched to environment: $APP_ENV_RESOLVED"
  else
    warn "Environment unchanged."
  fi
}

interactive_menu() {
  local choice
  while true; do
    print_menu
    printf '\nSelect an option: '
    if ! read -r choice; then
      printf '\n'
      return 0
    fi
    case "$choice" in
      1) action_up cached false; pause ;;
      2) action_down; pause ;;
      3) action_restart; pause ;;
      4) action_rebuild; pause ;;
      5) action_recreate; pause ;;
      6) action_status; pause ;;
      7) menu_logs; pause ;;
      8) action_health false; pause ;;
      9) action_smoke; pause ;;
      10)
        BACKUP_LIVE=false
        BACKUP_ALL_VOLUMES=false
        BACKUP_KEEP_STAGING=false
        BACKUP_REASON="manual"
        action_backup
        pause
        ;;
      11) menu_restore; pause ;;
      12) menu_backups; pause ;;
      13) menu_cleanup; pause ;;
      14) menu_secrets; pause ;;
      15)
        printf 'Service (1=app, 2=secrets-manager) [1]: '
        read -r choice || return 0
        case "$choice" in
          2) action_shell secrets-manager ;;
          *) action_shell app ;;
        esac
        pause
        ;;
      16) action_test_cli; pause ;;
      17) action_config; pause ;;
      18) action_doctor; pause ;;
      19) menu_switch_env; pause ;;
      0|q|Q) info "Bye."; return 0 ;;
      *) warn "Invalid option."; pause ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
cmd_up() {
  local build="cached" attach=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --build) build="cached" ;;
      --force-rebuild|--rebuild) build="force" ;;
      --no-build) build="no" ;;
      --attach) attach=true ;;
      *) err "Unknown option for up: $1"; return 1 ;;
    esac
    shift
  done
  action_up "$build" "$attach"
}

cmd_down() {
  action_down
}

cmd_restart() {
  action_restart
}

cmd_recreate() {
  action_recreate
}

cmd_rebuild() {
  action_rebuild
}

cmd_status() {
  action_status
}

cmd_logs() {
  local service="" follow=false tail="200"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --follow|-f) follow=true ;;
      --tail) tail="${2:-200}"; shift ;;
      --tail=*) tail="${1#--tail=}" ;;
      app|password|secrets|secrets-manager|secrets_manager) service="$1" ;;
      *) err "Unknown argument for logs: $1"; return 1 ;;
    esac
    shift
  done
  action_logs "$service" "$follow" "$tail"
}

cmd_health() {
  local strict=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --strict) strict=true ;;
      *) err "Unknown argument for health: $1"; return 1 ;;
    esac
    shift
  done
  action_health "$strict"
}

cmd_smoke() {
  action_smoke
}

cmd_backup() {
  BACKUP_LIVE=false
  BACKUP_ALL_VOLUMES=false
  BACKUP_KEEP_STAGING=false
  BACKUP_REASON="manual"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --live) BACKUP_LIVE=true ;;
      --all-volumes) BACKUP_ALL_VOLUMES=true ;;
      --keep-staging) BACKUP_KEEP_STAGING=true ;;
      --retention) BACKUP_RETENTION="${2:-$BACKUP_RETENTION}"; shift ;;
      --retention=*) BACKUP_RETENTION="${1#--retention=}" ;;
      *) err "Unknown option for backup: $1"; return 1 ;;
    esac
    shift
  done
  action_backup
}

cmd_restore() {
  local source="" choice
  ASSUME_YES=false
  RESTORE_SNAPSHOT=true
  RESTORE_MERGE=false
  RESTORE_VOLUME=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes|-y) ASSUME_YES=true ;;
      --no-snapshot) RESTORE_SNAPSHOT=false ;;
      --merge) RESTORE_MERGE=true ;;
      --volume) RESTORE_VOLUME="${2:-}"; shift ;;
      --volume=*) RESTORE_VOLUME="${1#--volume=}" ;;
      --) shift; break ;;
      -*) err "Unknown option for restore: $1"; return 1 ;;
      *) source="$1" ;;
    esac
    shift
  done
  if [ -z "$source" ]; then
    err "Usage: ./bin/start.sh restore [dev|prd] <bundle.tar.gz|directory> [--yes]"
    return 1
  fi
  action_restore "$source"
}

cmd_backups() {
  local sub="${1:-list}" keep
  if [ "$#" -gt 0 ]; then
    shift
  fi
  ASSUME_YES=false
  local filtered=() argument
  for argument in "$@"; do
    case "$argument" in
      --yes|-y) ASSUME_YES=true ;;
      *) filtered[${#filtered[@]}]="$argument" ;;
    esac
  done
  set -- ${filtered[@]+"${filtered[@]}"}
  case "$sub" in
    list) action_backups_list ;;
    verify) action_backups_verify ;;
    prune)
      keep="${1:-$BACKUP_RETENTION}"
      action_backups_prune "$keep"
      ;;
    *) err "Usage: ./bin/start.sh backups [dev|prd] list|verify|prune [N] [--yes]"; return 1 ;;
  esac
}

cmd_cleanup() {
  local scope="${1:-}"
  ASSUME_YES=false
  if [ "$#" -gt 0 ]; then
    shift
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes|-y) ASSUME_YES=true ;;
      *) err "Unknown option for cleanup: $1"; return 1 ;;
    esac
    shift
  done
  if [ -z "$scope" ]; then
    err "Usage: ./bin/start.sh cleanup [dev|prd] <containers|volumes|images|backups|all|dangling> [--yes]"
    return 1
  fi
  action_cleanup "$scope"
}

cmd_secrets() {
  local sub="${1:-help}"
  ASSUME_YES=false
  if [ "$#" -gt 0 ]; then
    shift
  fi
  case "$sub" in
    list) action_secrets_list ;;
    get)
      local secret_id="${1:-}" stage="" json=false
      shift || true
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --stage) stage="${2:-}"; shift ;;
          --stage=*) stage="${1#--stage=}" ;;
          --json) json=true ;;
          *) err "Unknown option for secrets get: $1"; return 1 ;;
        esac
        shift
      done
      [ -n "$secret_id" ] || { err "Usage: secrets [dev|prd] get <secret-id> [--stage STAGE] [--json]"; return 1; }
      action_secrets_get "$secret_id" "$stage" "$json"
      ;;
    describe) action_secrets_describe "${1:-}" ;;
    put)
      local id="${1:-}" file=""
      shift || true
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --file) file="${2:-}"; shift ;;
          --file=*) file="${1#--file=}" ;;
          *) err "Unknown option for secrets put: $1"; return 1 ;;
        esac
        shift
      done
      [ -n "$id" ] || { err "Usage: secrets [dev|prd] put <secret-id> [--file PATH]"; return 1; }
      action_secrets_put "$id" "$file"
      ;;
    create)
      local name="${1:-}" description=""
      shift || true
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --description) description="${2:-}"; shift ;;
          --description=*) description="${1#--description=}" ;;
          *) err "Unknown option for secrets create: $1"; return 1 ;;
        esac
        shift
      done
      [ -n "$name" ] || { err "Usage: secrets [dev|prd] create <name> [--description TEXT]"; return 1; }
      action_secrets_create "$name" "$description"
      ;;
    delete)
      local secret_id="${1:-}" force=false
      shift || true
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --force) force=true ;;
          --yes|-y) ASSUME_YES=true ;;
          *) err "Unknown option for secrets delete: $1"; return 1 ;;
        esac
        shift
      done
      [ -n "$secret_id" ] || { err "Usage: secrets [dev|prd] delete <secret-id> [--force]"; return 1; }
      action_secrets_delete "$secret_id" "$force"
      ;;
    seed)
      local force=false
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --force) force=true ;;
          *) err "Unknown option for secrets seed: $1"; return 1 ;;
        esac
        shift
      done
      seed_secrets "$force"
      ;;
    test) action_secrets_test ;;
    verify)
      local with_sdk=false with_boto3=false
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --sdk) with_sdk=true ;;
          --boto3) with_boto3=true ;;
          *) err "Unknown option for secrets verify: $1"; return 1 ;;
        esac
        shift
      done
      action_secrets_verify "$with_sdk" "$with_boto3"
      ;;
    endpoint) action_secrets_endpoint ;;
    random)
      local length="32"
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --length) length="${2:-32}"; shift ;;
          --length=*) length="${1#--length=}" ;;
          *) err "Unknown option for secrets random: $1"; return 1 ;;
        esac
        shift
      done
      action_secrets_random "$length"
      ;;
    raw)
      [ -n "${1:-}" ] || { err "Usage: secrets [dev|prd] raw <Operation> [json]"; return 1; }
      action_secrets_raw "$1" "${2:-}"
      ;;
    help|--help|-h|"") usage; return 0 ;;
    *) err "Unknown secrets command: $sub"; return 1 ;;
  esac
}

cmd_shell() {
  local service="${1:-app}"
  action_shell "$service"
}

cmd_exec() {
  action_exec "$@"
}

cmd_test_cli() {
  action_test_cli
}

cmd_config() {
  action_config
}

cmd_check_env() {
  bash "$ROOT_DIR/bin/check-env-parity.sh" "$@"
}

cmd_doctor() {
  action_doctor
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
main() {
  local filtered=() argument command
  for argument in "$@"; do
    case "$argument" in
      dev|development) REQUESTED_ENV="dev" ;;
      prd|prod|production) REQUESTED_ENV="prd" ;;
      *) filtered[${#filtered[@]}]="$argument" ;;
    esac
  done
  set -- ${filtered[@]+"${filtered[@]}"}
  command="${1:-}"

  case "$command" in
    help|-h|--help)
      usage
      return 0
      ;;
    version|--version)
      printf '%s %s\n' "$(basename "$0")" "$VERSION"
      return 0
      ;;
    ""|menu|up|start|down|stop|restart|recreate|rebuild|status|logs|health|smoke|backup|restore|backups|cleanup|secrets|shell|exec|test-cli|config|check-env|doctor)
      ;;
    *)
      err "Unknown command: $command"
      usage
      return 2
      ;;
  esac

  if [ "$command" = "check-env" ]; then
    shift
    cmd_check_env "$@"
    return $?
  fi

  resolve_env "${REQUESTED_ENV:-}" || return 1

  case "$command" in
    ""|menu)
      if [ ! -t 0 ]; then
        usage
        return 2
      fi
      interactive_menu
      return $?
      ;;
    up|start)
      shift
      cmd_up "$@"
      ;;
    down|stop) cmd_down ;;
    restart) cmd_restart ;;
    recreate) cmd_recreate ;;
    rebuild) cmd_rebuild ;;
    status) cmd_status ;;
    logs)
      shift
      cmd_logs "$@"
      ;;
    health)
      shift
      cmd_health "$@"
      ;;
    smoke) cmd_smoke ;;
    backup)
      shift
      cmd_backup "$@"
      ;;
    restore)
      shift
      cmd_restore "$@"
      ;;
    backups)
      shift
      cmd_backups "$@"
      ;;
    cleanup)
      shift
      cmd_cleanup "$@"
      ;;
    secrets)
      shift
      cmd_secrets "$@"
      ;;
    shell)
      shift
      cmd_shell "$@"
      ;;
    exec)
      shift
      cmd_exec "$@"
      ;;
    test-cli) cmd_test_cli ;;
    config) cmd_config ;;
    check-env) cmd_check_env ;;
    doctor) cmd_doctor ;;
  esac
}

main "$@"

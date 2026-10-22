#!/usr/bin/env bash
# =============================================================================
#  Environment parity gate
#
#  .env.example is the canonical reference. .env.dev and .env.prd must:
#    • exist,
#    • contain exactly the same keys as .env.example,
#    • keep every key on the same line number (line-aligned contract),
#    • contain no duplicate keys and no malformed lines,
#    • provide a non-empty value for every required key
#      (# optional keys may be empty),
#    • keep the correct APP_ENV suffix and non-placeholder secrets,
#    • use distinct projects/ports per environment.
#
#  It also verifies that every ${VAR} interpolated by the Compose files is
#  declared in .env.example.
#
#  Values are never printed. Errors only name the file and the variable.
#
#  Usage:
#    ./bin/check-env-parity.sh             check every env file
#    ./bin/check-env-parity.sh --quiet     only errors (used by start.sh)
#    ./bin/check-env-parity.sh /repo/root  explicit repository root
# =============================================================================
set -uo pipefail

QUIET=false
ROOT=""

usage() {
  cat <<'EOF'
Usage: ./bin/check-env-parity.sh [--quiet] [repo-root]

  --quiet, -q   Suppress the success line (failures are always printed).
  -h, --help    Show this help.

Checks .env.example against .env.dev and .env.prd (plus any additional root
.env.* files): key parity, line alignment, duplicates, malformed lines,
required values, secret placeholders, APP_ENV suffixes and Compose variables.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet|-q) QUIET=true ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    -*) printf 'env-parity: unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *) ROOT="$1" ;;
  esac
  shift
done

if [ -z "$ROOT" ]; then
  ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)" || exit 2
fi
ROOT="$(CDPATH= cd -- "$ROOT" 2>/dev/null && pwd)" || {
  printf 'env-parity: fail (invalid repository root)\n' >&2
  exit 2
}
cd "$ROOT" || exit 2

TMP="$(mktemp -d "${TMPDIR:-/tmp}/env-parity.XXXXXX")" || {
  printf 'env-parity: fail (cannot create a temporary directory)\n' >&2
  exit 2
}
trap 'rm -rf "$TMP"' EXIT INT TERM

BASE=".env.example"
CANONICAL=(".env.dev" ".env.prd")
FILES=("$BASE" "${CANONICAL[@]}")

shopt -s nullglob
for extra in .env.*; do
  [ -f "$extra" ] || continue
  case "$extra" in
    .env.example|.env.dev|.env.prd) ;;
    *) FILES+=("$extra") ;;
  esac
done

STATUS=0
fail() {
  STATUS=1
  printf 'env-parity: %s\n' "$*" >&2
}
pass() {
  [ "$QUIET" = true ] || printf 'env-parity: %s\n' "$*"
}

key_names() {
  awk -F= '/^[A-Z0-9_]+=/{print $1}' "$1"
}

key_lines() {
  awk -F= '/^[A-Z0-9_]+=/{print NR " " $1}' "$1"
}

value_of() {
  local file="$1" key="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "$file"
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_quotes() {
  local value
  value="$(trim "$1")"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

invalid_lines() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    !/^[A-Z0-9_]+=/ { print NR ": " $0 }
  ' "$1"
}

# Parse annotations that appear on the comment line immediately above a key.
# Supported forms: "# optional", "# secret", "# optional secret", "# secret optional".
build_flags() {
  awk '
    /^[[:space:]]*#/ {
      line=$0
      sub(/^[[:space:]]*#[[:space:]]*/, "", line)
      gsub(/[[:space:]]+/, " ", line)
      line=tolower(line)
      if (line == "optional" || line == "secret" || line == "optional secret" || line == "secret optional") {
        opt = (line ~ /optional/) ? 1 : 0
        sec = (line ~ /secret/) ? 1 : 0
      } else {
        opt = 0
        sec = 0
      }
      next
    }
    /^[[:space:]]*$/ { opt = 0; sec = 0; next }
    /^[A-Z0-9_]+=/ {
      key=$0
      sub(/=.*/, "", key)
      print key, opt, sec
      opt = 0
      sec = 0
    }
  ' "$BASE"
}

# $1 = key, $2 = column (2 optional, 3 secret)
is_flag() {
  awk -v key="$1" -v column="$2" '
    $1 == key && $column == 1 { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$TMP/flags"
}

# ---------------------------------------------------------------------------
# Required files
# ---------------------------------------------------------------------------
for file in "$BASE" "${CANONICAL[@]}"; do
  if [ ! -f "$file" ]; then
    fail "$file is missing (required: .env.example, .env.dev, .env.prd)"
  fi
done
if [ ! -f "$BASE" ]; then
  printf 'env-parity: FAIL\n' >&2
  exit 1
fi

PRESENT=()
for file in "${FILES[@]}"; do
  [ -f "$file" ] && PRESENT+=("$file")
done

# ---------------------------------------------------------------------------
# Structure: malformed lines and duplicate keys
# ---------------------------------------------------------------------------
for file in "${PRESENT[@]}"; do
  invalid="$(invalid_lines "$file")"
  if [ -n "$invalid" ]; then
    fail "$file has invalid lines (expected KEY=value, # comment or blank):"
    printf '%s\n' "$invalid" | sed 's/^/  /' >&2
  fi

  duplicates="$(key_names "$file" | sort | uniq -d)"
  if [ -n "$duplicates" ]; then
    fail "$file has duplicate keys: $(printf '%s' "$duplicates" | tr '\n' ' ')"
  fi
done

KEY_COUNT="$(key_names "$BASE" | wc -l | tr -d ' ')"
if [ "$KEY_COUNT" -eq 0 ]; then
  fail "$BASE contains no variables"
fi
BASE_KEYS="$(key_names "$BASE" | sort -u)"

build_flags > "$TMP/flags"

# ---------------------------------------------------------------------------
# Key parity and line alignment
# ---------------------------------------------------------------------------
for other in "${PRESENT[@]}"; do
  [ "$other" = "$BASE" ] && continue

  missing="$(comm -23 <(key_names "$BASE" | sort -u) <(key_names "$other" | sort -u) || true)"
  extra="$(comm -13 <(key_names "$BASE" | sort -u) <(key_names "$other" | sort -u) || true)"

  if [ -n "$missing" ]; then
    fail "$other is missing keys present in $BASE: $(printf '%s' "$missing" | tr '\n' ' ')"
  fi
  if [ -n "$extra" ]; then
    fail "$other has keys absent from $BASE: $(printf '%s' "$extra" | tr '\n' ' ')"
  fi

  if ! diff -q <(key_lines "$BASE") <(key_lines "$other") >/dev/null 2>&1; then
    fail "$other is not line-aligned with $BASE"
    diff -u <(key_lines "$BASE") <(key_lines "$other") 2>/dev/null | sed -n '3,30p' | sed 's/^/  /' >&2 || true
  fi
done

# ---------------------------------------------------------------------------
# Example must not contain real secrets
# ---------------------------------------------------------------------------
for key in $BASE_KEYS; do
  if is_flag "$key" 3; then
    value="$(strip_quotes "$(value_of "$BASE" "$key")")"
    if [ -n "$value" ]; then
      case "$value" in
        *"<"*">"*|*CHANGE_ME*|*change_me*) ;;
        *) fail "$BASE: $key must remain a placeholder, not a real value" ;;
      esac
    fi
  fi
done

# ---------------------------------------------------------------------------
# Values in the real environment files
# ---------------------------------------------------------------------------
for env_file in "${CANONICAL[@]}"; do
  [ -f "$env_file" ] || continue
  suffix="${env_file#.env.}"

  app_env="$(strip_quotes "$(value_of "$env_file" APP_ENV)")"
  if [ "$app_env" != "$suffix" ]; then
    fail "$env_file: APP_ENV must be '$suffix' (found '$app_env')"
  fi

  for key in $BASE_KEYS; do
    if is_flag "$key" 2; then
      continue
    fi
    value="$(strip_quotes "$(value_of "$env_file" "$key")")"
    if [ -z "$value" ]; then
      fail "$env_file: $key must not be empty"
    fi
  done

  for key in APP_PORT APP_DEBUG_PORT SECRETS_MANAGER_PORT PUBLIC_HTTPS_PORT SECRETS_CACHE_TTL_MS BACKUP_RETENTION; do
    value="$(strip_quotes "$(value_of "$env_file" "$key")")"
    case "$value" in
      ''|*[!0-9]*) fail "$env_file: $key must be a non-negative integer" ;;
    esac
  done

  for key in $BASE_KEYS; do
    if ! is_flag "$key" 3; then
      continue
    fi
    value="$(strip_quotes "$(value_of "$env_file" "$key")")"
    [ -n "$value" ] || continue
    case "$value" in
      *CHANGE_ME*|*change_me*|*"<"*">"*)
        fail "$env_file: $key still contains a placeholder value"
        ;;
    esac
  done

  account="$(strip_quotes "$(value_of "$env_file" SECRETS_MANAGER_ACCOUNT_ID)")"
  if ! printf '%s' "$account" | grep -qE '^[0-9]{12}$'; then
    fail "$env_file: SECRETS_MANAGER_ACCOUNT_ID must be 12 digits"
  fi

  region="$(strip_quotes "$(value_of "$env_file" SECRETS_MANAGER_REGION)")"
  if ! printf '%s' "$region" | grep -qE '^[a-z]{2}(-[a-z]+)+-[0-9]$'; then
    fail "$env_file: SECRETS_MANAGER_REGION is not a valid region (for example us-east-1)"
  fi

  enabled="$(strip_quotes "$(value_of "$env_file" SECRETS_MANAGER_ENABLED)")"
  case "$enabled" in
    true|false) ;;
    *) fail "$env_file: SECRETS_MANAGER_ENABLED must be true or false" ;;
  esac

  endpoint="$(strip_quotes "$(value_of "$env_file" SECRETS_MANAGER_ENDPOINT)")"
  case "$endpoint" in
    http://*|https://*) ;;
    *) fail "$env_file: SECRETS_MANAGER_ENDPOINT must start with http:// or https://" ;;
  esac

  log_level="$(strip_quotes "$(value_of "$env_file" LOG_LEVEL)")"
  case "$log_level" in
    debug|info|warn|error) ;;
    *) fail "$env_file: LOG_LEVEL must be debug, info, warn or error" ;;
  esac

  for key in APP_PUBLIC_URL SECRETS_MANAGER_PUBLIC_URL; do
    value="$(strip_quotes "$(value_of "$env_file" "$key")")"
    case "$value" in
      https://*) ;;
      *) fail "$env_file: $key must start with https://" ;;
    esac
  done

  master_key="$(strip_quotes "$(value_of "$env_file" SECRETS_MANAGER_MASTER_KEY)")"
  if [ -n "$master_key" ]; then
    if ! printf '%s' "$master_key" | grep -qE '^[0-9a-fA-F]{64}$' &&
       ! printf '%s' "$master_key" | grep -qE '^[A-Za-z0-9+/]{43}=$'; then
      fail "$env_file: SECRETS_MANAGER_MASTER_KEY must be 64 hex characters or base64 of 32 bytes"
    fi
  fi
done

# ---------------------------------------------------------------------------
# Environment isolation and shared host ports
#
# The project names and volumes are separate, but host ports are deliberately
# shared so the same integration URLs work for dev and prd. Only one
# environment can own the host ports at a time.
# ---------------------------------------------------------------------------
if [ -f ".env.dev" ] && [ -f ".env.prd" ]; then
  dev_project="$(strip_quotes "$(value_of ".env.dev" COMPOSE_PROJECT_NAME)")"
  prd_project="$(strip_quotes "$(value_of ".env.prd" COMPOSE_PROJECT_NAME)")"
  if [ "$dev_project" = "$prd_project" ]; then
    fail "COMPOSE_PROJECT_NAME must differ between .env.dev and .env.prd"
  fi

  for key in APP_PORT APP_DEBUG_PORT SECRETS_MANAGER_PORT PUBLIC_HTTPS_PORT; do
    dev_value="$(strip_quotes "$(value_of ".env.dev" "$key")")"
    prd_value="$(strip_quotes "$(value_of ".env.prd" "$key")")"
    if [ "$dev_value" != "$prd_value" ]; then
      fail "$key must be identical in .env.dev and .env.prd (shared host ports)"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Compose interpolation variables must be declared in the reference
# ---------------------------------------------------------------------------
if [ -n "$BASE_KEYS" ]; then
  compose_vars="$(grep -hoE '\$\{[A-Z_][A-Z0-9_]*' docker-compose.*.yml 2>/dev/null | sed -e 's/^[$]//' -e 's/^{//' | sort -u)"
  for var in $compose_vars; do
    if ! printf '%s\n' "$BASE_KEYS" | grep -qx "$var"; then
      fail "docker-compose files reference \${$var}, which is not declared in $BASE"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [ "$STATUS" -ne 0 ]; then
  printf 'env-parity: FAIL (%s)\n' "${PRESENT[*]}" >&2
  exit 1
fi

pass "$(printf '%s: %s keys, line-aligned, no duplicates, required values set' "${PRESENT[*]}" "$KEY_COUNT")"
exit 0

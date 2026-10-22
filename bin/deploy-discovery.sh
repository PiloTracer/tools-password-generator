#!/usr/bin/env bash
# =============================================================================
# deploy-discovery.sh - READ-ONLY deployment discovery for Linux hosts.
#
# Generic: no application, domain, port or path is hard-coded. Describe the
# deployment with flags; the script discovers the host, Docker, host nginx,
# other reverse proxies, listeners, DNS/TLS/HTTP behaviour and the repository.
#
# It supports multiple domains and multiple ports. Use --domain/--port for a
# domain x port matrix and/or --endpoint DOMAIN:PORT for exact pairs.
#
# Usage:
#   sudo ./bin/deploy-discovery.sh \
#     --name myapp \
#     --domain app.example.com --domain api.example.com \
#     --port 443 --port 8443 --tls-port 8443 \
#     --repo /opt/myapp \
#     --compose docker-compose.prd.yml \
#     --env-file .env.prd \
#     --project myapp_prd \
#     --format both \
#     --output-dir /var/log/deploy-discovery/myapp-$(date +%Y%m%dT%H%M%SZ)
#
#   Legacy positional form: ./bin/deploy-discovery.sh [domain] [repo_path]
#
# Options:
#   --name NAME              Report label (default: deployment).
#   --domain DOMAIN          Repeatable. Added to the domain x port matrix.
#   --port PORT              Repeatable. Defaults to 80 and 443 if only
#                            domains are supplied.
#   --endpoint DOMAIN:PORT   Repeatable exact endpoint (domain may be empty
#                            for a local-only port check).
#   --tls-port PORT          Repeatable. Treat this port as HTTPS even if it
#                            is not one of the well-known TLS ports.
#   --http-port PORT         Repeatable. Treat this port as plain HTTP.
#   --repo PATH              Application repository (default: current dir).
#   --compose FILE           Compose file, relative to --repo or absolute.
#   --env-file FILE          Env file, relative to --repo or absolute.
#   --project NAME           Compose project / Docker label filter.
#   --format text|markdown|both
#                            text = raw report only (default);
#                            markdown/both also writes runbook.md.
#   --output-dir DIR         Report directory (default: ./deploy-discovery-*).
#   --no-network             Skip DNS, HTTP, TLS and external probes.
#   --tls                    Force TLS for endpoint HTTP probes.
#   --http                   Force plain HTTP for endpoint HTTP probes.
#   --max-lines N            Cap each raw command output (default: 160).
#   -h, --help               This help.
#
# Read-only: no packages installed, no configuration edited, no service
# restarted. Env files are listed by variable NAME only and values are never
# printed. The report directory is 700 and files are 600.
#
# Exit codes: 0 discovery completed (warnings may still exist), 1 usage/setup
# error, 2 no usable output directory.
# =============================================================================
set -uo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
HOST_SHORT="$(hostname -s 2>/dev/null || hostname)"
HOST_FQDN="$(hostname -f 2>/dev/null || hostname)"
TS="$(date +%Y%m%dT%H%M%SZ)"

NAME="deployment"
REPO="$PWD"
COMPOSE_FILE=""
ENV_FILE=""
PROJECT=""
OUTPUT_DIR=""
FORMAT="text"
NO_NETWORK=false
FORCE_PROTO=""
MAX_LINES=160

DOMAINS=()
PORTS=()
ENDPOINTS=()
TLS_PORTS=()
HTTP_PORTS=()

S=""
REPORT=""
RUNBOOK=""
WARNINGS_FILE=""
ENDPOINT_TSV=""
CONTAINERS_TSV=""
COMPOSE_TSV=""
NGINX_SERVERS_TSV=""
NGINX_MAP_TSV=""
PROXIES_TXT=""
PORTS_TSV=""
TLS_DIR=""
NGINX_FULL=""
NGINX_ERR=""
DOCKER_OK=false
NGINX_OK=false
PYTHON_OK=false
PUBLIC_IPV4=""

usage() { sed -n '2,55p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

die() { printf 'deploy-discovery: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --name)
        [ "$#" -ge 2 ] || die "--name requires a value"
        NAME="$2"; shift 2 ;;
      --domain)
        [ "$#" -ge 2 ] || die "--domain requires a value"
        DOMAINS+=("$2"); shift 2 ;;
      --port)
        [ "$#" -ge 2 ] || die "--port requires a value"
        PORTS+=("$2"); shift 2 ;;
      --endpoint)
        [ "$#" -ge 2 ] || die "--endpoint requires DOMAIN:PORT"
        ENDPOINTS+=("$2"); shift 2 ;;
      --tls-port)
        [ "$#" -ge 2 ] || die "--tls-port requires a port"
        TLS_PORTS+=("$2"); shift 2 ;;
      --http-port)
        [ "$#" -ge 2 ] || die "--http-port requires a port"
        HTTP_PORTS+=("$2"); shift 2 ;;
      --repo)
        [ "$#" -ge 2 ] || die "--repo requires a path"
        REPO="$2"; shift 2 ;;
      --compose)
        [ "$#" -ge 2 ] || die "--compose requires a file"
        COMPOSE_FILE="$2"; shift 2 ;;
      --env-file)
        [ "$#" -ge 2 ] || die "--env-file requires a file"
        ENV_FILE="$2"; shift 2 ;;
      --project)
        [ "$#" -ge 2 ] || die "--project requires a name"
        PROJECT="$2"; shift 2 ;;
      --format)
        [ "$#" -ge 2 ] || die "--format requires text, markdown or both"
        FORMAT="$2"; shift 2 ;;
      --output-dir)
        [ "$#" -ge 2 ] || die "--output-dir requires a path"
        OUTPUT_DIR="$2"; shift 2 ;;
      --no-network)
        NO_NETWORK=true; shift ;;
      --tls)
        FORCE_PROTO="tls"; shift ;;
      --http)
        FORCE_PROTO="http"; shift ;;
      --max-lines)
        [ "$#" -ge 2 ] || die "--max-lines requires a number"
        MAX_LINES="$2"; shift 2 ;;
      -h|--help)
        usage; exit 0 ;;
      --)
        shift; break ;;
      -*)
        die "unknown option '$1' (see --help)" ;;
      *)
        # Legacy positional: domain, then repo path.
        if [ "${#DOMAINS[@]}" -eq 0 ]; then
          DOMAINS+=("$1")
        elif [ "$REPO" = "$PWD" ]; then
          REPO="$1"
        else
          die "unexpected argument '$1' (use flags for additional values)"
        fi
        shift ;;
    esac
  done

  case "$FORMAT" in
    text|markdown|both) ;;
    *) die "--format must be text, markdown or both" ;;
  esac
  case "$MAX_LINES" in
    ''|*[!0-9]*) die "--max-lines must be a positive integer" ;;
  esac
  [ "$MAX_LINES" -ge 10 ] || die "--max-lines must be at least 10"
}

parse_args "$@"

# ---------------------------------------------------------------------------
# Paths and output setup
# ---------------------------------------------------------------------------
if [ -n "$REPO" ]; then
  if [ ! -d "$REPO" ]; then
    printf 'deploy-discovery: warning: repository path does not exist: %s\n' "$REPO" >&2
  else
    REPO="$(cd -- "$REPO" && pwd)"
  fi
fi

case "$COMPOSE_FILE" in
  "") ;;
  /*) ;;
  *) COMPOSE_FILE="$REPO/$COMPOSE_FILE" ;;
esac
case "$ENV_FILE" in
  "") ;;
  /*) ;;
  *) ENV_FILE="$REPO/$ENV_FILE" ;;
esac

if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR="$PWD/deploy-discovery-${HOST_SHORT}-${TS}"
fi
case "$OUTPUT_DIR" in
  /*) ;;
  *) OUTPUT_DIR="$PWD/$OUTPUT_DIR" ;;
esac
mkdir -p -- "$OUTPUT_DIR" || exit 2
chmod 700 "$OUTPUT_DIR" 2>/dev/null || true
OUTPUT_DIR="$(cd -- "$OUTPUT_DIR" && pwd)"

REPORT="$OUTPUT_DIR/deploy-report.txt"
RUNBOOK="$OUTPUT_DIR/runbook.md"
WARNINGS_FILE="$OUTPUT_DIR/warnings.txt"
ENDPOINT_TSV="$OUTPUT_DIR/endpoints.tsv"
CONTAINERS_TSV="$OUTPUT_DIR/containers.tsv"
COMPOSE_TSV="$OUTPUT_DIR/compose-services.tsv"
NGINX_SERVERS_TSV="$OUTPUT_DIR/nginx-servers.tsv"
NGINX_MAP_TSV="$OUTPUT_DIR/nginx-endpoint-map.tsv"
PROXIES_TXT="$OUTPUT_DIR/reverse-proxies.txt"
PORTS_TSV="$OUTPUT_DIR/ports.tsv"
TLS_DIR="$OUTPUT_DIR/.tls"
NGINX_FULL="$OUTPUT_DIR/nginx-T.conf"
NGINX_ERR="$OUTPUT_DIR/nginx-T.err"

: >"$REPORT"
: >"$WARNINGS_FILE"
: >"$ENDPOINT_TSV"
: >"$CONTAINERS_TSV"
: >"$COMPOSE_TSV"
: >"$NGINX_SERVERS_TSV"
: >"$NGINX_MAP_TSV"
: >"$PROXIES_TXT"
: >"$PORTS_TSV"
chmod 600 "$REPORT" "$WARNINGS_FILE" "$ENDPOINT_TSV" "$CONTAINERS_TSV" \
  "$COMPOSE_TSV" "$NGINX_SERVERS_TSV" "$NGINX_MAP_TSV" "$PROXIES_TXT" "$PORTS_TSV" 2>/dev/null || true
mkdir -p "$TLS_DIR"; chmod 700 "$TLS_DIR" 2>/dev/null || true

if [ "$(id -u)" -eq 0 ]; then
  S=""
elif sudo -n true 2>/dev/null; then
  S="sudo -n"
else
  S=""
fi
export S REPO NAME

if [ -z "$S" ] && [ "$(id -u)" -ne 0 ]; then
  printf 'deploy-discovery: warning: not root and passwordless sudo is unavailable; process/port ownership will be incomplete\n' >&2
fi

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
log() { printf '%s\n' "$*"; printf '%s\n' "$*" >>"$REPORT"; }
section() { log ""; log "########## $* ##########"; }

add_warning() {
  local message="$*"
  printf 'WARNING: %s\n' "$message" >&2
  if ! grep -Fxq -- "$message" "$WARNINGS_FILE" 2>/dev/null; then
    printf '%s\n' "$message" >>"$WARNINGS_FILE"
  fi
}

redact() {
  sed -E \
    -e 's#(://[^/@[:space:]:]+:)[^@/[:space:]]+@#\1***@#g' \
    -e 's#(://)[A-Za-z0-9_-]{20,}@#\1***@#g' \
    -e 's#((^|[[:space:]])(pass(word)?|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*[[:space:]]*=)[[:space:]]*[^[:space:]]+#\1***#Ig' \
    -e 's#(Authorization:[[:space:]]*)[^[:space:]]+#\1***#Ig' \
    -e 's#(Bearer[[:space:]]+)[A-Za-z0-9._~+/-]+=*#\1***#Ig' \
    -e 's#(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sk-[a-z]*-?)[A-Za-z0-9_-]{8,}#\1***#g' \
    -e 's#(AKIA|ASIA)[A-Z0-9]{16}#\1****************#g'
}

run() {
  local command="$1"
  log ""
  log "\$ $command"
  timeout 30 bash -c "$command" 2>&1 | redact | head -n "$MAX_LINES" | tee -a "$REPORT"
}

capture() {
  timeout 30 bash -c "$1" 2>&1 | redact
}

port_is_number() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "$1" -ge 1 ] && [ "$1" -le 65535 ] ;;
  esac
}

sanitize_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

# ---------------------------------------------------------------------------
# Endpoint model
# ---------------------------------------------------------------------------
endpoint_proto() {
  local port="$1" p
  if [ -n "$FORCE_PROTO" ]; then
    [ "$FORCE_PROTO" = "tls" ] && { printf 'https'; return; }
    printf 'http'; return
  fi
  for p in "${TLS_PORTS[@]:-}"; do
    [ "$p" = "$port" ] && { printf 'https'; return; }
  done
  for p in "${HTTP_PORTS[@]:-}"; do
    [ "$p" = "$port" ] && { printf 'http'; return; }
  done
  case "$port" in
    443|8443|9443|10443|4443) printf 'https' ;;
    80|8080|8000|3000|5000|9000|9090) printf 'http' ;;
    *) printf 'tcp' ;;
  esac
}

normalize_endpoint() {
  local raw="$1" domain port
  case "$raw" in
    \[*\]:*)
      domain="${raw%%]:*}]"
      port="${raw##*:}"
      ;;
    *:*)
      domain="${raw%:*}"
      port="${raw##*:}"
      ;;
    *)
      die "endpoint '$raw' must be DOMAIN:PORT (or :PORT)"
      ;;
  esac
  [ -n "$port" ] || die "endpoint '$raw' has no port"
  port_is_number "$port" || die "endpoint '$raw' has an invalid port"
  [ -n "$domain" ] || domain="localhost"
  printf '%s:%s' "$domain" "$port"
}

build_endpoints() {
  local domain port ep port_list=() new_list=() seen=" "

  for port in "${TLS_PORTS[@]:-}" "${HTTP_PORTS[@]:-}"; do
    [ -n "$port" ] || continue
    port_is_number "$port" || die "invalid --tls-port/--http-port '$port'"
  done

  if [ "${#PORTS[@]}" -gt 0 ]; then
    for port in "${PORTS[@]}"; do
      port_is_number "$port" || die "invalid --port '$port'"
      port_list+=("$port")
    done
  elif [ "${#DOMAINS[@]}" -gt 0 ]; then
    port_list=(80 443)
  fi

  for ep in "${ENDPOINTS[@]}"; do
    ep="$(normalize_endpoint "$ep")"
    case "$seen" in
      *" $ep "*) ;;
      *) seen="$seen$ep "; new_list+=("$ep") ;;
    esac
  done

  if [ "${#DOMAINS[@]}" -gt 0 ] && [ "${#port_list[@]}" -gt 0 ]; then
    for domain in "${DOMAINS[@]}"; do
      [ -n "$domain" ] || die "empty --domain"
      for port in "${port_list[@]}"; do
        ep="$(normalize_endpoint "$domain:$port")"
        case "$seen" in
          *" $ep "*) ;;
          *) seen="$seen$ep "; new_list+=("$ep") ;;
        esac
      done
    done
  elif [ "${#DOMAINS[@]}" -eq 0 ] && [ "${#port_list[@]}" -gt 0 ]; then
    for port in "${port_list[@]}"; do
      ep="localhost:$port"
      case "$seen" in
        *" $ep "*) ;;
        *) seen="$seen$ep "; new_list+=("$ep") ;;
      esac
    done
  fi

  ENDPOINTS=("${new_list[@]}")
  if [ "${#ENDPOINTS[@]}" -eq 0 ]; then
    add_warning "No endpoints requested. Use --domain/--port or --endpoint; endpoint-specific checks are skipped."
  fi
}

endpoint_domain() { printf '%s' "${1%:*}"; }
endpoint_port() { printf '%s' "${1##*:}"; }

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------
docker_usable() {
  have docker || return 1
  $S docker info >/dev/null 2>&1
}

project_containers_tsv() {
  [ -n "$PROJECT" ] || return 0
  $S docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null
}

collect_docker() {
  section "DOCKER CONTAINERS / NETWORKS / VOLUMES"
  if ! have docker; then
    log "docker: NOT INSTALLED"
    add_warning "Docker is not installed; container checks are skipped."
    return 0
  fi
  if ! $S docker info >/dev/null 2>&1; then
    log "docker: installed but the daemon is not reachable with this user/sudo"
    add_warning "Docker daemon is not reachable; container checks are incomplete."
    return 0
  fi
  DOCKER_OK=true

  run '$S docker version --format "client={{.Client.Version}} server={{.Server.Version}}"'
  run '$S docker compose version'
  run 'docker context show 2>/dev/null || true'
  run '$S docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"'

  $S docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' \
    >"$CONTAINERS_TSV" 2>/dev/null || true
  chmod 600 "$CONTAINERS_TSV" 2>/dev/null || true

  section "DOCKER COMPOSE PROJECTS / NETWORKS / VOLUMES"
  run '$S docker compose ls -a'
  run '$S docker network ls'
  run '$S docker volume ls'

  section "DOCKER PROJECT FILTER: ${PROJECT:-<none>}"
  if [ -n "$PROJECT" ]; then
    run "$S docker ps -a --filter 'label=com.docker.compose.project=$PROJECT' --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'"
    local ids id
    ids="$($S docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)"
    if [ -z "$ids" ]; then
      log "No containers found for project '$PROJECT'."
      add_warning "No containers found for project '$PROJECT'; it may be stopped or use another project name."
    else
      log ""
      log "Project container detail (no environment values):"
      for id in $ids; do
        $S docker inspect --format \
          '{{.Name}}|image={{.Config.Image}}|state={{.State.Status}}|health={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|restart={{.RestartPolicy.Name}}|project={{index .Config.Labels "com.docker.compose.project"}}|service={{index .Config.Labels "com.docker.compose.service"}}|ports={{json .NetworkSettings.Ports}}|mounts={{json .Mounts}}' \
          "$id" 2>/dev/null | redact | tee -a "$REPORT"
      done
    fi
  else
    log "No --project supplied; project-filtered container detail skipped."
  fi
}

collect_compose() {
  section "COMPOSE FILE / SERVICE / PORT MAPPING"
  local detected=() f
  if [ -n "$COMPOSE_FILE" ]; then
    detected+=("$COMPOSE_FILE")
  else
    if [ -d "$REPO" ]; then
      while IFS= read -r f; do
        [ -n "$f" ] && detected+=("$f")
      done < <(find "$REPO" -maxdepth 2 -type f \
        \( -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' \
           -o -name 'compose*.yml' -o -name 'compose*.yaml' \) \
        -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | sort)
    fi
  fi

  if [ "${#detected[@]}" -eq 0 ]; then
    log "No compose file supplied or auto-detected under $REPO."
    return 0
  fi
  log "Compose candidates:"
  for f in "${detected[@]}"; do log "  - $f"; done

  if [ -z "$COMPOSE_FILE" ]; then
    COMPOSE_FILE="${detected[0]}"
    log "Using first detected compose file for the service/port summary: $COMPOSE_FILE"
  fi
  if [ ! -f "$COMPOSE_FILE" ]; then
    add_warning "Compose file not found: $COMPOSE_FILE"
    return 0
  fi
  if ! $S docker compose version >/dev/null 2>&1; then
    add_warning "docker compose is unavailable; service/port mapping skipped."
    return 0
  fi

  if [ -z "$ENV_FILE" ] && [ -f "$REPO/.env.prd" ]; then
    ENV_FILE="$REPO/.env.prd"
  fi
  if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
    add_warning "Env file not found: $ENV_FILE"
  fi

  local compose_args=(-f "$COMPOSE_FILE")
  [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && compose_args+=(--env-file "$ENV_FILE")

  run "$S docker compose ${compose_args[*]} config --services"
  run "$S docker compose ${compose_args[*]} config --images"
  run "$S docker compose ${compose_args[*]} config --volumes"

  local tmp="$OUTPUT_DIR/.compose-config.json"
  if $S docker compose "${compose_args[@]}" config --format json >"$tmp" 2>/dev/null; then
    chmod 600 "$tmp" 2>/dev/null || true
    if have python3; then
      python3 - "$tmp" >"$COMPOSE_TSV" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8', errors='replace') as fh:
    data = json.load(fh)
for name, svc in sorted((data.get('services') or {}).items()):
    ports = []
    for p in svc.get('ports') or []:
        if isinstance(p, dict):
            ports.append('%s->%s/%s' % (p.get('published', ''), p.get('target', ''), p.get('protocol', 'tcp')))
        else:
            ports.append(str(p))
    image = svc.get('image') or ('build:' + str(svc.get('build')))
    volumes = []
    for v in svc.get('volumes') or []:
        if isinstance(v, dict):
            volumes.append('%s:%s' % (v.get('source', ''), v.get('target', '')))
        else:
            volumes.append(str(v))
    networks = ','.join(sorted((svc.get('networks') or {}).keys()))
    print('\t'.join([name, image, ','.join(ports), ','.join(volumes), networks]))
PY
      chmod 600 "$COMPOSE_TSV" 2>/dev/null || true
      log ""
      log "SERVICE | IMAGE | PORTS | VOLUMES | NETWORKS"
      while IFS=$'\t' read -r name image ports volumes networks; do
        log "$name | $image | ${ports:--} | ${volumes:--} | ${networks:--}"
      done <"$COMPOSE_TSV"
    else
      add_warning "python3 is unavailable; compose port/volume detail is limited."
    fi
  else
    add_warning "Could not render compose config JSON for service/port detail."
  fi
  rm -f "$tmp"

  if [ -z "$PROJECT" ]; then
    local candidate=""
    candidate="$($S docker compose "${compose_args[@]}" config --format json 2>/dev/null | \
      python3 -c 'import json,sys; print((json.load(sys.stdin).get("name") or "").strip())' 2>/dev/null)"
    if [ -n "$candidate" ]; then
      PROJECT="$candidate"
      log "Detected compose project name: $PROJECT"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Host nginx
# ---------------------------------------------------------------------------
nginx_installed() { have nginx || [ -x /usr/sbin/nginx ]; }

parse_nginx_conf() {
  local full="$1" out="$2"
  python3 - "$full" >"$out" <<'PY'
import json, re, sys

path = sys.argv[1]
current_file = ""
in_server = False
depth = 0
srv = None
servers = []

def listen_ports(value):
    ports = []
    for token in value.split():
        token = token.strip(';').strip()
        if not token or token in ('ssl', 'http2', 'default_server', 'reuseport'):
            continue
        if token.startswith('ipv6only=') or token.startswith('so_keepalive='):
            continue
        if token.startswith('unix:'):
            continue
        if token.startswith('['):
            # [::]:443 or [::1]:8443
            if ']:' in token:
                candidate = token.rsplit(']:', 1)[1]
            else:
                candidate = '80'
        elif ':' in token:
            candidate = token.rsplit(':', 1)[1]
        else:
            candidate = token
        if candidate.isdigit() and 0 < int(candidate) <= 65535:
            ports.append(candidate)
    if not ports:
        ports = ['80']
    return sorted(set(ports), key=int)

def emit():
    global srv
    if srv is not None:
        srv['ports'] = sorted(set(srv.get('ports') or []), key=int) or ['80']
        servers.append(srv)
    srv = None

with open(path, encoding='utf-8', errors='replace') as fh:
    for raw in fh:
        marker = re.match(r'^# configuration file (.+):\s*$', raw.rstrip())
        if marker:
            current_file = marker.group(1)
            continue
        line = raw.split('#', 1)[0].strip()
        if not line:
            continue

        if not in_server:
            if re.match(r'^server\s*\{', line):
                srv = {
                    'file': current_file,
                    'listen': [],
                    'ports': [],
                    'server_name': [],
                    'ssl_certificate': '',
                    'proxy_pass': [],
                    'host_header': [],
                    'root': '',
                }
                in_server = True
                depth = line.count('{') - line.count('}')
                if depth <= 0:
                    emit()
                    in_server = False
            continue

        # We are inside a server block. Collect directives at any nesting level.
        for value in re.findall(r'\blisten\s+([^;]+);', line):
            srv['listen'].append(value.strip())
            srv['ports'].extend(listen_ports(value))
        for value in re.findall(r'\bserver_name\s+([^;]+);', line):
            srv['server_name'].extend(value.split())
        for value in re.findall(r'\bssl_certificate\s+([^;]+);', line):
            if not srv['ssl_certificate']:
                srv['ssl_certificate'] = value.strip()
        for value in re.findall(r'\bproxy_pass\s+([^;]+);', line):
            srv['proxy_pass'].append(value.strip())
        for value in re.findall(r'\bproxy_set_header\s+Host\s+([^;]+);', line):
            srv['host_header'].append(value.strip())
        for value in re.findall(r'\broot\s+([^;]+);', line):
            if not srv['root']:
                srv['root'] = value.strip()

        depth += line.count('{') - line.count('}')
        if depth <= 0:
            emit()
            in_server = False

if in_server:
    emit()

for s in servers:
    print('\t'.join([
        s.get('file', ''),
        ','.join(s.get('ports', [])),
        ' '.join(s.get('listen', [])),
        ' '.join(s.get('server_name', [])),
        ','.join(s.get('proxy_pass', [])),
        s.get('ssl_certificate', ''),
        ','.join(s.get('host_header', [])) or '-',
    ]))
PY
  chmod 600 "$out" 2>/dev/null || true
}

collect_nginx() {
  section "HOST NGINX (CONFIG, SERVER BLOCKS, UPSTREAMS)"
  if ! nginx_installed; then
    log "nginx: NOT INSTALLED"
    return 0
  fi
  NGINX_OK=true
  run 'command -v nginx; nginx -v'
  run '$S systemctl is-active nginx 2>/dev/null || true; pgrep -a nginx 2>/dev/null || true'

  if $S nginx -T >"$NGINX_FULL" 2>"$NGINX_ERR"; then
    log "Captured full nginx config: $NGINX_FULL"
  else
    log "nginx -T failed (TLS key permissions are a common cause without root); stderr:"
    redact <"$NGINX_ERR" | tee -a "$REPORT"
    if [ ! -s "$NGINX_FULL" ]; then
      log "Building a read-only fallback config dump from enabled nginx files..."
      {
        for f in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
          [ -f "$f" ] || continue
          printf '# configuration file %s:\n' "$f"
          $S cat "$f" 2>/dev/null || cat "$f" 2>/dev/null
          printf '\n'
        done
      } >"$NGINX_FULL"
    fi
    if [ -s "$NGINX_FULL" ]; then
      log "nginx config fallback captured: $NGINX_FULL"
    else
      add_warning "nginx -T failed and no fallback config files were readable; server-block discovery is incomplete."
    fi
  fi
  chmod 600 "$NGINX_FULL" "$NGINX_ERR" 2>/dev/null || true

  run '$S ls -la /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null'
  run '$S grep -R "^[[:space:]]*include" /etc/nginx/nginx.conf /etc/nginx/conf.d /etc/nginx/sites-enabled 2>/dev/null | head -40'

  if have python3 && [ -s "$NGINX_FULL" ]; then
    parse_nginx_conf "$NGINX_FULL" "$NGINX_SERVERS_TSV"
    log ""
    log "NGINX SERVER BLOCKS"
    log "FILE | LISTEN_PORTS | LISTEN | SERVER_NAMES | PROXY_PASS | SSL_CERTIFICATE | HOST_HEADER"
    while IFS=$'\t' read -r file ports listens names proxy cert hosthdr; do
      log "$file | $ports | $listens | $names | $proxy | ${cert:--} | ${hosthdr:--}"
    done <"$NGINX_SERVERS_TSV"
    log ""
    log "Server-block count: $(wc -l <"$NGINX_SERVERS_TSV" | tr -d ' ')"
  else
    add_warning "python3 is unavailable or nginx config capture is empty; nginx server blocks were not parsed."
    run '$S grep -rhE "^\s*(server_name|listen|root|proxy_pass|ssl_certificate)\b" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null'
  fi
}

# Match a domain/port against the parsed nginx server blocks.
nginx_for_endpoint() {
  local domain="$1" port="$2"
  [ -s "$NGINX_SERVERS_TSV" ] || return 0
  awk -F'\t' -v d="$domain" -v p="$port" '
    function hostmatch(name) {
      if (name == "" || name == "_") return 1
      if (name == d) return 1
      if (substr(name, 1, 2) == "*.") {
        suffix = substr(name, 2)
        if (length(d) > length(suffix) && substr(d, length(d) - length(suffix) + 1) == suffix) return 1
      }
      return 0
    }
    {
      n = split($2, ports, ",")
      portmatch = 0
      for (i = 1; i <= n; i++) if (ports[i] == p) portmatch = 1
      if (!portmatch) next
      m = split($4, names, " ")
      for (j = 1; j <= m; j++) {
        if (hostmatch(names[j])) {
          print $1 " | listen=" $3 " | names=" $4 " | proxy=" $5 " | cert=" $6 " | host_header=" $7
          next
        }
      }
    }
  ' "$NGINX_SERVERS_TSV"
}

# ---------------------------------------------------------------------------
# Reverse proxies
# ---------------------------------------------------------------------------
collect_proxies() {
  section "REVERSE PROXIES / EDGE PROCESSES"
  local software path listeners
  : >"$PROXIES_TXT"
  for software in nginx caddy traefik haproxy apache2 httpd envoy; do
    path="$(command -v "$software" 2>/dev/null || true)"
    if [ -z "$path" ]; then
      printf '%s\tnot-installed\t-\t-\n' "$software" >>"$PROXIES_TXT"
      continue
    fi
    local version=""
    case "$software" in
      nginx) version="$(nginx -v 2>&1 | head -1)" ;;
      caddy) version="$(caddy version 2>/dev/null | head -1)" ;;
      traefik) version="$(traefik version 2>/dev/null | head -1)" ;;
      haproxy) version="$(haproxy -v 2>/dev/null | head -1)" ;;
      apache2|httpd) version="$($software -v 2>&1 | head -1)" ;;
      envoy) version="$(envoy --version 2>/dev/null | head -1)" ;;
    esac
    local svc="unknown"
    svc="$($S systemctl is-active "$software" 2>/dev/null || true)"
    svc="$(printf '%s\n' "$svc" | head -1)"
    [ -n "$svc" ] || svc="unknown"
    printf '%s\t%s\t%s\t%s\n' "$software" "$path" "${version:--}" "$svc" >>"$PROXIES_TXT"
  done

  log "SOFTWARE | PATH | VERSION | SYSTEMD"
  while IFS=$'\t' read -r software path version svc; do
    log "$software | $path | $version | $svc"
  done <"$PROXIES_TXT"

  log ""
  log "Proxy processes:"
  run 'for p in nginx caddy traefik haproxy apache2 httpd envoy; do pgrep -a -x "$p" 2>/dev/null; done'

  log ""
  log "Proxy listeners on 80/443 and requested ports:"
  local port_re="80 443" p
  for p in "${PORTS[@]:-}"; do
    [ -n "$p" ] && port_re="$port_re $p"
  done
  for p in "${ENDPOINTS[@]:-}"; do
    [ -n "$p" ] && port_re="$port_re $(endpoint_port "$p")"
  done
  port_re="$(printf '%s\n' $port_re | sort -un | paste -sd '|' -)"
  run "$S ss -tulpn | grep -E ':(${port_re})\\b' | head -60"

  log ""
  log "Caddy configuration (host and repo):"
  run 'for f in /etc/caddy/Caddyfile /etc/caddy/*.caddyfile /var/snap/caddy/current/etc/Caddyfile "$REPO/Caddyfile" "$REPO/docker/caddy/Caddyfile"; do [ -f "$f" ] && { echo "== $f"; grep -nE "^[^#[:space:]].*\{|reverse_proxy|tls |import " "$f" | head -40; }; done'

  log ""
  log "Traefik / HAProxy / Apache configuration paths:"
  run 'for f in /etc/traefik/traefik.yml /etc/traefik/traefik.yaml /etc/traefik/traefik.toml /etc/haproxy/haproxy.cfg /etc/apache2/apache2.conf /etc/httpd/conf/httpd.conf; do [ -f "$f" ] && { echo "== $f"; grep -nE "entryPoints|routers|frontend|backend|bind|server |VirtualHost|ServerName|ProxyPass" "$f" | head -30; }; done'

  log ""
  log "Docker reverse-proxy containers:"
  if $S docker info >/dev/null 2>&1; then
    $S docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null | \
      grep -Ei 'caddy|traefik|nginx|haproxy|envoy|edge|proxy' | head -30 | redact | tee -a "$REPORT"
  else
    log "docker not reachable"
  fi

  log ""
  log "Project reverse-proxy config files:"
  if [ -d "$REPO" ]; then
    run "find '$REPO' -maxdepth 3 -type f \\( -iname 'Caddyfile*' -o -iname 'nginx*.conf' -o -iname 'traefik*.y*ml' -o -iname 'haproxy.cfg' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -20"
  fi
}

# ---------------------------------------------------------------------------
# Endpoint probes
# ---------------------------------------------------------------------------
local_listener() {
  local port="$1"
  if have ss; then
    $S ss -H -ltn "sport = :$port" 2>/dev/null | head -3
  elif have lsof; then
    $S lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -3
  fi
}

docker_for_port() {
  local port="$1"
  if ! docker_usable; then return 0; fi
  $S docker ps --filter "publish=$port" --format '{{.Names}} ({{.Image}})' 2>/dev/null | paste -sd ', ' -
}

http_probe() {
  local url="$1"; shift
  curl -k -sS --max-time 8 -o /dev/null \
    -w 'status=%{http_code} remote=%{remote_ip} time=%{time_total}s redirect=%{redirect_url} type=%{content_type}' \
    "$@" "$url" 2>/dev/null || printf 'status=000 unreachable'
}

http_headers() {
  local url="$1"; shift
  curl -k -sS --max-time 8 -D - -o /dev/null "$@" "$url" 2>/dev/null | \
    grep -iE '^(HTTP/|server:|location:|content-type:|strict-transport-security:|x-frame-options:|x-content-type-options:)' | \
    head -12 | redact
}

tls_probe() {
  local domain="$1" port="$2" label="$3" connect="$4" chain cert
  chain="$TLS_DIR/${label}.chain.pem"
  cert="$TLS_DIR/${label}.cert.pem"
  rm -f "$chain" "$cert"
  timeout 10 openssl s_client -connect "$connect:$port" -servername "$domain" \
    -showcerts </dev/null >"$chain" 2>/dev/null || true
  awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' "$chain" >"$cert" 2>/dev/null || true
  if [ ! -s "$cert" ]; then
    printf 'no certificate (connection/SNI failed)'
    return 1
  fi
  local subject issuer dates sans checkhost expired
  subject="$(openssl x509 -in "$cert" -noout -subject 2>/dev/null | sed 's/^subject=//')"
  issuer="$(openssl x509 -in "$cert" -noout -issuer 2>/dev/null | sed 's/^issuer=//')"
  dates="$(openssl x509 -in "$cert" -noout -dates 2>/dev/null | tr '\n' ' ')"
  sans="$(openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr '\n' ' ' | tr -s ' ')"
  local raw_check hostcheck
  raw_check="$(openssl x509 -in "$cert" -noout -checkhost "$domain" 2>/dev/null | head -1)"
  if printf '%s' "$raw_check" | grep -qi 'does match'; then
    hostcheck="OK"
  elif printf '%s' "$raw_check" | grep -qi 'does NOT match'; then
    hostcheck="FAIL"
  else
    hostcheck="unknown"
  fi
  if openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1; then
    expired="not-expired"
  else
    expired="EXPIRED"
  fi
  printf 'subject=%s | issuer=%s | %s | host=%s | %s | SAN=%s' \
    "$subject" "$issuer" "${dates:-dates?}" "$hostcheck" "$expired" "${sans:-n/a}"
}

collect_endpoints() {
  section "ENDPOINT PROBES (DOMAINS / PORTS / TLS / HTTP)"
  if [ "${#ENDPOINTS[@]}" -eq 0 ]; then
    log "No endpoints to probe."
    return 0
  fi

  if [ "$NO_NETWORK" = false ]; then
    PUBLIC_IPV4="$(curl -4 -s --max-time 5 https://icanhazip.com 2>/dev/null | tr -d '[:space:]')"
    if [ -z "$PUBLIC_IPV4" ]; then
      PUBLIC_IPV4="$(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null | tr -d '[:space:]')"
    fi
  fi

  printf 'DOMAIN\tPORT\tPROTO\tLOCAL_LISTENER\tDOCKER\tNGINX\tDNS\tHTTP_LOCAL\tTLS_LOCAL\n' >"$ENDPOINT_TSV"
  chmod 600 "$ENDPOINT_TSV" 2>/dev/null || true

  local ep domain port proto listener docker_map nginx_map dns http_local tls_local
  local label connect a aaaa cname host_ips dns_note
  for ep in "${ENDPOINTS[@]}"; do
    domain="$(endpoint_domain "$ep")"
    port="$(endpoint_port "$ep")"
    proto="$(endpoint_proto "$port")"
    label="$(sanitize_name "${domain}_${port}")"
    connect="127.0.0.1"

    log ""
    log "--- ${domain}:${port} (${proto}) ---"

    listener="$(local_listener "$port" | paste -sd ';' -)"
    if [ -n "$listener" ]; then
      log "local listener:"
      printf '%s\n' "$listener" | redact | tee -a "$REPORT"
    else
      log "local listener: NONE on 127.0.0.1:${port} (or ss unavailable)"
      add_warning "No local TCP listener found on port ${port} for endpoint ${domain}:${port}."
    fi

    docker_map="$(docker_for_port "$port")"
    log "docker mapping: ${docker_map:--}"
    nginx_map="$(nginx_for_endpoint "$domain" "$port" | paste -sd ';' -)"
    if [ -n "$nginx_map" ]; then
      log "nginx mapping:"
      printf '%s\n' "$nginx_map" | tee -a "$REPORT"
    else
      log "nginx mapping: -"
      if [ "$NGINX_OK" = true ] && [ -z "$docker_map" ]; then
        add_warning "No nginx server block matched ${domain}:${port}."
      fi
    fi

    # A non-standard port is often a Docker/Caddy edge. If host nginx does
    # proxy it and sets Host to $host, SigV4 clients that sign :port will fail.
    if [ -n "$nginx_map" ]; then
      case "$port" in
        80|443) ;;
        *)
          case "$nginx_map" in
            *'host_header=$host'*)
              add_warning "Nginx at ${domain}:${port} sets 'Host \$host' (port dropped); SigV4 clients signing :${port} would fail. Use \$http_host."
              ;;
          esac
          ;;
      esac
    fi

    dns=""
    if [ "$NO_NETWORK" = true ]; then
      dns="network probes disabled"
      log "dns: network probes disabled"
    elif [ "$domain" = "localhost" ]; then
      dns="localhost"
      log "dns: localhost"
    else
      a="$(dig +short A "$domain" 2>/dev/null | paste -sd, -)"
      aaaa="$(dig +short AAAA "$domain" 2>/dev/null | paste -sd, -)"
      cname="$(dig +short CNAME "$domain" 2>/dev/null | paste -sd, -)"
      host_ips="$(hostname -I 2>/dev/null) 127.0.0.1 ::1 ${PUBLIC_IPV4:-}"
      dns="A=${a:-none} AAAA=${aaaa:-none} CNAME=${cname:-none}"
      if [ -z "$a$aaaa" ]; then
        add_warning "DNS has no A/AAAA record for ${domain}."
      else
        dns_note=""
        for ip in $(printf '%s\n' "$a" | tr ',' ' ') $(printf '%s\n' "$aaaa" | tr ',' ' '); do
          case " $host_ips " in *" $ip "*) dns_note="points-to-this-host";; esac
        done
        [ -n "$dns_note" ] || dns_note="does-not-match-host-interfaces"
        dns="$dns $dns_note"
        [ "$dns_note" = "does-not-match-host-interfaces" ] && \
          add_warning "DNS for ${domain} does not resolve to one of this host's interface/public IPs; verify the record or the edge."
      fi
      log "dns: $dns"
    fi

    http_local=""
    tls_local=""
    if [ "$NO_NETWORK" = true ]; then
      http_local="network probes disabled"
    elif [ "$proto" = "tcp" ]; then
      http_local="tcp-only (no HTTP probe)"
      tls_local="-"
      log "http local: skipped (tcp-only port)"
      log "tls local: skipped (tcp-only port)"
    elif [ -n "$listener" ]; then
      if [ "$proto" = "https" ]; then
        http_local="$(http_probe "https://${domain}:${port}/" --resolve "${domain}:${port}:127.0.0.1")"
        log "http local (${domain}:${port} -> 127.0.0.1): $http_local"
        log "headers:"
        http_headers "https://${domain}:${port}/" --resolve "${domain}:${port}:127.0.0.1" | tee -a "$REPORT"
      else
        http_local="$(http_probe "http://127.0.0.1:${port}/" -H "Host: ${domain}")"
        log "http local (Host: ${domain} -> 127.0.0.1:${port}): $http_local"
        log "headers:"
        http_headers "http://127.0.0.1:${port}/" -H "Host: ${domain}" | tee -a "$REPORT"
      fi
    else
      http_local="no local listener"
      log "http local: no local listener"
    fi

    if [ "$NO_NETWORK" = true ]; then
      tls_local="network probes disabled"
    elif [ "$proto" = "https" ] && [ -n "$listener" ]; then
      tls_local="$(tls_probe "$domain" "$port" "$label" "$connect")"
      log "tls local: $tls_local"
      case "$tls_local" in
        *"host=FAIL"*) add_warning "TLS certificate on ${domain}:${port} does not match the requested hostname." ;;
        *EXPIRED*) add_warning "TLS certificate on ${domain}:${port} is expired." ;;
        *"no certificate"*) add_warning "Could not obtain a TLS certificate from 127.0.0.1:${port} for SNI ${domain}." ;;
      esac
    elif [ "$proto" = "https" ]; then
      tls_local="no local listener"
      log "tls local: no local listener"
    else
      tls_local="-"
      log "tls local: not a TLS port (${proto})"
    fi

    case "$http_local" in
      *status=000*|*unreachable*) add_warning "Local HTTP probe for ${domain}:${port} failed: ${http_local}" ;;
      *status=5*) add_warning "Local HTTP probe for ${domain}:${port} returned a 5xx: ${http_local}" ;;
    esac

    if [ "$NO_NETWORK" = false ] && [ "$domain" != "localhost" ] && [ "$proto" != "tcp" ] && [ -n "$a$aaaa" ]; then
      log "http public (DNS): $(http_probe "${proto}://${domain}:${port}/")"
      log "tls public (DNS): $(tls_probe "$domain" "$port" "${label}-public" "$domain")"
    fi

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$domain" "$port" "$proto" "${listener:-none}" "${docker_map:--}" "${nginx_map:--}" "${dns:--}" "${http_local:--}" "${tls_local:--}" \
      >>"$ENDPOINT_TSV"
  done
}

collect_ports() {
  section "PORT ANALYSIS (REQUESTED PORTS)"
  local port listener docker_map nginx_map
  printf 'PORT\tLOCAL_LISTEN\tDOCKER\tNGINX\n' >"$PORTS_TSV"
  for port in $(printf '%s\n' "${ENDPOINTS[@]}" | awk -F: '{print $NF}' | sort -u); do
    [ -n "$port" ] || continue
    listener="$(local_listener "$port" | paste -sd ';' -)"
    docker_map="$(docker_for_port "$port")"
    nginx_map="$(awk -F'\t' -v p="$port" 'index("," $2 ",", "," p ",") {print $1 "|" $3 "|" $4 "|" $5}' "$NGINX_SERVERS_TSV" 2>/dev/null | paste -sd ';' -)"
    log ""
    log "port ${port}:"
    log "  local:  ${listener:-NONE}"
    log "  docker: ${docker_map:--}"
    log "  nginx:  ${nginx_map:--}"
    [ -z "$listener" ] && add_warning "Requested port ${port} has no local TCP listener."
    printf '%s\t%s\t%s\t%s\n' "$port" "${listener:-none}" "${docker_map:--}" "${nginx_map:--}" >>"$PORTS_TSV"
  done

  log ""
  log "All listeners (first ${MAX_LINES} lines):"
  run '$S ss -tulpn | head -"$MAX_LINES"'
  log ""
  log "Firewall rules mentioning requested ports:"
  local p
  for p in $(printf '%s\n' "${ENDPOINTS[@]}" | awk -F: '{print $NF}' | sort -u); do
    run "$S ufw status 2>/dev/null | grep -E '(^|[[:space:]])$p(/tcp|/udp)?([[:space:]]|$)' | head -5; $S iptables -S 2>/dev/null | grep -E 'dport $p([[:space:]]|$)' | head -5"
  done
}

# ---------------------------------------------------------------------------
# Host inventory (generic; commands are read-only)
# ---------------------------------------------------------------------------
collect_host() {
  section "ACCESS / SSH / USERS"
  run 'whoami; id'
  run 'echo "SSH_CONNECTION=${SSH_CONNECTION:-}"; who; last -n 10 -a'
  run '$S sudo -n -l 2>/dev/null || true'
  run '$S grep -rE "^[^#]*NOPASSWD" /etc/sudoers /etc/sudoers.d 2>/dev/null || true'
  run '$S sshd -T 2>/dev/null | grep -E "^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|allowusers|allowgroups|maxauthtries|listenaddress|usepam) "'
  run 'grep -vE "(nologin|false)$" /etc/passwd | cut -d: -f1,3,6,7'
  run 'getent group sudo docker www-data 2>/dev/null || true'
  run 'for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do [ -f "$f" ] && echo "$f: $($S grep -c . "$f") key(s)"; done'
  run '$S grep -E "^[^:]+::" /etc/shadow 2>/dev/null | cut -d: -f1 || true'

  section "SYSTEM / RESOURCES"
  run 'lsb_release -a 2>/dev/null; head -5 /etc/os-release; uname -a; dpkg --print-architecture 2>/dev/null'
  run 'hostnamectl 2>/dev/null || true; timedatectl 2>/dev/null || true'
  run 'uptime; systemd-detect-virt 2>/dev/null || true'
  run 'nproc; lscpu | grep -E "Model name|^CPU\\(s\\)|Thread|Core"'
  run 'free -h; swapon --show'
  run 'df -hT -x tmpfs -x devtmpfs -x squashfs'
  run 'lsblk -f'
  run 'systemctl is-enabled unattended-upgrades 2>/dev/null; systemctl is-active unattended-upgrades 2>/dev/null; cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null'
  run 'ls /var/run/reboot-required 2>/dev/null; echo "upgradable packages: $(apt list --upgradable 2>/dev/null | tail -n +2 | wc -l)"'

  section "NETWORK / FIREWALL"
  run 'ip -br addr; echo; ip route'
  run 'resolvectl status 2>/dev/null | head -20'
  if [ "$NO_NETWORK" = false ]; then
    run 'echo "public IPv4: $(curl -4 -s --max-time 5 https://icanhazip.com 2>/dev/null | tr -d "[:space:]")"; echo "public IPv6: $(curl -6 -s --max-time 5 https://icanhazip.com 2>/dev/null | tr -d "[:space:]")"'

    run 'curl -s --max-time 2 http://169.254.169.254/ 2>/dev/null | head -5'
  else
    log "public IP / cloud metadata: skipped (--no-network)"
  fi
  run '$S ss -tulpn'
  run '$S ufw status verbose 2>/dev/null || true'
  run '$S nft list ruleset 2>/dev/null | head -60 || true'
  run '$S iptables -S 2>/dev/null | head -50 || true'

  section "DNS / TLS TOOLING (HOST)"
  run 'command -v dig; command -v getent; command -v openssl; openssl version'
  run 'command -v certbot && certbot --version; command -v acme.sh; systemctl list-timers --all --no-pager 2>/dev/null | grep -iE "certbot|acme" || true'
  run '$S certbot certificates 2>/dev/null || true'
  run '$S ls -la /etc/letsencrypt /etc/letsencrypt/live /etc/letsencrypt/renewal 2>/dev/null || true'
  if [ "$NO_NETWORK" = false ]; then
    run 'for d in '"${DOMAINS[*]:-}"'; do [ -z "$d" ] && continue; echo "== $d"; for t in A AAAA CNAME CAA NS MX; do echo "  $t: $(dig +short "$d" "$t" 2>/dev/null | paste -sd, -)"; done; done'
  else
    log "DNS records: skipped (--no-network)"
  fi

  section "SOFTWARE / RUNTIME"
  run 'for c in node npm yarn pnpm pm2 python3 pip3 php composer java go ruby bundle git make gcc psql mysql redis-server mongod supervisord; do p=$(command -v "$c") && echo "$c -> $p" || echo "$c -> not found"; done'
  run 'nginx -v 2>&1; node -v 2>/dev/null; npm -v 2>/dev/null; python3 -V 2>/dev/null; php -v 2>/dev/null | head -1; java -version 2>&1 | head -1; go version 2>/dev/null; git --version; docker --version 2>/dev/null; docker compose version 2>/dev/null'
  run 'dpkg -l 2>/dev/null | grep -E "^ii +(nginx|apache2|caddy|haproxy|certbot|docker|containerd|php|nodejs|postgresql|mysql|mariadb|redis|mongodb|supervisor)" | cut -c1-110'
  run 'systemctl list-units --type=service --state=running --no-pager | head -40'
  run 'systemctl list-timers --no-pager | head -30'

  section "LOGS / BACKUPS / MONITORING / HARDENING"
  run 'ls /etc/logrotate.d 2>/dev/null | head -40; du -sh /var/log 2>/dev/null; journalctl --disk-usage 2>/dev/null'
  run 'for c in restic borg rclone duplicity rsnapshot; do command -v $c >/dev/null && echo "$c installed"; done; echo "(no output above = no backup tool found)"'
  run 'systemctl list-units --no-pager 2>/dev/null | grep -iE "netdata|datadog|prometheus|node_exporter|zabbix|newrelic|cloudwatch|telegraf|grafana|monit|uptime" | head -20'
  run 'dpkg -l 2>/dev/null | grep -iE "postfix|exim|msmtp|sendmail" | cut -c1-100'
  run 'systemctl is-active fail2ban ufw apparmor 2>/dev/null; aa-status 2>/dev/null | head -5'
  run '$S fail2ban-client status 2>/dev/null || true'
}

collect_repo() {
  section "PROJECT / REPOSITORY: $REPO"
  if [ ! -d "$REPO" ]; then
    log "Repository path is not a directory: $REPO"
    add_warning "Repository path does not exist: $REPO"
    return 0
  fi
  run 'stat -c "%U:%G  %a  %n" "$REPO"; ls -la "$REPO" | head -40'
  run 'du -sh "$REPO" 2>/dev/null; df -h "$REPO" 2>/dev/null | tail -1'
  run 'G="git -c safe.directory=$REPO -C $REPO"; $S $G remote -v 2>/dev/null; $S $G branch --show-current 2>/dev/null; $S $G log -3 --format="%h %an %ad %s" --date=short 2>/dev/null; $S $G status --short 2>/dev/null | head -20'

  log ""
  log "Stack / deployment files:"
  run 'cd "$REPO" && $S ls -1d package.json package-lock.json yarn.lock pnpm-lock.yaml requirements.txt pyproject.toml Pipfile manage.py composer.json artisan Gemfile go.mod pom.xml build.gradle Cargo.toml Dockerfile* docker-compose*.yml docker-compose*.yaml compose*.yml compose*.yaml Makefile Procfile ecosystem.config.js .nvmrc .python-version .tool-versions .github README* 2>/dev/null'

  log ""
  log "Compose files:"
  if [ -d "$REPO" ]; then
    find "$REPO" -maxdepth 2 -type f \( -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' -o -name 'compose*.yml' -o -name 'compose*.yaml' \) \
      -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | sort | tee -a "$REPORT"
  fi

  log ""
  log "Env/key files (permissions only; NO values):"
  run '$S find "$REPO" -maxdepth 3 \( -name ".env*" -o -name "*.pem" -o -name "*.key" -o -name "*.crt" -o -name "id_*" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -exec ls -l {} \; 2>/dev/null | head -40'

  log ""
  log "Env variable NAMES only:"
  if [ -d "$REPO" ]; then
    for f in $(find "$REPO" -maxdepth 2 -name ".env*" -type f -not -path '*/node_modules/*' 2>/dev/null | sort); do
      log "== $f"
      grep -vE '^\s*(#|$)' "$f" 2>/dev/null | cut -d= -f1 | sed 's/[[:space:]]*$//' | sort -u | tee -a "$REPORT"
    done
  fi

  log ""
  log "Project-specific configuration:"
  log "name:     $NAME"
  log "compose:  ${COMPOSE_FILE:-<not set>}"
  log "env file: ${ENV_FILE:-<not set>}"
  log "project:  ${PROJECT:-<not set>}"

  if [ -s "$COMPOSE_TSV" ]; then
    log ""
    log "Compose services (from config; no env values):"
    cat "$COMPOSE_TSV" | tee -a "$REPORT"
  fi
}

collect_project_endpoint_map() {
  section "PROJECT ENDPOINT / SERVICE CORRELATION"
  if [ ! -s "$COMPOSE_TSV" ]; then
    log "No compose service data. Provide --compose and optionally --env-file."
    return 0
  fi
  local port ep domain
  for ep in "${ENDPOINTS[@]}"; do
    domain="$(endpoint_domain "$ep")"
    port="$(endpoint_port "$ep")"
    log ""
    log "endpoint ${domain}:${port}"
    awk -F'\t' -v p="$port" '
      {
        n = split($3, ports, ",")
        for (i = 1; i <= n; i++) {
          if (ports[i] ~ ("^" p "->") || ports[i] ~ ("^" p "/") || ports[i] == p) {
            print "  service " $1 " | image " $2 " | ports " $3
          }
        }
      }
    ' "$COMPOSE_TSV" | head -20 | tee -a "$REPORT"
  done
}

# ---------------------------------------------------------------------------
# Markdown runbook
# ---------------------------------------------------------------------------
md_escape() { printf '%s' "$1" | sed 's/|/\\|/g; s/\t/ /g'; }

write_runbook() {
  local endpoint_rows containers nginx_rows compose_rows warnings
  {
    printf '# Deployment Discovery — %s\n\n' "$NAME"
    printf -- '- Generated: `%s`\n' "$(date -Is)"
    printf -- '- Host: `%s` (`%s`)\n' "$HOST_FQDN" "$HOST_SHORT"
    printf -- '- Repository: `%s`\n' "$REPO"
    printf -- '- Compose: `%s`\n' "${COMPOSE_FILE:-not set}"
    printf -- '- Env file: `%s`\n' "${ENV_FILE:-not set}"
    printf -- '- Project: `%s`\n' "${PROJECT:-not set}"
    printf -- '- Raw report: `deploy-report.txt`\n\n'

    printf '## Requested endpoints\n\n'
    printf '| Domain | Port | Proto | Local listener | Docker | Nginx | DNS | HTTP (local) | TLS (local) |\n'
    printf '|---|---:|---|---|---|---|---|---|---|\n'
    if [ -s "$ENDPOINT_TSV" ]; then
      while IFS=$'\t' read -r d p proto listener docker nginx dns http tls; do
        [ "$d" = "DOMAIN" ] && continue
        printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
          "$(md_escape "$d")" "$p" "$proto" "$(md_escape "$listener")" "$(md_escape "$docker")" \
          "$(md_escape "$nginx")" "$(md_escape "$dns")" "$(md_escape "$http")" "$(md_escape "$tls")"
      done <"$ENDPOINT_TSV"
    else
      printf '| _none_ | - | - | - | - | - | - | - | - |\n'
    fi

    printf '\n## Docker containers\n\n'
    printf '| Name | Image | Ports | Status |\n|---|---|---|---|\n'
    if [ -s "$CONTAINERS_TSV" ]; then
      head -40 "$CONTAINERS_TSV" | while IFS=$'\t' read -r n i p s; do
        printf '| %s | %s | %s | %s |\n' "$(md_escape "$n")" "$(md_escape "$i")" "$(md_escape "$p")" "$(md_escape "$s")"
      done
    else
      printf '| _no containers / Docker unavailable_ | - | - | - |\n'
    fi

    printf '\n## Host nginx server blocks\n\n'
    printf '| File | Ports | Listen | Server names | Proxy pass | Certificate | Host header |\n|---|---|---|---|---|---|---|\n'
    if [ -s "$NGINX_SERVERS_TSV" ]; then
      head -40 "$NGINX_SERVERS_TSV" | while IFS=$'\t' read -r f ports listen n p c h; do
        printf '| %s | %s | %s | %s | %s | %s | %s |\n' "$(md_escape "$f")" "$ports" "$(md_escape "$listen")" "$(md_escape "$n")" "$(md_escape "$p")" "$(md_escape "$c")" "$(md_escape "$h")"
      done
    else
      printf '| _nginx not installed / no server blocks parsed_ | - | - | - | - | - | - |\n'
    fi

    printf '\n## Compose services\n\n'
    printf '| Service | Image | Ports | Volumes | Networks |\n|---|---|---|---|---|\n'
    if [ -s "$COMPOSE_TSV" ]; then
      while IFS=$'\t' read -r n i p v net; do
        printf '| %s | %s | %s | %s | %s |\n' "$(md_escape "$n")" "$(md_escape "$i")" "$(md_escape "$p")" "$(md_escape "$v")" "$(md_escape "$net")"
      done <"$COMPOSE_TSV"
    else
      printf '| _no compose data_ | - | - | - | - |\n'
    fi

    printf '\n## Requested ports\n\n'
    printf '| Port | Local listener | Docker | Nginx |\n|---:|---|---|---|\n'
    if [ -s "$PORTS_TSV" ]; then
      while IFS=$'\t' read -r p l d n; do
        [ "$p" = "PORT" ] && continue
        printf '| %s | %s | %s | %s |\n' "$p" "$(md_escape "$l")" "$(md_escape "$d")" "$(md_escape "$n")"
      done <"$PORTS_TSV"
    else
      printf '| _none_ | - | - | - |\n'
    fi

    printf '\n## Reverse proxy software\n\n'
    printf '| Software | Path | Version | Systemd |\n|---|---|---|---|\n'
    if [ -s "$PROXIES_TXT" ]; then
      while IFS=$'\t' read -r sw path ver svc; do
        [ -n "$sw" ] || continue
        printf '| %s | %s | %s | %s |\n' "$(md_escape "$sw")" "$(md_escape "$path")" "$(md_escape "$ver")" "$(md_escape "$svc")"
      done <"$PROXIES_TXT"
    else
      printf '| _none detected_ | - | - | - |\n'
    fi

    printf '\n## Warnings / gaps\n\n'
    if [ -s "$WARNINGS_FILE" ]; then
      while IFS= read -r w; do printf -- '- %s\n' "$(md_escape "$w")"; done <"$WARNINGS_FILE"
    else
      printf -- '- No blocking gaps detected by the heuristics.\n'
    fi

    printf '\n## Runbook checklist\n\n'
    printf -- '- [ ] DNS A/AAAA for each domain points to this host (or its load balancer).\n'
    printf -- '- [ ] Only the intended public ports are open in the host firewall/security group.\n'
    printf -- '- [ ] TLS certificate covers every requested domain and is not expired.\n'
    printf -- '- [ ] Host nginx / reverse proxy routes each Host:port to the correct upstream.\n'
    printf -- '- [ ] For SigV4/Host-sensitive apps, the proxy preserves the exact Host header and path.\n'
    printf -- '- [ ] Docker published ports and Compose service ports match the endpoint map.\n'
    printf -- '- [ ] The expected Compose project/services are running.\n'
    printf -- '- [ ] Backups include all stateful volumes and any host-managed TLS material.\n'
    printf -- '- [ ] Health/readiness endpoints are reachable through the public edge.\n'
    printf -- '- [ ] Rollback/stop commands and log locations are documented.\n'
  } >"$RUNBOOK"
  chmod 600 "$RUNBOOK" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  build_endpoints

  log "Deployment discovery report"
  log "Generated : $(date -Is)"
  log "Name      : $NAME"
  log "Host      : $HOST_FQDN ($HOST_SHORT)"
  log "Repo      : $REPO"
  log "Compose   : ${COMPOSE_FILE:-<not set>}"
  log "Env file  : ${ENV_FILE:-<not set>}"
  log "Project   : ${PROJECT:-<not set>}"
  log "Domains   : ${DOMAINS[*]:-<none>}"
  log "Ports     : ${PORTS[*]:-<default per domains>}"
  log "Endpoints : ${ENDPOINTS[*]:-<none>}"
  log "Mode      : $([ "$NO_NETWORK" = true ] && printf 'no network probes' || printf 'network probes enabled')"
  log "Run as    : $(whoami) (sudo prefix: '${S:-none}')"

  collect_docker
  collect_compose
  # Recompute PROJECT if compose discovery found it, then collect project detail.
  if [ -n "$PROJECT" ] && [ "$DOCKER_OK" = true ]; then
    section "DOCKER PROJECT DETAIL (POST-COMPOSE)"
    $S docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
      --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null | \
      tee -a "$REPORT"
  fi
  collect_nginx
  collect_proxies
  collect_endpoints
  collect_ports
  collect_host
  collect_repo
  collect_project_endpoint_map

  section "WARNINGS / GAPS"
  if [ -s "$WARNINGS_FILE" ]; then
    cat "$WARNINGS_FILE" | tee -a "$REPORT"
  else
    log "No warnings."
  fi

  if [ "$FORMAT" = "markdown" ] || [ "$FORMAT" = "both" ]; then
    write_runbook
  fi
  rm -rf "$TLS_DIR" 2>/dev/null || true

  log ""
  log "########## DONE ##########"
  log "Raw report : $REPORT"
  [ -f "$RUNBOOK" ] && log "Runbook    : $RUNBOOK"
  log "Warnings   : $WARNINGS_FILE"
  log "Review before sharing; values are redacted, but validate manually."
}

main

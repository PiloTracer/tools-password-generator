# Deployment Discovery

`bin/deploy-discovery.sh` is a **generic, read-only** server inventory for
planning a deployment runbook. It has no application, domain, port or project
hard-coded. Describe the target with flags and it discovers the host, Docker,
host nginx, other reverse proxies, listeners, DNS/TLS/HTTP behaviour and the
repository.

- **Script:** [`bin/deploy-discovery.sh`](../bin/deploy-discovery.sh)
- **Help:** `./bin/deploy-discovery.sh --help`
- **Output:** raw `deploy-report.txt` plus optional `runbook.md`
- **Read-only:** it does not install packages, edit configuration or restart
  services. It only reads and writes its report directory.

---

## What it covers

| Area | Details |
|---|---|
| Multiple domains/ports | `--domain` × `--port` matrix and/or exact `--endpoint DOMAIN:PORT`; per-port `--tls-port` / `--http-port` |
| Docker | Engine/compose versions, all containers, project-filtered containers, published ports, networks, volumes, compose services/ports/volumes (no env values) |
| Host nginx | version, service state, `nginx -T` (with read-only fallback), server blocks, listen ports, `server_name`, `proxy_pass`, certificates, Host-header behaviour |
| Reverse proxies | nginx, Caddy, Traefik, HAProxy, Apache/HTTPD, Envoy; systemd state; processes; listeners; Caddyfile/Traefik/HAProxy/Apache config paths; Docker proxy containers |
| Endpoints | DNS A/AAAA/CNAME, local listener, Docker mapping, nginx mapping, local/public HTTP status/headers, SNI TLS certificate subject/issuer/dates/SAN/hostname check |
| Project | repository, git, stack files, compose files, env variable **names only**, compose service/port correlation, project containers |
| Host | OS, resources, network, firewall, listeners, software, logs/backups/monitoring/hardening |
| Reports | raw evidence and a Markdown deployment runbook (checklist + warnings) |

---

## Usage

```bash
./bin/deploy-discovery.sh --help

# Multiple domains and ports (domain x port matrix)
sudo ./bin/deploy-discovery.sh \
  --name myapp \
  --domain app.example.com \
  --domain api.example.com \
  --port 80 --port 443 --port 8443 --tls-port 8443 \
  --repo /opt/myapp \
  --compose docker-compose.prd.yml \
  --env-file .env.prd \
  --project myapp_prd \
  --format both \
  --output-dir /var/log/deploy-discovery/myapp-$(date +%Y%m%dT%H%M%SZ)

# Exact endpoints
sudo ./bin/deploy-discovery.sh \
  --endpoint app.example.com:443 \
  --endpoint api.example.com:8443 --tls-port 8443

# Air-gapped/local read-only inventory
./bin/deploy-discovery.sh --no-network --port 443
```

- `--domain` and `--port` are repeatable. If only domains are supplied, ports
  default to `80` and `443`.
- `--endpoint DOMAIN:PORT` is an exact pair; use it when the domain/port
  combinations are not a full matrix.
- `--tls-port`/`--http-port` classify non-standard ports. `--tls`/`--http`
  force the protocol for every endpoint.
- `--no-network` skips DNS, public HTTP/TLS and external IP/metadata probes.
- `--format text` (default) writes the raw report; `markdown`/`both` also write
  `runbook.md`.

Output directory contents:

| File | Purpose |
|---|---|
| `deploy-report.txt` | Full evidence: parameters, Docker, nginx, proxies, endpoints, ports, host, repo, warnings |
| `runbook.md` | Tables and checklist for the deployment runbook |
| `endpoints.tsv` | Per-domain/port mapping and probe results |
| `nginx-servers.tsv` | Parsed host-nginx server blocks |
| `compose-services.tsv` | Compose services, ports, volumes, networks (no env values) |
| `ports.tsv`, `warnings.txt` | Requested-port summary and gaps |

The directory is created mode `700`; files are `600` on a normal filesystem.
Share only after review.

---

## Production command for this repository

Run from the production checkout, with the prd stack running and DNS/TLS in
place:

```bash
cd /opt/agiolab/tools-password-generator

sudo ./bin/deploy-discovery.sh \
  --name agiolab-password-secrets \
  --domain agiolab.com \
  --domain www.agiolab.com \
  --domain password.agiolab.com \
  --domain secrets.agiolab.com \
  --port 80 --port 443 \
  --repo "$PWD" \
  --compose docker-compose.prd.yml \
  --env-file .env.prd \
  --project passwordgenerator_prd \
  --format both \
  --output-dir "/var/log/deploy-discovery/agiolab-$(date +%Y%m%dT%H%M%SZ)"
```

The script is generic; only the arguments above are repository-specific. Adjust
`/opt/agiolab/tools-password-generator` to the actual checkout path. Without
`sudo`, Docker and nginx ownership detail is reduced; the script warns.

The eight endpoints cover all four names on ports 80 and 443 (host nginx). Port 443
is TLS by default.

---

## Discovery findings for this deployment

Observed during the verification run (re-run on the production host before
executing the runbook):

- `agiolab.com`, `www.agiolab.com`, `password.agiolab.com` and
  `secrets.agiolab.com` all resolve to `80.65.211.200` via public resolvers.
  Confirm this is the production host. The server's local resolver may cache an
  older empty `secrets` answer; use `dig @1.1.1.1` and flush the cache.
- Host nginx on 80/443 has **no agiolab server block yet**: port 80 serves the
  default site (HTTP 200) and port 443 returns 502 with a certificate not
  matching the domain. Install [`deploy/nginx/agiolab.conf`](../deploy/nginx/agiolab.conf),
  set the certificate paths, `nginx -t`, and reload nginx.
- After the host nginx config is installed, the discovery should map all four
  names on 443 to nginx; apex and the password alias serve the app, `www`
  redirects to the apex, and the local HTTPS health checks return 200.
- Compose maps `app` → `127.0.0.1:18000` and `secrets-manager` →
  `127.0.0.1:18001`; there is **no Caddy/proxy service** in the production
  stack. The public edge is the host nginx.
- The public URLs are standard HTTPS: <https://agiolab.com> (canonical),
  <https://password.agiolab.com> (alias), <https://www.agiolab.com>
  (redirect), and <https://secrets.agiolab.com>.

These findings are why the production runbook treats host nginx as the edge and
the Docker services as loopback-only upstreams.

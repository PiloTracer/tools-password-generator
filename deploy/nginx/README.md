# Host nginx edge

Production terminates TLS at the **host nginx**, not at a container. nginx
listens on 80/443 and proxies to the loopback-published services:

| Public name | Upstream |
|---|---|
| `agiolab.com` | `http://127.0.0.1:18000` (canonical app) |
| `password.agiolab.com` | `http://127.0.0.1:18000` (alias) |
| `www.agiolab.com` | redirect to `https://agiolab.com` |
| `secrets.agiolab.com` | `http://127.0.0.1:18001` |

There is **no Caddy service** in the production stack. The app and Secrets
Manager are bound to loopback only; nginx is the public edge.

## First-time certificate issuance

The full site config references files under
`/etc/letsencrypt/live/agiolab.com/`, which do not exist on a fresh host. Issue
the certificate first with the HTTP-only bootstrap config:

```bash
sudo install -d -m 755 /var/www/html/.well-known/acme-challenge
sudo chown -R www-data:www-data /var/www/html

sudo cp deploy/nginx/agiolab-acme.conf /etc/nginx/conf.d/agiolab-acme.conf
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/html \
  -d agiolab.com -d www.agiolab.com \
  -d password.agiolab.com -d secrets.agiolab.com \
  --cert-name agiolab.com \
  --non-interactive --agree-tos --email admin@agiolab.com \
  --deploy-hook "systemctl reload nginx"

sudo rm /etc/nginx/conf.d/agiolab-acme.conf
sudo cp deploy/nginx/agiolab.conf /etc/nginx/conf.d/agiolab.conf
sudo nginx -t
sudo systemctl reload nginx
```

Use the certificate on a host where all four names already resolve to the server.
The bootstrap and the full `agiolab.conf` HTTP blocks both serve
`/.well-known/acme-challenge/` from `/var/www/html`, so renewals continue to
work after the full config is installed.

If you already have a certificate covering all names (SAN or wildcard
`*.agiolab.com`), skip certbot, point the `ssl_certificate` paths at it, and
install `agiolab.conf` directly.

## Install the full config

```bash
sudo cp deploy/nginx/agiolab.conf /etc/nginx/conf.d/agiolab.conf
sudo nginx -t
sudo systemctl reload nginx
```

The template uses:

```nginx
ssl_certificate     /etc/letsencrypt/live/agiolab.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/agiolab.com/privkey.pem;
```

If you use separate certificates, split the two server blocks and point each to
its own files.

Start the stack:

```bash
./bin/start.sh up prd
```

`start.sh` preflights host nginx: it must be listening on 443 and the enabled
nginx configuration must contain `server_name` for both names. It then waits for
the public HTTPS endpoints through nginx.

## DNS and firewall

Create A/AAAA records for `agiolab.com`, `www.agiolab.com`,
`password.agiolab.com` and `secrets.agiolab.com`, all pointing at the
production host. Allow inbound TCP 80 (redirect/ACME) and TCP 443 (HTTPS). The app/Secrets Manager
ports `18000`/`18001` remain loopback-only and must not be opened.

## Verification

```bash
curl -fsS https://agiolab.com/api/health
curl -fsS https://password.agiolab.com/api/health
curl -fsS -I https://www.agiolab.com/       # 301 to https://agiolab.com
curl -fsS https://secrets.agiolab.com/healthz

# AWS protocol through the host nginx edge
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
  aws --endpoint-url https://secrets.agiolab.com secretsmanager list-secrets
```

Expected: HTTP 200 from all four health checks.

## SigV4 / Host header

`proxy_set_header Host $http_host;` is mandatory. The Secrets Manager verifies
the signed `Host` header (and the path). nginx preserves both by default when
using this directive; do not replace it with a fixed hostname or strip the path.

## Notes

- The host nginx is outside Docker Compose. `start.sh` never edits nginx
  configuration; it validates the installed config and reloads nothing.
- nginx 1.25+ may warn that `listen ... http2` is deprecated. The directive
  remains compatible with older nginx; alternatively use `http2 on;` on a newer
  host.
- Keep the existing nginx sites for other applications. These server blocks are
  selected by `server_name`/SNI and do not affect them.
- TLS renewal is handled by the host certificate tooling (certbot or the
  organization’s certificate process). The stack does not manage certificates.

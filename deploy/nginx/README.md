# Host nginx edge

Production terminates TLS at the **host nginx**, not at a container. nginx
listens on 80/443 and proxies to the loopback-published services:

| Public name | Upstream |
|---|---|
| `password.agiolab.com` | `http://127.0.0.1:18000` |
| `secrets.agiolab.com` | `http://127.0.0.1:18001` |

There is **no Caddy service** in the production stack. The app and Secrets
Manager are bound to loopback only; nginx is the public edge.

## Install

1. Copy the site config:

   ```bash
   sudo cp deploy/nginx/agiolab.conf /etc/nginx/conf.d/agiolab.conf
   ```

2. Set the certificate paths in the file. The template uses:

   ```nginx
   ssl_certificate     /etc/letsencrypt/live/agiolab.com/fullchain.pem;
   ssl_certificate_key /etc/letsencrypt/live/agiolab.com/privkey.pem;
   ```

   Use a certificate with **both** names in its SAN, or a wildcard
   `*.agiolab.com`. If you use separate certificates, split the
   `password.agiolab.com` and `secrets.agiolab.com` server blocks and point each
   to its own files.

3. Validate and reload:

   ```bash
   sudo nginx -t
   sudo systemctl reload nginx
   ```

4. Start the stack:

   ```bash
   ./bin/start.sh up prd
   ```

   `start.sh` preflights host nginx: it must be listening on 443 and the enabled
   nginx configuration must contain `server_name` for both names. It then waits
   for the public HTTPS endpoints through nginx.

## DNS and firewall

Create A/AAAA records for both names pointing at the production host. Allow
inbound TCP 80 (redirect/ACME) and TCP 443 (HTTPS). The app/Secrets Manager
ports `18000`/`18001` remain loopback-only and must not be opened.

## Verification

```bash
curl -fsS https://password.agiolab.com/api/health
curl -fsS https://password.agiolab.com/api/ready
curl -fsS https://secrets.agiolab.com/healthz
curl -fsS https://secrets.agiolab.com/readyz

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

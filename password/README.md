# Password Generator - Next.js app

Next.js 16 App Router application for the Secure Password Generator.

See the [repository README](../README.md) for the full stack, Docker, backup
and Secrets Manager documentation.

## Local development

```bash
npm install
npm run dev            # http://localhost:3000
```

The API route resolves `../password_generator.py` and `python3` automatically.
The web app works without the Secrets Manager: it uses built-in policy defaults.
To exercise the AWS-compatible Secrets Manager integration locally, start the
`secrets-manager` service from the repository root and export the variables
listed in the root README ("Local development without Docker").

## Scripts

```bash
npm run dev        # hot-reload development server
npm run build      # production build (standalone output)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## API

| Route | Description |
|---|---|
| `POST /api/generate` | Generate a character password or passphrase |
| `GET /api/health` | Liveness plus dependency report (degraded = 200) |
| `GET /api/ready` | Readiness (503 when policy/word-list checks fail) |

Both API routes are `runtime = "nodejs"` and `dynamic = "force-dynamic"`; they
never cache secrets or passwords.

## Structure

```text
app/page.tsx                 landing page
app/layout.tsx               fonts, metadata, theme toggle
components/                  UI components
app/api/generate/route.ts    generation endpoint (validated, rate limited)
app/api/health/route.ts      health report
app/api/ready/route.ts       readiness probe
lib/aws-sigv4.ts             SigV4 request signer
lib/secrets-manager.ts       Secrets Manager client with short-lived cache
lib/runtime-config.ts        policy parsing + fail-safe defaults
lib/wordlist.ts              word-list integrity verification
lib/generator.ts             Python invocation (timeouts, output caps)
lib/rate-limit.ts            fixed-window in-memory limiter
lib/health.ts                dependency aggregation
```

import { NextResponse } from "next/server";

import { collectHealth } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe for orchestration and the start.sh smoke test. Unlike
 * /api/health, this returns 503 when the configured Secrets Manager cannot be
 * reached, because the deployment is then running on fallback policy.
 */
export async function GET(): Promise<NextResponse> {
  const report = await collectHealth();
  return NextResponse.json(
    {
      ready: report.ready,
      status: report.status,
      environment: report.environment,
      version: report.version,
      checkedAt: report.checkedAt,
      checks: report.checks,
    },
    {
      status: report.ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

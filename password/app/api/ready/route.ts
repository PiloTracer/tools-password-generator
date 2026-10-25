import { NextResponse } from "next/server";

import { collectHealth, publicHealthReport, verboseHealthEnabled } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe for orchestration and the start.sh smoke test.
 *
 * Ready means "this instance can generate passwords". The Secrets Manager is an
 * optional policy source that the app falls back from, so its degradation is
 * reported in `checks.secretsManager` / `status: "degraded"` rather than by
 * withdrawing the instance with a 503. A 503 is reserved for a broken generator
 * or an unenforced word-list integrity policy.
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
      checks: (verboseHealthEnabled() ? report : publicHealthReport(report)).checks,
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

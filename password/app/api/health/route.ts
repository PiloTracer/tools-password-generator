import { NextResponse } from "next/server";

import { collectHealth, publicHealthReport, verboseHealthEnabled } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + dependency report. Returns 200 while the generator can serve
 * requests; an unavailable Secrets Manager is reported as "degraded" rather
 * than taking the app down, because generation keeps working with defaults.
 *
 * The response omits absolute paths, the word-list digest and error detail
 * unless `HEALTH_VERBOSE=true`; see `publicHealthReport`.
 */
export async function GET(): Promise<NextResponse> {
  const report = await collectHealth();
  const body = verboseHealthEnabled() ? report : publicHealthReport(report);
  return NextResponse.json(body, {
    status: report.status === "error" ? 503 : 200,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

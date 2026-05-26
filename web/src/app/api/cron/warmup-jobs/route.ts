// P5: Lambda warmup cron — pings the most popular /api/jobs/init filter combos
// every 5 minutes so the function stays hot. Without this, any real user who
// arrives after Vercel reclaims the Lambda (~15 min idle) eats a 750ms–4s
// cold-start on initial paint, exactly when first impressions are forming.
//
// Schedule: see vercel.json (`*/5 * * * *`). Requires Vercel Pro for sub-daily
// cron cadence; on Hobby tier, change to `55 14 * * *` (daily before peak US
// traffic) — see action-plan.md P5 for context.
//
// Auth: Vercel cron invokes the URL with `Authorization: Bearer ${CRON_SECRET}`
// and `User-Agent: vercel-cron/1.0`. We require CRON_SECRET to match so the
// endpoint isn't a free DoS amplifier for randos discovering it.
//
// Combos hit (chosen for traffic share + CDN-key independence):
//   1. Default landing query — every visitor's first paint
//   2. location=Remote — second-most-popular landing filter
//   3. location=New York City — third-most-popular landing filter
// Each combo gets its own CDN cache entry, so warming one doesn't warm another.
// We refresh CDN simultaneously (each ping is itself a CDN-cached response with
// stale-while-revalidate=120, so the revalidation happens in the background).

import { NextRequest } from "next/server";

const BASE =
  process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://getdatjob.vercel.app";

const COMMON = "posted=7d&sort=recent&page=0&signal=all&visa=H1B&department=all&level=all";

const WARMUP_COMBOS = [
  `q=&location=all&${COMMON}`,
  `q=&location=Remote&${COMMON}`,
  `q=&location=New%20York%20City&${COMMON}`,
];

export async function GET(req: NextRequest) {
  // Auth: reject anything not carrying the cron secret. In dev (no secret set)
  // allow unauthenticated runs so the route is testable locally.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const started = Date.now();
  const results = await Promise.all(
    WARMUP_COMBOS.map(async (qs) => {
      const url = `${BASE}/api/jobs/init?${qs}`;
      const t0  = Date.now();
      try {
        // cache: "no-store" on the *cron's* fetch so we always reach origin
        // (otherwise the cron itself would be served from CDN and never warm
        // the Lambda). The downstream response Cache-Control still controls
        // what end-users see.
        const res = await fetch(url, { cache: "no-store" });
        return {
          url:        url.replace(BASE, ""),
          status:     res.status,
          cache:      res.headers.get("x-vercel-cache") ?? null,
          duration_ms: Date.now() - t0,
        };
      } catch (e: any) {
        return {
          url:         url.replace(BASE, ""),
          status:      0,
          error:       e?.message ?? String(e),
          duration_ms: Date.now() - t0,
        };
      }
    })
  );

  return Response.json({
    ok:           results.every((r) => r.status === 200),
    total_ms:     Date.now() - started,
    warmed_count: results.length,
    results,
  });
}

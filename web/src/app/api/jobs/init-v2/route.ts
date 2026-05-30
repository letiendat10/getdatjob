// /api/jobs/init-v2 — proxies the Supabase Edge Function (query-jobs).
// Runs on Vercel's Edge Runtime (no Node Lambda cold start) and adds the
// same Vercel CDN cache header as /api/jobs/init so CDN-warm path stays fast.
//
// Compared head-to-head with /api/jobs/init via perf-logs/measure.sh.

import { NextRequest } from "next/server";

export const runtime = "edge";

const FUNCTIONS_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/query-jobs`;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function GET(req: NextRequest) {
  const upstream = `${FUNCTIONS_BASE}?${req.nextUrl.searchParams.toString()}`;

  try {
    const res = await fetch(upstream, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=120",
      },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

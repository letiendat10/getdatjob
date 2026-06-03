import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const t0 = Date.now();
  const { error } = await supabase.rpc("refresh_stats_shelf");

  if (error) {
    console.error("[refresh-stats] error:", error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Card-health QA snapshot over the last-7-day window. Secondary to stats —
  // log but don't fail the cron if it errors.
  const { error: chErr } = await supabase.rpc("refresh_card_health", { p_window_days: 7 });
  if (chErr) console.error("[refresh-stats] card_health error:", chErr);

  return Response.json({ ok: true, card_health: !chErr, duration_ms: Date.now() - t0 });
}

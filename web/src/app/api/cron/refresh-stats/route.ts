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

  return Response.json({ ok: true, duration_ms: Date.now() - t0 });
}

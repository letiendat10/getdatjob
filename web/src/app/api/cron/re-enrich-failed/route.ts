import { NextRequest } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { enrichUser } from "@/lib/enrich-apollo";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabase = createSupabaseAdmin();

  const { data: failed } = await supabase
    .schema("enriched")
    .from("profiles")
    .select("user_id")
    .eq("enrich_status", "failed")
    .limit(20);

  if (!failed?.length) {
    return Response.json({ ok: true, retried: 0 });
  }

  const results = await Promise.allSettled(
    failed.map(async ({ user_id }) => {
      const { data: lp } = await supabase
        .schema("linkedin")
        .from("profiles")
        .select("email, first_name, full_name, linkedin_url")
        .eq("id", user_id)
        .maybeSingle();

      if (!lp) return { user_id, skipped: true };

      const firstName = lp.first_name ?? (lp.full_name ? lp.full_name.split(" ")[0] : null);
      const lastName = lp.full_name ? lp.full_name.split(" ").slice(1).join(" ") || null : null;

      await supabase
        .schema("enriched")
        .from("profiles")
        .update({ enrich_status: "pending" })
        .eq("user_id", user_id);

      await enrichUser(user_id, lp.email, firstName, lastName, lp.linkedin_url);
      return { user_id, retried: true };
    })
  );

  const retried = results.filter((r) => r.status === "fulfilled").length;
  console.log(`[re-enrich-cron] retried ${retried}/${failed.length} failed profiles`);

  return Response.json({ ok: true, retried, total: failed.length });
}

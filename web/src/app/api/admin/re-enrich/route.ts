import { NextRequest } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { enrichUser } from "@/lib/enrich-apollo";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-enrich-secret");
  if (!process.env.ENRICH_SECRET || secret !== process.env.ENRICH_SECRET) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { userId } = await req.json() as { userId?: string };
  if (!userId) return Response.json({ error: "userId required" }, { status: 400 });

  const supabase = createSupabaseAdmin();

  const { data: lp } = await supabase
    .schema("linkedin")
    .from("profiles")
    .select("email, first_name, full_name, linkedin_url")
    .eq("id", userId)
    .maybeSingle();

  if (!lp) return Response.json({ error: "user not found in linkedin.profiles" }, { status: 404 });

  const firstName = lp.first_name ?? (lp.full_name ? lp.full_name.split(" ")[0] : null);
  const lastName = lp.full_name ? lp.full_name.split(" ").slice(1).join(" ") || null : null;

  await supabase
    .schema("enriched")
    .from("profiles")
    .upsert({ user_id: userId, enrich_status: "pending" }, { onConflict: "user_id" });

  await enrichUser(userId, lp.email, firstName, lastName, lp.linkedin_url);

  const { data: ep } = await supabase
    .schema("enriched")
    .from("profiles")
    .select("enrich_status, current_title, location, job_function, job_level")
    .eq("user_id", userId)
    .maybeSingle();

  return Response.json({ ok: true, result: ep });
}

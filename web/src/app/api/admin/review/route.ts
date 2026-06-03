// Owner-only: apply a title review. Gates on OWNER_EMAIL, then calls apply_title_review
// (service-role — the function is REVOKEd from anon/authenticated) which upserts the
// decision, propagates dept/level to every job with this raw title, and re-scores the
// verified tier if title_clean was corrected.

import { createSupabaseServer } from "@/lib/supabase-server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const owner = process.env.OWNER_EMAIL;
  if (!user || !owner || user.email !== owner) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const title_norm = typeof body.title_norm === "string" ? body.title_norm : "";
  const decision = body.decision === "approved" || body.decision === "corrected" ? body.decision : "";
  if (!title_norm || !decision) {
    return Response.json({ error: "title_norm and decision required" }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  const { error } = await admin.rpc("apply_title_review", {
    p_title_norm: title_norm,
    p_decision: decision,
    p_department: (body.department as string) ?? null,
    p_job_level: (body.job_level as string) ?? null,
    p_title_clean: (body.title_clean as string) ?? null,
    p_reviewer: user.email,
    p_notes: (body.notes as string) ?? null,
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

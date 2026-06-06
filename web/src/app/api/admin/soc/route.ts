import { NextRequest } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const SOC_RE = /^\d{2}-\d{4}(\.\d{2})?$/;

// Owner-only: edit a title->SOC mapping, then re-stamp affected jobs (sets job_signals.soc_code
// and upgrades friendly -> verified where the SOC matches the employer's sponsored occupations).
// Human edits win over rule/llm and are never overwritten by the daily batch.
export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const owner = process.env.OWNER_EMAIL;
  // Owner-gated in production; allow saves in local dev (no localhost OAuth session). See page.tsx.
  const isLocalDev = process.env.NODE_ENV !== "production";
  if (!isLocalDev && (!user || !owner || user.email !== owner)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { title_clean?: string; soc_code?: string; soc_name?: string | null; sample_raw?: string | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const title_clean = (body.title_clean ?? "").trim();
  const soc_code = (body.soc_code ?? "").trim();
  if (!title_clean || !soc_code) {
    return Response.json({ error: "title_clean and soc_code are required" }, { status: 400 });
  }
  if (!SOC_RE.test(soc_code)) {
    return Response.json({ error: "soc_code must be a DOL SOC like 15-1252.00" }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  const { error } = await admin.from("title_soc_map").upsert(
    {
      title_clean,
      soc_code,
      soc_name: body.soc_name ?? null,
      mapped_by: "human",
      sample_raw: body.sample_raw ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "title_clean" },
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Re-stamp job_signals.soc_code + upgrade friendly->verified in bounded batches (avoids 57014).
  let restamped = 0;
  for (let i = 0; i < 100; i++) {
    const { data, error: rsErr } = await admin.rpc("restamp_soc", { p_batch: 5000 });
    if (rsErr) return Response.json({ error: rsErr.message, restamped }, { status: 500 });
    const n = Number(data) || 0;
    restamped += n;
    if (!n) break;
  }
  await admin.rpc("refresh_soc_map_counts");

  return Response.json({ ok: true, restamped });
}

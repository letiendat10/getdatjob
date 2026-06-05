import { NextRequest } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

// Owner-only: edit a raw->unified department mapping, then re-stamp affected jobs.
// Human edits win over rule/llm and are never overwritten by the daily batch.
export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const owner = process.env.OWNER_EMAIL;
  if (!user || !owner || user.email !== owner) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { source_norm?: string; unified_department?: string; sample_raw?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const source_norm = (body.source_norm ?? "").trim();
  const unified_department = (body.unified_department ?? "").trim();
  if (!source_norm || !unified_department) {
    return Response.json({ error: "source_norm and unified_department are required" }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  const { error } = await admin.from("dept_mapping").upsert(
    {
      source_norm,
      unified_department,
      mapped_by: "human",
      sample_raw: body.sample_raw ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "source_norm" },
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Re-stamp jobs.department from the mapping in bounded batches (avoids the 57014 class).
  let restamped = 0;
  for (let i = 0; i < 100; i++) {
    const { data, error: rsErr } = await admin.rpc("restamp_department", { p_batch: 5000 });
    if (rsErr) return Response.json({ error: rsErr.message, restamped }, { status: 500 });
    const n = Number(data) || 0;
    restamped += n;
    if (!n) break;
  }
  await admin.rpc("refresh_dept_mapping_counts");

  return Response.json({ ok: true, restamped });
}

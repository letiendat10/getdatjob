// Owner-only governance for the raw->unified department mapping (dept_mapping). Lists the
// distinct ATS department values and their unified bucket so the owner can correct a mis-map
// or approve an LLM-proposed new bucket. Edits win over rule/llm and re-stamp jobs corpus-wide
// (see /api/admin/departments). Reads the SMALL dept_mapping table only — never aggregates jobs,
// so it can't hit the statement-timeout class that bit the last HITL. Gated to OWNER_EMAIL.

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { DepartmentsClient, type DeptRow, type JobExample } from "./departments-client";

export const dynamic = "force-dynamic";

export default async function AdminDepartmentsPage() {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const owner = process.env.OWNER_EMAIL;
  if (!user || !owner || user.email !== owner) redirect("/");

  const admin = createSupabaseAdmin();
  const [{ data, error }, { data: exRows }] = await Promise.all([
    admin
      .from("dept_mapping")
      .select("source_norm,unified_department,mapped_by,sample_raw,n_jobs,updated_at")
      .order("n_jobs", { ascending: false })
      .limit(2000),
    // Up to 2 example postings per normalized raw value, so cryptic ATS departments
    // (e.g. "7LQ", "Mfg (JDS)") are reviewable at a glance. See migration 20260605052000.
    admin.rpc("dept_mapping_examples"),
  ]);

  const exByNorm = new Map<string, JobExample[]>(
    ((exRows ?? []) as { source_norm: string; examples: JobExample[] }[]).map((r) => [
      r.source_norm,
      r.examples ?? [],
    ]),
  );
  const rows = ((data ?? []) as DeptRow[]).map((r) => ({
    ...r,
    examples: exByNorm.get(r.source_norm) ?? [],
  }));

  return <DepartmentsClient initial={rows} loadError={error?.message ?? null} />;
}

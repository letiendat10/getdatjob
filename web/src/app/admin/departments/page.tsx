// Owner-only governance for the raw->unified department mapping (dept_mapping). Lists the
// distinct ATS department values and their unified bucket so the owner can correct a mis-map
// or approve an LLM-proposed new bucket. Edits win over rule/llm and re-stamp jobs corpus-wide
// (see /api/admin/departments). Reads the SMALL dept_mapping table only — never aggregates jobs,
// so it can't hit the statement-timeout class that bit the last HITL. Gated to OWNER_EMAIL.

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { DepartmentsClient, type DeptRow } from "./departments-client";

export const dynamic = "force-dynamic";

export default async function AdminDepartmentsPage() {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const owner = process.env.OWNER_EMAIL;
  if (!user || !owner || user.email !== owner) redirect("/");

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from("dept_mapping")
    .select("source_norm,unified_department,mapped_by,sample_raw,n_jobs,updated_at")
    .order("n_jobs", { ascending: false })
    .limit(2000);

  return <DepartmentsClient initial={(data ?? []) as DeptRow[]} loadError={error?.message ?? null} />;
}

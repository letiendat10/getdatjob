// Owner-only governance for the title->SOC occupation mapping (title_soc_map). Lists the
// distinct job titles and their inferred DOL SOC so the owner can correct a mis-map or confirm
// an LLM guess. Edits win over rule/llm and re-stamp job_signals.soc_code corpus-wide, upgrading
// friendly -> verified where the SOC matches the employer's sponsored occupations (see
// /api/admin/soc). Reads the SMALL title_soc_map table only — never aggregates jobs, so it can't
// hit the statement-timeout class that bit the old /admin/review. Gated to OWNER_EMAIL.

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { SocClient, type SocRow } from "./soc-client";

export const dynamic = "force-dynamic";

export default async function AdminSocPage() {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const owner = process.env.OWNER_EMAIL;
  // Owner-gated in production. In local dev the OAuth session lives on the prod domain
  // (NEXT_PUBLIC_SITE_URL), so there's no localhost session — allow local QA without login.
  // `next dev` => NODE_ENV==='development'; Vercel builds => 'production', so prod stays gated.
  const isLocalDev = process.env.NODE_ENV !== "production";
  if (!isLocalDev && (!user || !owner || user.email !== owner)) redirect("/");

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from("title_soc_map")
    .select("title_clean,soc_code,soc_name,mapped_by,sample_raw,examples,example_jobs,n_jobs,n_verify,updated_at")
    .order("n_verify", { ascending: false })   // badge-producing titles first
    .order("n_jobs", { ascending: false })
    .limit(2000);

  return <SocClient initial={(data ?? []) as SocRow[]} loadError={error?.message ?? null} />;
}

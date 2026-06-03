// Owner-only daily review queue (HITL). Surfaces up to 10 verified, freshly-posted
// (last 24h), highest-LCA-employer cards — one per still-unreviewed title — so the
// owner can approve/correct dept, level and title_clean. Decisions propagate corpus-wide
// (see apply_title_review). Gated to OWNER_EMAIL; everyone else is bounced.

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { ReviewClient, type ReviewCard } from "./review-client";

export const dynamic = "force-dynamic";

export default async function AdminReviewPage() {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const owner = process.env.OWNER_EMAIL;
  if (!user || !owner || user.email !== owner) redirect("/");

  // Service role: next_review_batch is read-only, but the admin client keeps this
  // consistent with the apply route and avoids relying on anon grants.
  const admin = createSupabaseAdmin();
  const { data, error } = await admin.rpc("next_review_batch", { p_limit: 10, p_hours: 24 });

  return (
    <ReviewClient
      initial={(data ?? []) as ReviewCard[]}
      loadError={error?.message ?? null}
    />
  );
}

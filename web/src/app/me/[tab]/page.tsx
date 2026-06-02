import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import MeClient from "../me-client";

export const metadata: Metadata = {
  title: "My Account — getdatjob",
  robots: { index: false, follow: false },
};

type Tab = "chat" | "matches" | "account";

const SLUG_TO_TAB: Record<string, Tab> = {
  chat: "chat",
  "job-matches": "matches",
  profile: "account",
};

export default async function MeTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const initialTab = SLUG_TO_TAB[tab];
  if (!initialTab) redirect("/me/chat");

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/signin");
  }

  const [{ data: profile }, { data: enrichedPrefs }, { data: liProfile }, { data: subData }, { data: alertPrefsData }] =
    await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase
        .schema("enriched")
        .from("profiles")
        .select("visa_type, salary_floor, job_level, job_function, location, posted_within_days, is_supporter")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .schema("linkedin")
        .from("profiles")
        .select("avatar_url")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("subscriptions")
        .select("subscription_tier, subscription_status, stripe_customer_id, current_tier_expires_at")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("user_job_alert_prefs")
        .select("email_alerts, frequency")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

  const profileData = {
    id: user.id,
    full_name:
      profile?.full_name ??
      user.user_metadata?.full_name ??
      user.user_metadata?.name ??
      null,
    email: profile?.email ?? user.email ?? null,
    avatar_url:
      liProfile?.avatar_url ??
      profile?.avatar_url ??
      user.user_metadata?.avatar_url ??
      user.user_metadata?.picture ??
      null,
    is_supporter:
      (enrichedPrefs as { is_supporter?: boolean } | null)?.is_supporter ??
      (profile as { is_supporter?: boolean } | null)?.is_supporter ??
      false,
    subscription_tier: (subData as { subscription_tier?: string } | null)?.subscription_tier ?? "free",
    subscription_status: (subData as { subscription_status?: string } | null)?.subscription_status ?? null,
    stripe_customer_id: (subData as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? null,
    current_tier_expires_at: (subData as { current_tier_expires_at?: string } | null)?.current_tier_expires_at ?? null,
    preferences: enrichedPrefs
      ? {
          visa_type: (enrichedPrefs as { visa_type?: string | null }).visa_type ?? null,
          salary_floor: (enrichedPrefs as { salary_floor?: number | null }).salary_floor ?? null,
          job_level: (enrichedPrefs as { job_level?: string | null }).job_level ?? null,
          job_function: (enrichedPrefs as { job_function?: string | null }).job_function ?? null,
          location: (enrichedPrefs as { location?: string | null }).location ?? null,
          posted_within_days: (enrichedPrefs as { posted_within_days?: number | null }).posted_within_days ?? null,
        }
      : null,
  };

  const alertPrefs = alertPrefsData
    ? {
        email_alerts: (alertPrefsData as { email_alerts?: boolean }).email_alerts ?? false,
        frequency: ((alertPrefsData as { frequency?: string }).frequency ?? "daily") as "daily" | "weekly",
      }
    : null;

  return <MeClient profile={profileData} alertPrefs={alertPrefs} initialTab={initialTab} />;
}

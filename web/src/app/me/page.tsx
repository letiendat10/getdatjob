import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import MeClient from "./me-client";

export const metadata: Metadata = {
  title: "My Account — getdatjob",
  robots: { index: false, follow: false },
};

export default async function MePage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/signin");
  }

  const [{ data: profile }, { data: enrichedPrefs }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).single(),
    supabase
      .schema("enriched")
      .from("profiles")
      .select("visa_type, salary_floor, job_level, location, is_supporter")
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
      profile?.avatar_url ??
      user.user_metadata?.avatar_url ??
      user.user_metadata?.picture ??
      null,
    is_supporter:
      (enrichedPrefs as { is_supporter?: boolean } | null)?.is_supporter ??
      (profile as { is_supporter?: boolean } | null)?.is_supporter ??
      false,
    preferences: enrichedPrefs
      ? {
          visa_type: (enrichedPrefs as { visa_type?: string | null }).visa_type ?? null,
          salary_floor: (enrichedPrefs as { salary_floor?: number | null }).salary_floor ?? null,
          job_level: (enrichedPrefs as { job_level?: string | null }).job_level ?? null,
          location: (enrichedPrefs as { location?: string | null }).location ?? null,
        }
      : null,
  };

  return <MeClient profile={profileData} />;
}

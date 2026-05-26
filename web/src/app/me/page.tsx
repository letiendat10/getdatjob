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

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

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
    is_supporter: (profile as { is_supporter?: boolean } | null)?.is_supporter ?? false,
  };

  return <MeClient profile={profileData} />;
}

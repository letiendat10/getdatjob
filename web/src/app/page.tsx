import type { Metadata } from "next";
import LandingPage from "./components/LandingPage";
import { createSupabaseServer } from "@/lib/supabase-server";

export const metadata: Metadata = {
  title: "getdatjob — a job board that gets your visa",
  description:
    "No more guesswork. We verify every US company that has sponsored visas straight from the US government database.",
};

export default async function Home() {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const primaryCtaHref = user ? "/me/chat" : "/auth/signin";

  return (
    <LandingPage
      headline={<>finally, a job board that<br /><em>gets your visa.</em></>}
      body="No more guesswork. We verify every US company that has sponsored visas straight from the US government database, so you can focus on landing your dream jobs."
      primaryCtaHref={primaryCtaHref}
    />
  );
}

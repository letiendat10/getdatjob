import type { Metadata } from "next";
import LandingPage from "../components/LandingPage";

export const metadata: Metadata = {
  title: "getdatjob — a job board that gets your visa",
  description:
    "No more guesswork. We verify every US company that has sponsored visas straight from the US government database.",
  robots: { index: false, follow: false },
};

export default function KPage() {
  return (
    <LandingPage
      headline={<>finally, a job board that<br /><em>gets your visa.</em></>}
      body="No more guesswork. We verify every US company that has sponsored visas straight from the US government database, so you can focus on landing your dream jobs."
      ctaHref="/auth/signin"
    />
  );
}

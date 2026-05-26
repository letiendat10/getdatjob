import type { Metadata } from "next";
import LandingPage from "../components/LandingPage";

export const metadata: Metadata = {
  title: "Don't let your visa hold you back | getdatjob",
  description:
    "We verify every US company that has sponsored visas straight from the USCIS database, so you can focus on landing your dream job.",
};

export default function VariantC() {
  return (
    <LandingPage
      headline={<>Don&rsquo;t let <em>your visa</em><br />hold you back.</>}
      body="We verify every US company that has sponsored visas straight from the USCIS database, so you can focus on landing your dream job."
    />
  );
}

import type { Metadata } from "next";
import LandingPage from "../components/LandingPage";
import VisaSwap from "../components/VisaSwap";

export const metadata: Metadata = {
  title: "Never miss a great visa opportunity | getdatjob",
  description:
    "We verify every US company that has sponsored visas straight from the USCIS database, so you can focus on landing your dream job.",
};

export default function VariantD() {
  return (
    <LandingPage
      headline={<>Never miss<br />a great <VisaSwap /> opportunity.</>}
      body="We verify every US company that has sponsored visas straight from the USCIS database, so you can focus on landing your dream job."
    />
  );
}

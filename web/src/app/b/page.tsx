import type { Metadata } from "next";
import LandingPage from "../components/LandingPage";

export const metadata: Metadata = {
  title: "Confirmed. These companies sponsor working visas. | getdatjob",
  description:
    "Fast-track your job search with the most up-to-date job listings — verified directly from the USCIS database. No more guesswork.",
};

export default function VariantB() {
  return (
    <LandingPage
      headline={<>Confirmed. These companies<br />sponsor <em>working visas.</em></>}
      body="Fast-track your job search with the most up-to-date job listings — verified directly from the USCIS database. No more guesswork."
    />
  );
}

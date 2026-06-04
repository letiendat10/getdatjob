"use client";

/**
 * Client wrapper for PaywallScreen on /pricing.
 *
 * /pricing is a server component (for SEO + metadata + footer rendering).
 * PaywallScreen is a "use client" island with interactive selection,
 * checkout, and Free-link handlers — those handlers must close over a
 * useRouter, hence this thin client wrapper.
 */

import { useRouter } from "next/navigation";
import PaywallScreen from "@/app/components/PaywallScreen";

export default function PricingClient() {
  const router = useRouter();
  return (
    <PaywallScreen
      // No body subhead on /pricing — empty string skips the <p> entirely.
      // The cards + Free link carry the full story.
      body=""
      // Cold visitor → signin first; after auth they land back here and
      // checkout proceeds.
      signInUrl="/auth/signin?next=/pricing"
      // Free tier on /pricing routes through signin so the user has an
      // account before browsing matches.
      onContinueFree={() => router.push("/auth/signin?next=/jobs")}
    />
  );
}

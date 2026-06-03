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
      // No live job count on a public pricing page; use a brand-aligned
      // pricing-specific subhead instead of the "Unlock all N matches…" copy
      // that's tied to Kai's search context.
      body="Two plans for working visa holders. First month on us."
      // Cold visitor → signin first; after auth they land back here and
      // checkout proceeds.
      signInUrl="/auth/signin?next=/pricing"
      // Free tier on /pricing routes through signin so the user has an
      // account before browsing matches.
      onContinueFree={() => router.push("/auth/signin?next=/jobs")}
    />
  );
}

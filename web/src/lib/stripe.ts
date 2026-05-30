import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  typescript: true,
});

// Map { tier_interval } → env var price ID
export function getPriceId(tier: "passed" | "preferred", interval: "monthly" | "annual"): string {
  const key = `${tier}_${interval}`.toUpperCase();
  const map: Record<string, string | undefined> = {
    PASSED_MONTHLY: process.env.STRIPE_PRICE_PASSED_MONTHLY,
    PASSED_ANNUAL: process.env.STRIPE_PRICE_PASSED_ANNUAL,
    PREFERRED_MONTHLY: process.env.STRIPE_PRICE_PREFERRED_MONTHLY,
    PREFERRED_ANNUAL: process.env.STRIPE_PRICE_PREFERRED_ANNUAL,
  };
  const priceId = map[key];
  if (!priceId) throw new Error(`Missing env var for price: ${key}`);
  return priceId;
}

// Map price ID → subscription tier
export function getTierFromPriceId(priceId: string): "passed" | "preferred" | null {
  const passedIds = [
    process.env.STRIPE_PRICE_PASSED_MONTHLY,
    process.env.STRIPE_PRICE_PASSED_ANNUAL,
  ].filter(Boolean);
  const preferredIds = [
    process.env.STRIPE_PRICE_PREFERRED_MONTHLY,
    process.env.STRIPE_PRICE_PREFERRED_ANNUAL,
  ].filter(Boolean);

  if (passedIds.includes(priceId)) return "passed";
  if (preferredIds.includes(priceId)) return "preferred";
  return null;
}

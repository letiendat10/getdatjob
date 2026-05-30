/**
 * One-time Stripe setup: creates products, prices, coupon, and promo code.
 * Run: node scripts/stripe-setup.mjs   (loads STRIPE_SECRET_KEY from .env.local)
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";

// Load .env.local manually
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { typescript: false });

async function main() {
  console.log("Creating Stripe products and prices for getdatjob...\n");

  // ── Products ──────────────────────────────────────────────────────
  const passed = await stripe.products.create({
    name: "getdatjob Passed",
    description: "Unlimited job matches + USCIS-verified sponsorship data",
  });
  console.log("✓ Product: Passed —", passed.id);

  const preferred = await stripe.products.create({
    name: "getdatjob Preferred",
    description: "Unlimited matches, daily job alerts, action plan, salary data",
  });
  console.log("✓ Product: Preferred —", preferred.id);

  // ── Prices ────────────────────────────────────────────────────────
  const passedMonthly = await stripe.prices.create({
    product: passed.id,
    unit_amount: 1499,          // $14.99
    currency: "usd",
    recurring: { interval: "month" },
    nickname: "Passed Monthly",
  });
  console.log("✓ Price: Passed Monthly —", passedMonthly.id);

  const passedAnnual = await stripe.prices.create({
    product: passed.id,
    unit_amount: 14999,         // $149.99
    currency: "usd",
    recurring: { interval: "year" },
    nickname: "Passed Annual",
  });
  console.log("✓ Price: Passed Annual —", passedAnnual.id);

  const preferredMonthly = await stripe.prices.create({
    product: preferred.id,
    unit_amount: 2999,          // $29.99
    currency: "usd",
    recurring: { interval: "month" },
    nickname: "Preferred Monthly",
  });
  console.log("✓ Price: Preferred Monthly —", preferredMonthly.id);

  const preferredAnnual = await stripe.prices.create({
    product: preferred.id,
    unit_amount: 29999,         // $299.99
    currency: "usd",
    recurring: { interval: "year" },
    nickname: "Preferred Annual",
  });
  console.log("✓ Price: Preferred Annual —", preferredAnnual.id);

  // ── Coupon: 100% off for 3 months ─────────────────────────────────
  const coupon = await stripe.coupons.create({
    percent_off: 100,
    duration: "repeating",
    duration_in_months: 3,
    name: "Launch beta – 3 months free",
  });
  console.log("✓ Coupon —", coupon.id);

  // ── Promo code: WORKINGVISA ────────────────────────────────────────
  const promo = await stripe.promotionCodes.create({
    coupon: coupon.id,
    code: "WORKINGVISA",
  });
  console.log("✓ Promo code: WORKINGVISA —", promo.id);

  // ── Summary ───────────────────────────────────────────────────────
  console.log("\n=== Add these to .env.local and Vercel ===");
  console.log(`STRIPE_PRICE_PASSED_MONTHLY=${passedMonthly.id}`);
  console.log(`STRIPE_PRICE_PASSED_ANNUAL=${passedAnnual.id}`);
  console.log(`STRIPE_PRICE_PREFERRED_MONTHLY=${preferredMonthly.id}`);
  console.log(`STRIPE_PRICE_PREFERRED_ANNUAL=${preferredAnnual.id}`);
  console.log(`STRIPE_PROMO_CODE_ID=${promo.id}`);
  console.log("\nDone. Still need to add your STRIPE_SECRET_KEY and create a webhook in the Stripe dashboard.");
}

main().catch((err) => { console.error(err); process.exit(1); });

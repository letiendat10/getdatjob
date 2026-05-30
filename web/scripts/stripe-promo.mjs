// Creates WORKINGVISA promo code using new Stripe dahlia API structure
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { typescript: false });

// Check if already exists
const existing = await stripe.promotionCodes.list({ limit: 20 });
const found = existing.data.find(p => p.code === "WORKINGVISA");
if (found) {
  console.log("✓ WORKINGVISA already exists:", found.id);
  console.log(`STRIPE_PROMO_CODE_ID=${found.id}`);
  process.exit(0);
}

// Dahlia API: promotion is nested under { type, coupon }
const promo = await stripe.promotionCodes.create({
  promotion: { type: "coupon", coupon: "QTTFDSH2" },
  code: "WORKINGVISA",
});

console.log("✓ Promo code WORKINGVISA:", promo.id);
console.log(`STRIPE_PROMO_CODE_ID=${promo.id}`);

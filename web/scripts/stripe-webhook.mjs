// Creates Stripe webhook endpoint and prints the signing secret
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

const endpoint = await stripe.webhookEndpoints.create({
  url: "https://getdatjob.vercel.app/api/stripe/webhook",
  enabled_events: [
    "checkout.session.completed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ],
  description: "getdatjob production webhook",
});

console.log("✓ Webhook created:", endpoint.id);
console.log(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}`);

/**
 * One-off: backfill the confirmation email + Kai chat message for a user whose
 * webhook failed to land. Use AFTER manually fixing the subs.subscriptions row.
 *
 * Usage: node scripts/backfill-paid-user.mjs <email> <stripe_subscription_id>
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const email = process.argv[2];
const subId = process.argv[3];
if (!email || !subId) {
  console.error("Usage: node scripts/backfill-paid-user.mjs <email> <stripe_subscription_id>");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { typescript: false });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

const sub = await stripe.subscriptions.retrieve(subId);
const priceId = sub.items.data[0].price.id;
const tier =
  priceId === process.env.STRIPE_PRICE_PREFERRED_MONTHLY ||
  priceId === process.env.STRIPE_PRICE_PREFERRED_ANNUAL
    ? "preferred"
    : "passed";
const tierName = tier === "preferred" ? "Preferred" : "Passed";
// Stripe SDK may not surface current_period_end on the top-level Subscription
// type in newer API versions; fall back to items.data[0].current_period_end.
const cpe =
  sub.current_period_end ??
  sub.items?.data?.[0]?.current_period_end ??
  null;
if (!cpe) {
  console.error("Could not resolve current_period_end on subscription", sub.id);
  process.exit(1);
}
const nextBillingDate = new Date(cpe * 1000);

console.log(`User: ${email} → ${tierName} (next bill: ${nextBillingDate.toISOString()})`);

// Look up user_id
const { data: { users } } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
if (!user) { console.error("user not found"); process.exit(1); }

// Insert Kai message
const { data: existingMsg } = await supabase
  .from("kai_messages")
  .select("id")
  .eq("user_id", user.id)
  .filter("cta->>checkout_session_id", "eq", sub.id)
  .maybeSingle();

if (!existingMsg) {
  await supabase.from("kai_messages").insert({
    user_id: user.id,
    role: "assistant",
    content: `Your **${tierName}** subscription is confirmed. Head to your **Job Matches** tab — I've already filtered everything to your preferences.`,
    cta: { label: "Go get them →", href: "/me/job-matches", checkout_session_id: sub.id },
  });
  console.log("✓ Kai confirmation message inserted");
} else {
  console.log("· Kai message already exists, skipped");
}

// Send email
const TIER_FEATURES = {
  passed: ["Unlimited job matches", "USCIS-verified sponsorship data", "Sponsorship history (LCA count, last filed)", "All visa types (H-1B, OPT, E-3/TN)", "Verified company point of contact"],
  preferred: ["Everything in Passed", "Daily job alerts", '"I just got laid off" action plan', "Salary benchmarking data"],
};
const features = TIER_FEATURES[tier];
const nextBillingStr = nextBillingDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://getdatjob.app";
const featureList = features.map(f => `<li style="margin-bottom:4px">${f}</li>`).join("");

const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F4F0E8;margin:0;padding:40px 20px;color:#171614">
  <div style="max-width:480px;margin:0 auto;background:#FAF7F0;border-radius:16px;padding:32px;border:1px solid #D9D2C2">
    <p style="font-size:13px;color:#6F6A60;margin:0 0 24px">getdatjob</p>
    <h1 style="font-size:22px;font-weight:700;margin:0 0 8px;color:#171614">You're in — ${tierName} access confirmed.</h1>
    <p style="font-size:14px;color:#3A3833;margin:0 0 24px">Your first month is on us with <strong>WORKINGVISA</strong>. Here's what's unlocked:</p>
    <ul style="font-size:14px;color:#3A3833;padding-left:20px;margin:0 0 24px">${featureList}</ul>
    <p style="font-size:13px;color:#6F6A60;margin:0 0 24px">Your first paid month begins <strong>${nextBillingStr}</strong>. Cancel anytime in your account.</p>
    <a href="${siteUrl}/me/job-matches" style="display:inline-block;background:#171614;color:#F4F0E8;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none">Go get them →</a>
    <p style="font-size:12px;color:#6F6A60;margin:24px 0 0">Manage your subscription at any time at <a href="${siteUrl}/me" style="color:#1F3A2E">${siteUrl.replace(/^https?:\/\//,"")}/me</a>.</p>
  </div>
</body></html>`.trim();

const { data: emailRes, error: emailErr } = await resend.emails.send({
  from: "Kai @ getdatjob <invoice@getdatjob.app>",
  to: email,
  subject: `You're in — ${tierName} access confirmed.`,
  html,
});
if (emailErr) console.error("✗ email failed:", emailErr);
else console.log(`✓ email sent: ${emailRes?.id}`);

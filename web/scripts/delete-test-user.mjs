/**
 * Wipe a test user clean so the Stripe checkout flow can be re-tested fresh.
 *
 * Usage:
 *   node scripts/delete-test-user.mjs <email>           # soft reset (keep auth user)
 *   node scripts/delete-test-user.mjs <email> --full    # also delete the Supabase auth user
 *
 * What it does (in order):
 *  1. Look up auth.users by email → user_id
 *  2. Read subs.subscriptions → stripe_customer_id
 *  3. Stripe: cancel active sub → detach payment methods → delete customer
 *  4. Supabase: delete rows from kai_messages, subs.subscriptions, user_job_alert_prefs, profiles
 *  5. With --full: supabase.auth.admin.deleteUser
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const email = process.argv[2];
const fullReset = process.argv.includes("--full");

if (!email) {
  console.error("Usage: node scripts/delete-test-user.mjs <email> [--full]");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { typescript: false });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log(`\n→ Resetting test user: ${email} ${fullReset ? "(FULL — also deleting auth row)" : "(soft — keeping auth row)"}\n`);

  // 1. Find Supabase user
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw listErr;
  const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());

  if (!user) {
    console.log(`  · no auth user found for ${email} — checking subs by email anyway`);
  } else {
    console.log(`  · auth user_id: ${user.id}`);
  }

  // 2. Find subscription row → stripe_customer_id
  const { data: subRow } = await supabase
    .schema("subs")
    .from("subscriptions")
    .select("user_id, stripe_customer_id, stripe_subscription_id")
    .eq("email", email)
    .maybeSingle();

  const customerId = subRow?.stripe_customer_id;
  const subscriptionId = subRow?.stripe_subscription_id;
  console.log(`  · stripe_customer_id: ${customerId ?? "(none)"}`);
  console.log(`  · stripe_subscription_id: ${subscriptionId ?? "(none)"}`);

  // 3. Stripe cleanup
  if (subscriptionId) {
    try {
      await stripe.subscriptions.cancel(subscriptionId);
      console.log(`  ✓ canceled subscription ${subscriptionId}`);
    } catch (e) {
      console.log(`  · sub cancel skipped: ${e.message}`);
    }
  }

  if (customerId) {
    try {
      const pms = await stripe.paymentMethods.list({ customer: customerId, limit: 100 });
      for (const pm of pms.data) {
        await stripe.paymentMethods.detach(pm.id);
      }
      if (pms.data.length) console.log(`  ✓ detached ${pms.data.length} payment method(s)`);
    } catch (e) {
      console.log(`  · detach skipped: ${e.message}`);
    }
    try {
      await stripe.customers.del(customerId);
      console.log(`  ✓ deleted Stripe customer ${customerId}`);
    } catch (e) {
      console.log(`  · customer delete skipped: ${e.message}`);
    }
  }

  // 4. Supabase cleanup
  const userId = subRow?.user_id ?? user?.id;
  if (userId) {
    const kai = await supabase.from("kai_messages").delete().eq("user_id", userId);
    console.log(`  ✓ kai_messages: ${kai.error ? "ERR " + kai.error.message : "deleted"}`);

    const subs = await supabase.schema("subs").from("subscriptions").delete().eq("user_id", userId);
    console.log(`  ✓ subs.subscriptions: ${subs.error ? "ERR " + subs.error.message : "deleted"}`);

    try {
      const alerts = await supabase.from("user_job_alert_prefs").delete().eq("user_id", userId);
      console.log(`  ✓ user_job_alert_prefs: ${alerts.error ? "skipped (" + alerts.error.message + ")" : "deleted"}`);
    } catch (e) { console.log(`  · alerts skipped: ${e.message}`); }

    try {
      const prof = await supabase.from("profiles").delete().eq("id", userId);
      console.log(`  ✓ profiles: ${prof.error ? "skipped (" + prof.error.message + ")" : "deleted"}`);
    } catch (e) { console.log(`  · profiles skipped: ${e.message}`); }
  } else {
    console.log("  · skipped Supabase row deletes (no user_id resolved)");
  }

  // 5. Optional full auth user delete
  if (fullReset && user) {
    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) {
      console.log(`  · auth user delete failed: ${error.message}`);
    } else {
      console.log(`  ✓ deleted auth user ${user.id}`);
    }
  }

  console.log("\nDone. Clear localStorage in the browser (DevTools → Application → Local Storage → getdatjob.app → clear `kai_*` keys) before re-testing.\n");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});

import { NextRequest } from "next/server";
import Stripe from "stripe";
import { stripe, getTierFromPriceId } from "@/lib/stripe";
import { sendSubscriptionConfirmation } from "@/lib/email";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function resolvePromoCode(stripeSubscription: Stripe.Subscription | null): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const discounts: any[] | undefined = (stripeSubscription as any)?.discounts;
  const couponId =
    // Newer API: discounts[0] is a discount object with coupon
    discounts?.[0]?.coupon?.id ??
    // Legacy field
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stripeSubscription as any)?.discount?.coupon?.id ??
    null;
  if (!couponId) return null;
  // Find the promotion code attached to this coupon, return its human code
  try {
    const promos = await stripe.promotionCodes.list({ coupon: couponId, limit: 1 });
    if (promos.data[0]?.code) return promos.data[0].code;
  } catch {
    // fall through
  }
  return couponId;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    return Response.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err);
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = adminClient();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const customerId = session.customer as string;

    const { data: sub } = await supabase
      .schema("subs")
      .from("subscriptions")
      .select("user_id, email, first_subscribed_at")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();

    if (!sub) {
      console.error("[stripe-webhook] no subscription row for customer:", customerId);
      return Response.json({ received: true });
    }

    const stripeSubscription = session.subscription
      ? await stripe.subscriptions.retrieve(session.subscription as string)
      : null;

    const priceId = stripeSubscription?.items?.data?.[0]?.price?.id ?? null;
    const tier = priceId ? getTierFromPriceId(priceId) : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentPeriodEnd: number = (stripeSubscription as any)?.current_period_end ?? 0;
    const nextBillingDate = currentPeriodEnd
      ? new Date(currentPeriodEnd * 1000)
      : new Date(Date.now() + 30 * 86400000);
    const status = stripeSubscription?.status ?? "active";
    const promoCodeUsed = await resolvePromoCode(stripeSubscription);

    await supabase
      .schema("subs")
      .from("subscriptions")
      .update({
        subscription_tier: tier ?? "passed",
        stripe_subscription_id: session.subscription as string,
        subscription_status: status,
        first_subscribed_at: sub.first_subscribed_at ?? new Date().toISOString(),
        current_tier_expires_at: nextBillingDate.toISOString(),
        promo_code_used: promoCodeUsed,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", sub.user_id);

    // Insert Kai confirmation message into chat history.
    // Idempotent: skip if a confirmation message for this checkout session already exists.
    try {
      const { data: existingMsg } = await supabase
        .from("kai_messages")
        .select("id")
        .eq("user_id", sub.user_id)
        .eq("role", "assistant")
        .filter("cta->>checkout_session_id", "eq", session.id)
        .maybeSingle();

      if (!existingMsg) {
        const tierName = tier === "preferred" ? "Preferred" : "Passed";
        await supabase.from("kai_messages").insert({
          user_id: sub.user_id,
          role: "assistant",
          content: `Your **${tierName}** subscription is confirmed. Head to your **Job Matches** tab — I've already filtered everything to your preferences.`,
          cta: {
            label: "Go get them →",
            href: "/me/job-matches",
            checkout_session_id: session.id,
          },
        });
      }
    } catch (err) {
      console.error("[stripe-webhook] kai message insert failed:", err);
    }

    if (sub.email && tier) {
      try {
        await sendSubscriptionConfirmation({ email: sub.email, tier, nextBillingDate });
      } catch (err) {
        console.error("[stripe-webhook] email failed:", err);
      }
    }
  }

  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = subscription.customer as string;

    const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
    const tier = priceId ? getTierFromPriceId(priceId) : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentPeriodEnd: number = (subscription as any).current_period_end ?? 0;

    await supabase
      .schema("subs")
      .from("subscriptions")
      .update({
        subscription_status: subscription.status,
        subscription_tier: tier ?? "free",
        current_tier_expires_at: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_customer_id", customerId);
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = subscription.customer as string;

    await supabase
      .schema("subs")
      .from("subscriptions")
      .update({
        subscription_tier: "free",
        subscription_status: "canceled",
        stripe_subscription_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_customer_id", customerId);
  }

  return Response.json({ received: true });
}

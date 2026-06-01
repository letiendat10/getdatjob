import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { stripe, getPriceId } from "@/lib/stripe";

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json() as { tier: "passed" | "preferred"; interval: "monthly" | "annual" };
  const { tier, interval } = body;

  if (!tier || !interval) {
    return Response.json({ error: "Missing tier or interval" }, { status: 400 });
  }

  let priceId: string;
  try {
    priceId = getPriceId(tier, interval);
  } catch {
    return Response.json({ error: "Invalid tier/interval or missing price config" }, { status: 400 });
  }

  const email = user.email!;
  // Always redirect to canonical domain so localStorage onboarding data is accessible
  const siteUrl = process.env.NODE_ENV === "production"
    ? "https://getdatjob.app"
    : "http://localhost:3000";

  // Look up or create Stripe customer
  const supabaseAdmin = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: { getAll: () => [], setAll: () => {} },
    }
  );

  const { data: existing } = await supabaseAdmin
    .schema("subs")
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = existing?.stripe_customer_id ?? null;

  if (!customerId) {
    const customer = await stripe.customers.create({ email, metadata: { user_id: user.id } });
    customerId = customer.id;
    await supabaseAdmin
      .schema("subs")
      .from("subscriptions")
      .upsert(
        {
          user_id: user.id,
          email,
          stripe_customer_id: customerId,
          subscription_tier: "free",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
  }

  const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${siteUrl}/me/chat?checkout=success`,
    cancel_url: `${siteUrl}/kai`,
    customer_update: { address: "auto" },
    allow_promotion_codes: false,
  };

  // Auto-apply WORKINGVISA promo only on monthly plans — "100% off first month"
  // is sensible for monthly subs; on annual it'd give a whole free year.
  if (process.env.STRIPE_PROMO_CODE_ID && interval === "monthly") {
    sessionParams.discounts = [{ promotion_code: process.env.STRIPE_PROMO_CODE_ID }];
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  return Response.json({ url: session.url });
}

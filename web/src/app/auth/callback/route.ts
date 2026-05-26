import { NextRequest, NextResponse, after } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { enrichWithApollo } from "@/lib/enrich-apollo";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/auth/signin?error=cancelled`);
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/auth/signin?error=auth_failed`);
  }

  const meta = data.user.user_metadata ?? {};
  const fullName = meta.full_name ?? meta.name ?? null;

  // Fetch vanityName from LinkedIn API using the provider token Supabase returns.
  // This gives us the exact profile URL (linkedin.com/in/{vanityName}).
  let linkedinUrl: string | null = null;
  const providerToken = data.session?.provider_token ?? null;
  if (providerToken) {
    try {
      const liRes = await fetch("https://api.linkedin.com/v2/me", {
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      if (liRes.ok) {
        const liData = await liRes.json() as { vanityName?: string };
        if (liData.vanityName) {
          linkedinUrl = `https://www.linkedin.com/in/${liData.vanityName}`;
        }
      }
    } catch {
      // Non-fatal — enrichment will fall back to name search
    }
  }

  await supabase.schema("linkedin").from("profiles").upsert(
    {
      id: data.user.id,
      full_name: fullName,
      first_name: meta.given_name ?? null,
      email: data.user.email ?? null,
      avatar_url: meta.avatar_url ?? meta.picture ?? null,
      linkedin_url: linkedinUrl,
    },
    { onConflict: "id" }
  );

  // Plant pending row
  await supabase
    .schema("enriched")
    .from("profiles")
    .upsert({ user_id: data.user.id, enrich_status: "pending" }, { onConflict: "user_id" });

  // Enrich via Apollo after the redirect is sent — non-blocking
  const userId = data.user.id;
  const email = data.user.email ?? null;
  const firstName = (meta.given_name ?? null) as string | null;
  const lastName = (meta.family_name ?? null) as string | null;
  after(async () => {
    await enrichWithApollo(userId, email, firstName, lastName);
  });

  return NextResponse.redirect(`${origin}/kai-first`);
}

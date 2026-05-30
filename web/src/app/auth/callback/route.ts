import { NextRequest, NextResponse, after } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { enrichUser } from "@/lib/enrich-apollo";

// Attempt to fetch headline + vanityName from LinkedIn's REST API using the
// provider access token Supabase gives us after OIDC exchange. Works when the
// LinkedIn app has r_liteprofile scope approved (requested in SignInButton).
async function tryLinkedInV2Me(providerToken: string): Promise<{
  headline: string | null;
  vanityName: string | null;
}> {
  try {
    const res = await fetch(
      "https://api.linkedin.com/v2/me?projection=(id,localizedFirstName,localizedLastName,headline,vanityName)",
      {
        headers: {
          Authorization: `Bearer ${providerToken}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (res.ok) {
      const profile = (await res.json()) as {
        headline?: string;
        vanityName?: string;
      };
      console.log("[linkedin-v2me] ok — headline:", profile.headline, "vanityName:", profile.vanityName);
      return {
        headline: profile.headline ?? null,
        vanityName: profile.vanityName ?? null,
      };
    }
    const body = await res.text();
    console.log("[linkedin-v2me] failed:", res.status, body.slice(0, 200));
  } catch (err) {
    console.error("[linkedin-v2me] error:", err);
  }
  return { headline: null, vanityName: null };
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    // No ?code= means GoTrue used implicit flow and put #access_token=... in the
    // fragment (happens when generateLink() is called server-side — no PKCE
    // challenge). Fragments aren't sent to the server, so we can't process them
    // here. Redirect to the client-side session page; browsers preserve the
    // original fragment through same-origin 302 redirects, so the page will
    // receive #access_token=... and call setSession() to establish the session.
    const defaultDest = process.env.NEXT_PUBLIC_PAYWALL_PAGE === "paywall" ? "/kai-pay" : "/kai-first";
    const next = request.cookies.get("li_oauth_next")?.value ?? defaultDest;
    const sessionUrl = next !== defaultDest
      ? `${origin}/auth/linkedin/session?next=${encodeURIComponent(next)}`
      : `${origin}/auth/linkedin/session`;
    const res = NextResponse.redirect(sessionUrl);
    res.cookies.delete("li_oauth_next");
    return res;
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

  // Option 2: try provider_token → /v2/me to get headline + vanityName.
  // LinkedIn OIDC alone only returns OIDC standard claims (no headline).
  // If r_liteprofile scope was granted (requested in SignInButton), this call
  // returns the full liteprofile including headline and the vanity URL slug.
  let headline: string | null = (meta.headline as string | null) ?? null;
  let vanityName: string | null = (meta.vanity_name as string | null) ?? (meta.linkedin_vanity as string | null) ?? null;

  const providerToken = data.session?.provider_token ?? null;
  if (providerToken && !headline) {
    const v2me = await tryLinkedInV2Me(providerToken);
    headline = v2me.headline;
    vanityName = v2me.vanityName ?? vanityName;
  }

  const linkedinUrl: string | null = vanityName
    ? `https://www.linkedin.com/in/${vanityName}`
    : null;

  if (linkedinUrl) {
    console.log("[auth-callback] linkedinUrl resolved:", linkedinUrl);
  }

  await supabase.schema("linkedin").from("profiles").upsert(
    {
      id: data.user.id,
      full_name: fullName,
      first_name: meta.given_name ?? null,
      email: data.user.email ?? null,
      avatar_url: meta.avatar_url ?? meta.picture ?? null,
      linkedin_url: linkedinUrl,
      headline,
    },
    { onConflict: "id" }
  );

  // Plant pending row
  await supabase
    .schema("enriched")
    .from("profiles")
    .upsert({ user_id: data.user.id, enrich_status: "pending" }, { onConflict: "user_id" });

  const userId = data.user.id;
  const email = data.user.email ?? null;
  const firstName = (meta.given_name ?? null) as string | null;
  const lastName = (meta.family_name ?? null) as string | null;

  after(async () => {
    await enrichUser(userId, email, firstName, lastName, linkedinUrl, meta.locale ?? null);
  });

  const rawNext = request.cookies.get("li_oauth_next")?.value;
  let next: string;
  if (rawNext) {
    next = rawNext;
  } else {
    next = process.env.NEXT_PUBLIC_PAYWALL_PAGE === "paywall" ? "/kai-pay" : "/kai-first";
  }
  const finalRes = NextResponse.redirect(`${origin}${next}`);
  finalRes.cookies.delete("li_oauth_next");
  return finalRes;
}

import { NextRequest, NextResponse, after } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { enrichUser } from "@/lib/enrich-apollo";

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

  // LinkedIn OIDC (Supabase linkedin_oidc provider) only returns standard OIDC
  // claims: sub (member ID), name, email, picture. It does NOT expose vanityName
  // or headline — those require LinkedIn Partner API access. Both fields stay null
  // and enrichment falls back to email+name via PDL/Apollo.
  const linkedinUrl: string | null = null;
  const headline: string | null = null;

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

  // Enrich via Apollo after the redirect is sent — non-blocking
  const userId = data.user.id;
  const email = data.user.email ?? null;
  const firstName = (meta.given_name ?? null) as string | null;
  const lastName = (meta.family_name ?? null) as string | null;
  after(async () => {
    await enrichUser(userId, email, firstName, lastName, linkedinUrl, meta.locale ?? null);
  });

  return NextResponse.redirect(`${origin}/kai-first`);
}

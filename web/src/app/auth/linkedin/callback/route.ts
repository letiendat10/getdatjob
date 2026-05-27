import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";

const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_ME_URL =
  "https://api.linkedin.com/v2/me?projection=(id,localizedFirstName,localizedLastName,headline,vanityName,profilePicture(displayImage~:playableStreams))";
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const res = await fetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: process.env.LINKEDIN_CLIENT_ID!,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange ${res.status}: ${body.slice(0, 300)}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

type LiProfile = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  headline: string | null;
  vanityName: string | null;
  linkedinUrl: string | null;
  avatarUrl: string | null;
};

async function fetchLinkedInProfile(accessToken: string): Promise<LiProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "X-Restli-Protocol-Version": "2.0.0",
  };

  const [meRes, userinfoRes] = await Promise.all([
    fetch(LINKEDIN_ME_URL, { headers, signal: AbortSignal.timeout(6000) }),
    fetch(LINKEDIN_USERINFO_URL, { headers, signal: AbortSignal.timeout(6000) }),
  ]);

  const me = meRes.ok ? ((await meRes.json()) as Record<string, unknown>) : {};
  const userinfo = userinfoRes.ok
    ? ((await userinfoRes.json()) as Record<string, unknown>)
    : {};

  console.log(
    "[linkedin-custom] /v2/me status:", meRes.status,
    "headline:", me.headline,
    "vanityName:", me.vanityName
  );

  const firstName =
    (me.localizedFirstName as string | null) ??
    (userinfo.given_name as string | null) ??
    null;
  const lastName =
    (me.localizedLastName as string | null) ??
    (userinfo.family_name as string | null) ??
    null;
  const vanityName = (me.vanityName as string | null) ?? null;

  let avatarUrl: string | null = null;
  try {
    type Picture = { "displayImage~"?: { elements?: { identifiers?: { identifier: string }[] }[] } };
    const pic = me.profilePicture as Picture | undefined;
    avatarUrl = pic?.["displayImage~"]?.elements?.at(-1)?.identifiers?.[0]?.identifier ?? null;
  } catch {
    avatarUrl = (userinfo.picture as string | null) ?? null;
  }

  return {
    email: (userinfo.email as string | null) ?? null,
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ") || null,
    headline: (me.headline as string | null) ?? null,
    vanityName,
    linkedinUrl: vanityName ? `https://www.linkedin.com/in/${vanityName}` : null,
    avatarUrl,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // Read and clear state cookie
  const cookieHeader = request.cookies.get("li_oauth_state")?.value;
  const response = NextResponse.redirect(`${origin}/auth/signin?error=invalid_state`);
  response.cookies.delete("li_oauth_state");

  if (!code || !state || state !== cookieHeader) {
    return response;
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL!;
  const redirectUri = `${siteUrl}/auth/linkedin/callback`;

  let profile: LiProfile;
  try {
    const accessToken = await exchangeCode(code, redirectUri);
    profile = await fetchLinkedInProfile(accessToken);
  } catch (err) {
    console.error("[linkedin-custom] OAuth error:", err);
    return NextResponse.redirect(`${origin}/auth/signin?error=auth_failed`);
  }

  if (!profile.email) {
    return NextResponse.redirect(`${origin}/auth/signin?error=no_email`);
  }

  const supabaseAdmin = createSupabaseAdmin();

  // generateLink finds-or-creates the user by email in one call.
  // This avoids the createUser "already registered" error for users who signed
  // in previously via Supabase OIDC but don't yet have a linkedin.profiles row.
  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: profile.email,
      options: { redirectTo: `${siteUrl}/auth/callback` },
    });

  if (linkError || !linkData?.properties?.action_link) {
    console.error("[linkedin-custom] generateLink error:", linkError);
    return NextResponse.redirect(`${origin}/auth/signin?error=auth_failed`);
  }

  const userId = linkData.user.id;

  const profileMeta = {
    full_name: profile.fullName,
    given_name: profile.firstName,
    family_name: profile.lastName,
    avatar_url: profile.avatarUrl,
    // These are read in /auth/callback to skip the provider_token call
    headline: profile.headline,
    linkedin_vanity: profile.vanityName,
  };

  // Stamp LinkedIn metadata onto the user record so /auth/callback can read it.
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: profileMeta,
  });

  // Store LinkedIn profile data now — before the magic link bounce — so that
  // /auth/callback can read headline + linkedinUrl from user_metadata and skip
  // the provider_token call entirely.
  await supabaseAdmin.schema("linkedin").from("profiles").upsert(
    {
      id: userId,
      full_name: profile.fullName,
      first_name: profile.firstName,
      email: profile.email,
      avatar_url: profile.avatarUrl,
      linkedin_url: profile.linkedinUrl,
      headline: profile.headline,
    },
    { onConflict: "id" }
  );

  const finalResponse = NextResponse.redirect(linkData.properties.action_link);
  finalResponse.cookies.delete("li_oauth_state");
  return finalResponse;
}

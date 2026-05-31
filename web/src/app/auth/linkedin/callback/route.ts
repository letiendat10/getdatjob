import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { trySerpAPI } from "@/lib/enrich-apollo";
import { verifyOAuthState } from "@/lib/oauth-state";

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
  locale: string | null;
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
    // ignore parse errors
  }
  avatarUrl = avatarUrl ?? (userinfo.picture as string | null) ?? null;

  // LinkedIn locale can be a string ("en_US") or object ({ country: "US", language: "en" })
  const localeRaw = userinfo.locale;
  let locale: string | null = null;
  if (typeof localeRaw === "string") {
    locale = localeRaw;
  } else if (localeRaw && typeof localeRaw === "object" && "country" in localeRaw) {
    const c = (localeRaw as Record<string, string>).country;
    const l = (localeRaw as Record<string, string>).language;
    if (l && c) locale = `${l}_${c}`;
    else if (c) locale = `_${c}`;
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
    locale,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(`${origin}/auth/signin?error=invalid_state`);
  }

  const parsed = verifyOAuthState(state);
  if (!parsed) {
    console.warn("[linkedin-custom] invalid_state — HMAC verification failed");
    return NextResponse.redirect(`${origin}/auth/signin?error=invalid_state`);
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

  // Run generateLink + SerpAPI in parallel — SerpAPI takes ~5s and used to run
  // in after() (background), meaning the extension only started after the user
  // landed on /kai-first. By running it here (in the request), the queue row
  // is inserted BEFORE the redirect, so the extension is already scraping
  // LinkedIn by the time the user sees Q1.
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  const country  = profile.locale ? (profile.locale.split("_")[1] ?? null) : null;

  const [{ data: linkData, error: linkError }, serpResult] = await Promise.all([
    supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: profile.email,
      options: { redirectTo: `${siteUrl}/auth/callback` },
    }),
    // SerpAPI only needed when OAuth didn't return vanityName
    profile.linkedinUrl
      ? Promise.resolve(null)
      : (fullName ? trySerpAPI(fullName, profile.email, country) : Promise.resolve(null)),
  ]);

  if (linkError || !linkData?.properties?.action_link) {
    console.error("[linkedin-custom] generateLink error:", linkError);
    return NextResponse.redirect(`${origin}/auth/signin?error=auth_failed`);
  }

  const userId      = linkData.user.id;
  const resolvedUrl = profile.linkedinUrl ?? serpResult?.url ?? null;
  const serpHeadline = serpResult?.headline ?? null;

  // Stamp LinkedIn metadata onto the user record so /auth/callback can read it.
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: {
      full_name:      profile.fullName,
      given_name:     profile.firstName,
      family_name:    profile.lastName,
      avatar_url:     profile.avatarUrl,
      headline:       profile.headline,
      linkedin_vanity: profile.vanityName,
    },
  });

  // Write profile row — include SERP headline as a fast approximation if we
  // don't have a real headline yet. Extension will overwrite with the DOM value.
  await supabaseAdmin.schema("linkedin").from("profiles").upsert(
    {
      id:         userId,
      full_name:  profile.fullName,
      first_name: profile.firstName,
      email:      profile.email,
      avatar_url: profile.avatarUrl,
      ...(resolvedUrl  && { linkedin_url: resolvedUrl }),
      ...(profile.headline ? { headline: profile.headline } : serpHeadline ? { headline: serpHeadline } : {}),
    },
    { onConflict: "id" }
  );

  // Plant pending enrichment row.
  await supabaseAdmin
    .schema("enriched")
    .from("profiles")
    .upsert({ user_id: userId, enrich_status: "pending" }, { onConflict: "user_id" });

  // Insert extension job NOW (before redirect) — extension starts scraping
  // immediately while the user is being redirected through the magic-link flow.
  if (resolvedUrl) {
    const { error: queueErr } = await supabaseAdmin
      .from("linkedin_import_queue")
      .insert({ user_id: userId, linkedin_url: resolvedUrl });
    if (queueErr) {
      console.error("[linkedin-custom] queue insert failed:", queueErr);
    } else {
      console.log(`[linkedin-custom] queued extension job for ${resolvedUrl}`);
    }
  } else {
    console.warn("[linkedin-custom] no LinkedIn URL found — skipping queue insert");
  }

  return NextResponse.redirect(linkData.properties.action_link);
}

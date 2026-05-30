import { NextResponse } from "next/server";

// Option 1: Custom LinkedIn OAuth initiation.
// Requests r_liteprofile scope directly — gives headline + vanityName via /v2/me.
// Requires LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET in env.
// Also add https://<your-domain>/auth/linkedin/callback to the LinkedIn app's
// authorized redirect URIs in the LinkedIn Developer Portal.
//
// To activate: update SignInButton to use window.location.href = "/auth/linkedin"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const defaultDest = process.env.NEXT_PUBLIC_PAYWALL_PAGE === "paywall" ? "/kai-pay" : "/kai-first";
  const next = searchParams.get("next") ?? defaultDest;

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  if (!clientId) {
    console.error("[linkedin-custom] LINKEDIN_CLIENT_ID not set");
    return NextResponse.redirect(`${siteUrl}/auth/signin?error=linkedin_not_configured`);
  }

  const state = crypto.randomUUID();
  const redirectUri = `${siteUrl}/auth/linkedin/callback`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    // openid + profile + email = OIDC claims (name, picture, locale)
    // Note: r_liteprofile requires LinkedIn's legacy "Sign In with LinkedIn"
    // product — app only has OIDC product, so we use OIDC scopes only.
    // We still call /v2/me in the callback to test what the OIDC token returns.
    scope: "openid profile email",
    state,
  });

  const response = NextResponse.redirect(
    `https://www.linkedin.com/oauth/v2/authorization?${params}`
  );

  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 600,
    path: "/",
  };
  response.cookies.set("li_oauth_state", state, cookieOpts);
  response.cookies.set("li_oauth_next", next, cookieOpts);

  return response;
}

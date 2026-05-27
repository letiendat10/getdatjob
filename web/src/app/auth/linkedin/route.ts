import { NextResponse } from "next/server";

// Option 1: Custom LinkedIn OAuth initiation.
// Requests r_liteprofile scope directly — gives headline + vanityName via /v2/me.
// Requires LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET in env.
// Also add https://<your-domain>/auth/linkedin/callback to the LinkedIn app's
// authorized redirect URIs in the LinkedIn Developer Portal.
//
// To activate: update SignInButton to use window.location.href = "/auth/linkedin"

export async function GET() {
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
    // r_liteprofile = LinkedIn REST /v2/me headline + vanityName
    scope: "openid profile email r_liteprofile",
    state,
  });

  const response = NextResponse.redirect(
    `https://www.linkedin.com/oauth/v2/authorization?${params}`
  );

  response.cookies.set("li_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}

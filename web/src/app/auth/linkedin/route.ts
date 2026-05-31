import { NextResponse } from "next/server";
import { createOAuthState } from "@/lib/oauth-state";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const next = searchParams.get("next") ?? "/kai";

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  if (!clientId) {
    console.error("[linkedin-custom] LINKEDIN_CLIENT_ID not set");
    return NextResponse.redirect(`${siteUrl}/auth/signin?error=linkedin_not_configured`);
  }

  // HMAC-signed state encodes the nonce + next destination.
  // Self-verifying in the callback — no cookie needed, so browser ITP / privacy
  // settings that strip cookies on cross-site redirects can't break the flow.
  const state = createOAuthState(crypto.randomUUID(), next);
  const redirectUri = `${siteUrl}/auth/linkedin/callback`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state,
  });

  return NextResponse.redirect(
    `https://www.linkedin.com/oauth/v2/authorization?${params}`
  );
}

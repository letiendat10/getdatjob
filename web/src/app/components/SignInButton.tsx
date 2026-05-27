"use client";

import { createSupabaseBrowser } from "@/lib/supabase-browser";

// Toggle: set to true once LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET are in
// env and the callback URL is registered in LinkedIn Developer Portal.
// Custom OAuth requests r_liteprofile → gets headline + vanityName from /v2/me.
const USE_CUSTOM_LINKEDIN_OAUTH = false;

export default function SignInButton({
  className,
  style,
  label = "Continue with LinkedIn",
}: {
  className?: string;
  style?: React.CSSProperties;
  label?: React.ReactNode;
}) {
  async function handleSignIn() {
    if (USE_CUSTOM_LINKEDIN_OAUTH) {
      // Option 1: custom OAuth — headline + vanityName guaranteed via /v2/me
      window.location.href = "/auth/linkedin";
      return;
    }

    // Option 2: Supabase OIDC + r_liteprofile scope attempt.
    // provider_token in callback will try /v2/me; works if r_liteprofile is
    // approved on the LinkedIn app, otherwise falls back to PDL/Apollo.
    const supabase = createSupabaseBrowser();
    await supabase.auth.signInWithOAuth({
      provider: "linkedin_oidc",
      options: {
        redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
        scopes: "openid profile email r_liteprofile",
      },
    });
  }

  return (
    <button onClick={handleSignIn} className={className} style={style}>
      {label}
    </button>
  );
}

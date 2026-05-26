"use client";

import { createSupabaseBrowser } from "@/lib/supabase-browser";

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
    const supabase = createSupabaseBrowser();
    await supabase.auth.signInWithOAuth({
      provider: "linkedin_oidc",
      options: {
        redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
        scopes: "openid profile email",
      },
    });
  }

  return (
    <button onClick={handleSignIn} className={className} style={style}>
      {label}
    </button>
  );
}

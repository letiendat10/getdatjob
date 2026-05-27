"use client";

// This page is the redirect target for the custom LinkedIn OAuth flow.
// generateLink() server-side has no PKCE challenge, so GoTrue uses implicit
// flow and appends #access_token=...&refresh_token=... to the redirect URL.
// Fragments never reach the server, so we handle them here client-side:
// parse the hash, call setSession(), then send the user to /kai-first.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

export default function LinkedInSessionPage() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createSupabaseBrowser();

    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");

    if (access_token && refresh_token) {
      supabase.auth
        .setSession({ access_token, refresh_token })
        .then(({ error }) => {
          if (error) {
            console.error("[linkedin-session] setSession error:", error.message);
            router.replace("/auth/signin?error=session_failed");
          } else {
            // Clear the tokens from the URL bar before navigating away.
            window.history.replaceState(null, "", window.location.pathname);
            router.replace("/kai-first");
          }
        });
    } else {
      // No hash tokens — maybe already signed in, maybe a stale link.
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          router.replace("/kai-first");
        } else {
          router.replace("/auth/signin?error=session_missing");
        }
      });
    }
  }, [router]);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
        fontFamily: "sans-serif",
        color: "var(--ink-3, #888)",
      }}
    >
      Signing you in…
    </div>
  );
}

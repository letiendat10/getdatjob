"use client";

// This page is the redirect target for the custom LinkedIn OAuth flow.
// generateLink() server-side has no PKCE challenge, so GoTrue uses implicit
// flow and appends #access_token=...&refresh_token=... to the redirect URL.
// Fragments never reach the server, so we handle them here client-side:
// parse the hash, call setSession(), then send the user to the next destination
// (default /kai-first; /onboarding when coming via /grace).

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

function SessionHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/kai-first";

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
            window.history.replaceState(null, "", window.location.pathname);
            router.replace(next);
          }
        });
    } else {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          router.replace(next);
        } else {
          router.replace("/auth/signin?error=session_missing");
        }
      });
    }
  }, [router, next]);

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

export default function LinkedInSessionPage() {
  return (
    <Suspense
      fallback={
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
      }
    >
      <SessionHandler />
    </Suspense>
  );
}

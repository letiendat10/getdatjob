"use client";

/**
 * Preview-only route for iterating on PaywallScreen visuals without walking
 * through the Kai onboarding flow each time.
 *
 * Visit /paywall-preview locally — mounts PaywallScreen with mock props in a
 * wrap that mirrors the chat-thread context (max-width: 720px, padding-left: 50px)
 * so layout decisions translate 1:1 to production.
 *
 * Toggle the ?wide=1 query param to render in a wider frame for comparison.
 */

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import PaywallScreen from "@/app/components/PaywallScreen";

function PreviewInner() {
  const params = useSearchParams();
  const wide = params.get("wide") === "1";
  const jobCount = Number(params.get("n") ?? 78);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        padding: "32px 16px",
      }}
    >
      <div
        style={{
          maxWidth: wide ? 1040 : 720,
          margin: "0 auto",
          paddingLeft: wide ? 0 : 50,
          paddingBottom: 24,
        }}
      >
        <PaywallScreen
          jobCount={jobCount}
          email="preview@example.com"
          onContinueFree={() => alert("onContinueFree fired — would advance Kai flow")}
        />
      </div>
    </div>
  );
}

export default function PaywallPreviewPage() {
  return (
    <Suspense fallback={null}>
      <PreviewInner />
    </Suspense>
  );
}

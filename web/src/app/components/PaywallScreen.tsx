"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import s from "./PaywallScreen.module.css";

type Props = {
  jobCount?: number;
  email?: string;
  onContinueFree: () => void;
};

// Side-by-side comparison: both cards list the same first 4 features so the eye
// can scan in parallel; Preferred adds the 5th and 6th below them.
const PASSED_FEATURES = [
  "USCIS-verified data",
  "Unlimited job listings",
  "Sponsorship history",
  "Verified company contact",
];

const PREFERRED_FEATURES = [
  "USCIS-verified data",
  "Unlimited job listings",
  "Sponsorship history",
  "Verified company contact",
  "Job alerts to make you first in line",
  '"I just got laid off" action plan',
];

type Tier = "preferred" | "passed";

export default function PaywallScreen({ jobCount, onContinueFree }: Props) {
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  // Mobile-only: which tier's card is expanded. Default = preferred (the
  // recommended path). Clicking the other tier's compact row swaps them.
  const [expandedTier, setExpandedTier] = useState<Tier>("preferred");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isFirstRenderRef = useRef(true);
  const router = useRouter();

  const body = jobCount && jobCount > 0
    ? `Unlock all ${jobCount} job matches in the last 3 days for your search.`
    : "Unlock all job matches in the last 3 days for your search.";

  const passedPrice = interval === "monthly" ? "$14.99/mo" : "$149.99/yr";
  const preferredPrice = interval === "monthly" ? "$19.99/mo" : "$199.99/yr";

  // After a tier swap on mobile, scroll the bottom of the paywall into view so
  // the user sees the newly-expanded card's CTA without manually scrolling.
  // Skip on first render and on desktop (no swap happens there).
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    if (typeof window === "undefined" || window.innerWidth >= 640) return;
    // Small delay lets the layout settle from the visibility/order swap before
    // the browser computes the scroll target.
    const id = window.setTimeout(() => {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [expandedTier]);

  const handleCheckout = async (tier: Tier) => {
    if (loadingTier) return;
    setLoadingTier(tier);
    try {
      const res = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, interval }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (data.url) {
        router.push(data.url);
      }
    } catch (err) {
      console.error("Checkout failed:", err);
    } finally {
      setLoadingTier(null);
    }
  };

  return (
    <div className={s.wrap}>
      {/* Trust pill — credibility before the ask */}
      <div className={s["trust-pill"]}>
        <span className={s["trust-glyph"]}>✦</span>
        Trusted by 1,120 working visa holders
      </div>

      {/* Brand-matched H1: Instrument Serif (parity with /c landing page) */}
      <h2 className={s.h1}>
        Don&rsquo;t let <em className={s["h1-em"]}>your visa</em> hold you back.
      </h2>
      <p className={s.body}>{body}</p>

      {/* Billing toggle — "Annual pricing · Save 20% · [switch]"
          Centered on desktop, right-aligned on mobile via CSS */}
      <div className={s["toggle-wrap"]}>
        <div className={s["toggle-row"]}>
          <span className={s["toggle-label"]}>Annual pricing</span>
          <span className={s["save-badge"]}>Save 20%</span>
          <button
            type="button"
            role="switch"
            aria-checked={interval === "annual"}
            aria-label="Toggle annual pricing"
            className={`${s["switch"]} ${interval === "annual" ? s["switch-on"] : ""}`}
            onClick={() => setInterval(interval === "annual" ? "monthly" : "annual")}
          >
            <span className={s["switch-knob"]} aria-hidden />
          </button>
        </div>
      </div>

      {/*
        Cards container with `cards-{expandedTier}` class that drives
        mobile-only show/hide CSS. Desktop always shows both full cards;
        mobile shows one full card + the other's compact tappable row.
      */}
      <div className={`${s.cards} ${s[`cards-${expandedTier}`]}`}>
        {/* Passed — FULL card */}
        <div className={`${s.card} ${s["card-passed"]} ${s["passed-full"]}`}>
          <div className={s["card-name"]}>Passed</div>
          <p className={s.tagline}>Just seeing what&rsquo;s out there.</p>
          <div className={s["price-block"]}>
            <div className={s["price-big"]}>
              <span className={s["price-strike"]}>{passedPrice}</span>
            </div>
            <div className={s["price-offer"]}>First month on us</div>
          </div>
          <ul className={s.features}>
            {PASSED_FEATURES.map((f) => (
              <li key={f} className={s.feature}>{f}</li>
            ))}
          </ul>
          <button
            className={`${s.cta} ${loadingTier === "passed" ? s["cta-loading"] : ""}`}
            onClick={() => handleCheckout("passed")}
            disabled={!!loadingTier}
          >
            {loadingTier === "passed" ? "Loading…" : "Get started"}
          </button>
        </div>

        {/* Passed — MOBILE compact tappable row. Tapping EXPANDS (does not
            checkout); the user then taps the in-card CTA to start checkout. */}
        <button
          type="button"
          className={s["passed-mobile-row"]}
          onClick={() => setExpandedTier("passed")}
          aria-label="Expand Passed plan"
        >
          <div className={s["mobile-row-top"]}>
            <span className={s["mobile-row-name"]}>Passed</span>
            <span className={s["mobile-row-price"]}>{passedPrice}</span>
          </div>
          <div className={s["mobile-row-desc"]}>Just seeing what&rsquo;s out there</div>
        </button>

        {/* Preferred — FULL card (rainbow outer) */}
        <div className={`${s["preferred-outer"]} ${s["preferred-full"]}`}>
          <div className={`${s.card} ${s["card-preferred"]}`}>
            {/* Chip absolute top-right so feature list stays at its natural position */}
            <div className={s["recommended-chip"]}>
              <span aria-hidden>⭐</span> RECOMMENDED
            </div>
            <div className={s["card-name"]}>Preferred</div>
            <p className={s.tagline}>For when you&rsquo;re actively applying.</p>
            <div className={s["price-block"]}>
              <div className={s["price-big"]}>
                <span className={s["price-strike"]}>{preferredPrice}</span>
              </div>
              <div className={s["price-offer"]}>First month on us</div>
            </div>
            <ul className={s.features}>
              {PREFERRED_FEATURES.map((f) => (
                <li key={f} className={s.feature}>{f}</li>
              ))}
            </ul>
            <button
              className={`${s.cta} ${loadingTier === "preferred" ? s["cta-loading"] : ""}`}
              onClick={() => handleCheckout("preferred")}
              disabled={!!loadingTier}
            >
              {loadingTier === "preferred" ? "Loading…" : "Get started"}
            </button>
          </div>
        </div>

        {/* Preferred — MOBILE compact tappable row. Tapping expands it.
            Keeps the small RECOMMENDED chip inline so the editor's-pick
            signal survives even when this tier is collapsed. */}
        <button
          type="button"
          className={s["preferred-mobile-row"]}
          onClick={() => setExpandedTier("preferred")}
          aria-label="Expand Preferred plan"
        >
          <div className={s["mobile-row-top"]}>
            <span className={s["mobile-row-name"]}>Preferred</span>
            <span className={s["mobile-row-chip"]}>
              <span aria-hidden>⭐</span> RECOMMENDED
            </span>
            <span className={s["mobile-row-price"]}>{preferredPrice}</span>
          </div>
          <div className={s["mobile-row-desc"]}>For when you&rsquo;re actively applying</div>
        </button>
      </div>

      {/* Free demoted to a text link, not a card */}
      <button className={s["free-link"]} onClick={onContinueFree}>
        Don&rsquo;t need unlimited job listings? <span className={s["free-link-cta"]}>Continue on Free →</span>
      </button>

      {/* Scroll anchor for mobile expand/collapse — placed at the very bottom
          so scrollIntoView reveals the newly expanded card's CTA + free link. */}
      <div ref={bottomRef} aria-hidden style={{ height: 0 }} />
    </div>
  );
}

"use client";

import { useState } from "react";
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
  "Contact of company POC",
];

const PREFERRED_FEATURES = [
  "USCIS-verified data",
  "Unlimited job listings",
  "Sponsorship history",
  "Contact of company POC",
  "Job alerts to make you first in line",
  '"I just got laid off" action plan',
];

export default function PaywallScreen({ jobCount, onContinueFree }: Props) {
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  const router = useRouter();

  const body = jobCount && jobCount > 0
    ? `Unlock all ${jobCount} job matches in the last 3 days for your search.`
    : "Unlock all job matches in the last 3 days for your search.";

  const passedPrice = interval === "monthly" ? "$14.99/mo" : "$149.99/yr";
  const preferredPrice = interval === "monthly" ? "$19.99/mo" : "$199.99/yr";

  const handleCheckout = async (tier: "passed" | "preferred") => {
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

      {/* Billing toggle — pill above cards; Save 20% lives OUTSIDE the pill */}
      <div className={s["toggle-wrap"]}>
        <div className={s.toggle} role="tablist" aria-label="Billing interval">
          <button
            type="button"
            className={`${s["toggle-btn"]} ${interval === "monthly" ? s["toggle-active"] : ""}`}
            onClick={() => setInterval("monthly")}
            role="tab"
            aria-selected={interval === "monthly"}
          >
            Monthly
          </button>
          <button
            type="button"
            className={`${s["toggle-btn"]} ${interval === "annual" ? s["toggle-active"] : ""}`}
            onClick={() => setInterval("annual")}
            role="tab"
            aria-selected={interval === "annual"}
          >
            Annually
          </button>
        </div>
        <span className={s["save-badge"]}>Save 20%</span>
      </div>

      {/* Two equal-width cards for true side-by-side comparison */}
      <div className={s.cards}>
        {/* Passed — DESKTOP full card */}
        <div className={`${s.card} ${s["card-passed"]} ${s["passed-desktop"]}`}>
          <div className={s["card-name"]}>Passed</div>
          <p className={s.tagline}>Perfect for seeing what the market has to offer.</p>
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
            {loadingTier === "passed" ? "Loading…" : "Get started today →"}
          </button>
        </div>

        {/* Passed — MOBILE compact tappable row (hidden on desktop) */}
        <button
          type="button"
          className={`${s["passed-mobile-row"]} ${loadingTier === "passed" ? s["cta-loading"] : ""}`}
          onClick={() => handleCheckout("passed")}
          disabled={!!loadingTier}
        >
          <span className={s["passed-row-name"]}>Passed</span>
          <span className={s["passed-row-desc"]}>See what&rsquo;s out there</span>
          <span className={s["passed-row-price"]}>{passedPrice}</span>
          <span className={s["passed-row-chevron"]} aria-hidden>→</span>
        </button>

        {/* Preferred — right, rainbow outline */}
        <div className={s["preferred-outer"]}>
          <div className={`${s.card} ${s["card-preferred"]}`}>
            {/* Chip absolute top-right so feature list stays at its natural position */}
            <div className={s["recommended-chip"]}>
              <span aria-hidden>⭐</span> RECOMMENDED
            </div>
            <div className={s["card-name"]}>Preferred</div>
            <p className={s.tagline}>Necessary for serious job seekers.</p>
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
              {loadingTier === "preferred" ? "Loading…" : "Get started today →"}
            </button>
          </div>
        </div>
      </div>

      {/* Free demoted to a text link, not a card */}
      <button className={s["free-link"]} onClick={onContinueFree}>
        Don&rsquo;t need unlimited job listings? <span className={s["free-link-cta"]}>Continue on Free →</span>
      </button>
    </div>
  );
}

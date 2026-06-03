"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import s from "./PaywallScreen.module.css";

type Props = {
  jobCount?: number;
  /** Search window used to find the jobs (3, 7, or 14). Passed from Kai so
      the paywall body's "in the last X days" matches Kai's own bubble. */
  windowDays?: number;
  email?: string;
  onContinueFree: () => void;
  /** Override the body subhead. When set, replaces the default
      "Unlock all N job matches in the last X days for your search." */
  body?: string;
  /** Where to send the user if the checkout API returns 401 (unauthenticated).
      Used on public surfaces like /pricing where cold visitors land before auth. */
  signInUrl?: string;
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

export default function PaywallScreen({ jobCount, windowDays = 3, email: _email, onContinueFree, body: bodyOverride, signInUrl }: Props) {
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [loading, setLoading] = useState(false);
  // Selection state — which tier the bottom CTA will check out
  const [selectedTier, setSelectedTier] = useState<Tier>("preferred");
  const router = useRouter();

  const bodyText = bodyOverride
    ?? (jobCount && jobCount > 0
      ? `Unlock all ${jobCount} job matches in the last ${windowDays} days for your search.`
      : `Unlock all job matches in the last ${windowDays} days for your search.`);

  const passedPrice = interval === "monthly" ? "$14.99/mo" : "$149.99/yr";
  const preferredPrice = interval === "monthly" ? "$19.99/mo" : "$199.99/yr";

  const handleCheckout = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: selectedTier, interval }),
      });
      // Cold visitors on /pricing aren't authed — the API returns 401.
      // Send them through signin first if the caller provided a signInUrl.
      if (res.status === 401 && signInUrl) {
        router.push(signInUrl);
        return;
      }
      const data = await res.json() as { url?: string; error?: string };
      if (data.url) {
        router.push(data.url);
      }
    } catch (err) {
      console.error("Checkout failed:", err);
    } finally {
      setLoading(false);
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
      <p className={s.body}>{bodyText}</p>

      {/* Billing toggle — "[switch] · SAVE 20% · Annual plan"
          Switch first, then badge, then label.
          Centered on desktop, right-aligned on mobile via CSS.
          Toggling also re-defaults the tier selection to Preferred. */}
      <div className={s["toggle-wrap"]}>
        <div className={s["toggle-row"]}>
          <button
            type="button"
            role="switch"
            aria-checked={interval === "annual"}
            aria-label="Toggle annual plan"
            className={`${s["switch"]} ${interval === "annual" ? s["switch-on"] : ""}`}
            onClick={() => {
              setInterval(interval === "annual" ? "monthly" : "annual");
              setSelectedTier("preferred");
            }}
          >
            <span className={s["switch-knob"]} aria-hidden />
          </button>
          <span className={s["save-badge"]}>Save 20%</span>
          <span className={s["toggle-label"]}>Annual plan</span>
        </div>
      </div>

      {/* Two equal-width cards, both always visible.
          Each card is a selectable button — clicking sets selectedTier.
          The single CTA at the bottom checks out whichever tier is selected. */}
      <div className={s.cards}>
        {/* Passed */}
        <button
          type="button"
          className={`${s.card} ${s["card-passed"]} ${selectedTier === "passed" ? s["card-selected"] : ""}`}
          onClick={() => setSelectedTier("passed")}
          aria-pressed={selectedTier === "passed"}
          aria-label="Select Passed plan"
        >
          <Tick selected={selectedTier === "passed"} />
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
        </button>

        {/* Preferred — rainbow outline ALWAYS visible (regardless of selection) */}
        <div className={s["preferred-outer"]}>
          <button
            type="button"
            className={`${s.card} ${s["card-preferred"]} ${selectedTier === "preferred" ? s["card-selected"] : ""}`}
            onClick={() => setSelectedTier("preferred")}
            aria-pressed={selectedTier === "preferred"}
            aria-label="Select Preferred plan"
          >
            <span className={s["best-value-flag"]}>BEST VALUE</span>
            <Tick selected={selectedTier === "preferred"} />
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
          </button>
        </div>
      </div>

      {/* Single CTA outside both cards — checks out whichever tier is selected */}
      <div className={s["cta-row"]}>
        <button
          type="button"
          className={`${s.cta} ${loading ? s["cta-loading"] : ""}`}
          onClick={handleCheckout}
          disabled={loading}
        >
          {loading ? "Loading…" : "Get started"}
        </button>
      </div>

      {/* Free demoted to a text link, below the CTA */}
      <button className={s["free-link"]} onClick={onContinueFree}>
        Don&rsquo;t need unlimited job listings? <span className={s["free-link-cta"]}>Continue on Free →</span>
      </button>
    </div>
  );
}

/** Selection tick — top-right of each card. Filled ink circle with white ✓
    when selected; empty outlined circle when not. */
function Tick({ selected }: { selected: boolean }) {
  return (
    <span className={`${s["select-tick"]} ${selected ? s["select-tick-on"] : ""}`} aria-hidden>
      {selected && (
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path
            d="M10.8334 13.8496L16.1956 8.48743L17.0206 9.31238L10.8334 15.4995L7.12109 11.7873L7.94606 10.9623L10.8334 13.8496Z"
            fill="#F4F0E8"
          />
        </svg>
      )}
    </span>
  );
}

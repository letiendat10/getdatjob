"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import s from "./PaywallScreen.module.css";

type Props = {
  jobCount?: number;
  email?: string;
  onContinueFree: () => void;
};

const FREE_FEATURES = [
  "6 job matches/day",
  "USCIS-verified sponsorship data",
  "Sponsorship history (LCA count + last filed)",
  "All visa types (H-1B, OPT, E-3/TN)",
  "Verified company point of contact",
];

const PASSED_FEATURES = [
  "Everything in Free",
  "Unlimited job matches",
];

const PREFERRED_FEATURES = [
  "Everything in Passed",
  "Daily job alerts",
  '"I just got laid off" action plan',
  "Salary benchmarking data",
];

export default function PaywallScreen({ jobCount, onContinueFree }: Props) {
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  const router = useRouter();

  const headerText = jobCount && jobCount > 0
    ? `Unlock ${jobCount} job${jobCount === 1 ? "" : "s"} matching your search in the last 3 days.`
    : "Unlock jobs matching your search in the last 3 days.";

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
      <h2 className={s.header}>{headerText}</h2>
      <p className={s.trust}>✨ Exclusive offer: first month free with WORKINGVISA. Cancel anytime.</p>

      {/* Billing toggle */}
      <div className={s.toggle}>
        <button
          className={`${s["toggle-btn"]} ${interval === "monthly" ? s["toggle-active"] : ""}`}
          onClick={() => setInterval("monthly")}
        >
          Monthly
        </button>
        <button
          className={`${s["toggle-btn"]} ${interval === "annual" ? s["toggle-active"] : ""}`}
          onClick={() => setInterval("annual")}
        >
          Annual <span className={s["save-badge"]}>Save ~20%</span>
        </button>
      </div>

      {/* Tier cards */}
      <div className={s.cards}>
        {/* Free */}
        <div className={`${s.card} ${s["card-free"]}`}>
          <div className={s["card-name"]}>Free</div>
          <div className={s["price-area"]}>
            <span className={s["price-zero"]}>$0</span>
          </div>
          <ul className={s.features}>
            {FREE_FEATURES.map((f) => (
              <li key={f} className={s.feature}>{f}</li>
            ))}
          </ul>
          <button className={`${s.cta} ${s["cta-free"]}`} onClick={onContinueFree}>
            Continue for free
          </button>
        </div>

        {/* Passed */}
        <div className={`${s.card} ${s["card-passed"]}`}>
          <div className={s["card-name"]}>Passed</div>
          <div className={s["price-area"]}>
            <span className={s["price-zero"]}>{passedPrice}</span>
          </div>
          <ul className={s.features}>
            {PASSED_FEATURES.map((f) => (
              <li key={f} className={s.feature}>{f}</li>
            ))}
          </ul>
          <button
            className={`${s.cta} ${s["cta-paid"]} ${loadingTier === "passed" ? s["cta-loading"] : ""}`}
            onClick={() => handleCheckout("passed")}
            disabled={!!loadingTier}
          >
            {loadingTier === "passed" ? "Loading…" : "Get first month free →"}
          </button>
        </div>

        {/* Preferred – rainbow border */}
        <div className={s["preferred-outer"]}>
          <div className={`${s.card} ${s["card-preferred"]}`}>
            <div className={s["recommended-badge"]}>⭐ Recommended</div>
            <div className={s["card-name"]}>Preferred</div>
            <div className={s["price-area"]}>
              <span className={s["price-zero"]}>{preferredPrice}</span>
            </div>
            <ul className={s.features}>
              {PREFERRED_FEATURES.map((f) => (
                <li key={f} className={s.feature}>{f}</li>
              ))}
            </ul>
            <button
              className={`${s.cta} ${s["cta-paid"]} ${loadingTier === "preferred" ? s["cta-loading"] : ""}`}
              onClick={() => handleCheckout("preferred")}
              disabled={!!loadingTier}
            >
              {loadingTier === "preferred" ? "Loading…" : "Get first month free →"}
            </button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className={s.footer}>
        <p className={s["footer-trust"]}>Trusted by 1,120 working visa holders.</p>
        <p className={s["footer-promo"]}>
          Promo code{" "}
          <span className={s["promo-code"]}>WORKINGVISA</span>{" "}
          auto-applied — first month free. One redemption per user.
        </p>
      </div>
    </div>
  );
}

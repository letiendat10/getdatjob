import type { Metadata } from "next";
import Link from "next/link";
import PricingClient from "./PricingClient";
import s from "../landing.module.css";

export const metadata: Metadata = {
  title: "Pricing — getdatjob",
  description:
    "Two plans for working visa holders. First month on us. Unlimited access to verified visa-sponsoring employer matches.",
  openGraph: {
    title: "Pricing — getdatjob",
    description:
      "Two plans for working visa holders. First month on us. Unlimited access to verified visa-sponsoring employer matches.",
    url: "https://getdatjob.app/pricing",
    type: "website",
  },
};

// Visually-hidden style for the SEO H1. PaywallScreen renders its own
// brand-headline as the visible H2; this gives the page a proper H1 without
// duplicating the headline visually.
const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

export default function PricingPage() {
  return (
    <div className={s.page}>

      {/* NAV — minimal centered wordmark. No CTA on /pricing because the
          pricing cards themselves are the call to action; another CTA in
          the nav would compete. Inline justify-content override on the
          existing flex container. */}
      <header className={s.nav}>
        <div
          className={`${s.wrap} ${s["nav-inner"]}`}
          style={{ justifyContent: "center" }}
        >
          <Link href="/" className={s.brand} aria-label="getdatjob — home">
            getdatjob
          </Link>
        </div>
      </header>

      {/* MAIN — PaywallScreen carries its own headline, trust pill,
          cards, CTA, and Free link. We just give it vertical room. */}
      <main>
        <h1 style={srOnly}>Pricing</h1>
        <section style={{ padding: "32px 0 64px" }}>
          <div className={s.wrap}>
            <PricingClient />
          </div>
        </section>
      </main>

      {/* FOOTER — mirrors LandingPage.tsx. Resources column now leads with
          Pricing. Keep wordmark + legal bar so the page reads as part of
          the same site. */}
      <footer className={s.footer}>
        <div className={s["footer-cols"]}>

          {/* Column 1: Brand */}
          <div className={`${s.fcol} ${s["fcol-brand"]}`}>
            <h4 className={s["brand-title"]}>getdatjob</h4>
            <p className={s["fcol-tagline"]}>
              Built for visa holders,<br />by a working visa holder
            </p>
            <Link href="/jobs" className={s["brand-cta"]}>
              Get access
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="13 6 19 12 13 18" />
              </svg>
            </Link>

            <div className={s["sub-h"]}>Connect with us</div>
            <div className={s["inline-connect"]}>
              <a href="https://linkedin.com/company/getdatjob" target="_blank" rel="noopener">LinkedIn</a>
              <span className={s["inline-connect-sep"]} aria-hidden="true">.</span>
              <a href="mailto:support@getdatjob.com">Support</a>
              <span className={s["inline-connect-sep"]} aria-hidden="true">.</span>
              <a href="mailto:press@getdatjob.com">Press</a>
              <span className={s["inline-connect-sep"]} aria-hidden="true">.</span>
            </div>
          </div>

          {/* Columns 2 & 3: Jobs by visa + Jobs by category */}
          <div className={s["footer-jobs-group"]}>
            <div className={s.fcol}>
              <h4>Jobs by visa</h4>
              <div className={s["fcol-links"]}>
                <Link href="/jobs?visa=h1b">H-1B jobs</Link>
                <Link href="/jobs?visa=e3">E-3 jobs</Link>
                <Link href="/jobs?visa=tn">TN jobs</Link>
                <Link href="/jobs?visa=opt">OPT jobs</Link>
              </div>
            </div>

            <div className={s.fcol}>
              <h4>Jobs by category</h4>
              <div className={s["fcol-links"]}>
                <Link href="/jobs?q=AI+Engineer">AI jobs</Link>
                <Link href="/jobs?q=Software+Engineer">Tech jobs</Link>
                <Link href="/jobs?q=Engineering">Engineering jobs</Link>
                <Link href="/jobs?q=Designer">Design jobs</Link>
                <Link href="/jobs?q=Product+Manager">Product jobs</Link>
                <Link href="/jobs?q=Finance">Finance jobs</Link>
              </div>
            </div>
          </div>

          {/* Column 4: Resources — Pricing leads */}
          <div className={s.fcol}>
            <h4>Resources</h4>
            <div className={s["fcol-links"]}>
              <Link href="/pricing">Pricing</Link>
              <a href="/#laidoff">&ldquo;I just got laid off&rdquo; plan</a>
              <a href="/#laidoff">60-day grace period</a>
              <a href="/#salary">Salary data</a>
            </div>
          </div>

        </div>

        <div className={s["footer-mark"]}>
          <svg
            viewBox="0 -201 908 260"
            width="100%"
            overflow="hidden"
            style={{ display: "block" }}
            aria-label="getdatjob"
            role="img"
          >
            <defs>
              <linearGradient id="wm-grad" x1="0" y1="-201" x2="0" y2="59" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="55%" stopColor="rgba(255,255,255,0.65)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </linearGradient>
            </defs>
            <text
              x="0"
              y="0"
              fontSize="200"
              fill="url(#wm-grad)"
              style={{
                fontFamily: "var(--font-geist-sans), sans-serif",
                fontWeight: 600,
                letterSpacing: "-0.015em",
              }}
            >
              getdatjob
            </text>
          </svg>
        </div>

        <div className={s.legal}>
          <p>© 2026 getdatjob, Inc. All rights reserved.</p>
          <div className={s["legal-links"]}>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </div>
        </div>
      </footer>

    </div>
  );
}

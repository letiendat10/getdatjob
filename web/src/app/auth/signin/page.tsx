import type { Metadata } from "next";
import Link from "next/link";
import SignInButton from "@/app/components/SignInButton";
import s from "./signin.module.css";

export const metadata: Metadata = {
  title: "Sign in — getdatjob",
  robots: { index: false, follow: false },
};

const CDN = "https://cdn.jsdelivr.net/gh/gilbarbara/logos@latest/logos";

const SHELF_LOGOS = [
  { name: "google", alt: "Google" },
  { name: "apple", alt: "Apple" },
  { name: "microsoft", alt: "Microsoft" },
  { name: "meta", alt: "Meta" },
  { name: "netflix-icon", alt: "Netflix" },
  { name: "stripe", alt: "Stripe" },
  { name: "openai", alt: "OpenAI" },
  { name: "github", alt: "GitHub" },
  { name: "twilio", alt: "Twilio" },
  { name: "figma", alt: "Figma" },
  { name: "oracle", alt: "Oracle" },
  { name: "datadog", alt: "Datadog" },
  { name: "slack", alt: "Slack" },
  { name: "airbnb", alt: "Airbnb" },
  { name: "atlassian", alt: "Atlassian" },
  { name: "adobe", alt: "Adobe" },
  { name: "salesforce", alt: "Salesforce" },
  { name: "nvidia", alt: "NVIDIA" },
  { name: "shopify", alt: "Shopify" },
  { name: "linkedin", alt: "LinkedIn" },
  { name: "zoom", alt: "Zoom" },
  { name: "spotify", alt: "Spotify" },
  { name: "okta", alt: "Okta" },
];

const LinkedInIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

export default function SignInPage() {
  return (
    <div className={s.page}>

      {/* ── Nav ── */}
      <header className={s.nav}>
        <div className={s["nav-inner"]}>
          <Link href="/" className={s.brand}>getdatjob</Link>
        </div>
      </header>

      {/* ── Main centered content ── */}
      <div className={s.main}>
        <div className={s.center}>

          {/* Headline */}
          <div className={s.headline}>
            <span className={s["hl-primary"]}>Welcome!</span>
            <span className={s["hl-muted"]}>What&rsquo;s your <em>LinkedIn?</em></span>
          </div>

          {/* Card */}
          <div className={s.card}>
            <p className={s.body}>
              We read your LinkedIn profile — name, role, location. Nothing else. We never post.
            </p>

            <SignInButton
              className={s.btn}
              label={
                <>
                  <LinkedInIcon />
                  Continue with LinkedIn
                </>
              }
            />

            <p className={s.legal}>
              By continuing you agree to our{" "}
              <Link href="/privacy">Privacy Policy</Link>
              {" "}and{" "}
              <Link href="/terms">Terms</Link>.
            </p>
          </div>

        </div>
      </div>

      {/* ── Company logo shelf ── */}
      <div className={s.shelf}>
        <p className={s["shelf-label"]}>USCIS-verified visa-sponsoring companies</p>
        <div className={s.marquee}>
          <div className={s.track}>
            {SHELF_LOGOS.map((l) => (
              <span key={l.name} className={s.logo}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${CDN}/${l.name}.svg`} alt={l.alt} height={24} loading="eager" />
              </span>
            ))}
            {/* Duplicate for seamless infinite scroll */}
            {SHELF_LOGOS.map((l) => (
              <span key={`${l.name}-dup`} className={s.logo} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${CDN}/${l.name}.svg`} alt="" height={24} loading="eager" />
              </span>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}

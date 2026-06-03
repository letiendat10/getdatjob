import type { ReactNode } from "react";
import Link from "next/link";
import TestimonialsCarousel from "./TestimonialsCarousel";
import HeroCardStack from "./HeroCardStack";
import s from "../landing.module.css";
import { getStats, formatStat, type VisaStat } from "@/lib/stats";

// ── Laurel leaf SVG ──────────────────────────────────────────────────────────

function LaurelSVG({ flip }: { flip?: boolean }) {
  return (
    <svg
      className={flip ? `${s["laurel-svg"]} ${s.r}` : s["laurel-svg"]}
      viewBox="0 0 30 60"
      fill="currentColor"
      aria-hidden="true"
    >
      <ellipse cx="22" cy="54" rx="5.5" ry="2.2" transform="rotate(-35 22 54)" />
      <ellipse cx="16" cy="46" rx="6" ry="2.4" transform="rotate(-55 16 46)" />
      <ellipse cx="11" cy="36" rx="6.2" ry="2.5" transform="rotate(-75 11 36)" />
      <ellipse cx="9" cy="26" rx="6.2" ry="2.5" transform="rotate(-95 9 26)" />
      <ellipse cx="11" cy="16" rx="6" ry="2.4" transform="rotate(-115 11 16)" />
      <ellipse cx="17" cy="8" rx="5.5" ry="2.2" transform="rotate(-140 17 8)" />
    </svg>
  );
}

// ── Marquee logo rows ────────────────────────────────────────────────────────

const CDN = "https://cdn.jsdelivr.net/gh/gilbarbara/logos@latest/logos";

function Logo({ name, alt }: { name: string; alt: string }) {
  return (
    <span className={s.logo}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${CDN}/${name}.svg`} alt={alt} height={26} loading="eager" />
    </span>
  );
}

function LogoSet({ row }: { row: 1 | 2 }) {
  if (row === 1) {
    return (
      <>
        <Logo name="google" alt="Google" />
        <Logo name="apple" alt="Apple" />
        <Logo name="microsoft" alt="Microsoft" />
        <Logo name="meta" alt="Meta" />
        <Logo name="netflix-icon" alt="Netflix" />
        <Logo name="stripe" alt="Stripe" />
        <Logo name="openai" alt="OpenAI" />
        <Logo name="github" alt="GitHub" />
        <Logo name="twilio" alt="Twilio" />
        <Logo name="figma" alt="Figma" />
        <Logo name="oracle" alt="Oracle" />
        <Logo name="datadog" alt="Datadog" />
      </>
    );
  }
  return (
    <>
      <Logo name="slack" alt="Slack" />
      <Logo name="airbnb" alt="Airbnb" />
      <Logo name="atlassian" alt="Atlassian" />
      <Logo name="adobe" alt="Adobe" />
      <Logo name="salesforce" alt="Salesforce" />
      <Logo name="nvidia" alt="NVIDIA" />
      <Logo name="shopify" alt="Shopify" />
      <Logo name="linkedin" alt="LinkedIn" />
      <Logo name="zoom" alt="Zoom" />
      <Logo name="spotify" alt="Spotify" />
      <Logo name="okta" alt="Okta" />
    </>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface LandingPageProps {
  headline: ReactNode;
  body: string;
  ctaHref?: string;
  primaryCtaHref?: string;
}

const FALLBACK_VISA: Record<string, VisaStat> = {
  h1b: { jobs: 121000, employers: 287 },
  e3:  { jobs: 30500,  employers: 56  },
  tn:  { jobs: 25200,  employers: 267 },
  opt: { jobs: 121000, employers: 290 },
};

export default async function LandingPage({ headline, body, ctaHref = "/jobs", primaryCtaHref = "/auth/signin" }: LandingPageProps) {
  let totalJobs = 121000;
  let employerCount = 290;
  let byVisa: Record<string, VisaStat> = FALLBACK_VISA;
  try {
    ({ totalJobs, employerCount, byVisa } = await getStats());
  } catch {
    // Supabase unavailable or returned bad data — use safe fallback so page renders
  }
  return (
    <div className={s.page}>

      {/* NAV */}
      <header className={s.nav}>
        <div className={`${s.wrap} ${s["nav-inner"]}`}>
          <div className={s.brand}>getdatjob</div>
          <Link href={ctaHref} className={`${s.btn} ${s["btn-dark"]}`}>
            Get access
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
            </svg>
          </Link>
        </div>
      </header>

      {/* HERO */}
      <section className={s.hero}>
        <div className={`${s.wrap} ${s["hero-wrap"]}`}>

          {/* Laurel trust bar */}
          <div className={s["hero-laurel"]}>
            <div className={s["laurel-item"]}>
              <LaurelSVG />
              <div className={s["laurel-content"]}>
                <b className={s["laurel-b"]}>{formatStat(totalJobs)}</b>
                <span className={s["laurel-lbl"]}>up-to-date<br />jobs</span>
              </div>
              <LaurelSVG flip />
            </div>
            <div className={s["laurel-item"]}>
              <LaurelSVG />
              <div className={s["laurel-content"]}>
                <b className={s["laurel-b"]}>{formatStat(employerCount)}</b>
                <span className={s["laurel-lbl"]}>sponsoring<br />employers</span>
              </div>
              <LaurelSVG flip />
            </div>
            <div className={s["laurel-item"]}>
              <LaurelSVG />
              <div className={s["laurel-content"]}>
                <b className={s["laurel-b"]}>3,000+</b>
                <span className={s["laurel-lbl"]}>members</span>
                <span className={s["laurel-stars"]}>★★★★★</span>
              </div>
              <LaurelSVG flip />
            </div>
          </div>

          <h1 className={s["hero-title"]}>{headline}</h1>
          <p className={s["hero-sub"]}>{body}</p>
          <div className={s["hero-cta"]}>
            <Link href={primaryCtaHref} className={s["btn-primary"]}>
              Get dat job{" "}
              <span className={s.arr}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="13 6 19 12 13 18" />
                </svg>
              </span>
            </Link>
          </div>

          {/* Hero media — click goes to sign-in */}
          <Link href={primaryCtaHref} className={s["hero-media"]}>
            <HeroCardStack />
          </Link>

        </div>
      </section>

      {/* TRUSTED BY */}
      <section className={s.trusted}>
        <p className={s["trusted-label"]}>Trusted by working visa holders at</p>

        {/* Row 1: scroll left */}
        <div className={s.marquee}>
          <div className={`${s.logos} ${s["marquee-track"]}`}>
            <LogoSet row={1} />
            <LogoSet row={1} />
          </div>
        </div>

        {/* Row 2: scroll right */}
        <div className={s.marquee}>
          <div className={`${s.logos} ${s["marquee-track"]} ${s.reverse}`}>
            <LogoSet row={2} />
            <LogoSet row={2} />
          </div>
        </div>
      </section>

      {/* BENEFITS */}
      <section className={s.section}>
        <div className={s["wrap-85"]}>
          <h2 className={s["section-title"]}>More than <em>just a job board.</em></h2>

          <div className={s.benefits}>

            {/* 1 – Save time */}
            <div className={s["benefit-row"]}>
              <div className={s["benefit-image"]}>
                <div className={s["ph-stripes"]} />
              </div>
              <div className={s["benefit-content"]}>
                <div className={s["benefit-icon"]}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div className={s["benefit-tag"]}>Save time</div>
                <h3>Stop reading &lsquo;no sponsorship&rsquo;.</h3>
                <p>We do the work so you don&rsquo;t waste 10 minutes every time reading a &ldquo;no sponsorship for this role&rdquo; job listing.</p>
              </div>
            </div>

            {/* 2 – Apply with confidence */}
            <div className={`${s["benefit-row"]} ${s.reverse}`}>
              <div className={s["benefit-image"]}>
                <div className={s["ph-stripes"]} />
              </div>
              <div className={s["benefit-content"]}>
                <div className={s["benefit-icon"]}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div className={s["benefit-tag"]}>Apply with confidence</div>
                <h3>No more guesswork</h3>
                <p>&ldquo;Do they sponsor?&rdquo; Confirmed. Only job listings from USCIS-verified visa-sponsoring employers are curated.</p>
              </div>
            </div>

            {/* 3 – Know your worth */}
            <div id="salary" className={s["benefit-row"]}>
              <div className={s["benefit-image"]}>
                <div className={s["ph-stripes"]} />
              </div>
              <div className={s["benefit-content"]}>
                <div className={s["benefit-icon"]}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                </div>
                <div className={s["benefit-tag"]}>Know your worth</div>
                <h3>Know how much was paid.</h3>
                <p>Historical salary data and visa sponsorship records at your fingertips, before you hit apply.</p>
              </div>
            </div>

            {/* 4 – Plan ahead */}
            <div id="laidoff" className={`${s["benefit-row"]} ${s.reverse}`}>
              <div className={s["benefit-image"]}>
                <div className={s["ph-stripes"]} />
              </div>
              <div className={s["benefit-content"]}>
                <div className={s["benefit-icon"]}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <div className={s["benefit-tag"]}>Plan ahead</div>
                <h3>If you get laid off today?</h3>
                <p>60-day action plan in your pocket. No panic attack and no googling at 2am. We&rsquo;re sorry if this happens!</p>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* VISA TYPES */}
      <section className={s.section} style={{ background: 'var(--bg-2)' }}>
        <div className={s["wrap-85"]}>
          <h2 className={s["section-title"]}>Every visa, <em>covered.</em></h2>
          <div className={s["visa-grid"]}>

            <div className={s["visa-card"]}>
              <div className={s.ico}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18" />
                </svg>
              </div>
              <h3>H-1B</h3>
              <p>Specialty occupation visa. Annual lottery in March with ~25% selection odds. Easy to transfer between employers once you've got it.</p>
              <div className={s["visa-stats"]}>
                <div className={s.vs}><b>{formatStat(byVisa.h1b.jobs)}</b><span className={s.vl}>Open jobs</span></div>
                <div className={s.vs}><b>{byVisa.h1b.employers.toLocaleString("en-US")}+</b><span className={s.vl}>Employers</span></div>
              </div>
              <Link href="/jobs?visa=h1b" className={s["visa-cta"]}>
                Browse H-1B jobs
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
                </svg>
              </Link>
            </div>

            <div className={s["visa-card"]}>
              <div className={s.ico}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12h18M3 6h18M3 18h18" />
                </svg>
              </div>
              <h3>TN</h3>
              <p>Canada and Mexico under USMCA. Apply at the border, start in days.</p>
              <div className={s["visa-stats"]}>
                <div className={s.vs}><b>{formatStat(byVisa.tn.jobs)}</b><span className={s.vl}>Open jobs</span></div>
                <div className={s.vs}><b>{byVisa.tn.employers.toLocaleString("en-US")}+</b><span className={s.vl}>Employers</span></div>
              </div>
              <Link href="/jobs?visa=tn" className={s["visa-cta"]}>
                Browse TN jobs
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
                </svg>
              </Link>
            </div>

            <div className={s["visa-card"]}>
              <div className={s.ico}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20" />
                </svg>
              </div>
              <h3>E-3</h3>
              <p>Australia-only. Easier than H-1B with 10,500 slots reserved each year.</p>
              <div className={s["visa-stats"]}>
                <div className={s.vs}><b>{formatStat(byVisa.e3.jobs)}</b><span className={s.vl}>Open jobs</span></div>
                <div className={s.vs}><b>{byVisa.e3.employers.toLocaleString("en-US")}+</b><span className={s.vl}>Employers</span></div>
              </div>
              <Link href="/jobs?visa=e3" className={s["visa-cta"]}>
                Browse E-3 jobs
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
                </svg>
              </Link>
            </div>

            <div className={s["visa-card"]}>
              <div className={s.ico}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c0 1 4 3 6 3s6-2 6-3v-5" />
                </svg>
              </div>
              <h3>OPT</h3>
              <p>For recent grads. Find E-Verified employers who can extend you up to 3 years.</p>
              <div className={s["visa-stats"]}>
                <div className={s.vs}><b>{formatStat(byVisa.opt.jobs)}</b><span className={s.vl}>Open jobs</span></div>
                <div className={s.vs}><b>{byVisa.opt.employers.toLocaleString("en-US")}+</b><span className={s.vl}>Employers</span></div>
              </div>
              <Link href="/jobs?visa=opt" className={s["visa-cta"]}>
                Browse OPT jobs
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
                </svg>
              </Link>
            </div>

          </div>
        </div>
      </section>

      {/* FOUNDER */}
      <section className={s["founder-section"]}>
        <div className={s["founder-card"]}>
          <div className={s["founder-photo"]}>
            <div className={s["founder-photo-inner"]} />
          </div>
          <div className={s["founder-text"]}>
            <h2 className={s["founder-h"]}>Built for visa holders,<br />by a <em>H-1B visa holder.</em></h2>
            <p>Hey, I&rsquo;m Dat.</p>
            <p>I moved to the US in 2018 on L-1A visa.</p>
            <p>Then I switched to H-1B visa on the first lottery (very lucky).</p>
            <p>Then I got laid off, three times (here comes bad luck).</p>
            <p>Each time, I found a new job to transfer my H-1B – always in status, without leaving the US.</p>
            <p>Each time, I wished there was a tool that helps the panic attack at 2am less terrifying.</p>
            <p>There wasn&rsquo;t. So I built one for all of us.</p>
          </div>
        </div>
      </section>

      {/* TESTIMONIALS */}
      <section className={s["testimonials-section"]}>
        <div className={s.wrap}>
          <h2 className={s["section-title"]}>Real visa holders. <em>Real wins.</em></h2>
          <TestimonialsCarousel />
        </div>
      </section>

      {/* FAQ */}
      <section className={s.faq}>
        <div className={s.wrap}>
          <h2 className={s["faq-title"]}>Frequently asked <em>questions</em></h2>
          <div className={s["faq-list"]}>

            <details>
              <summary>What is getdatjob?<span className={s.plus}>+</span></summary>
              <div className={s.ans}>getdatjob is a curated job board built specifically for working visa holders. Every employer on the board is verified for sponsorship history including H-1B, E-3, TN, and OPT. So you can save time from reading ghost jobs and interviewing with companies that won&rsquo;t sponsor your visas.</div>
            </details>

            <details>
              <summary>How do you know which companies sponsor?<span className={s.plus}>+</span></summary>
              <div className={s.ans}>In order to be confident about which companies sponsor, we don&rsquo;t guess or collect user data. Instead, we pull data directly from the US government (<a href="https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub" target="_blank" rel="noopener noreferrer">USCIS</a>) including Department of Labor (DOL) and Labor Condition Application (LCA) filings to see companies&rsquo; history of H-1B approvals, which indicates a willingness to sponsor visas. If a company isn&rsquo;t in the database, we don&rsquo;t put them and their jobs on the board. You can manually do that too for every single company but it takes time that would otherwise be spent on interviewing.</div>
            </details>

            <details>
              <summary>Which visa types do you cover?<span className={s.plus}>+</span></summary>
              <div className={s.ans}>Currently, we&rsquo;re covering H-1B, E-3 (Australia), TN (Canada/Mexico), and OPT. But we will be expanding to cover others. Just <a href="mailto:support@getdatjob.app">reach out to us</a> if you have any recommendations.</div>
            </details>

            <details>
              <summary>How often are listings updated?<span className={s.plus}>+</span></summary>
              <div className={s.ans}>Job market is moving super fast and we&rsquo;re committed to get you ahead of the line so our jobs are updating every hour. Jobs posted more than 14 days ago are automatically skipped. And we re-verify all job listings every day so you&rsquo;ll never waste time reading a job listing that&rsquo;s already closed.</div>
            </details>

            <details>
              <summary>Can I switch visa categories through getdatjob?<span className={s.plus}>+</span></summary>
              <div className={s.ans}>getdatjob is a curated job board, not a law firm. We can&rsquo;t give legal advice. Please consult a licensed immigration attorney before making any decisions about your status. My advice: always double check with your attorney.</div>
            </details>

            <details>
              <summary>How is this different from LinkedIn or Indeed?<span className={s.plus}>+</span></summary>
              <div className={s.ans}>Those job boards bury sponsorship behind self-reported employer settings, which are wrong half the time. We verify with public government data and don&rsquo;t show you roles that won&rsquo;t sponsor your status.</div>
            </details>

          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className={s.footer}>
        <div className={s["footer-cols"]}>

          {/* Column 1: Brand */}
          <div className={`${s.fcol} ${s["fcol-brand"]}`}>
            <h4 className={s["brand-title"]}>getdatjob</h4>
            <p className={s["fcol-tagline"]}>Built for visa holders,<br />by a working visa holder</p>
            <Link href={ctaHref} className={s["brand-cta"]}>
              Get access
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
              </svg>
            </Link>

            <div className={s["sub-h"]}>Connect with us</div>
            <div className={s["inline-connect"]}>
              <a href="https://linkedin.com/company/getdatjob" target="_blank" rel="noopener">LinkedIn</a><span className={s["inline-connect-sep"]} aria-hidden="true">.</span><a href="mailto:support@getdatjob.com">Support</a><span className={s["inline-connect-sep"]} aria-hidden="true">.</span><a href="mailto:press@getdatjob.com">Press</a><span className={s["inline-connect-sep"]} aria-hidden="true">.</span>
            </div>

            <div className={s["sub-h"]}>Ask AI about getdatjob</div>
            <div className={s["icon-row"]}>
              <a className={s["icon-tile"]} target="_blank" rel="noopener" href="https://claude.ai/new?q=I%27m%20considering%20using%20getdatjob%20%28getdatjob.com%29%20and%20want%20to%20understand%20exactly%20what%20I%27ll%20get.%20Can%20you%20walk%20me%20through%20the%20experience%20step%20by%20step%3F" aria-label="Ask Claude">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/claude.png" alt="Claude" />
              </a>
              <a className={s["icon-tile"]} target="_blank" rel="noopener" href="https://chatgpt.com/?q=I%27m%20considering%20using%20getdatjob%20%28getdatjob.com%29%20and%20want%20to%20understand%20exactly%20what%20I%27ll%20get.%20Can%20you%20walk%20me%20through%20the%20experience%20step%20by%20step%3F" aria-label="Ask ChatGPT">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/openai.png" alt="ChatGPT" />
              </a>
              <a className={s["icon-tile"]} target="_blank" rel="noopener" href="https://gemini.google.com/app?q=I%27m%20considering%20using%20getdatjob%20%28getdatjob.com%29%20and%20want%20to%20understand%20exactly%20what%20I%27ll%20get.%20Can%20you%20walk%20me%20through%20the%20experience%20step%20by%20step%3F" aria-label="Ask Gemini">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/gemini.png" alt="Gemini" />
              </a>
              <a className={s["icon-tile"]} target="_blank" rel="noopener" href="https://grok.com/?q=I%27m%20considering%20using%20getdatjob%20%28getdatjob.com%29%20and%20want%20to%20understand%20exactly%20what%20I%27ll%20get.%20Can%20you%20walk%20me%20through%20the%20experience%20step%20by%20step%3F" aria-label="Ask Grok">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/xai.png" alt="Grok" />
              </a>
              <a className={s["icon-tile"]} target="_blank" rel="noopener" href="https://www.perplexity.ai/?q=I%27m%20considering%20using%20getdatjob%20%28getdatjob.com%29%20and%20want%20to%20understand%20exactly%20what%20I%27ll%20get.%20Can%20you%20walk%20me%20through%20the%20experience%20step%20by%20step%3F" aria-label="Ask Perplexity">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/perplexity.png" alt="Perplexity" />
              </a>
            </div>
          </div>

          {/* Columns 2 & 3: Jobs by visa + Jobs by category — side-by-side on mobile */}
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

          {/* Column 4: Resources */}
          <div className={s.fcol}>
            <h4>Resources</h4>
            <div className={s["fcol-links"]}>
              <Link href="/pricing">Pricing</Link>
              <a href="#laidoff">&ldquo;I just got laid off&rdquo; plan</a>
              <a href="#laidoff">60-day grace period</a>
              <a href="#salary">Salary data</a>
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
              style={{ fontFamily: "var(--font-geist-sans), sans-serif", fontWeight: 600, letterSpacing: "-0.015em" }}
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

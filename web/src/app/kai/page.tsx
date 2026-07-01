"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import s from "./kai.module.css";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { Bookmark, MapPin, ExternalLink, X, Share2 } from "lucide-react";
import { JobChips } from "@/app/components/JobChips";
import { CompanyAvatar } from "@/app/components/CompanyAvatar";
import PaywallScreen from "@/app/components/PaywallScreen";
import { levelFromTitle, levelLabel } from "@/lib/taxonomy";
import { normalizeCityState } from "@/lib/location";
import { useChatScroll } from "@/lib/useChatScroll";

// Feature flag: "paywall" → Stripe gate after batch1 (FREE_DAILY_MATCHES shown)
//               anything else → Venmo support screen after batch2 (3+3 jobs shown)
const PAYWALL_MODE = process.env.NEXT_PUBLIC_PAYWALL_PAGE === "paywall";

// Free tier: matches shown per day before the paywall. Keep the gate and its copy in sync.
const FREE_DAILY_MATCHES = 7;

// ── Types ─────────────────────────────────────────────────────────────────────

type Job = {
  id: number;
  title: string;
  company: string;
  company_domain: string | null;
  location: string | null;
  url: string | null;
  posted_at: string | null;
  effective_posted_at: string | null;
  department: string | null;
  job_level: string | null;
  is_remote: boolean | null;
  visa_tier: string | null;
  salary_range: string | null;
  lca_count: number | null;
  lca_count_2025: number | null;
  lca_last_filed: string | null;
  e3_lca_count: number | null;
  ats_source: string | null;
  ats_job_id: string | null;
  poc_first_name: string | null;
  poc_last_name: string | null;
  poc_email: string | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  jobs?: Job[];
  isThinking?: boolean;
  isStreaming?: boolean;
  isRateLimited?: boolean;
};

type QR = { label: string; value: string; row?: number };

type UserProfile = {
  id: string;
  firstName: string | null;
  email: string | null;
  avatar: string | null;
};

type LinkedInProfile = {
  headline: string | null;
};

type EnrichedProfile = {
  current_title: string | null;
  location: string | null;
  job_function: string | null;
  job_level: string | null;
};

// All steps from both flows — only the relevant subset is reachable per PAYWALL_MODE.
// Paywall flow:  q6 → alert_optin → scanning → batch1 → (auto) see_more → paywall → done
// Venmo flow:    q6 → scanning → batch1 → email_optin → batch2 → support → done
type OnboardingStep =
  | "init"
  | "q1"
  | "q1_layoff_date"
  | "q2"
  | "q3"
  | "q4"
  | "q4b"  // pivot target — shown when user picks "Other" at Q4
  | "q5"
  | "q6"
  | "scanning"
  | "batch1"
  // paywall mode
  | "alert_optin"
  | "see_more"
  | "paywall"
  // venmo mode
  | "email_optin"
  | "batch2"
  | "support"
  | "done";

type IntakeData = {
  intent: string | null;
  layoffDate: string | null;
  location: string | null;
  locationMode: string | null;
  visa: string | null;
  salaryMin: number | null;
  level: string | null;
  jobFunction: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY_NAME_OVERRIDES: Record<string, string> = {
  "social finance": "SoFi",
  "at&t services": "AT&T",
  "at&t mobility services": "AT&T",
  "at&t": "AT&T",
  "bank of america": "Bank of America",
  "the pnc financial services group": "PNC",
  "united services automobile association": "USAA",
  "american express travel related services company": "American Express",
  "standard & poor's financial services": "S&P Global",
  "s&p global market intelligence": "S&P Global",
  "laboratory corporation of america holdings": "LabCorp",
  "intercontinental exchange holdings": "ICE",
  "susquehanna international group": "SIG",
  "citadel enterprise americas services": "Citadel",
  "citadel securities americas services": "Citadel Securities",
  "bernstein institutional services": "AllianceBernstein",
  "galileo financial technologies": "Galileo",
  "deloitte touche tohmatsu services": "Deloitte",
  "deloitte transactions and business analytics": "Deloitte",
  "pricewaterhousecoopers advisory services": "PwC",
  "pricewaterhousecoopers": "PwC",
  "mckinsey & company united states": "McKinsey",
  "mckinsey & company": "McKinsey",
  "space exploration technologies": "SpaceX",
  "flextronics international usa": "Flex",
  "environmental systems research institute": "Esri",
  "cognizant trizetto software group": "Cognizant",
  "cognizant technology solutions us": "Cognizant",
  "hsbc technology & services": "HSBC",
  "cigna health and life insurance company": "Cigna",
  "united parcel service general services": "UPS",
  "foot locker corporate services": "Foot Locker",
  "macy's systems and technology": "Macy's",
  "openai opco": "OpenAI",
  "london stock exchange group holdings": "LSEG",
  "general dynamics information technology": "GDIT",
  "robinhood markets": "Robinhood",
};

function normalizeCompanyName(name: string): string {
  const cleaned = name
    .replace(/,?\s+(incorporated|inc\.?|l\.?l\.?c\.?|l\.?l\.?p\.?|corporation|corp\.?|limited|ltd\.?|co\.|l\.p\.?|\blp\b|pbc|p\.c\.|pllc|n\.a\.?|\bopco\b)\.?\s*$/i, "")
    .trim();
  const override = COMPANY_NAME_OVERRIDES[cleaned.toLowerCase()];
  if (override) return override;
  const letters = cleaned.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    return cleaned.split(/\s+/).map((w) => {
      const alpha = w.replace(/[^a-zA-Z]/g, "");
      const isAcronym = /^[A-Z]{1,4}$/.test(w);
      const isSymbolAcronym = alpha.length > 0 && alpha === alpha.toUpperCase() && w.length > alpha.length;
      return isAcronym || isSymbolAcronym ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(" ");
  }
  return cleaned;
}

function extractPostedSalary(html: string): string | null {
  const decoded = html
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–").replace(/&nbsp;/gi, " ");
  const text = decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const dollarRange = text.match(/\$[\d,]+(?:\.\d+)?K?\s*(?:[–—\-]+|to)\s*\$[\d,]+(?:\.\d+)?K?/i);
  if (dollarRange) return dollarRange[0].replace(/\s+/g, " ").trim();
  const usdRange = text.match(/([\d,]+(?:\.\d+)?)\s*[-–—]\s*([\d,]+(?:\.\d+)?)\s*USD/i);
  if (usdRange) {
    const lo = Math.round(parseFloat(usdRange[1].replace(/,/g, "")));
    const hi = Math.round(parseFloat(usdRange[2].replace(/,/g, "")));
    if (lo > 10000 && hi > lo) return `$${lo.toLocaleString()} – $${hi.toLocaleString()}`;
  }
  return null;
}

function timeAgo(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function postedWithin(jobs: { posted_at: string | null }[]): string | null {
  const dates = jobs.map((j) => j.posted_at ? new Date(j.posted_at).getTime() : null).filter(Boolean) as number[];
  if (dates.length === 0) return null;
  const oldestHours = Math.floor((Date.now() - Math.min(...dates)) / 3600000);
  if (oldestHours < 24) return "the last 24 hours";
  if (oldestHours < 48) return "the last 2 days";
  const days = Math.ceil(oldestHours / 24);
  if (days <= 7) return "the last week";
  if (days <= 14) return "the last 2 weeks";
  return "the last month";
}

// How the onboarding search was widened vs the user's exact ask (null = strict hit).
// Mirrors the `broadened` field returned by /api/onboarding/jobs.
type Broadened =
  | { kind: "window"; days: number }
  | { kind: "salary"; days: number }
  | { kind: "nationwide"; days: number }
  | null;

const VERIFIED_NOTE =
  "\n\nThe ones marked 'Verified LCA Filings' mean the company has filed an LCA with a similar job title before, so the sponsorship signal is extremely high.";

// Honest, capture-on-zero copy. The employer is always the subject of sponsorship.
const ZERO_CAPTURE =
  "Genuinely nothing live for this exact search today, and I won't pad it with employers that don't sponsor.";

function broadenDayLabel(days: number): string {
  if (days <= 7) return "7 days";
  if (days <= 14) return "2 weeks";
  return "30 days";
}

// One reveal line for BOTH the Venmo and Paywall paths, so they can never drift. When the
// search had to widen, Kai says so plainly instead of pretending the strict ask hit.
function revealLineFor(
  broadened: Broadened,
  ctx: { total: number; capped: boolean; place: string | null; hasVerified: boolean; freshLabel?: string | null },
): string {
  const plus = ctx.capped ? "+" : "";
  const roleWord = ctx.total === 1 && !ctx.capped ? "role" : "roles";
  const roles = `${ctx.total}${plus} ${roleWord} from employers that sponsor`;
  const place = ctx.place && ctx.place !== "anywhere in the US" ? ctx.place : null;
  let line: string;
  if (!broadened) {
    line = `Found ${roles}${ctx.freshLabel ? `, posted within ${ctx.freshLabel}` : ""}.`;
  } else if (broadened.kind === "window") {
    line = `Expanded to the last ${broadenDayLabel(broadened.days)} to get you more. Found ${roles}.`;
  } else if (broadened.kind === "salary") {
    line = `Eased your salary floor a bit to open things up. Found ${roles}.`;
  } else {
    line = `${place ? `Slim pickings in ${place} this week` : "Slim pickings this week"}, so I opened it up across the US. Found ${roles}. Some may mean relocating.`;
  }
  return ctx.hasVerified ? line + VERIFIED_NOTE : line;
}

function formatLcaDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const parts = dateStr.split("-");
  if (parts.length < 2) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[month]} ${year}`;
}

function formatPoc(firstName: string | null, lastName: string | null, email: string | null): string | null {
  if (!email) return null;
  const first = firstName ? firstName.split(/[\s/,]+/)[0].trim() : null;
  const lastInitial = lastName ? lastName.trim()[0].toUpperCase() : null;
  if (first && lastInitial) return `${first} ${lastInitial} (${email})`;
  if (first) return `${first} (${email})`;
  return email;
}

function inferDepartment(title: string | null): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (t.includes("product market")) return "product marketing";
  if (t.includes("growth market") || t.includes("demand gen")) return "growth marketing";
  if (t.includes("product manager") || t.includes("product owner") || /\bhead of product\b/.test(t) || / pm,| pm$|\bvp product\b/.test(t)) return "product";
  if (t.includes("machine learning") || / ml | ml,|mlops/.test(t) || t.includes("deep learning") || t.includes("llm") || t.includes("ai engineer")) return "AI / ML";
  if (t.includes("data scientist") || t.includes("data engineer") || t.includes("data analyst") || t.includes("analytics engineer")) return "data";
  if (t.includes("software") || t.includes("engineer") || t.includes("developer") || t.includes("backend") || t.includes("frontend") || t.includes("full stack") || t.includes("swe")) return "engineering";
  if (t.includes("design") || /\bux\b/.test(t) || /\bui\b/.test(t)) return "design";
  if (t.includes("sales") || t.includes("account executive") || t.includes("bdr") || t.includes("sdr") || t.includes("business development")) return "sales";
  if (t.includes("marketing")) return "marketing";
  if (t.includes("finance") || t.includes("financial analyst") || t.includes("accounting") || t.includes("controller")) return "finance";
  if (t.includes("recruiter") || t.includes("recruiting") || t.includes("talent acquisition") || t.includes("people ops") || /\bhr\b/.test(t)) return "people ops";
  if (t.includes("customer success") || t.includes("customer support") || t.includes("account manager")) return "customer success";
  if (t.includes("operations") || t.includes("supply chain") || t.includes("logistics")) return "operations";
  if (t.includes("security") || t.includes("infosec") || t.includes("cybersecurity")) return "security";
  if (t.includes("devops") || t.includes("site reliability") || t.includes("platform engineer") || t.includes("infrastructure")) return "platform / devops";
  if (t.includes("legal") || t.includes("counsel") || t.includes("attorney") || t.includes("compliance")) return "legal";
  return null;
}

function inferJobFunction(headline: string | null): string | null {
  if (!headline) return null;
  const h = headline.toLowerCase();
  if (h.includes("software") || h.includes("engineer") || h.includes("developer") || h.includes("backend") || h.includes("frontend") || h.includes("devops") || h.includes("fullstack") || h.includes("mobile") || h.includes("infrastructure")) return "Engineering";
  if (h.includes("product manager") || h.includes("product management") || /\bhead of product\b/.test(h) || / pm,| pm$|\bvp product\b/.test(h)) return "Product";
  if (h.includes("machine learning") || h.includes("data scientist") || h.includes("data engineer") || h.includes("analytics") || /\bml\b/.test(h) || h.includes("ai ")) return "Data / AI";
  if (h.includes("growth") || h.includes("marketing") || h.includes("demand gen")) return "Marketing";
  if (h.includes("design") || /\bux\b/.test(h) || /\bui\b/.test(h)) return "Design";
  if (h.includes("sales") || h.includes("account executive") || h.includes("business development") || h.includes("partnerships")) return "Sales";
  if (h.includes("finance") || h.includes("accounting") || h.includes("controller") || h.includes("cfo")) return "Finance";
  if (h.includes("operations") || h.includes("recruiting") || h.includes("talent") || /\bhr\b/.test(h)) return "Operations";
  if (h.includes("product")) return "Product";
  return null;
}

// Cosmetic onboarding guess at the user's level from their headline (drives the Q5 message +
// quick-reply labels only — the STORED value comes from levelMap below). Uses the canonical
// taxonomy helper so it matches /jobs and the search; plain ICs default to "Senior".
function inferLevel(title: string): string | null {
  if (!title) return null;
  return levelLabel(levelFromTitle(title) ?? "Senior");
}

interface Greeting {
  headline: string;
  line2: { pre?: string; em: string; post?: string };
}

const UNIVERSAL_GREETINGS: Greeting[] = [
  { headline: "It's a numbers game.", line2: { pre: "Let's ", em: "keep going." } },
  { headline: "Sponsored roles get filled every day.", line2: { pre: "Let's get you ", em: "in front." } },
];

const DOW_GREETINGS: Partial<Record<number, Greeting[]>> = {
  1: [{ headline: "New week, new visa-sponsored opportunities.", line2: { pre: "Let's find ", em: "yours." } }],
  5: [{ headline: "Let's end the week strong.", line2: { em: "A few more", post: " to apply." } }],
};

const TIME_POOLS: Record<string, Greeting[]> = {
  late: [
    { headline: "Working late{name}?", line2: { pre: "We love ", em: "the hustle." } },
    { headline: "Late nights build futures.", line2: { pre: "Let's find ", em: "your next role." } },
  ],
  earlyMorning: [
    { headline: "Early bird gets the job", line2: { pre: "Let's find ", em: "yours." } },
    { headline: "Up before everyone.", line2: { pre: "Let's ", em: "stay ahead." } },
  ],
  morning: [
    { headline: "Good morning{name}.", line2: { pre: "Let's ", em: "get to work." } },
    { headline: "Fresh start today.", line2: { pre: "Your next visa-sponsored opportunity is ", em: "waiting." } },
  ],
  afternoon: [
    { headline: "You got this{name}.", line2: { pre: "Let's find ", em: "your next role." } },
  ],
  evening: [
    { headline: "Ready to apply tonight{name}?", line2: { pre: "Let's ", em: "make it count." } },
  ],
};

function getTimeGreeting(firstName: string | null): { headline: string; line2: Greeting["line2"] } {
  const now = new Date();
  const hour = now.getHours();
  const dow = now.getDay();

  let slotKey: string;
  if (hour >= 22 || hour < 6) slotKey = "late";
  else if (hour < 9) slotKey = "earlyMorning";
  else if (hour < 12) slotKey = "morning";
  else if (hour < 17) slotKey = "afternoon";
  else slotKey = "evening";

  const dowExtras = DOW_GREETINGS[dow] ?? [];
  const pool = [...TIME_POOLS[slotKey], ...dowExtras, ...UNIVERSAL_GREETINGS];

  const dateSeed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const slotOffset = slotKey.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const picked = pool[(dateSeed + slotOffset) % pool.length];

  const nameInsert = firstName ? `, ${firstName}` : "";
  return { headline: picked.headline.replace("{name}", nameInsert), line2: picked.line2 };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function JobCard({ job, onClick }: { job: Job; onClick: () => void }) {
  const [saved, setSaved] = useState(false);
  const [showToast, setShowToast] = useState(false);

  function handleSave() {
    if (!saved) {
      setShowToast(true);
      setTimeout(() => setShowToast(false), 1500);
    }
    setSaved(v => !v);
  }

  const posted = timeAgo(job.posted_at);
  const displayCompany = normalizeCompanyName(job.company);

  return (
    <div
      className="border border-zinc-200 rounded-xl bg-white px-3.5 pt-3 pb-2.5 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <CompanyAvatar name={job.company} domain={job.company_domain} />
          <span className="text-sm font-semibold text-zinc-600 truncate">{displayCompany}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2" onClick={e => e.stopPropagation()}>
          <div className="relative">
            {showToast && (
              <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap pointer-events-none animate-fade-out">
                Saved
              </span>
            )}
            <button
              onClick={handleSave}
              className={`p-1.5 rounded-full border transition-all ${saved ? "bg-zinc-900 border-zinc-900 text-white" : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700"}`}
              aria-label={saved ? "Unsave job" : "Save job"}
            >
              <Bookmark size={14} className={saved ? "fill-current" : ""} />
            </button>
          </div>
          {job.url && (
            <a href={job.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-zinc-900 text-white text-xs font-semibold hover:bg-zinc-700 transition-colors no-underline">
              Apply <ExternalLink size={11} />
            </a>
          )}
        </div>
      </div>

      <h3 className="text-base font-bold text-zinc-900 leading-snug mb-1.5">{job.title}</h3>

      {(job.location || posted) && (
        <div className="flex items-center gap-1 text-xs text-zinc-500 mb-2">
          <MapPin size={10} className="text-zinc-400 flex-shrink-0" />
          <span>{[normalizeCityState(job.location, job.is_remote) || job.location, posted ? `Posted ${posted}` : null].filter(Boolean).join(" · ")}</span>
        </div>
      )}

      <JobChips
        salary_range={job.salary_range}
        visa_tier={job.visa_tier}
        e3_lca_count={job.e3_lca_count}
        title={job.title}
        lca_last_filed={job.lca_last_filed}
        lca_count_2025={job.lca_count_2025}
        poc_first_name={job.poc_first_name}
        poc_last_name={job.poc_last_name}
        poc_email={job.poc_email}
      />
    </div>
  );
}

function JobDetailModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const [descHtml, setDescHtml] = useState("");
  const [descText, setDescText] = useState("");
  const [descLoading, setDescLoading] = useState(true);
  const displayCompany = normalizeCompanyName(job.company);
  const posted = timeAgo(job.posted_at);
  const [apiSalary, setApiSalary] = useState<string | null>(null);
  const extractedSalary = useMemo(() => extractPostedSalary(descHtml || descText), [descHtml, descText]);
  const postedSalary = job.salary_range || apiSalary || extractedSalary;
  const [saved, setSaved] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleSave() {
    if (!saved) {
      setShowToast(true);
      setTimeout(() => setShowToast(false), 1500);
    }
    setSaved(v => !v);
  }
  function handleShare() {
    const url = job.url ?? window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  useEffect(() => {
    setDescLoading(true);
    setDescHtml("");
    setDescText("");
    setApiSalary(null);
    (async () => {
      try {
        if (job.ats_source === "amazon" && job.ats_job_id) {
          const res = await fetch(`/api/jobs/description?source=amazon&job_id=${encodeURIComponent(job.ats_job_id)}`);
          if (res.ok) {
            const { html } = await res.json();
            if (html) { setDescHtml(html); setDescLoading(false); return; }
          }
        } else if (job.ats_source === "ashby" && job.ats_job_id && job.url) {
          const slug = job.url.match(/jobs\.ashbyhq\.com\/([^/]+)\//)?.[1] ?? "";
          if (slug) {
            const res = await fetch(`/api/jobs/description?source=ashby&job_id=${encodeURIComponent(job.ats_job_id)}&slug=${encodeURIComponent(slug)}`);
            if (res.ok) {
              const { html, salary } = await res.json();
              if (html) { setDescHtml(html); }
              if (salary) { setApiSalary(salary); }
              setDescLoading(false);
              return;
            }
          }
        } else if (job.ats_source === "workday" && job.url) {
          const res = await fetch(`/api/jobs/description?url=${encodeURIComponent(job.url)}`);
          if (res.ok) {
            const { html, text } = await res.json();
            if (html) { setDescHtml(html); setDescLoading(false); return; }
            if (text) { setDescText(text); setDescLoading(false); return; }
          }
        }
        const res = await fetch(`/api/jobs/description?source=db&id=${job.id}`);
        if (res.ok) {
          const { html, text } = await res.json();
          if (html) { setDescHtml(html); } else { setDescText(text ?? ""); }
        }
      } catch { /* graceful */ } finally {
        setDescLoading(false);
      }
    })();
  }, [job.id, job.ats_source, job.ats_job_id, job.url]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      <div className={s["job-overlay"]} onClick={onClose} />
      <div className={s["job-panel"]}>
        <div className={s["job-drag-handle"]}>
          <div className="w-10 h-1 rounded-full bg-zinc-200" />
        </div>

        <div className="flex-shrink-0 px-5 pt-3 pb-4 border-b border-zinc-100">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <CompanyAvatar name={job.company} domain={job.company_domain} />
              <span className="text-sm font-semibold text-zinc-600 truncate">{displayCompany}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-3">
              {posted && <span className="text-xs text-zinc-400">{posted}</span>}
              <div className="relative">
                {copied && (
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap pointer-events-none">
                    Copied!
                  </span>
                )}
                <button onClick={handleShare} className="p-2 rounded-full border border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700 transition-all" aria-label="Share">
                  <Share2 size={14} />
                </button>
              </div>
              <div className="relative">
                {showToast && (
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap pointer-events-none">
                    Saved
                  </span>
                )}
                <button
                  onClick={handleSave}
                  className={`p-2 rounded-full border transition-all ${saved ? "bg-zinc-900 border-zinc-900 text-white" : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700"}`}
                  aria-label={saved ? "Unsave job" : "Save job"}
                >
                  <Bookmark size={14} className={saved ? "fill-current" : ""} />
                </button>
              </div>
              <button onClick={onClose} className="p-2 rounded-full border border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700 transition-all" aria-label="Close">
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="flex items-start gap-4 mb-3">
            <h2 className="flex-1 text-xl font-bold text-zinc-900 leading-snug">{job.title}</h2>
            {job.url && (
              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-semibold rounded-lg transition-colors no-underline"
              >
                Apply <ExternalLink size={12} />
              </a>
            )}
          </div>

          {job.location && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
              <MapPin size={11} className="flex-shrink-0 text-zinc-400" />
              <span>{normalizeCityState(job.location, job.is_remote) || job.location}</span>
            </div>
          )}

          <JobChips
            salary_range={postedSalary ?? null}
            visa_tier={job.visa_tier}
            e3_lca_count={job.e3_lca_count}
            title={job.title}
            lca_last_filed={job.lca_last_filed}
            lca_count_2025={job.lca_count_2025}
            poc_first_name={job.poc_first_name}
            poc_last_name={job.poc_last_name}
            poc_email={job.poc_email}
          />
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">Job Description</div>
          {descLoading ? (
            <div className="space-y-2">
              {[80, 60, 90, 50, 70, 85, 45].map((w, i) => (
                <div key={i} className="h-3 bg-zinc-100 rounded animate-pulse" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : descHtml ? (
            <div className="text-xs text-zinc-600 leading-relaxed prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: descHtml }} />
          ) : descText ? (
            <p className="text-xs text-zinc-600 leading-relaxed whitespace-pre-wrap">{descText}</p>
          ) : (
            <p className="text-xs text-zinc-400 italic">Description unavailable – view full posting on company site.</p>
          )}
        </div>
      </div>
    </>
  );
}

function KaiText({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
        return part.split("\n").map((line, j, arr) => (
          <span key={`${i}-${j}`}>{line}{j < arr.length - 1 && <br />}</span>
        ));
      })}
      {isStreaming && <span className={s.cursor} />}
    </>
  );
}

const SCAN_LABELS = [
  "Checking ATS feeds",
  "Filtering for active sponsors",
  "Matching seniority and comp range",
];

function ScanChecklistBubble({ phase, jobCount, visa }: { phase: number; jobCount: number | null; visa: string | null }) {
  return (
    <div className={s["msg-row"]}>
      <div className={s["kai-avatar"]}>K</div>
      <div className={`${s.bubble} ${s["bubble-kai"]} ${s["scan-bubble"]}`}>
        {SCAN_LABELS.map((label, i) => {
          const isDone = phase > i + 1;
          const isActive = phase === i + 1;
          const cls = isDone ? s["scan-item-done"] : isActive ? s["scan-item-active"] : s["scan-item"];
          const text = i === 1 && visa ? `Filtering for active ${visa} sponsors` : label;
          return (
            <div key={i} className={cls}>
              {isDone ? "✓ " : ""}{text}{!isDone ? "..." : ""}
            </div>
          );
        })}
        {phase >= 4 && jobCount !== null ? (
          <div className={s["scan-item-active"]}>
            Found {jobCount} match{jobCount !== 1 ? "es" : ""}. Ranking by sponsor reliability...
          </div>
        ) : phase < 4 && (
          <div className={s["thinking-inline"]}>
            <span className={s.dot} /><span className={s.dot} /><span className={s.dot} />
          </div>
        )}
      </div>
    </div>
  );
}

// Venmo mode only — shown after batch2 to gate additional results
function SupportScreen({
  email,
  jobCount,
  onClose,
  onSent,
}: {
  email: string | null;
  jobCount: number;
  onClose: () => void;
  onSent: () => void;
}) {
  const note = email ? `getdatjob+${encodeURIComponent(email)}` : "getdatjob";
  const venmoDeepLink = `venmo://paycharge?txn=pay&recipients=letiendat&amount=10&note=${note}`;
  const venmoWeb = "https://venmo.com/letiendat?txn=pay&amount=10";

  const handleVenmoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onSent();
    const fallback = setTimeout(() => {
      window.open(venmoWeb, "_blank");
    }, 1500);
    const cleanup = () => { clearTimeout(fallback); document.removeEventListener("visibilitychange", cleanup); };
    document.addEventListener("visibilitychange", cleanup);
    window.location.href = venmoDeepLink;
  };

  return (
    <div
      className={s["support-overlay"]}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={s["support-sheet"]}>
        <p className={s["support-eyebrow"]}>Unlock the rest with $10 support</p>
        <p className={s["support-hook"]}>
          <em className={s["support-count"]}>{jobCount}</em>{" "}
          jobs match your search<br />in the last 3 days
        </p>
        <p className={`${s["support-story"]} ${s["support-story-first"]}`}>
          Hi there, I&apos;m Dat, a solo founder of getdatjob. I&apos;m also on a working visa.
          I&apos;ve been building this on weeknights and weekends, on top of a 60-hour startup work week.
        </p>
        <p className={s["support-story"]}>
          No VC, no team — your support of this LGBT-owned project means everything.
        </p>
        <a href={venmoDeepLink} onClick={handleVenmoClick} className={s["support-cta"]}>
          Support with $10
        </a>
        <button className={s["support-sent"]} onClick={onClose}>
          I&apos;m not a supporter
        </button>
        <p className={s["support-skip"]}>
          No pressure. Come back tomorrow for 6 more — that&apos;s your daily limit.
        </p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const POST_RESULT_CHIPS = ["Show more", "Change location", "Higher salary only", "Posted this week"];
const KAI_HISTORY_KEY = "kai_chat_history";

export default function KaiPage() {
  const [step, setStep] = useState<OnboardingStep>("init");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quickReplies, setQuickReplies] = useState<QR[]>([]);
  const [intake, setIntake] = useState<IntakeData>({
    intent: null, layoffDate: null, location: null, locationMode: null,
    visa: null, salaryMin: null, level: null, jobFunction: null,
  });
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [total3dCount, setTotal3dCount] = useState<number>(0);
  // The actual search window (3, 7, or 14) used by the cascade in
  // /api/onboarding/jobs. Paywall body needs this so its "in the last X days"
  // phrasing matches what Kai already told the user in the bubble above.
  const [windowDays, setWindowDays] = useState<number>(3);
  const [scanPhase, setScanPhase] = useState(0);
  const [scanJobCount, setScanJobCount] = useState<number | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [linkedIn, setLinkedIn] = useState<LinkedInProfile | null>(null);
  const [enriched, setEnriched] = useState<EnrichedProfile | null>(null);
  const [timeGreeting, setTimeGreeting] = useState<{ headline: string; line2: Greeting["line2"] } | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  // Free-chat mode
  const [chatInput, setChatInput] = useState("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [showPostChips, setShowPostChips] = useState(false);
  const [dateInput, setDateInput] = useState("");

  // Venmo mode: support bottom sheet
  const [showSupport, setShowSupport] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const historyLoadedRef = useRef(false);
  const restoredFromLocalRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  // Prevents the onboarding useEffect from double-firing when linkedIn/enriched
  // state resolves during the ~1.6s delay before setStep("q1") runs.
  const onboardingStartedRef = useRef(false);
  // Paywall mode: jobs fetch starts during Q6 so it runs while user answers alert_optin
  const pendingScanRef = useRef<{
    jobsPromise: Promise<{ jobs: Job[]; total_count: number; capped: boolean; window_days: number; broadened: Broadened; place: string | null }>;
    filterTokens: string[];
  } | null>(null);

  // The hook owns all scroll decisions (follow light content, anchor heavy
  // content, reveal the user's own message). The scan checklist and step blocks
  // render outside `messages`, so their state rides along as followKey.
  // Onboarding follows unconditionally — light bubbles must never leave a pill.
  // Free chat (step "done") AND the paywall are position-aware: no light
  // bubbles arrive there, and nothing may fight the user's own scrolling while
  // they read the pricing block or a long streamed answer.
  const { onScroll, jumpToLatest, showJump } = useChatScroll(threadRef, messages, {
    followKey: `${scanPhase}|${step}`,
    followMode: step === "done" || step === "paywall" ? "pinned" : "always",
    heavyBlock: PAYWALL_MODE ? { id: "paywall", active: step === "paywall" } : null,
  });

  // Keep messagesRef current so the sync effect can read latest without re-running on every update
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Restore chat if user already completed onboarding OR bailed at the paywall
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KAI_HISTORY_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as {
          step: OnboardingStep;
          messages: ChatMessage[];
          total3dCount?: number;
          windowDays?: number;
        };
        const resumableSteps: OnboardingStep[] = ["done", "paywall"];
        if (resumableSteps.includes(saved.step) && saved.messages?.length > 0) {
          const clean = saved.messages.filter((m) => !m.isThinking && !m.isStreaming);
          if (clean.length > 0) {
            setMessages(clean);
            setStep(saved.step);
            if (typeof saved.total3dCount === "number") {
              setTotal3dCount(saved.total3dCount);
            }
            if (typeof saved.windowDays === "number") {
              setWindowDays(saved.windowDays);
            }
            restoredFromLocalRef.current = true; // Don't re-sync a restored session
          }
        }
      }
    } catch { /* ignore */ }
    historyLoadedRef.current = true;
  }, []);

  // Real-time sync of every Kai message to Supabase as it lands.
  // Rule: persist any stable message (not thinking, not streaming) we haven't
  // persisted yet. Tracking by message id keeps it idempotent across re-renders
  // and across the restored-from-localStorage path (those messages already exist
  // in Supabase from a prior session, so we mark them persisted on restore).
  const persistedIdsRef = useRef<Set<string>>(new Set());

  // Mark restored-from-local messages as already persisted so we don't double-write
  useEffect(() => {
    if (!historyLoadedRef.current) return;
    if (!restoredFromLocalRef.current) return;
    if (persistedIdsRef.current.size > 0) return;
    messages.forEach((m) => persistedIdsRef.current.add(m.id));
  }, [messages]);

  useEffect(() => {
    if (!historyLoadedRef.current) return;
    if (!user?.id) return;
    const uid = user.id;
    const toPersist = messages.filter(
      (m) => !m.isThinking && !m.isStreaming && !persistedIdsRef.current.has(m.id),
    );
    if (toPersist.length === 0) return;
    // Optimistically mark, then write. Failures are logged but don't retry —
    // the next /me/chat load falls back to localStorage if Supabase is short.
    toPersist.forEach((m) => persistedIdsRef.current.add(m.id));
    const supabase = createSupabaseBrowser();
    (async () => {
      for (const m of toPersist) {
        const { error } = await supabase.from("kai_messages").insert({
          user_id: uid,
          role: m.role,
          content: m.content,
          jobs: m.jobs ?? null,
        });
        if (error) {
          console.error("[kai] persist failed", m.id, error);
          persistedIdsRef.current.delete(m.id); // allow retry on next change
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, user]);

  // Persist chat history once user reaches the paywall (so a cancel returns them
  // mid-flow) or completes onboarding.
  useEffect(() => {
    if (!historyLoadedRef.current) return;
    if (step !== "done" && step !== "paywall") return;
    const stable = messages.filter((m) => !m.isThinking && !m.isStreaming);
    try {
      if (stable.length === 0) localStorage.removeItem(KAI_HISTORY_KEY);
      else localStorage.setItem(
        KAI_HISTORY_KEY,
        JSON.stringify({ step, messages: stable, total3dCount, windowDays }),
      );
    } catch { /* storage full */ }
  }, [messages, step, total3dCount, windowDays]);

  // Load auth user + enriched profile
  useEffect(() => {
    const supabase = createSupabaseBrowser();
    supabase.auth.getUser().then(async ({ data }) => {
      if (data.user) {
        const meta = data.user.user_metadata ?? {};
        const fullName = meta.full_name ?? meta.name ?? null;
        setUser({
          id: data.user.id,
          firstName: fullName ? fullName.split(" ")[0] : null,
          email: data.user.email ?? null,
          avatar: meta.avatar_url ?? meta.picture ?? null,
        });

        supabase.schema("linkedin").from("profiles").select("headline").eq("id", data.user.id).maybeSingle()
          .then(({ data: lp }) => { if (lp?.headline) setLinkedIn({ headline: lp.headline }); });

        supabase.schema("enriched").from("profiles").select("current_title, location, job_function, job_level")
          .eq("user_id", data.user.id).eq("enrich_status", "done").maybeSingle()
          .then(({ data: ep }) => { if (ep) setEnriched(ep as EnrichedProfile); });
      }
      setUserLoading(false);
    });
  }, []);

  useEffect(() => { setTimeGreeting(getTimeGreeting(null)); }, []);
  useEffect(() => { if (user?.firstName) setTimeGreeting(getTimeGreeting(user.firstName)); }, [user?.firstName]);

  // Start onboarding once user state is resolved.
  // onboardingStartedRef prevents a double-start if linkedIn/enriched resolve
  // during the ~1.6s async delay before setStep("q1") fires.
  useEffect(() => {
    if (userLoading || step !== "init") return;
    if (onboardingStartedRef.current) return;
    onboardingStartedRef.current = true;

    const firstName = user?.firstName ?? null;
    const headline = linkedIn?.headline ?? enriched?.current_title ?? null;

    let greeting: string;
    if (firstName && headline) {
      greeting = `Hey ${firstName}! I'm Kai. I see you're a ${headline}. I'm an AI on a working visa too, and I'm here to help you land your next visa-sponsored role.`;
    } else if (firstName) {
      greeting = `Hey ${firstName}! I'm Kai. I'm an AI on a working visa too. I'm here to help you land your next visa-sponsored role.`;
    } else {
      greeting = "Hey there! I'm Kai. I'm an AI on a working visa too. I'm here to help you land your next visa-sponsored role.";
    }

    (async () => {
      await delay(400);
      setMessages([{ id: "k-greeting", role: "assistant", content: greeting }]);
      await delay(1200);
      setMessages((prev) => [...prev, { id: "k-q1", role: "assistant", content: "What's got you looking right now?" }]);
      setQuickReplies([
        { label: "I just got laid off.", value: "laid_off" },
        { label: "I'm employed, but actively looking.", value: "active" },
        { label: "I'm employed – just worried about potential layoffs and want to stay prepared.", value: "prepared" },
      ]);
      setStep("q1");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLoading, linkedIn, enriched]);

  // ── Tile click handler ────────────────────────────────────────────────────────

  const handleTileClick = async (qr: QR) => {
    setQuickReplies([]);

    if (step === "q1") {
      const intent = qr.value;
      setIntake((prev) => ({ ...prev, intent }));
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(450);

      if (intent === "laid_off") {
        setMessages((prev) => [...prev, { id: "k-f1", role: "assistant", content: "I'm sorry for this." }]);
        await delay(900);
        setMessages((prev) => [...prev, { id: "k-q1b", role: "assistant", content: "When did it happen? (MM/DD/YY)" }]);
        setStep("q1_layoff_date");
        setTimeout(() => dateInputRef.current?.focus(), 100);
        return;
      }

      const filler = intent === "active"
        ? "Got it. I'm here to fast-track your search – visa sponsoring opportunities only, so you're not wasting time on companies that won't work for you."
        : "That's the immigrant mindset. Aren't we all running a plan B in this economy?";
      setMessages((prev) => [...prev, { id: "k-f1", role: "assistant", content: filler }]);
      await delay(900);
      setMessages((prev) => [...prev, { id: "k-q2", role: "assistant", content: "To match you with the right sponsors – what visa are you working with?" }]);
      setQuickReplies([
        { label: "H-1B", value: "H-1B" },
        { label: "E-3",  value: "E-3"  },
        { label: "TN",   value: "TN"   },
        { label: "OPT",  value: "OPT"  },
      ]);
      setStep("q2");

    } else if (step === "q2") {
      const visa = qr.value;
      setIntake((prev) => ({ ...prev, visa }));
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(450);
      const visaFiller: Record<string, string> = {
        h1b:  "That narrows the pool to companies with a real H-1B track record. But don't worry – over 47,000 companies filed H-1B LCAs in 2025, and the good ones are in here.",
        e3:   "E-3 sponsors are a more specific group, but don't worry – over 4,000 companies filed E-3 LCAs in 2025. I'll zero in on the ones with the strongest Australian hire track record.",
        tn:   "Good news – TN has no H-1B lottery and no LCA requirement, so you're not locked out by a quota. Any verified employer with a qualifying role can hire you on TN status. I'll surface the best matches.",
        opt:  "Got it – I'll prioritize the companies with the strongest H-1B filing track record, since that's the clearest path to long-term status. Over 47,000 companies filed H-1B LCAs in 2025 – the active sponsors are in here.",
        o1:   "O-1 is for people with extraordinary ability – and honestly, it's the most flexible work visa out there. Most employers can hire you without going through the H-1B lottery or LCA process. Your options are wider than you might think. I'll pull from our full verified employer list.",
      };
      const visaKey = visa.toLowerCase().replace(/[-/ ]/g, "");
      setMessages((prev) => [...prev, { id: "k-f2", role: "assistant", content: visaFiller[visaKey] ?? "Got it – pulling the right sponsors." }]);
      await delay(850);
      setMessages((prev) => [...prev, { id: "k-q3", role: "assistant", content: [
        "What's the minimum base salary that would make a move worth it? Or are you open?",
        "What's the minimum base salary that would make a move worth it? Or no minimum?",
        "What's the minimum base salary that would make a move worth it? Or are you flexible on salary?",
      ][Math.floor(Math.random() * 3)] }]);
      setQuickReplies([
        { label: "No floor", value: "0"      },
        { label: "$100K+",   value: "100000" },
        { label: "$150K+",   value: "150000" },
        { label: "$200K+",   value: "200000" },
      ]);
      setStep("q3");

    } else if (step === "q3") {
      const salaryMin = parseInt(qr.value, 10);
      setIntake((prev) => ({ ...prev, salaryMin: salaryMin > 0 ? salaryMin : null }));
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(400);
      await delay(3000);

      let freshHeadline = linkedIn?.headline ?? null;
      if (!freshHeadline && user) {
        const supa = createSupabaseBrowser();
        const { data: lp } = await supa.schema("linkedin").from("profiles").select("headline").eq("id", user.id).maybeSingle();
        if (lp?.headline) { freshHeadline = lp.headline; setLinkedIn({ headline: lp.headline }); }
      }

      const inferredFunc = inferJobFunction(freshHeadline);
      const funcLabel: Record<string, string> = {
        Engineering: "Engineering", Product: "Product", Marketing: "Marketing / Growth",
        "Data / AI": "Data / AI", Design: "Design", Sales: "Sales", Finance: "Finance", Operations: "Operations",
      };
      const q4Text = inferredFunc
        ? `I see you're in ${funcLabel[inferredFunc] ?? inferredFunc} on your profile. Are you staying in that direction, or looking to pivot?`
        : "What kind of role are you looking for?";
      const topFuncs: QR[] = [
        { label: "Engineering",    value: "Engineering", row: 1 },
        { label: "Product",        value: "Product",     row: 1 },
        { label: "Data",           value: "Data",        row: 1 },
        { label: "Marketing",      value: "Marketing",   row: 2 },
        { label: "Growth",         value: "Growth",      row: 2 },
        { label: "Design",         value: "Design",      row: 3 },
        { label: "Something else", value: "Other",       row: 3 },
      ];
      const q4Replies: QR[] = inferredFunc
        ? [
            { label: `Staying in ${funcLabel[inferredFunc] ?? inferredFunc}`, value: inferredFunc },
            { label: "Pivoting to something new", value: "Other" },
          ]
        : topFuncs;
      setMessages((prev) => [...prev, { id: "k-q4", role: "assistant", content: q4Text }]);
      setQuickReplies(q4Replies);
      setStep("q4");

    } else if (step === "q4") {
      const jobFunction = qr.value;
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(400);

      // "Pivoting to something new" / "Something else" → ask what field they want
      if (jobFunction === "Other") {
        setMessages((prev) => [...prev, { id: "k-q4b", role: "assistant", content: "What field are you looking to move into?" }]);
        setQuickReplies([
          { label: "Engineering", value: "Engineering", row: 1 },
          { label: "Product",     value: "Product",     row: 1 },
          { label: "Data",        value: "Data",        row: 1 },
          { label: "Marketing",   value: "Marketing",   row: 2 },
          { label: "Growth",      value: "Growth",      row: 2 },
          { label: "Design",      value: "Design",      row: 2 },
        ]);
        setStep("q4b");
        return;
      }

      setIntake((prev) => ({ ...prev, jobFunction }));

      let q5Headline = linkedIn?.headline ?? null;
      if (!q5Headline && user) {
        const supa = createSupabaseBrowser();
        const { data: lp } = await supa.schema("linkedin").from("profiles").select("headline").eq("id", user.id).maybeSingle();
        if (lp?.headline) { q5Headline = lp.headline; setLinkedIn({ headline: lp.headline }); }
      }

      const inferredLevel = inferLevel(q5Headline ?? "");
      const isManager = inferredLevel?.toLowerCase().includes("manager") || inferredLevel?.toLowerCase().includes("lead");
      const q5Text = inferredLevel
        ? isManager
          ? "Looks like you're in a manager role — staying that path, or open to IC work too?"
          : `Looks like you're a ${inferredLevel} based on your profile — planning to stay that route, or open to people management?`
        : "Senior IC, or ready to lead a team?";
      const q5Replies: QR[] = inferredLevel
        ? isManager
          ? [{ label: "Staying Manager / Lead", value: "manager" }, { label: "Open to IC too", value: "senior_ic" }, { label: "Either works", value: "either" }]
          : [{ label: `Staying ${inferredLevel}`, value: "senior_ic" }, { label: "Open to Manager / Lead", value: "manager" }, { label: "Either works", value: "either" }]
        : [{ label: "Senior IC", value: "senior_ic" }, { label: "Manager / Lead", value: "manager" }, { label: "Either works", value: "either" }];
      setMessages((prev) => [...prev, { id: "k-q5", role: "assistant", content: q5Text }]);
      setQuickReplies(q5Replies);
      setStep("q5");

    } else if (step === "q4b") {
      // User picked their pivot target field
      const jobFunction = qr.value;
      setIntake((prev) => ({ ...prev, jobFunction }));
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(400);

      let q5Headline = linkedIn?.headline ?? null;
      if (!q5Headline && user) {
        const supa = createSupabaseBrowser();
        const { data: lp } = await supa.schema("linkedin").from("profiles").select("headline").eq("id", user.id).maybeSingle();
        if (lp?.headline) { q5Headline = lp.headline; setLinkedIn({ headline: lp.headline }); }
      }

      const inferredLevel4b = inferLevel(q5Headline ?? "");
      const isManager4b = inferredLevel4b?.toLowerCase().includes("manager") || inferredLevel4b?.toLowerCase().includes("lead");
      const q5Text4b = inferredLevel4b
        ? isManager4b
          ? "Looks like you're in a manager role — staying that path, or open to IC work too?"
          : `Looks like you're a ${inferredLevel4b} based on your profile — planning to stay that route, or open to people management?`
        : "Senior IC, or ready to lead a team?";
      const q5Replies4b: QR[] = inferredLevel4b
        ? isManager4b
          ? [{ label: "Staying Manager / Lead", value: "manager" }, { label: "Open to IC too", value: "senior_ic" }, { label: "Either works", value: "either" }]
          : [{ label: `Staying ${inferredLevel4b}`, value: "senior_ic" }, { label: "Open to Manager / Lead", value: "manager" }, { label: "Either works", value: "either" }]
        : [{ label: "Senior IC", value: "senior_ic" }, { label: "Manager / Lead", value: "manager" }, { label: "Either works", value: "either" }];
      setMessages((prev) => [...prev, { id: "k-q5", role: "assistant", content: q5Text4b }]);
      setQuickReplies(q5Replies4b);
      setStep("q5");

    } else if (step === "q5") {
      const level = qr.value;
      setIntake((prev) => ({ ...prev, level }));
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      if (level === "either") {
        await delay(450);
        setMessages((prev) => [...prev, { id: "k-f5", role: "assistant", content: "Flexible – that opens it up." }]);
      }
      await delay(level === "either" ? 700 : 400);

      const supabase = createSupabaseBrowser();
      const { data: { user: authUser } } = await supabase.auth.getUser();
      let knownLocation: string | null = null;
      if (authUser) {
        const { data: lp } = await supabase.schema("linkedin").from("profiles").select("location").eq("id", authUser.id).maybeSingle();
        const raw = lp?.location ?? null;
        knownLocation =
          raw &&
          (raw.includes(" ") || /^remote$/i.test(raw)) &&
          !/university|college|school|institute|academy|polytechnic/i.test(raw)
            ? raw
            : null;
      }

      const q6Text = knownLocation
        ? `Where are you looking to work from? Staying in ${knownLocation.split(",")[0]}, open to relocating, or remote only?`
        : "Do you have any location preferences?";
      const q6Replies: QR[] = knownLocation
        ? [
            { label: `Staying in ${knownLocation.split(",")[0]}`, value: "local"    },
            { label: "Remote only",                               value: "remote"   },
            { label: "Open to relocating",                        value: "anywhere" },
          ]
        : [
            { label: "San Francisco Bay Area", value: "bay_area" },
            { label: "East Coast / NYC",       value: "nyc"      },
            { label: "Remote only",            value: "remote"   },
            { label: "Open to anywhere",       value: "anywhere" },
          ];
      if (knownLocation) setIntake((prev) => ({ ...prev, location: knownLocation, locationMode: "local" }));
      setMessages((prev) => [...prev, { id: "k-q6", role: "assistant", content: q6Text }]);
      setQuickReplies(q6Replies);
      setStep("q6");

    } else if (step === "q6") {
      const level = intake.level ?? "either";
      const locMap: Record<string, { location: string | null; locationMetro: string | null; locationMode: string }> = {
        local:    { location: intake.location, locationMetro: null,       locationMode: "local"    },
        bay_area: { location: null,            locationMetro: "bay_area", locationMode: "local"    },
        nyc:      { location: null,            locationMetro: "nyc",      locationMode: "local"    },
        remote:   { location: null,            locationMetro: null,       locationMode: "remote"   },
        anywhere: { location: null,            locationMetro: null,       locationMode: "anywhere" },
      };
      const loc = locMap[qr.value] ?? { location: null, locationMetro: null, locationMode: "anywhere" };
      const locationMetro = loc.locationMetro;
      const updatedIntake = { ...intake, location: loc.location, locationMode: loc.locationMode, level };
      setIntake(updatedIntake);
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(500);

      // The canonicalizer in kai-tools (@/lib/taxonomy) understands the raw quick-reply
      // values ("Marketing", "Growth", "Data", "Data / AI", ...) plus inferred strings, so
      // pass the chosen function straight through — no lossy pre-mapping.
      const dept = updatedIntake.jobFunction && updatedIntake.jobFunction !== "Other"
        ? updatedIntake.jobFunction
        : inferDepartment(linkedIn?.headline ?? enriched?.current_title ?? null);
      // Order: department · level · earning minimum $X · location
      const salaryStr = updatedIntake.salaryMin
        ? `earning minimum $${Math.round(updatedIntake.salaryMin / 1000)}K+`
        : null;
      const levelStr = level === "senior_ic" ? "IC" : level === "manager" ? "Manager / Lead" : "all levels";
      const locStr = updatedIntake.locationMode === "remote" ? "remote" : updatedIntake.locationMode === "anywhere" ? "anywhere in the US" : (updatedIntake.location ?? qr.label);
      const filterTokens = [dept, levelStr, salaryStr, locStr].filter((t): t is string => Boolean(t));

      const jobsFetch: Promise<{ jobs: Job[]; total_count: number; capped: boolean; window_days: number; broadened: Broadened; place: string | null }> = fetch("/api/onboarding/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visa: updatedIntake.visa,
          location: updatedIntake.location,
          location_metro: locationMetro,
          locationMode: updatedIntake.locationMode,
          salary_min: updatedIntake.salaryMin,
          intent: updatedIntake.intent,
          department: dept ?? undefined,
          level: updatedIntake.level ?? undefined,
        }),
      })
        .then((r) => r.json())
        .then((d) => ({
          jobs: (d.jobs ?? []) as Job[],
          total_count: (d.total_count ?? 0) as number,
          capped: (d.capped ?? false) as boolean,
          window_days: (d.window_days ?? 0) as number,
          broadened: (d.broadened ?? null) as Broadened,
          place: (d.place ?? null) as string | null,
        }))
        .catch(() => ({ jobs: [] as Job[], total_count: 0, capped: false, window_days: 0, broadened: null as Broadened, place: null }));

      // Fire-and-forget: persist intake preferences
      createSupabaseBrowser().auth.getUser().then(({ data }) => {
        if (!data.user) return;
        const levelMap: Record<string, string | null> = { senior_ic: "Senior", manager: "Lead/Manager", either: null };
        const visaMap: Record<string, string> = { "H-1B": "H-1B", "OPT": "OPT", "E-3": "E-3/TN" };
        const prefLocStr = updatedIntake.locationMode === "remote" ? "Remote" : updatedIntake.locationMode === "anywhere" ? null : updatedIntake.location;
        createSupabaseBrowser().schema("enriched").from("profiles").upsert({
          user_id: data.user.id,
          visa_type: visaMap[updatedIntake.visa ?? ""] ?? "Other",
          salary_floor: updatedIntake.salaryMin ?? null,
          job_function: updatedIntake.jobFunction !== "Other" ? updatedIntake.jobFunction : null,
          job_level: levelMap[updatedIntake.level ?? ""] ?? null,
          location: prefLocStr ?? null,
          onboarding_complete: true,
        }, { onConflict: "user_id" }).then(() => {});
      });

      if (PAYWALL_MODE) {
        // Store the in-flight fetch so handleAlertOptin can await it after user answers
        pendingScanRef.current = { jobsPromise: jobsFetch, filterTokens };
        setMessages((prev) => [...prev, {
          id: "k-alert-optin",
          role: "assistant",
          content: "Before I start searching — want me to ping you when new matches come in? Your daily batch resets at midnight.",
        }]);
        setStep("alert_optin");
      } else {
        // Venmo mode: bubble 1 — always shown immediately
        setMessages((prev) => [...prev, {
          id: "k-scan-announce",
          role: "assistant",
          content: `Running a pass across ${filterTokens.join(" · ")}.`,
        }]);
        setStep("scanning");

        setScanPhase(1);
        await delay(1100);
        setScanPhase(2);
        await delay(1000);
        setScanPhase(3);
        await delay(1000);

        const { jobs, total_count, capped, window_days, broadened: brd, place } = await jobsFetch;
        setAllJobs(jobs);
        setTotal3dCount(total_count);
        setWindowDays(window_days || 3);
        setScanJobCount(jobs.length);
        setScanPhase(4);
        await delay(1300);

        setScanPhase(0);
        // API already returns company-unique results sorted by recency
        const batch1 = jobs.slice(0, 3);
        const hasVerified = batch1.some((j) => j.visa_tier === "verified");

        if (jobs.length > 0) {
          const revealText = revealLineFor(brd, { total: total_count, capped, place, hasVerified, freshLabel: postedWithin(batch1) });
          setMessages((prev) => [...prev, { id: "k-reveal1", role: "assistant", content: revealText, jobs: batch1 }]);
          setStep("batch1");
        } else {
          // Genuine zero — capture the alert instead of dead-ending the first experience.
          setMessages((prev) => [...prev, { id: "k-reveal1", role: "assistant", content: `${ZERO_CAPTURE} Want me to ping you the moment fresh ones land? No spam.` }]);
          setQuickReplies([
            { label: "Yes, keep me posted", value: "yes" },
            { label: "No thanks",           value: "no"  },
          ]);
          setStep("email_optin");
        }
      }

    // Venmo mode: email opt-in → batch2
    } else if (step === "email_optin") {
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(450);
      if (qr.value === "yes") {
        setMessages((prev) => [...prev, { id: "k-optin-yes", role: "assistant", content: "Perfect – I'll ping you daily when new matches hit. Won't spam you." }]);
        try {
          const supabase = createSupabaseBrowser();
          const { data: { user: authUser } } = await supabase.auth.getUser();
          if (authUser) await supabase.from("user_job_alert_prefs")
            .upsert({ user_id: authUser.id, email_alerts: true, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
        } catch { /* graceful */ }
      } else {
        setMessages((prev) => [...prev, { id: "k-optin-no", role: "assistant", content: "Got it – no pressure." }]);
      }
      await delay(600);

      const batch2 = allJobs.slice(3, 6);
      if (batch2.length > 0) {
        setMessages((prev) => [...prev, {
          id: "k-reveal2",
          role: "assistant",
          content: (() => { const fl = postedWithin(batch2); return fl ? `Here are ${batch2.length} more, posted within ${fl}.` : `Here are ${batch2.length} more worth a look.`; })(),
          jobs: batch2,
        }]);
        setStep("batch2");
      } else {
        setMessages((prev) => [...prev, { id: "k-no-more", role: "assistant", content: "That's all the matches for today – new ones drop daily." }]);
        setStep("done");
      }

    // Paywall mode: see_more → paywall or done
    } else if (step === "see_more") {
      setQuickReplies([]);
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(300);
      if (qr.value === "yes") {
        setStep("paywall");
      } else {
        setMessages((prev) => [...prev, {
          id: "k-no-more",
          role: "assistant",
          content: "No worries — new matches drop daily. Come back tomorrow!",
        }]);
        setStep("done");
      }
    }
  };

  // ── Date input ────────────────────────────────────────────────────────────────

  const handleDateInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value.replace(/[^\d]/g, "");
    if (v.length > 2) v = v.slice(0, 2) + "/" + v.slice(2);
    if (v.length > 5) v = v.slice(0, 5) + "/" + v.slice(5);
    if (v.length > 8) v = v.slice(0, 8);
    setDateInput(v);
  };

  const handleDateSubmit = async () => {
    const trimmed = dateInput.trim();
    if (!trimmed) return;
    const valid = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{2}$/.test(trimmed);
    if (!valid) {
      setDateInput("");
      setMessages((prev) => [...prev,
        { id: `u-${Date.now()}`, role: "user", content: trimmed },
        { id: `k-date-err-${Date.now()}`, role: "assistant", content: "Hmm, that doesn't look right. Try MM/DD/YY – for example, 05/25/25." },
      ]);
      setTimeout(() => dateInputRef.current?.focus(), 100);
      return;
    }
    setDateInput("");
    setIntake((prev) => ({ ...prev, layoffDate: trimmed }));
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: trimmed }]);
    try {
      const supabase = createSupabaseBrowser();
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (authUser) await supabase.from("profiles").update({ layoff_date: trimmed }).eq("id", authUser.id);
    } catch { /* graceful */ }
    await delay(500);
    setMessages((prev) => [...prev, { id: "k-f1b", role: "assistant", content: "Okay – 30, 60, 90 days matters here. I'm pulling for roles that can move fast." }]);
    await delay(900);
    setMessages((prev) => [...prev, { id: "k-q2", role: "assistant", content: "To match you with the right sponsors – what visa are you working with?" }]);
    setQuickReplies([
      { label: "H-1B", value: "H-1B" },
      { label: "E-3",  value: "E-3"  },
      { label: "TN",   value: "TN"   },
      { label: "OPT",  value: "OPT"  },
    ]);
    setStep("q2");
  };

  // ── Venmo mode: show-more handlers ───────────────────────────────────────────

  const handleShowMore1 = async () => {
    setStep("email_optin");
    await delay(300);
    setMessages((prev) => [...prev, {
      id: "k-optin-ask",
      role: "assistant",
      content: "Before I pull the next batch – want me to ping you when new matches come in? Your daily batch resets at midnight.",
    }]);
    setQuickReplies([
      { label: "Yes, keep me posted", value: "yes" },
      { label: "Maybe later",         value: "no"  },
    ]);
  };

  const handleShowMore2 = () => {
    setShowSupport(true);
    setStep("support");
  };

  const handleSupportClose = async () => {
    setShowSupport(false);
    setStep("done");
    await delay(300);
    setMessages((prev) => [...prev, {
      id: "k-skip-support",
      role: "assistant",
      content: "No worries – that's today's batch. New matches drop daily, come back tomorrow and I'll pull fresh ones.",
    }]);
  };

  const handleISentIt = async () => {
    setShowSupport(false);
    setStep("done");
    try {
      const supabase = createSupabaseBrowser();
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (authUser) await supabase.from("profiles").update({ is_supporter: true }).eq("id", authUser.id);
    } catch { /* graceful */ }
    await delay(300);
    setMessages((prev) => [...prev, {
      id: "k-supporter",
      role: "assistant",
      content: "You're in – thank you! Unlimited Kai starting now. What else can I find you?",
    }]);
  };

  // ── Paywall mode: alert opt-in handler ──────────────────────────────────────

  const handleAlertOptin = async (value: string) => {
    const label = value === "yes" ? "Absolutely, keep me updated on new matches" : "No thanks, I'll check manually";
    setMessages((prev) => [...prev, { id: `u-alert-${Date.now()}`, role: "user", content: label }]);

    if (value === "yes") {
      await delay(300);
      setMessages((prev) => [...prev, { id: "k-alert-ok", role: "assistant", content: "Perfect — I'll ping you daily when new matches hit. Won't spam you." }]);
      try {
        const supabase = createSupabaseBrowser();
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (authUser) await supabase.from("user_job_alert_prefs")
          .upsert({ user_id: authUser.id, email_alerts: true, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      } catch { /* graceful */ }
      await delay(500);
    } else {
      await delay(300);
    }

    const ctx = pendingScanRef.current;
    pendingScanRef.current = null;
    const filterTokens = ctx?.filterTokens ?? [];
    const jobsPromise = ctx?.jobsPromise ?? Promise.resolve({ jobs: [] as Job[], total_count: 0, capped: false, window_days: 0, broadened: null as Broadened, place: null });

    // Bubble 1 — scan announcement, always shown
    setMessages((prev) => [...prev, {
      id: "k-scan-announce",
      role: "assistant",
      content: `Running a pass across ${filterTokens.join(" · ")}.`,
    }]);
    setStep("scanning");

    setScanPhase(1);
    await delay(800);
    setScanPhase(2);
    await delay(1000);
    setScanPhase(3);
    await delay(1000);

    const { jobs, total_count, capped, window_days, broadened: brd, place } = await jobsPromise;
    setAllJobs(jobs);
    setTotal3dCount(total_count);
    setWindowDays(window_days || 3);
    setScanJobCount(jobs.length);
    setScanPhase(4);
    await delay(1300);

    setScanPhase(0);
    // API already returns company-unique results sorted by recency
    const batch1 = jobs.slice(0, FREE_DAILY_MATCHES);
    const hasVerified = batch1.some((j) => j.visa_tier === "verified");

    if (jobs.length === 0) {
      // Genuine zero — the alert opt-in already ran before the scan, so just be honest.
      setMessages((prev) => [...prev, { id: "k-reveal1", role: "assistant", content: `${ZERO_CAPTURE} You're on the alert list, so the next match comes straight to you.` }]);
      setStep("batch1");
      return;
    }

    const revealText = revealLineFor(brd, { total: total_count, capped, place, hasVerified, freshLabel: postedWithin(batch1) });
    setMessages((prev) => [...prev, { id: "k-reveal1", role: "assistant", content: revealText, jobs: batch1 }]);
    setStep("batch1");

    // Paywall auto-advance: show "Want to see all?" right after the cards render.
    await delay(900);
    setMessages((prev) => [...prev, {
      id: "k-see-more-auto",
      role: "assistant",
      content: `We found ${total_count}${capped ? "+" : ""} ${total_count === 1 && !capped ? "role" : "roles"} from employers that sponsor. Want to see all of them?`,
    }]);
    setQuickReplies([
      { label: "Yes, show me", value: "yes" },
      { label: "Not now",      value: "no"  },
    ]);
    setStep("see_more");
  };

  // ── Free chat ─────────────────────────────────────────────────────────────────

  const handleChatInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setChatInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const sendChatMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isChatStreaming) return;
      setChatInput("");
      if (chatInputRef.current) chatInputRef.current.style.height = "auto";
      if (step === "q2") { await handleTileClick({ label: trimmed, value: trimmed }); return; }
      setShowPostChips(false);

      const userMsgId = `u-${Date.now()}`;
      const thinkingId = `k-${Date.now() + 1}`;
      setMessages((prev) => [...prev,
        { id: userMsgId, role: "user", content: trimmed },
        { id: thinkingId, role: "assistant", content: "", isThinking: true },
      ]);
      setIsChatStreaming(true);

      const history = [...messages, { role: "user" as const, content: trimmed }].map((m) => ({ role: m.role, content: m.content }));

      // Persist user message (fire-and-forget)
      if (user?.id) {
        createSupabaseBrowser().from("kai_messages").insert({ user_id: user.id, role: "user", content: trimmed });
      }

      let accContent = "";
      let accJobs: Job[] | undefined;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, userName: user?.firstName ?? null }),
        });
        if (!res.ok || !res.body) throw new Error("Failed");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let receivedJobs = false;

        setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, isThinking: false, isStreaming: true } : m));

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "text") {
                accContent += event.text;
                setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, content: m.content + event.text } : m));
              } else if (event.type === "tool_start") {
                accContent = accContent ? accContent.trimEnd() + "\n\n" : "";
                setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, content: m.content ? m.content.trimEnd() + "\n\n" : "", isThinking: true, isStreaming: false } : m));
              } else if (event.type === "jobs") {
                receivedJobs = true;
                accJobs = event.jobs;
                setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, jobs: event.jobs } : m));
              } else if (event.type === "done") {
                setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, isThinking: false, isStreaming: false } : m));
                if (user?.id) {
                  createSupabaseBrowser().from("kai_messages").insert({
                    user_id: user.id,
                    role: "assistant",
                    content: accContent,
                    jobs: accJobs ?? null,
                  });
                }
                if (receivedJobs) setShowPostChips(true);
              }
            } catch { /* skip malformed SSE */ }
          }
        }
      } catch {
        setMessages((prev) => prev.map((m) =>
          m.id === thinkingId ? { ...m, isThinking: false, isStreaming: false, content: "Something went wrong. Try again?" } : m
        ));
      } finally {
        setIsChatStreaming(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, isChatStreaming, user, step]
  );

  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(chatInput); }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  const remaining = Math.max(0, total3dCount - 5);

  // Conditions where the main chat input bar should be hidden
  const hideInputBar = step === "init" || step === "scanning" || step === "q1_layoff_date"
    || (PAYWALL_MODE && step === "paywall");

  return (
    <div className={s.page}>
      {/* Nav */}
      <nav className={s.nav}>
        <div className={s["nav-inner"]}>
          <Link href="/me" className={s["exit-btn"]} aria-label="Exit">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="1" y1="1" x2="13" y2="13" />
              <line x1="13" y1="1" x2="1" y2="13" />
            </svg>
          </Link>
          <Link href="/" className={s.brand}>getdatjob</Link>
          <div className={s["nav-spacer"]} />
        </div>
      </nav>

      {/* Chat thread */}
      <div className={s.thread} ref={threadRef} onScroll={onScroll}>
        <div className={s["thread-inner"]}>
          {timeGreeting && (
            <div className={s["page-greeting"]}>
              <h1 className={s["page-headline"]}>
                {timeGreeting.headline}<br />
                {timeGreeting.line2.pre}<em>{timeGreeting.line2.em}</em>{timeGreeting.line2.post}
              </h1>
            </div>
          )}

          {messages.map((msg) => {
            if (msg.isThinking) {
              return (
                <div key={msg.id} className={s["msg-row"]}>
                  <div className={s["kai-avatar"]}>K</div>
                  <div className={`${s.bubble} ${s["bubble-kai"]} ${msg.content ? "" : s.thinking}`}>
                    {msg.content && <KaiText text={msg.content} />}
                    {msg.content
                      ? <div className={s["thinking-inline"]}><span className={s.dot} /><span className={s.dot} /><span className={s.dot} /></div>
                      : <><span className={s.dot} /><span className={s.dot} /><span className={s.dot} /></>}
                  </div>
                </div>
              );
            }
            return (
              <div key={msg.id} data-mid={msg.id} className={s["msg-anchor"]}>
                <div className={`${s["msg-row"]} ${msg.role === "user" ? s["msg-row-user"] : ""}`}>
                  {msg.role === "assistant" && <div className={s["kai-avatar"]}>K</div>}
                  {msg.role === "user" && (
                    user?.avatar
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={user.avatar} alt="" className={s["user-avatar"]} />
                      : <div className={s["user-avatar"]} style={{ background: "var(--accent)", color: "#F4F0E8", fontSize: 11, fontWeight: 700 }}>
                          {(user?.firstName ?? "?").slice(0, 1).toUpperCase()}
                        </div>
                  )}
                  <div className={`${s.bubble} ${msg.role === "user" ? s["bubble-user"] : s["bubble-kai"]}`}>
                    {msg.role === "user" ? msg.content : <KaiText text={msg.content} isStreaming={msg.isStreaming} />}
                  </div>
                </div>
                {msg.role === "assistant" && msg.jobs && msg.jobs.length > 0 && (
                  <div className={s["msg-row"]} style={{ paddingLeft: 50 }}>
                    <div className={s["jobs-wrap"]}>
                      {msg.jobs.map((job) => <JobCard key={job.id} job={job} onClick={() => setSelectedJob(job)} />)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {step === "scanning" && scanPhase > 0 && (
            <ScanChecklistBubble phase={scanPhase} jobCount={scanJobCount} visa={intake.visa} />
          )}

          {/* Paywall mode: alert opt-in chips before scan */}
          {PAYWALL_MODE && step === "alert_optin" && (
            <div className={s["inline-replies"]}>
              <div className={s["inline-stem"]} />
              <div className={s["inline-tree"]}>
                {[
                  { label: "Absolutely, keep me updated on new matches", value: "yes" },
                  { label: "No thanks, I'll check manually",             value: "no"  },
                ].map((qr, i, arr) => (
                  <div key={qr.value} className={i === arr.length - 1 ? `${s["inline-tree-item"]} ${s["inline-tree-item-last"]}` : s["inline-tree-item"]}>
                    <button className={s["inline-chip"]} onClick={() => handleAlertOptin(qr.value)}>{qr.label}</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* batch1 show-more — venmo mode only (paywall auto-advances without a button) */}
          {step === "batch1" && !PAYWALL_MODE && (
            <div className={s["show-more-row"]}>
              <button className={s["show-more-btn"]} onClick={handleShowMore1}>
                Show more →
              </button>
            </div>
          )}

          {/* Venmo mode: batch2 show-more */}
          {!PAYWALL_MODE && step === "batch2" && (
            <div className={s["show-more-row"]}>
              <button className={s["show-more-btn"]} onClick={handleShowMore2}>
                Show more →
              </button>
            </div>
          )}

          {/* Paywall mode: inline PaywallScreen — data-mid lets the scroll hook anchor its top */}
          {PAYWALL_MODE && step === "paywall" && (
            <div data-mid="paywall" className={s["msg-anchor"]} style={{ paddingLeft: 50, paddingBottom: 24 }}>
              <PaywallScreen
                jobCount={total3dCount}
                windowDays={windowDays}
                email={user?.email ?? undefined}
                onContinueFree={() => {
                  setStep("done");
                  setMessages((prev) => [...prev, {
                    id: "k-continue-free",
                    role: "assistant",
                    content: `No worries — your ${FREE_DAILY_MATCHES} free daily matches are always here. Come back tomorrow for fresh ones.`,
                  }]);
                }}
              />
            </div>
          )}

          {/* Inline quick-reply chips */}
          {quickReplies.length > 0 && (() => {
            // A multi-option group (e.g. departments) is flagged with `row` — let those
            // chips flow next to one another and wrap by screen width instead of forcing
            // fixed rows. Single-option groups keep the vertical decision-tree look.
            const isWrap = quickReplies.some((qr) => qr.row !== undefined);
            if (isWrap) {
              // Max 3 chips per row — denser looks bad. Each row still wraps
              // internally on narrow screens, and every visual row gets a tick.
              const chipRows: (typeof quickReplies)[] = [];
              for (let i = 0; i < quickReplies.length; i += 3) chipRows.push(quickReplies.slice(i, i + 3));
              return (
                <div className={s["inline-replies"]}>
                  <div className={s["inline-stem"]} />
                  <div className={s["inline-wrap"]}>
                    {chipRows.map((row) => (
                      <div key={row[0].value} className={s["wrap-row"]}>
                        {row.map((qr) => (
                          <div key={qr.value} className={s["wrap-chip"]}>
                            <button className={s["inline-chip"]} onClick={() => handleTileClick(qr)}>{qr.label}</button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            return (
              <div className={s["inline-replies"]}>
                <div className={s["inline-stem"]} />
                <div className={s["inline-tree"]}>
                  {quickReplies.map((qr, i) => (
                    <div key={qr.value} className={i === quickReplies.length - 1 ? `${s["inline-tree-item"]} ${s["inline-tree-item-last"]}` : s["inline-tree-item"]}>
                      <button className={s["inline-chip"]} onClick={() => handleTileClick(qr)}>{qr.label}</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {showPostChips && step === "done" && (
            <div className={s.chips} style={{ justifyContent: "flex-start", paddingLeft: 50 }}>
              {POST_RESULT_CHIPS.map((c) => (
                <button key={c} className={s.chip} onClick={() => sendChatMessage(c)}>{c}</button>
              ))}
            </div>
          )}

          {/* Dock always renders so the pill toggling can't resize the thread */}
          <div className={s["jump-pill-dock"]}>
            {showJump && (
              <button
                type="button"
                className={s["jump-pill"]}
                onClick={() => jumpToLatest()}
                aria-label="Jump to newest messages"
              >
                New messages
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Date input bar (layoff date step) */}
      {step === "q1_layoff_date" && (
        <div className={s["input-bar"]}>
          <div className={s["input-bar-inner"]}>
            <div className={s["input-wrap"]}>
              <input
                ref={dateInputRef}
                type="text"
                inputMode="numeric"
                className={s["date-input"]}
                placeholder="MM/DD/YY"
                value={dateInput}
                onChange={handleDateInputChange}
                onKeyDown={(e) => { if (e.key === "Enter") handleDateSubmit(); }}
                maxLength={8}
                autoComplete="off"
              />
            </div>
            <button
              className={s["send-btn"]}
              onClick={handleDateSubmit}
              disabled={dateInput.length < 6}
              aria-label="Submit date"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 8H2M8 2l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Main chat input bar */}
      {!hideInputBar && (
        <div className={s["input-bar"]}>
          <div className={s["input-bar-inner"]}>
            <div className={s["input-wrap"]}>
              <textarea
                ref={chatInputRef}
                className={s.input}
                placeholder="Send Kai a message..."
                value={chatInput}
                onChange={handleChatInputChange}
                onKeyDown={handleChatKeyDown}
                rows={1}
                disabled={isChatStreaming}
              />
            </div>
            <button
              className={s["send-btn"]}
              onClick={() => sendChatMessage(chatInput)}
              disabled={!chatInput.trim() || isChatStreaming}
              aria-label="Send"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 8H2M8 2l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Venmo mode: support bottom sheet */}
      {!PAYWALL_MODE && showSupport && (
        <SupportScreen
          email={user?.email ?? null}
          jobCount={total3dCount || allJobs.length}
          onClose={handleSupportClose}
          onSent={handleISentIt}
        />
      )}

      {selectedJob && <JobDetailModal job={selectedJob} onClose={() => setSelectedJob(null)} />}
    </div>
  );
}

"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import s from "./onboarding.module.css";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { Bookmark, MapPin, ExternalLink, X, Share2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Job = {
  id: number;
  title: string;
  company: string;
  company_domain: string | null;
  location: string | null;
  url: string | null;
  posted_at: string | null;
  visa_tier: string | null;
  salary_range: string | null;
  salary_estimate: number | null;
  lca_count: number | null;
  lca_count_2025: number | null;
  lca_last_filed: string | null;
  ats_source: string | null;
  ats_job_id: string | null;
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

type QR = { label: string; value: string };

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

type OnboardingStep =
  | "init"
  | "q1"
  | "q1_layoff_date"
  | "q2"
  | "q3"
  | "q4"
  | "q5"
  | "scanning"
  | "batch1"
  | "email_optin"
  | "count_prompt"
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
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN ?? "";
const DOMAIN_OVERRIDES: Record<string, string> = { block: "block.xyz" };

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

function companyDomain(name: string): string {
  const stem = normalizeCompanyName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return DOMAIN_OVERRIDES[stem] ?? stem + ".com";
}

function formatSalary(n: number): string {
  return "~$" + Math.round(n / 1000) + "K";
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

function isPostedToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return Date.now() - new Date(dateStr).getTime() < 86_400_000;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function formatLcaDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const parts = dateStr.split("-");
  if (parts.length < 2) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[month]} ${year}`;
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

function inferLevel(title: string): string | null {
  const t = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(t)) return "Intern";
  if (/\b(junior|jr\.?|entry[- ]level|associate(?! director| product))\b/.test(t)) return "Junior";
  if (/\b(principal|staff engineer|distinguished|fellow)\b/.test(t)) return "Principal / Staff";
  if (/\b(senior|sr\.?)\b/.test(t)) return "Senior";
  if (/\b(lead|manager|director|head of|vp\b|vice president)\b/.test(t)) return "Lead / Manager";
  return null;
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

function CompanyAvatar({ name, domain }: { name: string; domain: string | null }) {
  const [imgError, setImgError] = useState(false);
  const resolved = domain || companyDomain(name);
  if (LOGO_DEV_TOKEN && !imgError) {
    return (
      <div className="w-10 h-10 rounded-lg flex-shrink-0 border border-zinc-100 bg-white overflow-hidden flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`https://img.logo.dev/${resolved}?token=${LOGO_DEV_TOKEN}&size=64&format=png&fallback=monogram`}
          alt={name}
          onError={() => setImgError(true)}
          className="w-full h-full object-contain p-0.5"
        />
      </div>
    );
  }
  return (
    <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-zinc-100 border border-zinc-100 flex items-center justify-center font-bold text-xs text-zinc-500 uppercase">
      {name.slice(0, 2)}
    </div>
  );
}

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

  const isVerified = job.visa_tier === "verified";
  const isFriendly = job.visa_tier === "friendly";
  const posted = timeAgo(job.posted_at);
  const fresh = isPostedToday(job.posted_at);
  const displayCompany = normalizeCompanyName(job.company);
  const lcaLastFiled = formatLcaDate(job.lca_last_filed);

  return (
    <div
      className="border border-zinc-200 rounded-xl bg-white px-3.5 pt-3 pb-2.5 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
      onClick={onClick}
    >
      {/* Logo + company | bookmark + apply */}
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

      {/* Title */}
      <h3 className="text-base font-bold text-zinc-900 leading-snug mb-1.5">{job.title}</h3>

      {/* Location · date posted */}
      {(job.location || posted) && (
        <div className="flex items-center gap-1 text-xs text-zinc-500 mb-2">
          <MapPin size={10} className="text-zinc-400 flex-shrink-0" />
          <span>{[job.location, posted ? `Posted ${posted}` : null].filter(Boolean).join(" · ")}</span>
        </div>
      )}

      {/* Tags: fresh, salary, verified, friendly */}
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {fresh && (
          <span className={s["fresh-badge"]}>
            <span className={s["fresh-dot"]} />
            Posted today
          </span>
        )}
        {job.salary_range && (
          <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
            Salary: {job.salary_range}
          </span>
        )}
        {!job.salary_range && job.salary_estimate && job.salary_estimate > 50000 && (
          <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{formatSalary(job.salary_estimate)}</span>
        )}
        {isVerified && (
          <span className="inline-flex rounded-full p-[2px]" style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}>
            <span className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900">
              Verified LCA Filings With Similar Job Title
            </span>
          </span>
        )}
        {isFriendly && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-green-50 text-[var(--ink-2)] text-xs font-medium border border-green-200">
            H-1B Friendly Employer
          </span>
        )}
      </div>

      {/* LCA stats */}
      {(lcaLastFiled || (job.lca_count_2025 && job.lca_count_2025 > 0)) && (
        <div className="flex flex-wrap gap-1.5">
          {lcaLastFiled && (
            <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
              Last LCA filed in {lcaLastFiled}
            </span>
          )}
          {job.lca_count_2025 && job.lca_count_2025 > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
              {job.lca_count_2025} LCA filings in 2025
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function JobDetailModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const [descHtml, setDescHtml] = useState("");
  const [descText, setDescText] = useState("");
  const [descLoading, setDescLoading] = useState(true);
  const displayCompany = normalizeCompanyName(job.company);
  const posted = timeAgo(job.posted_at);
  const isVerified = job.visa_tier === "verified";
  const isFriendly = job.visa_tier === "friendly";
  const lcaLastFiled = formatLcaDate(job.lca_last_filed);
  const extractedSalary = useMemo(() => extractPostedSalary(descHtml || descText), [descHtml, descText]);
  const postedSalary = job.salary_range || extractedSalary;
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
    (async () => {
      try {
        if (job.ats_source === "amazon" && job.ats_job_id) {
          const res = await fetch(`/api/jobs/description?source=amazon&job_id=${encodeURIComponent(job.ats_job_id)}`);
          if (res.ok) {
            const { html } = await res.json();
            if (html) { setDescHtml(html); setDescLoading(false); return; }
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
                <button onClick={handleShare} className="p-2 rounded-full border border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700 transition-all" aria-label="Share job">
                  <Share2 size={14} />
                </button>
              </div>
              <div className="relative">
                {showToast && (
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap pointer-events-none">
                    Saved
                  </span>
                )}
                <button onClick={handleSave} className={`p-2 rounded-full border transition-all ${saved ? "bg-zinc-900 border-zinc-900 text-white" : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700"}`} aria-label={saved ? "Unsave job" : "Save job"}>
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
              <a href={job.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-semibold rounded-lg transition-colors no-underline">
                Apply <ExternalLink size={12} />
              </a>
            )}
          </div>

          {job.location && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
              <MapPin size={11} className="flex-shrink-0 text-zinc-400" />
              <span>{job.location}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5 mb-3">
            {isVerified && (
              <span className="inline-flex rounded-full p-[2px]" style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}>
                <span className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900">
                  Verified LCA Filings With Similar Job Title
                </span>
              </span>
            )}
            {isFriendly && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-50 text-[var(--ink-2)] text-xs font-medium border border-green-200">
                H-1B Friendly Employer
              </span>
            )}
          </div>

          {(postedSalary || job.lca_count_2025 || lcaLastFiled) && (
            <div className="flex flex-wrap gap-1.5">
              {postedSalary && (
                <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
                  Salary: {postedSalary}
                </span>
              )}
              {job.lca_count_2025 && job.lca_count_2025 > 0 && (
                <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
                  {job.lca_count_2025} LCA filings in 2025
                </span>
              )}
              {lcaLastFiled && (
                <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
                  Last LCA filed in {lcaLastFiled}
                </span>
              )}
            </div>
          )}
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
  "Checking today's ATS feeds",
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
            Found {jobCount} fresh match{jobCount !== 1 ? "es" : ""} from today. Ranking by sponsor reliability...
          </div>
        ) : (
          phase < 4 && (
            <div className={s["thinking-inline"]}>
              <span className={s.dot} /><span className={s.dot} /><span className={s.dot} />
            </div>
          )
        )}
      </div>
    </div>
  );
}

function SupportScreen({ email, jobCount, onClose, onSent }: { email: string | null; jobCount: number; onClose: () => void; onSent: () => void }) {
  const note = email ? `getdatjob+${encodeURIComponent(email)}` : "getdatjob";
  const venmoDeepLink = `venmo://paycharge?txn=pay&recipients=letiendat&amount=10&note=${note}`;
  const venmoWeb = "https://venmo.com/letiendat?txn=pay&amount=10";

  const handleVenmoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const fallback = setTimeout(() => { window.open(venmoWeb, "_blank"); }, 1500);
    const cleanup = () => { clearTimeout(fallback); document.removeEventListener("visibilitychange", cleanup); };
    document.addEventListener("visibilitychange", cleanup);
    window.location.href = venmoDeepLink;
  };

  return (
    <div className={s["support-overlay"]} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s["support-sheet"]}>
        <p className={s["support-hook"]}>
          <span className={s["support-count"]}>{jobCount} matching jobs today</span>{" "}
          waiting for you.
        </p>
        <p className={s["support-body"]}>
          Tip $10 to unlock the rest – that&apos;s your daily batch.
        </p>
        <p className={s["support-story"]}>
          I&apos;m Dat, solo founder of getdatjob. I&apos;m on a working visa too.
          No VC, no team – I build this on weeknights and weekends.
        </p>
        <a href={venmoDeepLink} onClick={handleVenmoClick} className={s["support-cta"]}>
          Support on Venmo – $10 👊
        </a>
        <button className={s["support-sent"]} onClick={onSent}>
          I sent it ✓
        </button>
        <button className={s["support-skip"]} onClick={onClose}>
          No pressure – come back tomorrow
        </button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [step, setStep] = useState<OnboardingStep>("init");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quickReplies, setQuickReplies] = useState<QR[]>([]);
  const [intake, setIntake] = useState<IntakeData>({
    intent: null, layoffDate: null, location: null, locationMode: null,
    visa: null, salaryMin: null, level: null,
  });
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [totalJobCount, setTotalJobCount] = useState<number>(0);
  const [scanPhase, setScanPhase] = useState(0);
  const [scanJobCount, setScanJobCount] = useState<number | null>(null);
  const [showSupport, setShowSupport] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [linkedIn, setLinkedIn] = useState<LinkedInProfile | null>(null);
  const [enriched, setEnriched] = useState<EnrichedProfile | null>(null);
  const [timeGreeting, setTimeGreeting] = useState<{ headline: string; line2: Greeting["line2"] } | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [showPostChips, setShowPostChips] = useState(false);
  const [dateInput, setDateInput] = useState("");

  const threadRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const pendingJobsRef = useRef<Promise<{ jobs: Job[]; total_count: number }> | null>(null);

  const scrollToBottom = useCallback(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scanPhase, step, scrollToBottom]);

  // Load auth user + profiles
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

        supabase.schema("enriched").from("profiles").select("current_title, location, job_function, job_level").eq("user_id", data.user.id).eq("enrich_status", "done").maybeSingle()
          .then(({ data: ep }) => { if (ep) setEnriched(ep as EnrichedProfile); });
      }
      setUserLoading(false);
    });
  }, []);

  useEffect(() => { setTimeGreeting(getTimeGreeting(null)); }, []);
  useEffect(() => { if (user?.firstName) setTimeGreeting(getTimeGreeting(user.firstName)); }, [user?.firstName]);

  // Kick off onboarding once user resolves
  useEffect(() => {
    if (userLoading || step !== "init") return;
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

  // ── Tile click (state machine) ────────────────────────────────────────────────

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
        "h1b": "That narrows the pool to companies with a real H-1B track record. But don't worry – over 47,000 companies filed H-1B LCAs in 2025, and the good ones are in here.",
        "e3":  "E-3 sponsors are a more specific group – I'll zero in on the ones with a strong Australian hire track record.",
        "tn":  "TN sponsors are a more specific group – I'll zero in on the ones with a strong Canada/Mexico hire track record.",
        "opt": "Got it – OPT-friendly companies are in the mix. I'll prioritize the ones with strong recent filing history.",
      };
      const visaKey = visa.toLowerCase().replace(/[-/ ]/g, "");
      setMessages((prev) => [...prev, { id: "k-f2", role: "assistant", content: visaFiller[visaKey] ?? "Got it – pulling the right sponsors." }]);
      await delay(850);
      setMessages((prev) => [...prev, {
        id: "k-q3", role: "assistant", content: [
          "What's the minimum base salary that would make a move worth it? Or are you open?",
          "What's the minimum base salary that would make a move worth it? Or no minimum?",
          "What's the minimum base salary that would make a move worth it? Or are you flexible on salary?",
        ][Math.floor(Math.random() * 3)],
      }]);
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
      const inferredLevel = inferLevel(linkedIn?.headline ?? "");
      const q4Text = inferredLevel
        ? `Based on your title, looks like **${inferredLevel}** – is that right?`
        : "Senior IC, or ready to lead a team?";
      const q4Replies: QR[] = inferredLevel
        ? [
            { label: "That's right", value: inferredLevel.toLowerCase().includes("manager") || inferredLevel.toLowerCase().includes("lead") ? "manager" : "senior_ic" },
            { label: "Actually Manager / Lead", value: "manager" },
            { label: "Either works", value: "either" },
          ]
        : [
            { label: "Senior IC",      value: "senior_ic" },
            { label: "Manager / Lead", value: "manager"   },
            { label: "Either works",   value: "either"    },
          ];
      setMessages((prev) => [...prev, { id: "k-q4", role: "assistant", content: q4Text }]);
      setQuickReplies(q4Replies);
      setStep("q4");

    } else if (step === "q4") {
      const level = qr.value;
      setIntake((prev) => ({ ...prev, level }));
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);

      if (level === "either") {
        await delay(450);
        setMessages((prev) => [...prev, { id: "k-f4", role: "assistant", content: "Flexible – that opens it up." }]);
      }
      await delay(level === "either" ? 700 : 400);

      const supabase = createSupabaseBrowser();
      const { data: { user: authUser } } = await supabase.auth.getUser();
      let knownLocation: string | null = null;
      if (authUser) {
        const { data: ep } = await supabase.schema("enriched").from("profiles").select("location").eq("user_id", authUser.id).eq("enrich_status", "done").maybeSingle();
        const raw = ep?.location ?? null;
        knownLocation =
          raw &&
          (raw.includes(" ") || /^remote$/i.test(raw)) &&
          !/university|college|school|institute|academy|polytechnic/i.test(raw)
            ? raw
            : null;
      }

      const q5Text = knownLocation
        ? `You're in ${knownLocation} – staying local, or open to remote and other cities?`
        : "Where are you based right now?";
      const q5Replies: QR[] = knownLocation
        ? [
            { label: `${knownLocation.split(",")[0]} / local`, value: "local"   },
            { label: "Remote only",                            value: "remote"  },
            { label: "Open to other cities",                   value: "anywhere"},
          ]
        : [
            { label: "Bay Area / SF",    value: "bay_area" },
            { label: "NYC / East Coast", value: "nyc"      },
            { label: "Remote only",      value: "remote"   },
            { label: "Open anywhere",    value: "anywhere" },
          ];

      if (knownLocation) setIntake((prev) => ({ ...prev, location: knownLocation, locationMode: "local" }));
      setMessages((prev) => [...prev, { id: "k-q5", role: "assistant", content: q5Text }]);
      setQuickReplies(q5Replies);
      setStep("q5");

    } else if (step === "q5") {
      const level = intake.level ?? "either";
      const locMap: Record<string, { location: string | null; locationMode: string }> = {
        local:    { location: intake.location, locationMode: "local"    },
        bay_area: { location: "San Francisco", locationMode: "local"    },
        nyc:      { location: "New York",      locationMode: "local"    },
        remote:   { location: null,            locationMode: "remote"   },
        anywhere: { location: null,            locationMode: "anywhere" },
      };
      const loc = locMap[qr.value] ?? { location: null, locationMode: "anywhere" };
      const updatedIntake = { ...intake, ...loc, level };
      setIntake(updatedIntake);
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(500);

      const dept = inferDepartment(linkedIn?.headline ?? enriched?.current_title ?? null);
      const salaryStr = updatedIntake.salaryMin ? `$${Math.round(updatedIntake.salaryMin / 1000)}K+` : "any salary";
      const levelStr = level === "senior_ic" ? "Senior IC" : level === "manager" ? "Manager / Lead" : "all levels";
      const locStr = updatedIntake.locationMode === "remote" ? "remote" : updatedIntake.locationMode === "anywhere" ? "anywhere in the US" : updatedIntake.location ?? "all locations";

      const filterTokens = [dept, locStr, salaryStr, levelStr, "posted today"].filter(Boolean);
      setMessages((prev) => [...prev, {
        id: "k-scan-announce", role: "assistant",
        content: `Scanning today's postings — ${filterTokens.join(" · ")}.\n\nGive me a sec – I'll bring back what's fresh.`,
      }]);

      // Fire fetch immediately so it runs while user answers the email question
      pendingJobsRef.current = fetch("/api/onboarding/jobs-today", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visa: updatedIntake.visa,
          location: updatedIntake.location,
          locationMode: updatedIntake.locationMode,
          salary_min: updatedIntake.salaryMin,
          intent: updatedIntake.intent,
          department: dept ?? undefined,
        }),
      })
        .then((r) => r.json())
        .then((d) => ({ jobs: d.jobs ?? [], total_count: d.total_count ?? 0 }))
        .catch(() => ({ jobs: [], total_count: 0 }));

      // Save intake preferences (fire-and-forget)
      createSupabaseBrowser().auth.getUser().then(({ data }) => {
        if (!data.user) return;
        const levelMap: Record<string, string> = { senior_ic: "Senior IC", manager: "Manager/Lead", either: "Either" };
        const visaMap: Record<string, string> = { "H-1B": "H-1B", "OPT": "OPT", "E-3": "E-3/TN" };
        const prefLocStr = updatedIntake.locationMode === "remote" ? "Remote" : updatedIntake.locationMode === "anywhere" ? null : updatedIntake.location;
        createSupabaseBrowser().schema("enriched").from("profiles").upsert({
          user_id: data.user.id,
          visa_type: visaMap[updatedIntake.visa ?? ""] ?? "Other",
          salary_floor: updatedIntake.salaryMin ?? null,
          job_level: levelMap[updatedIntake.level ?? ""] ?? null,
          location: prefLocStr ?? null,
          onboarding_complete: true,
        }, { onConflict: "user_id" }).then(() => {});
      });

      // Ask email opt-in while search is running in background
      await delay(400);
      setMessages((prev) => [...prev, {
        id: "k-optin-ask", role: "assistant",
        content: "While I'm searching for your matches, can I ping you when you get new matches?",
      }]);
      setQuickReplies([
        { label: "Yes, keep me posted", value: "yes" },
        { label: "Maybe later",         value: "no"  },
      ]);
      setStep("email_optin");

    } else if (step === "email_optin") {
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      setQuickReplies([]);
      await delay(350);
      if (qr.value === "yes") {
        setMessages((prev) => [...prev, { id: "k-optin-yes", role: "assistant", content: "Perfect – I'll ping you daily when new matches hit. Won't spam you." }]);
        try {
          const supabase = createSupabaseBrowser();
          const { data: { user: authUser } } = await supabase.auth.getUser();
          if (authUser) await supabase.from("profiles").update({ email_alerts: true }).eq("id", authUser.id);
        } catch { /* graceful */ }
      } else {
        setMessages((prev) => [...prev, { id: "k-optin-no", role: "assistant", content: "Got it – no pressure." }]);
      }
      await delay(500);

      // Now run the scan animation while awaiting the already-in-flight fetch
      setStep("scanning");
      setScanPhase(1);
      await delay(1100);
      setScanPhase(2);
      await delay(1000);
      setScanPhase(3);
      await delay(1000);

      const { jobs, total_count } = await (pendingJobsRef.current ?? Promise.resolve({ jobs: [], total_count: 0 }));
      setAllJobs(jobs);
      setTotalJobCount(total_count);
      setScanJobCount(jobs.length);
      setScanPhase(4);
      await delay(1300);

      setScanPhase(0);
      const count = jobs.length;
      const hasVerified = jobs.some((j) => j.visa_tier === "verified");
      const revealText = count > 0
        ? `Found ${count} fresh job${count !== 1 ? "s" : ""} posted today.${hasVerified ? "\n\nThe ones marked 'Verified LCA Filings' mean the company has filed an LCA with a similar job title before – so the sponsorship signal is extremely high." : ""}`
        : "Hmm, nothing fresh from today yet – new postings drop throughout the day. Come back in a few hours.";
      setMessages((prev) => [...prev, { id: "k-reveal1", role: "assistant", content: revealText, jobs }]);
      setStep("batch1");

    } else if (step === "count_prompt") {
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(400);
      if (qr.value === "yes") {
        setShowSupport(true);
        setStep("support");
      } else {
        setMessages((prev) => [...prev, { id: "k-skip", role: "assistant", content: "No problem – that's today's batch. Come back tomorrow for fresh picks." }]);
        setStep("done");
      }
    }
  };

  // ── Date input (layoff date) ──────────────────────────────────────────────────

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

  // ── Show-more from batch1 → count prompt ─────────────────────────────────────

  const handleShowMore1 = async () => {
    if (totalJobCount > allJobs.length) {
      const remaining = totalJobCount - allJobs.length;
      setMessages((prev) => [...prev, {
        id: "k-count-prompt", role: "assistant",
        content: `We found **${totalJobCount}** visa-sponsoring jobs posted today that match your profile.\n\nWant to see the other ${remaining}?`,
      }]);
      setQuickReplies([
        { label: "Yes, show me", value: "yes" },
        { label: "No thanks",    value: "no"  },
      ]);
      setStep("count_prompt");
    } else {
      setMessages((prev) => [...prev, { id: "k-done", role: "assistant", content: "That's today's full batch. New matches drop daily – come back tomorrow for fresh picks." }]);
      setStep("done");
    }
  };

  // ── Support sheet handlers ────────────────────────────────────────────────────

  const handleSupportClose = async () => {
    setShowSupport(false);
    setStep("done");
    await delay(300);
    setMessages((prev) => [...prev, {
      id: "k-skip-support", role: "assistant",
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
      id: "k-supporter", role: "assistant",
      content: "You're in – thank you! Unlimited Kai starting now. What else can I find you?",
    }]);
  };

  // ── Free chat (after done) ────────────────────────────────────────────────────

  const handleChatInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setChatInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const sendChatMessage = useCallback(async (text: string) => {
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
              setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, content: m.content + event.text } : m));
              scrollToBottom();
            } else if (event.type === "tool_start") {
              setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, content: m.content ? m.content.trimEnd() + "\n\n" : "", isThinking: true, isStreaming: false } : m));
            } else if (event.type === "jobs") {
              receivedJobs = true;
              setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, jobs: event.jobs } : m));
            } else if (event.type === "done") {
              setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, isThinking: false, isStreaming: false } : m));
              if (receivedJobs) setShowPostChips(true);
            }
          } catch { /* skip malformed SSE */ }
        }
      }
    } catch {
      setMessages((prev) => prev.map((m) => m.id === thinkingId ? { ...m, isThinking: false, isStreaming: false, content: "Something went wrong. Try again?" } : m));
    } finally {
      setIsChatStreaming(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isChatStreaming, scrollToBottom, user, step]);

  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(chatInput); }
  };

  const POST_RESULT_CHIPS = ["Show more", "Change location", "Higher salary only", "Posted this week"];

  // ── Render ────────────────────────────────────────────────────────────────────

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
      <div className={s.thread} ref={threadRef}>
        <div className={s["thread-inner"]}>
          {/* Time-aware greeting */}
          {timeGreeting && (
            <div className={s["page-greeting"]}>
              <h1 className={s["page-headline"]}>
                {timeGreeting.headline}<br />
                {timeGreeting.line2.pre}<em>{timeGreeting.line2.em}</em>{timeGreeting.line2.post}
              </h1>
            </div>
          )}

          {/* Conversation */}
          {messages.map((msg) => {
            if (msg.isThinking) {
              return (
                <div key={msg.id} className={s["msg-row"]}>
                  <div className={s["kai-avatar"]}>K</div>
                  <div className={`${s.bubble} ${s["bubble-kai"]} ${msg.content ? "" : s.thinking}`}>
                    {msg.content && <KaiText text={msg.content} />}
                    {msg.content ? (
                      <div className={s["thinking-inline"]}>
                        <span className={s.dot} /><span className={s.dot} /><span className={s.dot} />
                      </div>
                    ) : (
                      <><span className={s.dot} /><span className={s.dot} /><span className={s.dot} /></>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={msg.id}>
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

          {/* Scan checklist */}
          {step === "scanning" && scanPhase > 0 && (
            <ScanChecklistBubble phase={scanPhase} jobCount={scanJobCount} visa={intake.visa} />
          )}

          {/* Batch 1 show-more */}
          {step === "batch1" && (
            <div className={s["show-more-row"]}>
              <button className={s["show-more-btn"]} onClick={handleShowMore1}>
                {totalJobCount > allJobs.length ? `See ${totalJobCount - allJobs.length} more →` : "See more →"}
              </button>
            </div>
          )}

          {/* Quick-reply chips */}
          {quickReplies.length > 0 && (
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
          )}

          {/* Post-result chips */}
          {showPostChips && step === "done" && (
            <div className={s.chips} style={{ justifyContent: "flex-start", paddingLeft: 50 }}>
              {POST_RESULT_CHIPS.map((c) => (
                <button key={c} className={s.chip} onClick={() => sendChatMessage(c)}>{c}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Date input bar */}
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
            <button className={s["send-btn"]} onClick={handleDateSubmit} disabled={dateInput.length < 6} aria-label="Submit date">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 8H2M8 2l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Chat input bar */}
      {step !== "init" && step !== "scanning" && step !== "q1_layoff_date" && (
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
            <button className={s["send-btn"]} onClick={() => sendChatMessage(chatInput)} disabled={!chatInput.trim() || isChatStreaming} aria-label="Send">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 8H2M8 2l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Support bottom sheet */}
      {showSupport && (
        <SupportScreen
          email={user?.email ?? null}
          jobCount={totalJobCount}
          onClose={handleSupportClose}
          onSent={handleISentIt}
        />
      )}

      {/* Job detail modal */}
      {selectedJob && (
        <JobDetailModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  );
}

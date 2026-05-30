"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import s from "../kai-first/kai.module.css";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { Bookmark, MapPin, ExternalLink, X, Share2 } from "lucide-react";
import PaywallScreen from "@/app/components/PaywallScreen";

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

// kai-pay uses a different step sequence — no email_optin/batch2/support;
// instead: alert_optin → scanning → batch1 → see_more → paywall
type OnboardingStep =
  | "init"
  | "q1"
  | "q1_layoff_date"
  | "q2"
  | "q3"
  | "q4"
  | "q5"
  | "q6"
  | "alert_optin"
  | "scanning"
  | "batch1"
  | "see_more"
  | "paywall"
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
  "space exploration technologies": "SpaceX",
  "openai opco": "OpenAI",
  "deloitte touche tohmatsu services": "Deloitte",
  "deloitte transactions and business analytics": "Deloitte",
  "pricewaterhousecoopers advisory services": "PwC",
  "pricewaterhousecoopers": "PwC",
  "mckinsey & company united states": "McKinsey",
  "mckinsey & company": "McKinsey",
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

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function postedWithin(jobs: { posted_at: string | null }[]): string | null {
  const dates = jobs.map((j) => j.posted_at ? new Date(j.posted_at).getTime() : null).filter(Boolean) as number[];
  if (dates.length === 0) return null;
  const oldestHours = Math.floor((Date.now() - Math.min(...dates)) / 3600000);
  if (oldestHours < 24) return "the last 24 hours";
  if (oldestHours < 48) return "the last 2 days";
  return "the last 3 days";
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
  if (t.includes("product manager") || t.includes("product owner") || /\bhead of product\b/.test(t)) return "product";
  if (t.includes("machine learning") || / ml | ml,|mlops/.test(t) || t.includes("llm") || t.includes("ai engineer")) return "AI / ML";
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
  if (h.includes("product manager") || h.includes("product management") || /\bhead of product\b/.test(h)) return "Product";
  if (h.includes("machine learning") || h.includes("data scientist") || h.includes("data engineer") || h.includes("analytics") || /\bml\b/.test(h) || h.includes("ai ")) return "Data / AI";
  if (h.includes("growth") || h.includes("marketing") || h.includes("demand gen")) return "Marketing";
  if (h.includes("design") || /\bux\b/.test(h) || /\bui\b/.test(h)) return "Design";
  if (h.includes("sales") || h.includes("account executive") || h.includes("business development") || h.includes("partnerships")) return "Sales";
  if (h.includes("finance") || h.includes("accounting") || h.includes("controller") || h.includes("cfo")) return "Finance";
  if (h.includes("operations") || h.includes("recruiting") || h.includes("talent") || /\bhr\b/.test(h)) return "Operations";
  if (h.includes("product")) return "Product";
  return null;
}

function inferLevel(title: string): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(t)) return "Intern";
  if (/\b(junior|jr\.?|entry[- ]level|associate(?! director| product))\b/.test(t)) return "Junior";
  if (/\b(principal|staff engineer|distinguished|fellow)\b/.test(t)) return "Principal / Staff";
  if (/\b(senior|sr\.?)\b/.test(t)) return "Senior";
  if (/\b(lead|manager|director|head of|vp\b|vice president)\b/.test(t)) return "Lead / Manager";
  return "Senior IC";
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
  const displayCompany = normalizeCompanyName(job.company);
  const lcaLastFiled = formatLcaDate(job.lca_last_filed);

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
              <Bookmark size={13} className={saved ? "fill-current" : ""} />
            </button>
          </div>
          {job.url && (
            <a href={job.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-zinc-900 text-white text-xs font-semibold hover:bg-zinc-700 transition-colors no-underline">
              Apply <ExternalLink size={11} />
            </a>
          )}
        </div>
      </div>
      <h3 className="text-base font-bold text-zinc-900 leading-snug mb-1">{job.title}</h3>
      {(job.location || posted) && (
        <div className="flex items-center gap-1 text-xs text-zinc-500 mb-1.5">
          <MapPin size={10} className="text-zinc-400 flex-shrink-0" />
          <span>{[job.location, posted ? `Posted ${posted}` : null].filter(Boolean).join(" · ")}</span>
        </div>
      )}
      {(job.salary_range || isVerified || isFriendly) && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {job.salary_range && (
            <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
              Salary: {job.salary_range}
            </span>
          )}
          {isVerified && (
            <span className="inline-flex rounded-full p-[2px]" style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}>
              <span className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900">
                Verified LCA Filings With Similar Job Title
              </span>
            </span>
          )}
          {isFriendly && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-green-50 text-[var(--ink-2)] text-xs font-medium border border-green-200">H-1B Friendly Employer</span>
          )}
        </div>
      )}
      {(lcaLastFiled || (job.lca_count_2025 && job.lca_count_2025 > 0) || formatPoc(job.poc_first_name, job.poc_last_name, job.poc_email)) && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {lcaLastFiled && (
            <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">Last LCA filed in {lcaLastFiled}</span>
          )}
          {job.lca_count_2025 && job.lca_count_2025 > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{job.lca_count_2025} LCA filings in 2025</span>
          )}
          {formatPoc(job.poc_first_name, job.poc_last_name, job.poc_email) && (
            <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">PoC: {formatPoc(job.poc_first_name, job.poc_last_name, job.poc_email)}</span>
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
  const [apiSalary, setApiSalary] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [copied, setCopied] = useState(false);
  const displayCompany = normalizeCompanyName(job.company);
  const posted = timeAgo(job.posted_at);
  const isVerified = job.visa_tier === "verified";
  const isFriendly = job.visa_tier === "friendly";
  const lcaLastFiled = formatLcaDate(job.lca_last_filed);
  const extractedSalary = useMemo(() => extractPostedSalary(descHtml || descText), [descHtml, descText]);
  const postedSalary = job.salary_range || apiSalary || extractedSalary;

  function handleSave() {
    if (!saved) { setShowToast(true); setTimeout(() => setShowToast(false), 1500); }
    setSaved(v => !v);
  }
  function handleShare() {
    navigator.clipboard.writeText(job.url ?? window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  useEffect(() => {
    setDescLoading(true);
    setDescHtml(""); setDescText(""); setApiSalary(null);
    (async () => {
      try {
        if (job.ats_source === "amazon" && job.ats_job_id) {
          const res = await fetch(`/api/jobs/description?source=amazon&job_id=${encodeURIComponent(job.ats_job_id)}`);
          if (res.ok) { const { html } = await res.json(); if (html) { setDescHtml(html); return; } }
        } else if (job.ats_source === "ashby" && job.ats_job_id && job.url) {
          const slug = job.url.match(/jobs\.ashbyhq\.com\/([^/]+)\//)?.[1] ?? "";
          if (slug) {
            const res = await fetch(`/api/jobs/description?source=ashby&job_id=${encodeURIComponent(job.ats_job_id)}&slug=${encodeURIComponent(slug)}`);
            if (res.ok) { const { html, salary } = await res.json(); if (html) setDescHtml(html); if (salary) setApiSalary(salary); return; }
          }
        } else if (job.ats_source === "workday" && job.url) {
          const res = await fetch(`/api/jobs/description?url=${encodeURIComponent(job.url)}`);
          if (res.ok) { const { html, text } = await res.json(); if (html) { setDescHtml(html); return; } if (text) { setDescText(text); return; } }
        }
        const res = await fetch(`/api/jobs/description?source=db&id=${job.id}`);
        if (res.ok) { const { html, text } = await res.json(); if (html) setDescHtml(html); else setDescText(text ?? ""); }
      } catch { /* graceful */ } finally { setDescLoading(false); }
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
        <div className={s["job-drag-handle"]}><div className="w-10 h-1 rounded-full bg-zinc-200" /></div>
        <div className="flex-shrink-0 px-5 pt-3 pb-4 border-b border-zinc-100">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <CompanyAvatar name={job.company} domain={job.company_domain} />
              <span className="text-sm font-semibold text-zinc-600 truncate">{displayCompany}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-3">
              {posted && <span className="text-xs text-zinc-400">{posted}</span>}
              <div className="relative">
                {copied && <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap pointer-events-none">Copied!</span>}
                <button onClick={handleShare} className="p-2 rounded-full border border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700 transition-all" aria-label="Share"><Share2 size={14} /></button>
              </div>
              <div className="relative">
                {showToast && <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap pointer-events-none">Saved</span>}
                <button onClick={handleSave} className={`p-2 rounded-full border transition-all ${saved ? "bg-zinc-900 border-zinc-900 text-white" : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700"}`} aria-label={saved ? "Unsave" : "Save"}><Bookmark size={14} className={saved ? "fill-current" : ""} /></button>
              </div>
              <button onClick={onClose} className="p-2 rounded-full border border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700 transition-all" aria-label="Close"><X size={14} /></button>
            </div>
          </div>
          <div className="flex items-start gap-4 mb-3">
            <h2 className="flex-1 text-xl font-bold text-zinc-900 leading-snug">{job.title}</h2>
            {job.url && (
              <a href={job.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-semibold rounded-lg transition-colors no-underline">
                Apply <ExternalLink size={12} />
              </a>
            )}
          </div>
          {job.location && <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3"><MapPin size={11} className="flex-shrink-0 text-zinc-400" /><span>{job.location}</span></div>}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {isVerified && (
              <span className="inline-flex rounded-full p-[2px]" style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}>
                <span className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900">Verified LCA Filings With Similar Job Title</span>
              </span>
            )}
            {isFriendly && <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-50 text-[var(--ink-2)] text-xs font-medium border border-green-200">H-1B Friendly Employer</span>}
          </div>
          {(postedSalary || job.lca_count_2025 || lcaLastFiled || formatPoc(job.poc_first_name, job.poc_last_name, job.poc_email)) && (
            <div className="flex flex-wrap gap-1.5">
              {postedSalary && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">Salary: {postedSalary}</span>}
              {job.lca_count_2025 && job.lca_count_2025 > 0 && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{job.lca_count_2025} LCA filings in 2025</span>}
              {lcaLastFiled && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">Last LCA filed in {lcaLastFiled}</span>}
              {formatPoc(job.poc_first_name, job.poc_last_name, job.poc_email) && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">PoC: {formatPoc(job.poc_first_name, job.poc_last_name, job.poc_email)}</span>}
            </div>
          )}
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">Job Description</div>
          {descLoading ? (
            <div className="space-y-2">{[80,60,90,50,70,85,45].map((w,i) => <div key={i} className="h-3 bg-zinc-100 rounded animate-pulse" style={{ width: `${w}%` }} />)}</div>
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
          return <div key={i} className={cls}>{isDone ? "✓ " : ""}{text}{!isDone ? "..." : ""}</div>;
        })}
        {phase >= 4 && jobCount !== null ? (
          <div className={s["scan-item-active"]}>Found {jobCount} match{jobCount !== 1 ? "es" : ""}. Ranking by sponsor reliability...</div>
        ) : phase < 4 && (
          <div className={s["thinking-inline"]}>
            <span className={s.dot} /><span className={s.dot} /><span className={s.dot} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const POST_RESULT_CHIPS = ["Show more", "Change location", "Higher salary only", "Posted this week"];
const KAI_PAY_HISTORY_KEY = "kai_pay_chat_history";

export default function KaiPayPage() {
  const [step, setStep] = useState<OnboardingStep>("init");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quickReplies, setQuickReplies] = useState<QR[]>([]);
  const [intake, setIntake] = useState<IntakeData>({
    intent: null, layoffDate: null, location: null, locationMode: null,
    visa: null, salaryMin: null, level: null, jobFunction: null,
  });
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [total3dCount, setTotal3dCount] = useState<number>(0);
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

  const threadRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const historyLoadedRef = useRef(false);
  const pendingScanRef = useRef<{
    jobsPromise: Promise<{ jobs: Job[]; total_3d_count: number }>;
    filterTokens: string[];
  } | null>(null);

  const scrollToBottom = useCallback(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scanPhase, step, scrollToBottom]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KAI_PAY_HISTORY_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { step: OnboardingStep; messages: ChatMessage[] };
        if (saved.step === "done" && saved.messages?.length > 0) {
          const clean = saved.messages.filter((m) => !m.isThinking && !m.isStreaming);
          if (clean.length > 0) { setMessages(clean); setStep("done"); }
        }
      }
    } catch { /* ignore */ }
    historyLoadedRef.current = true;
  }, []);

  useEffect(() => {
    if (!historyLoadedRef.current || step !== "done") return;
    const stable = messages.filter((m) => !m.isThinking && !m.isStreaming);
    try {
      if (stable.length === 0) localStorage.removeItem(KAI_PAY_HISTORY_KEY);
      else localStorage.setItem(KAI_PAY_HISTORY_KEY, JSON.stringify({ step, messages: stable }));
    } catch { /* storage full */ }
  }, [messages, step]);

  useEffect(() => {
    const supabase = createSupabaseBrowser();
    supabase.auth.getUser().then(async ({ data }) => {
      if (data.user) {
        const meta = data.user.user_metadata ?? {};
        const fullName = meta.full_name ?? meta.name ?? null;
        setUser({ id: data.user.id, firstName: fullName ? fullName.split(" ")[0] : null, email: data.user.email ?? null, avatar: meta.avatar_url ?? meta.picture ?? null });

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
        { label: "E-3", value: "E-3" },
        { label: "TN", value: "TN" },
        { label: "OPT", value: "OPT" },
      ]);
      setStep("q2");

    } else if (step === "q2") {
      const visa = qr.value;
      setIntake((prev) => ({ ...prev, visa }));
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(450);
      const visaFiller: Record<string, string> = {
        h1b: "That narrows the pool to companies with a real H-1B track record. But don't worry – over 47,000 companies filed H-1B LCAs in 2025, and the good ones are in here.",
        e3: "E-3 sponsors are a more specific group, but don't worry – over 4,000 companies filed E-3 LCAs in 2025. I'll zero in on the ones with the strongest Australian hire track record.",
        tn: "Good news – TN has no H-1B lottery and no LCA requirement, so you're not locked out by a quota. Any verified employer with a qualifying role can hire you on TN status. I'll surface the best matches.",
        opt: "Got it – I'll prioritize the companies with the strongest H-1B filing track record, since that's the clearest path to long-term status. Over 47,000 companies filed H-1B LCAs in 2025 – the active sponsors are in here.",
      };
      const visaKey = visa.toLowerCase().replace(/[-/ ]/g, "");
      setMessages((prev) => [...prev, { id: "k-f2", role: "assistant", content: visaFiller[visaKey] ?? "Got it – pulling the right sponsors." }]);
      await delay(850);
      setMessages((prev) => [...prev, { id: "k-q3", role: "assistant", content: ["What's the minimum base salary that would make a move worth it? Or are you open?", "What's the minimum base salary that would make a move worth it? Or no minimum?", "What's the minimum base salary that would make a move worth it? Or are you flexible on salary?"][Math.floor(Math.random() * 3)] }]);
      setQuickReplies([
        { label: "No floor", value: "0" },
        { label: "$100K+", value: "100000" },
        { label: "$150K+", value: "150000" },
        { label: "$200K+", value: "200000" },
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
        ? `Based on your profile, looks like you're in ${funcLabel[inferredFunc] ?? inferredFunc} — is that right?`
        : "What kind of role are you looking for?";
      const topFuncs: QR[] = [
        { label: "Engineering", value: "Engineering", row: 1 },
        { label: "Product",     value: "Product",     row: 1 },
        { label: "Data",        value: "Data",        row: 1 },
        { label: "Marketing",   value: "Marketing",   row: 2 },
        { label: "Growth",      value: "Growth",      row: 2 },
        { label: "Design",      value: "Design",      row: 2 },
        { label: "Other",       value: "Other",       row: 2 },
      ];
      const q4Replies: QR[] = inferredFunc
        ? [
            { label: `Yes, ${funcLabel[inferredFunc] ?? inferredFunc}`, value: inferredFunc },
            ...topFuncs.filter(c => c.value !== inferredFunc).slice(0, 2).map(c => ({ label: c.label, value: c.value })),
            { label: "Something else", value: "Other" },
          ]
        : topFuncs;
      setMessages((prev) => [...prev, { id: "k-q4", role: "assistant", content: q4Text }]);
      setQuickReplies(q4Replies);
      setStep("q4");

    } else if (step === "q4") {
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
        ? `You're in ${knownLocation} – staying local, or open to remote and other cities?`
        : "Where are you based right now?";
      const q6Replies: QR[] = knownLocation
        ? [
            { label: `${knownLocation.split(",")[0]} / local`, value: "local" },
            { label: "Remote only", value: "remote" },
            { label: "Open to other cities", value: "anywhere" },
          ]
        : [
            { label: "Bay Area / SF", value: "bay_area" },
            { label: "NYC / East Coast", value: "nyc" },
            { label: "Remote only", value: "remote" },
            { label: "Open anywhere", value: "anywhere" },
          ];
      if (knownLocation) setIntake((prev) => ({ ...prev, location: knownLocation, locationMode: "local" }));
      setMessages((prev) => [...prev, { id: "k-q6", role: "assistant", content: q6Text }]);
      setQuickReplies(q6Replies);
      setStep("q6");

    } else if (step === "q6") {
      const level = intake.level ?? "either";
      const locMap: Record<string, { location: string | null; locationMode: string }> = {
        local:    { location: intake.location, locationMode: "local" },
        bay_area: { location: "San Francisco", locationMode: "local" },
        nyc:      { location: "New York", locationMode: "local" },
        remote:   { location: null, locationMode: "remote" },
        anywhere: { location: null, locationMode: "anywhere" },
      };
      const loc = locMap[qr.value] ?? { location: null, locationMode: "anywhere" };
      const updatedIntake = { ...intake, ...loc, level };
      setIntake(updatedIntake);
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: qr.label }]);
      await delay(500);

      const funcLabelMap: Record<string, string> = { Marketing: "marketing / growth", Growth: "marketing / growth", Data: "data / AI", "Data / AI": "data / AI" };
      const dept = updatedIntake.jobFunction && updatedIntake.jobFunction !== "Other"
        ? (funcLabelMap[updatedIntake.jobFunction] ?? updatedIntake.jobFunction.toLowerCase())
        : inferDepartment(linkedIn?.headline ?? enriched?.current_title ?? null);
      const salaryStr = updatedIntake.salaryMin ? `$${Math.round(updatedIntake.salaryMin / 1000)}K+` : "any salary";
      const levelStr = level === "senior_ic" ? "Senior IC" : level === "manager" ? "Manager / Lead" : "all levels";
      const locStr = updatedIntake.locationMode === "remote" ? "remote" : updatedIntake.locationMode === "anywhere" ? "anywhere in the US" : updatedIntake.location ?? "all locations";
      const filterTokens = [dept, locStr, salaryStr, levelStr].filter((t): t is string => Boolean(t));

      // Fire jobs fetch immediately so it runs while the user answers the alert question
      pendingScanRef.current = {
        jobsPromise: fetch("/api/onboarding/jobs", {
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
          .then((d) => ({ jobs: d.jobs ?? [], total_3d_count: d.total_3d_count ?? 0 }))
          .catch(() => ({ jobs: [], total_3d_count: 0 })),
        filterTokens,
      };

      // Persist intake (fire-and-forget)
      createSupabaseBrowser().auth.getUser().then(({ data }) => {
        if (!data.user) return;
        const levelMap: Record<string, string> = { senior_ic: "Senior IC", manager: "Manager/Lead", either: "Either" };
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

      // Ask about job alerts FIRST — scan starts after user answers
      setMessages((prev) => [...prev, {
        id: "k-alert-optin",
        role: "assistant",
        content: "Before I start searching — want me to ping you when new matches come in? Your daily batch resets at midnight.",
      }]);
      setStep("alert_optin");

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

  // ── Date input handler ────────────────────────────────────────────────────────

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
      { label: "E-3", value: "E-3" },
      { label: "TN", value: "TN" },
      { label: "OPT", value: "OPT" },
    ]);
    setStep("q2");
  };

  // ── See-more handler ──────────────────────────────────────────────────────────

  const handleSeeMore = async () => {
    const remaining = Math.max(0, total3dCount - 5);
    const total = total3dCount || allJobs.length;
    setStep("see_more");
    await delay(300);
    setMessages((prev) => [...prev, {
      id: "k-see-more",
      role: "assistant",
      content: `We found ${total} visa-sponsored jobs posted in the last 3 days that match your preferences. Want to see the other ${remaining}?`,
    }]);
    setQuickReplies([
      { label: "Yes, show me", value: "yes" },
      { label: "Not now", value: "no" },
    ]);
  };

  // ── Alert opt-in handler — triggers the scan after user answers ───────────────

  const handleAlertOptin = async (value: string) => {
    const label = value === "yes" ? "Absolutely, keep me updated on new matches" : "No thanks, I'll check manually";
    setMessages((prev) => [...prev, {
      id: `u-alert-${Date.now()}`,
      role: "user",
      content: label,
    }]);

    if (value === "yes") {
      await delay(300);
      setMessages((prev) => [...prev, {
        id: "k-alert-ok",
        role: "assistant",
        content: "Perfect — I'll ping you daily when new matches hit. Won't spam you.",
      }]);
      try {
        const supabase = createSupabaseBrowser();
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (authUser) {
          await supabase.schema("enriched").from("profiles").update({ email_alerts: true }).eq("user_id", authUser.id);
        }
      } catch { /* graceful */ }
      await delay(500);
    } else {
      await delay(300);
    }

    // Retrieve stored context and start scan
    const ctx = pendingScanRef.current;
    pendingScanRef.current = null;
    const filterTokens = ctx?.filterTokens ?? [];
    const jobsPromise = ctx?.jobsPromise ?? Promise.resolve({ jobs: [], total_3d_count: 0 });

    setMessages((prev) => [...prev, {
      id: "k-scan-announce",
      role: "assistant",
      content: `Running a pass across ${filterTokens.join(" · ")}.\n\nI'm looking at the last 3 days – so everything I bring back is fresh. Give me a sec.`,
    }]);
    setStep("scanning");

    setScanPhase(1);
    await delay(800);
    setScanPhase(2);
    await delay(1000);
    setScanPhase(3);
    await delay(1000);

    const { jobs, total_3d_count } = await jobsPromise;
    setAllJobs(jobs);
    setTotal3dCount(total_3d_count);
    setScanJobCount(jobs.length);
    setScanPhase(4);
    await delay(1300);

    // Batch 1 — 5 unique-company cards
    setScanPhase(0);
    const seenCos = new Set<string>();
    const batch1 = jobs.filter((j) => {
      const key = j.company.toLowerCase().trim();
      if (seenCos.has(key)) return false;
      seenCos.add(key);
      return true;
    }).slice(0, 5);

    const count = batch1.length;
    const hasVerified = batch1.some((j) => j.visa_tier === "verified");
    const freshLabel = postedWithin(batch1);
    const jobsDesc = freshLabel ? `posted within ${freshLabel}` : "worth your time";
    const revealText = count > 0
      ? `Okay, found ${count} job${count !== 1 ? "s" : ""} ${jobsDesc}.${hasVerified ? "\n\nThe ones marked 'Verified LCA Filings' mean the company has filed an LCA with a similar job title before – so the sponsorship signal is extremely high." : ""}`
      : "Hmm, nothing matching exactly right now – this changes daily. Come back tomorrow for fresh picks.";
    setMessages((prev) => [...prev, { id: "k-reveal1", role: "assistant", content: revealText, jobs: batch1 }]);
    setStep("batch1");
  };

  // ── Free chat (after onboarding done) ────────────────────────────────────────

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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, isChatStreaming, scrollToBottom, user, step]
  );

  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(chatInput); }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  const remaining = Math.max(0, total3dCount - 5);

  return (
    <div className={s.page}>
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

      <div className={s.thread} ref={threadRef}>
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

          {step === "scanning" && scanPhase > 0 && (
            <ScanChecklistBubble phase={scanPhase} jobCount={scanJobCount} visa={intake.visa} />
          )}

          {/* Job alert opt-in chips — shown before scan starts */}
          {step === "alert_optin" && (
            <div className={s["inline-replies"]}>
              <div className={s["inline-stem"]} />
              <div className={s["inline-tree"]}>
                {[
                  { label: "Absolutely, keep me updated on new matches", value: "yes" },
                  { label: "No thanks, I'll check manually", value: "no" },
                ].map((qr, i, arr) => (
                  <div key={qr.value} className={i === arr.length - 1 ? `${s["inline-tree-item"]} ${s["inline-tree-item-last"]}` : s["inline-tree-item"]}>
                    <button className={s["inline-chip"]} onClick={() => handleAlertOptin(qr.value)}>{qr.label}</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* See [N-5] more → after batch 1 */}
          {step === "batch1" && (
            <div className={s["show-more-row"]}>
              <button className={s["show-more-btn"]} onClick={handleSeeMore}>
                {remaining > 0 ? `See ${remaining} more →` : "See more →"}
              </button>
            </div>
          )}

          {/* PaywallScreen — inline in thread */}
          {step === "paywall" && (
            <div style={{ paddingLeft: 50, paddingBottom: 24 }}>
              <PaywallScreen
                jobCount={remaining}
                email={user?.email ?? undefined}
                onContinueFree={() => {
                  setStep("done");
                  setMessages((prev) => [...prev, {
                    id: "k-continue-free",
                    role: "assistant",
                    content: "No worries — your 5 free daily matches are always here. Come back tomorrow for fresh ones.",
                  }]);
                }}
              />
            </div>
          )}

          {/* Inline quick-reply chips */}
          {quickReplies.length > 0 && (() => {
            const rows: QR[][] = [];
            quickReplies.forEach((qr) => {
              if (qr.row !== undefined) {
                const existing = rows.find(r => r[0].row === qr.row);
                if (existing) { existing.push(qr); return; }
              }
              rows.push([qr]);
            });
            return (
              <div className={s["inline-replies"]}>
                <div className={s["inline-stem"]} />
                <div className={s["inline-tree"]}>
                  {rows.map((rowChips, i) => (
                    <div key={rowChips[0].value} className={i === rows.length - 1 ? `${s["inline-tree-item"]} ${s["inline-tree-item-last"]}` : s["inline-tree-item"]}>
                      {rowChips.map((qr, ci) => (
                        <div key={qr.value} style={{ display: "contents" }}>
                          {ci > 0 && <span className={s["inline-chip-connector"]} aria-hidden="true" />}
                          <button className={s["inline-chip"]} onClick={() => handleTileClick(qr)}>{qr.label}</button>
                        </div>
                      ))}
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
        </div>
      </div>

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

      {step !== "init" && step !== "alert_optin" && step !== "scanning" && step !== "q1_layoff_date" && step !== "paywall" && (
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

      {selectedJob && <JobDetailModal job={selectedJob} onClose={() => setSelectedJob(null)} />}
    </div>
  );
}

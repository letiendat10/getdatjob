"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { Bookmark, MapPin, ExternalLink, Share2, X } from "lucide-react";
import s from "./kai.module.css";

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
  isStreaming?: boolean;
  isThinking?: boolean;
  isRateLimited?: boolean;
};

type Meta = {
  weekCount: number;
  totalCount: number;
  companies: string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN ?? "";

const DOMAIN_OVERRIDES: Record<string, string> = {
  block: "block.xyz",
  // Amazon – many legal entities, all resolve to amazon.com
  amazoncomservices: "amazon.com",
  amazonadvertising: "amazon.com",
  amazondataservices: "amazon.com",
  amazondevelopmentcenterus: "amazon.com",
  amazonwebservices: "amazon.com",
  // Subsidiaries / alternate legal names whose stem ≠ real domain
  metaplatforms: "meta.com",
  ubertechnologies: "uber.com",
  ciscosystems: "cisco.com",
  oracleamerica: "oracle.com",
};
function normalizeCompanyName(name: string): string {
  const cleaned = name
    .replace(/,?\s+(incorporated|inc\.?|l\.?l\.?c\.?|corporation|corp\.?|limited|ltd\.?|co\.|l\.p\.?|\blp\b|pbc|p\.c\.|pllc)\.?\s*$/i, "")
    .trim();
  const letters = cleaned.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    return cleaned
      .split(/\s+/)
      .map((w) => (/^[A-Z]{1,4}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join(" ");
  }
  return cleaned;
}
function companyDomain(name: string): string {
  const stem = normalizeCompanyName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return DOMAIN_OVERRIDES[stem] ?? stem + ".com";
}

function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "server";
  const key = "gdj_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, id);
  }
  return id;
}

function formatSalary(n: number): string {
  return "~$" + Math.round(n / 1000) + "K";
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

// ── Inline markdown renderer (bold + newlines only) ──────────────────────────

function KaiText({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return part.split("\n").map((line, j, arr) => (
          <span key={`${i}-${j}`}>
            {line}
            {j < arr.length - 1 && <br />}
          </span>
        ));
      })}
      {isStreaming && <span className={s.cursor} />}
    </>
  );
}

// ── Laurel leaf SVG ──────────────────────────────────────────────────────────

function LaurelSVG({ flip }: { flip?: boolean }) {
  return (
    <svg
      className={flip ? s["laurel-svg-flip"] : s["laurel-svg"]}
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function formatLcaDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const parts = dateStr.split("-");
  if (parts.length < 2) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[month]} ${year}`;
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
  const level = inferLevel(job.title);
  const department = inferDepartment(job.title);
  const lcaLastFiled = formatLcaDate(job.lca_last_filed);

  return (
    <div className="border border-zinc-200 rounded-xl bg-white px-3.5 pt-3 pb-2.5 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors" onClick={onClick}>
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

      {/* Tags: salary, level, department, verified */}
      {(job.salary_estimate || level || department || isVerified || isFriendly) && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {job.salary_estimate && job.salary_estimate > 50000 && (
            <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
              Salary: {formatSalary(job.salary_estimate)}
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
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium border border-green-200">
              H-1B Friendly Employer
            </span>
          )}
        </div>
      )}

      {/* LCA stats: last filed + year count */}
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
  const level = inferLevel(job.title);
  const department = inferDepartment(job.title);
  const isVerified = job.visa_tier === "verified";
  const isFriendly = job.visa_tier === "friendly";
  const lcaLastFiled = formatLcaDate(job.lca_last_filed);
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
          const { text } = await res.json();
          setDescText(text ?? "");
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
                <button
                  onClick={handleShare}
                  className="p-2 rounded-full border border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700 transition-all"
                  aria-label="Share job"
                >
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
              <button
                onClick={onClose}
                className="p-2 rounded-full border border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700 transition-all"
                aria-label="Close"
              >
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
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium border border-green-200">
                H-1B Friendly Employer
              </span>
            )}
          </div>

          {(job.salary_estimate && job.salary_estimate > 50000 || job.lca_count_2025 || lcaLastFiled) && (
            <div className="flex flex-wrap gap-1.5">
              {job.salary_estimate && job.salary_estimate > 50000 && (
                <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
                  Salary: {formatSalary(job.salary_estimate)}
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

function ThinkingBubble() {
  return (
    <div className={s["msg-row"]}>
      <div className={s["kai-avatar"]}>K</div>
      <div className={`${s.bubble} ${s["bubble-kai"]} ${s.thinking}`}>
        <span className={s.dot} />
        <span className={s.dot} />
        <span className={s.dot} />
      </div>
    </div>
  );
}

function RateLimitBubble() {
  return (
    <div className={s["msg-row"]}>
      <div className={s["kai-avatar"]}>K</div>
      <div className={s["rate-limit"]}>
        <p className={s["rate-limit-text"]}>
          We&rsquo;re getting along so well! Sign up so I can keep helping you →
        </p>
        <Link href="/signup" className={s["rate-limit-btn"]}>
          Create an account
        </Link>
      </div>
    </div>
  );
}

function getGreeting(): React.ReactNode {
  const h = new Date().getHours();
  if (h >= 21 || h < 5)
    return <>You&rsquo;re working <em>late</em> today.</>;
  if (h >= 5 && h < 12)
    return <>Hey there, <em>stranger.</em></>;
  if (h >= 12 && h < 17)
    return <>Ready to apply for <em>5 jobs</em> today?</>;
  return <>You <em>got this.</em></>;
}

const EXAMPLE_CHIPS = [
  "Remote PM roles, must sponsor H1B",
  "Senior SWE, remote",
  "Data roles posted this week",
];

const POST_RESULT_CHIPS = [
  "Show more",
  "Change location",
  "Higher salary only",
  "Posted this week",
];

// ── Main page ─────────────────────────────────────────────────────────────────

const CHAT_HISTORY_KEY = "kai_chat_history";

export default function KaiPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [showPostChips, setShowPostChips] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deviceIdRef = useRef<string>("");
  const historyLoadedRef = useRef(false);

  const isEmpty = messages.length === 0;

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Load meta stats
  useEffect(() => {
    fetch("/api/jobs/meta")
      .then((r) => r.json())
      .then((d: Meta) => setMeta(d))
      .catch(() => {});
  }, []);

  // Device ID + load persisted chat history
  useEffect(() => {
    deviceIdRef.current = getOrCreateDeviceId();
    try {
      const raw = localStorage.getItem(CHAT_HISTORY_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as ChatMessage[];
        const clean = saved.filter((m) => !m.isThinking && !m.isStreaming && !m.isRateLimited);
        if (clean.length > 0) setMessages(clean);
      }
    } catch { /* ignore parse/storage errors */ }
    historyLoadedRef.current = true;
  }, []);

  // Persist chat history whenever messages settle
  useEffect(() => {
    if (!historyLoadedRef.current) return;
    const stable = messages.filter((m) => !m.isThinking && !m.isStreaming);
    try {
      if (stable.length === 0) {
        localStorage.removeItem(CHAT_HISTORY_KEY);
      } else {
        localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(stable));
      }
    } catch { /* storage full – silently skip */ }
  }, [messages]);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      setInput("");
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
      setShowPostChips(false);

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        content: trimmed,
      };

      const assistantMsgId = `a-${Date.now() + 1}`;
      const thinkingMsg: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        isThinking: true,
      };

      setMessages((prev) => [...prev, userMsg, thinkingMsg]);
      setIsStreaming(true);

      // Build history for API (exclude current thinking placeholder)
      const history = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-device-id": deviceIdRef.current,
          },
          body: JSON.stringify({ messages: history, isSignedIn: false }),
        });

        if (res.status === 429) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, isThinking: false, isRateLimited: true }
                : m
            )
          );
          setIsStreaming(false);
          return;
        }

        if (!res.ok || !res.body) {
          throw new Error("Request failed");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let receivedJobs = false;

        // Switch thinking → streaming
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, isThinking: false, isStreaming: true } : m
          )
        );

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
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, isThinking: false, isStreaming: true, content: m.content + event.text }
                      : m
                  )
                );
                scrollToBottom();
              } else if (event.type === "tool_start") {
                // Keep pre-tool text (add separator so post-tool text doesn't smash into it)
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, content: m.content ? m.content.trimEnd() + "\n\n" : "", isThinking: true, isStreaming: false }
                      : m
                  )
                );
              } else if (event.type === "jobs") {
                receivedJobs = true;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, jobs: event.jobs }
                      : m
                  )
                );
              } else if (event.type === "done") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId ? { ...m, isStreaming: false } : m
                  )
                );
                if (receivedJobs) setShowPostChips(true);
              } else if (event.type === "error") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          isThinking: false,
                          isStreaming: false,
                          content: m.content || "Something went wrong. Try again?",
                        }
                      : m
                  )
                );
              }
            } catch {
              // malformed SSE line – skip
            }
          }
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  isThinking: false,
                  isStreaming: false,
                  content: "Something went wrong. Try again?",
                }
              : m
          )
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [messages, isStreaming, scrollToBottom]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className={s.page}>
      {/* Nav */}
      <nav className={s.nav}>
        <div className={s["nav-inner"]}>
          <Link href="/" className={s.brand}>getdatjob</Link>
          <Link href="/jobs" className={s["nav-link"]}>Browse jobs</Link>
        </div>
      </nav>

      {/* Chat thread */}
      <div className={s.thread} ref={threadRef}>
        <div className={s["thread-inner"]}>

          {/* Empty state – greeting */}
          {isEmpty && (
            <div className={s.greeting}>
              <h1 className={s["greeting-headline"]}>{getGreeting()}</h1>
              <p className={s["greeting-sub"]}>
                Hey, I&rsquo;m Kai.<br />
                I&rsquo;m an AI who is on a working visa too.<br />
                I&rsquo;m here to help you land your sponsored job fast.
              </p>
              {meta && (
                <div className={s["trust-line"]}>
                  <div className={s["laurel-item"]}>
                    <LaurelSVG />
                    <div className={s["laurel-content"]}>
                      <b className={s["laurel-b"]}>{meta.weekCount.toLocaleString()}</b>
                      <span className={s["laurel-lbl"]}>new jobs<br />this week</span>
                    </div>
                    <LaurelSVG flip />
                  </div>
                  <div className={s["laurel-item"]}>
                    <LaurelSVG />
                    <div className={s["laurel-content"]}>
                      <b className={s["laurel-b"]}>{meta.totalCount.toLocaleString()}</b>
                      <span className={s["laurel-lbl"]}>total<br />jobs</span>
                    </div>
                    <LaurelSVG flip />
                  </div>
                  <div className={s["laurel-item"]}>
                    <LaurelSVG />
                    <div className={s["laurel-content"]}>
                      <b className={s["laurel-b"]}>{meta.companies.length.toLocaleString()}</b>
                      <span className={s["laurel-lbl"]}>sponsoring<br />companies</span>
                    </div>
                    <LaurelSVG flip />
                  </div>
                </div>
              )}
              {/* Inline input (empty state only) */}
              <div className={s["greeting-input-wrap"]}>
                <textarea
                  ref={inputRef}
                  className={s.input}
                  placeholder="Want to find new job listings to apply?"
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={isStreaming}
                />
                <button
                  className={s["send-btn"]}
                  onClick={() => sendMessage(input)}
                  disabled={!input.trim() || isStreaming}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 8H14M8 2l6 6-6 6" />
                  </svg>
                </button>
              </div>
              {/* Chips below input */}
              <div className={s.chips}>
                {EXAMPLE_CHIPS.map((c) => (
                  <button key={c} className={s.chip} onClick={() => sendMessage(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg) => {
            if (msg.isThinking) {
              if (msg.content) {
                // Pre-tool text + dots in one bubble, one K avatar
                return (
                  <div key={msg.id} className={s["msg-row"]}>
                    <div className={s["kai-avatar"]}>K</div>
                    <div className={`${s.bubble} ${s["bubble-kai"]}`}>
                      <KaiText text={msg.content} isStreaming={false} />
                      <div className={s["thinking-inline"]}>
                        <span className={s.dot} />
                        <span className={s.dot} />
                        <span className={s.dot} />
                      </div>
                    </div>
                  </div>
                );
              }
              return <ThinkingBubble key={msg.id} />;
            }
            if (msg.isRateLimited) return <RateLimitBubble key={msg.id} />;

            return (
              <div key={msg.id}>
                <div className={`${s["msg-row"]} ${msg.role === "user" ? s["msg-row-user"] : ""}`}>
                  {msg.role === "assistant" && (
                    <div className={s["kai-avatar"]}>K</div>
                  )}
                  <div
                    className={`${s.bubble} ${
                      msg.role === "user" ? s["bubble-user"] : s["bubble-kai"]
                    }`}
                  >
                    {msg.role === "user" ? (
                      msg.content
                    ) : (
                      <KaiText text={msg.content} isStreaming={msg.isStreaming} />
                    )}
                  </div>
                </div>

                {/* Job cards below assistant message */}
                {msg.role === "assistant" && msg.jobs && msg.jobs.length > 0 && (
                  <div className={s["msg-row"]} style={{ paddingLeft: 38 }}>
                    <div className={s["jobs-wrap"]}>
                      {msg.jobs.map((job) => (
                        <JobCard key={job.id} job={job} onClick={() => setSelectedJob(job)} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Post-result quick-reply chips */}
          {showPostChips && messages.length > 0 && (
            <div className={s.chips} style={{ justifyContent: "flex-start", paddingLeft: 38 }}>
              {POST_RESULT_CHIPS.map((c) => (
                <button key={c} className={s.chip} onClick={() => sendMessage(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Input bar – only when conversation is active */}
      {!isEmpty && (
        <div className={s["input-bar"]}>
          <div className={s["input-bar-inner"]}>
            <div className={s["input-wrap"]}>
              <textarea
                ref={inputRef}
                className={s.input}
                placeholder="Write a message..."
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                rows={1}
                disabled={isStreaming}
              />
            </div>
            <button
              className={s["send-btn"]}
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isStreaming}
              aria-label="Send"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 8H2M8 2l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {selectedJob && (
        <JobDetailModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  );
}

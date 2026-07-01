"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  Search, MapPin, ExternalLink, ChevronDown,
  Share2, ArrowLeft, CheckCircle, Bookmark,
} from "lucide-react";
import type { JobRow } from "@/lib/query-jobs";
import { getTnCategory } from "@/lib/tn-eligible";
import { normalizeCityState } from "@/lib/location";
import { DEPARTMENTS, departmentLabel, toStoredDepartments, toCanonicalLevel } from "@/lib/taxonomy";
// Shared filter option lists — single source of truth (see lib/filters.ts + lib/taxonomy.ts).
import {
  LOCATION_FILTER_OPTIONS as LOCATION_OPTIONS,
  POSTED_FILTER_OPTIONS as POSTED_DATE_OPTIONS,
  SALARY_FILTER_OPTIONS as SALARY_OPTIONS,
  VISA_FILTER_OPTIONS as VISA_OPTIONS,
  LEVEL_FILTER_OPTIONS as LEVEL_OPTIONS,
  DEPARTMENT_FILTER_OPTIONS as DEPARTMENT_OPTIONS_FALLBACK,
  SIGNAL_OPTIONS, SORT_OPTIONS, VIEW_OPTIONS,
} from "@/lib/filters";
import { JobChips } from "@/app/components/JobChips";
import { CompanyAvatar } from "@/app/components/CompanyAvatar";
import s from "./me.module.css";

// ── Types ─────────────────────────────────────────────────────────────────────

type JobWithNorm = JobRow & { _normLoc: string; _normCompany: string };

export type MatchesPanelPrefs = {
  visa_type: string | null;
  salary_floor: number | null;
  job_level: string | null;
  job_function: string | null;
  location: string | null;
  posted_within_days: number | null;
} | null;

// ── Helpers ───────────────────────────────────────────────────────────────────


const COMPANY_NAME_OVERRIDES: Record<string, string> = {
  "social finance": "SoFi", "at&t services": "AT&T", "at&t mobility services": "AT&T",
  "bank of america": "Bank of America", "the pnc financial services group": "PNC",
  "united services automobile association": "USAA",
  "american express travel related services company": "American Express",
  "standard & poor's financial services": "S&P Global",
  "laboratory corporation of america holdings": "LabCorp",
  "intercontinental exchange holdings": "ICE", "susquehanna international group": "SIG",
  "citadel enterprise americas services": "Citadel",
  "citadel securities americas services": "Citadel Securities",
  "bernstein institutional services": "AllianceBernstein",
  "galileo financial technologies": "Galileo",
  "deloitte touche tohmatsu services": "Deloitte",
  "deloitte transactions and business analytics": "Deloitte",
  "pricewaterhousecoopers advisory services": "PwC", "pricewaterhousecoopers": "PwC",
  "mckinsey & company united states": "McKinsey", "mckinsey & company": "McKinsey",
  "space exploration technologies": "SpaceX", "flextronics international usa": "Flex",
  "environmental systems research institute": "Esri",
  "cognizant trizetto software group": "Cognizant",
  "cognizant technology solutions us": "Cognizant",
  "hsbc technology & services": "HSBC", "cigna health and life insurance company": "Cigna",
  "united parcel service general services": "UPS",
  "foot locker corporate services": "Foot Locker", "macy's systems and technology": "Macy's",
  "openai opco": "OpenAI", "london stock exchange group holdings": "LSEG",
  "general dynamics information technology": "GDIT", "robinhood markets": "Robinhood",
};

function normalizeCompanyName(name: string): string {
  const dba = name.match(/\(?\bd\/?b\/?a\.?\)?\s+([^)]+)/i);
  const cleaned = (dba ? dba[1] : name)
    .replace(/\s*\([^)]*f\.?k\.?a\.?[^)]*\)/gi, "")
    .replace(/\s*\([^)]+\)\s*$/g, "")
    .replace(/,?\s+(united states|north america|americas|usa|u\.s\.a?)\.?\s*$/i, "")
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

function formatPoc(firstName: string | null, lastName: string | null, email: string | null): string | null {
  if (!email) return null;
  const first = firstName ? firstName.split(/[\s/,]+/)[0].trim() : null;
  const lastInitial = lastName ? lastName.trim()[0].toUpperCase() : null;
  if (first && lastInitial) return `${first} ${lastInitial} (${email})`;
  if (first) return `${first} (${email})`;
  return email;
}

function formatLastFiling(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
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

const HTML_ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&laquo;": "«", "&raquo;": "»", "&bull;": "•", "&hellip;": "…",
};
function decodeHtmlEntities(s: string): string {
  return s.replace(/&[a-z]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function extractSalary(html: string): string | null {
  const text = decodeHtmlEntities(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // A dollar amount, tolerant of a space after "$": Workday renders the upper bound as
  // "$ 260,400.00" (nbsp collapses to a space), which used to break the "$X to $Y"
  // pattern and fall through to the single-number grab — showing only the minimum.
  const money = String.raw`\$\s*[\d,]+(?:\.\d+)?\s*K?`;
  const norm = (s: string) => s.replace(/\$\s*/, "$").replace(/\.00\b/g, "").replace(/\s+/g, " ").trim();
  // "$X – $Y" or "$X to $Y" (dash or the word "to", optional "USD" before the separator).
  const range = text.match(new RegExp(`(${money})\\s*(?:USD)?\\s*(?:[\\u2013\\u2014-]+|to)\\s*(${money})`, "i"));
  if (range) return `${norm(range[1])} – ${norm(range[2])}`;
  // Bare-number USD range without a "$": "150,000 USD – 200,000 USD".
  const usdRange = text.match(/([\d,]{5,}(?:\.\d+)?)\s*USD\s*(?:[–—-]+|to)\s*\$?\s*([\d,]{5,}(?:\.\d+)?)\s*USD/i);
  if (usdRange) return `$${usdRange[1].replace(/\.00\b/, "")} – $${usdRange[2].replace(/\.00\b/, "")}`;
  // Genuinely single figure (no range present in the posting).
  const single = text.match(/\$\s*\d{2,3},\d{3}/);
  return single ? norm(single[0]) : null;
}
function extractExperience(html: string): string | null {
  const text = html.replace(/<[^>]+>/g, " ");
  const range = text.match(/(\d+)\s*[-–]\s*(\d+)\s*\+?\s*years?\s*(?:of\s*)?(?:experience|exp)/i);
  if (range) return `${range[1]}–${range[2]} years`;
  const plus = text.match(/(\d+)\s*\+\s*years?\s*(?:of\s*)?(?:experience|exp)/i);
  if (plus) return `${plus[1]}+ years`;
  const simple = text.match(/(\d+)\s*years?\s*(?:of\s*)?(?:experience|exp)/i);
  return simple ? `${simple[1]}+ years` : null;
}
function toJobWithNorm(raw: JobRow): JobWithNorm {
  return { ...raw, _normLoc: normalizeCityState(raw.location, raw.is_remote), _normCompany: normalizeCompanyName(raw.company ?? "") };
}

// ── Preference → filter mapping ───────────────────────────────────────────────

function prefToVisa(v: string | null): string {
  if (!v) return "H1B";
  const p = v.toUpperCase();
  if (p.includes("H-1B") || p.includes("H1B")) return "H1B";
  if (p.includes("E-3") || p.includes("E3")) return "E3";
  if (p.includes("TN")) return "TN";
  return "all";
}

function prefToLocation(l: string | null): string {
  if (!l) return "all";
  const p = l.toLowerCase();
  if (p.includes("remote")) return "Remote";
  if (p.includes("san francisco") || p.includes("bay area") || p.includes("silicon valley")) return "San Francisco Bay Area";
  if (p.includes("new york") || p.includes("nyc") || p.includes("brooklyn") || p.includes("manhattan")) return "New York City";
  if (p.includes("seattle")) return "Seattle, WA";
  if (p.includes("chicago")) return "Chicago, IL";
  if (p.includes("los angeles") || p.includes("santa monica")) return "Los Angeles, CA";
  if (p.includes("austin")) return "Austin, TX";
  if (p.includes("boston")) return "Boston, MA";
  if (p.includes("denver")) return "Denver, CO";
  if (p.includes("washington") && p.includes("dc")) return "Washington, DC";
  if (p.includes("atlanta")) return "Atlanta, GA";
  if (p.includes("miami") || p.includes("florida")) return "Miami, FL";
  if (p.includes("nashville")) return "Nashville, TN";
  if (p.includes("portland")) return "Portland, OR";
  if (p.includes("salt lake")) return "Salt Lake City, UT";
  if (p.includes("phoenix") || p.includes("arizona")) return "Phoenix, AZ";
  if (p.includes("san diego")) return "San Diego, CA";
  if (p.includes("virginia") || p.includes("mclean") || p.includes("reston")) return "Virginia";
  if (p.includes("pennsylvania") || p.includes("pittsburgh") || p.includes("philadelphia")) return "Pennsylvania";
  return "all";
}

function prefToLevel(l: string | null): string {
  // Map a stored preference job_level (canonical, or any legacy value) to the canonical filter
  // value the server understands. toCanonicalLevel handles both vocabularies; null → "all".
  return toCanonicalLevel(l) ?? "all";
}

function prefToSalary(f: number | null): string {
  if (!f || f < 100000) return "all";
  if (f >= 200000) return "200000";
  if (f >= 150000) return "150000";
  return "100000";
}

function prefToDepartment(d: string | null): string {
  // Route every stored job_function (canonical, Kai tokens, or legacy) through the
  // taxonomy SSOT so the chip value always equals a real jobs.department value.
  // Strict mapping only: a coined live bucket saved as a pref ("Product Management")
  // passes through literally — the keyword fallback would hijack it onto Product.
  if (!d) return "all";
  const canon = toStoredDepartments(d);
  return canon.length ? canon[0] : d;
}

function prefToPosted(d: number | null): string {
  if (!d || d === 0) return "7d";
  if (d <= 1) return "1d";
  if (d <= 3) return "3d";
  if (d <= 7) return "7d";
  if (d <= 30) return "30d";
  return "90d";
}

// ── Filter config ─────────────────────────────────────────────────────────────
// All option lists now come from the shared SSOT (imported at the top of this file):
// LOCATION_OPTIONS, SIGNAL_OPTIONS, POSTED_DATE_OPTIONS, SORT_OPTIONS, SALARY_OPTIONS,
// VISA_OPTIONS, LEVEL_OPTIONS, VIEW_OPTIONS, DEPARTMENT_OPTIONS_FALLBACK (fallback until live
// department_facets load). DEPARTMENT_OPTIONS_FALLBACK matches /jobs exactly.

// ── Filter SVG Icons ──────────────────────────────────────────────────────────

const S = 1.4;
function FilterIconCompany() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><path d="M5 20.5V8.2L12 5l7 3.2v12.3" /><path d="M9.5 20.5V15.5h5v5" /><circle cx="8.5" cy="11" r=".55" fill="currentColor" stroke="none" /><circle cx="12" cy="11" r=".55" fill="currentColor" stroke="none" /><circle cx="15.5" cy="11" r=".55" fill="currentColor" stroke="none" /><path d="M3.5 20.5h17" /></g>; }
function FilterIconSponsorship() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><path d="M4 15.5l3.2-3.2 3 2.2 4.2-5 3.8 2.8" /><circle cx="18.2" cy="12.3" r="1.1" fill="currentColor" stroke="none" /><path d="M4 20h16" opacity=".35" /></g>; }
function FilterIconLocation() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><path d="M12 21.5s-6.5-6.4-6.5-12A6.5 6.5 0 0 1 18.5 9.5c0 5.6-6.5 12-6.5 12z" /><circle cx="12" cy="9.3" r="1.4" fill="currentColor" stroke="none" /></g>; }
function FilterIconPosted() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5.5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17" /><path d="M8 3.5v3.4M16 3.5v3.4" /><circle cx="8" cy="14" r=".65" fill="currentColor" stroke="none" /><circle cx="12" cy="14" r=".65" fill="currentColor" stroke="none" /><circle cx="16" cy="14" r=".65" fill="currentColor" stroke="none" /><circle cx="8" cy="17.5" r=".65" fill="currentColor" stroke="none" /><circle cx="12" cy="17.5" r=".65" fill="currentColor" stroke="none" /></g>; }
function FilterIconVisa() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5.5" width="16" height="13" rx="1.6" /><path d="M4 10h16" /><circle cx="8" cy="14.5" r="1.6" /><path d="M12 14h5.5M12 16.5h4" /><circle cx="16.6" cy="7.7" r="1.1" /></g>; }
function FilterIconDepartment() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5.2" r="1.9" /><circle cx="5" cy="18.5" r="1.9" /><circle cx="12" cy="18.5" r="1.9" /><circle cx="19" cy="18.5" r="1.9" /><path d="M12 7.1v3.4M5 16.6v-3.1h14v3.1" /></g>; }
function FilterIconExperience() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><path d="M8 20.5V12M12 20.5V8.5M16 20.5V5" /><circle cx="8" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="12" cy="8.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="16" cy="5" r="1.1" fill="currentColor" stroke="none" /><path d="M3.5 20.5h17" /></g>; }
function FilterIconAll() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="8" width="17" height="12.5" rx="2" /><path d="M8.5 8V6.2A2 2 0 0 1 10.5 4.2h3a2 2 0 0 1 2 2V8" /><circle cx="12" cy="14.2" r="1.1" fill="currentColor" stroke="none" /><path d="M3.5 13h7M13.5 13h7" opacity=".4" /></g>; }
function FilterIconCompensation() { return <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><path d="M14.5 9.3c-.6-.8-1.6-1.3-2.7-1.3-1.5 0-2.8.9-2.8 2.1 0 1.2 1.3 1.7 2.8 2.1 1.5.4 2.8.9 2.8 2.1 0 1.2-1.3 2.1-2.8 2.1-1.1 0-2.1-.5-2.7-1.3" /><path d="M12 6.5v1M12 16.5v1" /></g>; }

function FilterIcon({ icon: IconInner }: { icon: () => React.ReactElement }) {
  return <svg width={17} height={17} viewBox="0 0 24 24" style={{ display: "block", flexShrink: 0 }}><IconInner /></svg>;
}

// ── FilterChip ────────────────────────────────────────────────────────────────

function FilterChip({ label, value, allValue = "all", options, onChange, isOpen, onToggle, icon }: {
  label: string; value: string; allValue?: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void; isOpen: boolean; onToggle: () => void;
  icon?: () => React.ReactElement;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  // Show the selected option label whenever a real value is picked; generic chip label
  // only when sitting at the "all" sentinel. Active visual = a value is applied.
  const isActive = value !== allValue;
  const currentLabel = isActive ? (options.find((o) => o.value === value)?.label ?? label) : label;

  const handleToggle = () => {
    if (!isOpen && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 6, left: r.left });
    }
    onToggle();
  };

  // Render the dropdown into a portal at <body> so it can't be clipped or have its
  // position:fixed coordinates reinterpreted by any ancestor that creates a
  // containing block (overflow:hidden chain, backdrop-filter, transform, etc.).
  // Without this the menu rendered fine on desktop but stayed invisible on
  // iOS Safari mobile even though state was updating (the chevron rotated).
  const menu = isOpen && dropPos && typeof document !== "undefined"
    ? createPortal(
        <div data-matches-chip-menu="" style={{ top: dropPos.top, left: dropPos.left }} className={s["matches-chip-menu"]}>
          {options.map((opt) => (
            <button key={opt.value} onClick={() => { onChange(opt.value); onToggle(); }}
              className={`${s["matches-chip-option"]} ${opt.value === value ? s["matches-chip-option-active"] : ""}`}>
              {opt.label}
              {opt.value === value && <CheckCircle size={13} />}
            </button>
          ))}
        </div>,
        document.body
      )
    : null;

  return (
    <div style={{ flexShrink: 0 }}>
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className={`${s["matches-chip"]} ${isActive ? s["matches-chip-active"] : ""}`}
      >
        {icon && <FilterIcon icon={icon} />}
        {currentLabel}
        <ChevronDown size={12} style={{ transition: "transform .15s", transform: isOpen ? "rotate(180deg)" : "none" }} />
      </button>
      {menu}
    </div>
  );
}

// ── DescriptionSkeleton ───────────────────────────────────────────────────────

function DescriptionSkeleton() {
  return (
    <div className="space-y-3 animate-pulse mt-2">
      {[100, 88, 94, 72, 85, 60, 78, 90].map((w, i) => (
        <div key={i} className="h-3 bg-zinc-200 rounded" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

// ── JobCard ───────────────────────────────────────────────────────────────────

function JobCard({ job, isSelected, isViewed, isFilled, onClick }: {
  job: JobWithNorm; isSelected: boolean; isViewed: boolean; isFilled?: boolean; onClick: () => void;
}) {
  const posted = timeAgo(job.posted_at);
  return (
    <div onClick={onClick}
      className={`${s["matches-card"]} ${isSelected ? s["matches-card-selected"] : ""} ${isFilled ? s["matches-card-filled"] : ""}`}
    >
      <CompanyAvatar name={job._normCompany} domain={job.company_domain_url} size="md" />
      <div className={s["matches-card-body"]}>
        <div className={s["matches-card-row"]}>
          <h3 className={s["matches-card-title"]}>{job.title}</h3>
          {posted && <span className={s["matches-card-time"]}>{posted}</span>}
        </div>
        <p className={s["matches-card-sub"]}>{job._normCompany} · {job._normLoc}</p>
        <div className={s["matches-card-chips"]}>
          <JobChips
            salary_range={job.salary_range}
            confidence_tier={job.confidence_tier}
            e3_lca_count={job.e3_lca_count}
            title={job.title}
            last_filing_date={job.last_filing_date}
            lca_count_2025={job.lca_count_2025}
            poc_first_name={job.poc_first_name}
            poc_last_name={job.poc_last_name}
            poc_email={job.poc_email}
          />
        </div>
        {isViewed && <span className={s["matches-card-viewed"]}>Viewed</span>}
      </div>
    </div>
  );
}

// ── JobDetailPanel ────────────────────────────────────────────────────────────

function JobDetailPanel({ job, descHtml, descText, descLoading, copied, isSaved, onShare, onSave, salaryOverride }: {
  job: JobWithNorm; descHtml: string; descText: string;
  descLoading: boolean; copied: boolean; isSaved: boolean; onShare: () => void; onSave: () => void;
  salaryOverride?: string;
}) {
  const lastFiling = formatLastFiling(job.last_filing_date);
  const posted = timeAgo(job.posted_at);
  const extractedSalary = useMemo(() => extractSalary(descHtml), [descHtml]);
  const salary = salaryOverride ?? job.salary_range ?? extractedSalary;
  const experience = useMemo(() => extractExperience(descHtml), [descHtml]);
  const level = job.job_level;  // canonical stored value (same source as /jobs) — fixes VP vs Lead/Manager
  const department = job.department;
  const tnCategory = getTnCategory(job.title);

  return (
    <div style={{ background: "#ffffff", display: "flex", flexDirection: "column", width: "100%" }}>
      {/* Sticky compact bar — logo + company + title + Apply only (condensed) */}
      <div className="px-4 pt-3 pb-2.5" style={{ borderBottom: "1px solid #f4f4f5", position: "sticky", top: 0, background: "#ffffff", zIndex: 2 }}>
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <CompanyAvatar name={job._normCompany} domain={job.company_domain_url} size="sm" />
            <span className="text-xs font-semibold text-zinc-600 truncate">{job._normCompany}</span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
            <button onClick={onSave} aria-label={isSaved ? "Unsave" : "Save"}
              className={`p-1.5 rounded-full border transition-all ${isSaved ? "bg-zinc-900 border-zinc-900 text-white" : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700"}`}>
              <Bookmark size={12} className={isSaved ? "fill-current" : ""} />
            </button>
            <button onClick={onShare} aria-label="Share"
              className={`p-1.5 rounded-full border transition-all ${copied ? "border-zinc-400 text-zinc-700 bg-zinc-100" : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700"}`}>
              <Share2 size={12} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <h2 className="flex-1 text-base font-bold text-zinc-900 leading-snug">{job.title}</h2>
          <a href={job.url} target="_blank" rel="noopener noreferrer"
            className="flex-shrink-0 inline-flex items-center gap-1 px-3.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 !text-white text-xs font-semibold rounded-md transition-colors shadow-sm">
            Apply <ExternalLink size={11} />
          </a>
        </div>
      </div>

      {/* Non-sticky metadata — scrolls away to give the description more room */}
      <div className="px-5 pt-3 pb-3" style={{ borderBottom: "1px solid #f4f4f5" }}>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <MapPin size={11} className="flex-shrink-0 text-zinc-400" />
          <span>{job._normLoc}</span>
          {posted && <><span className="text-zinc-300">·</span><span>Posted {posted}</span></>}
        </div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {level && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{level}</span>}
          {department && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{department}</span>}
          {job.confidence_tier === "verified" && (
            <span className="inline-flex rounded-full p-[2px]" style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}>
              <span className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900">Verified LCA Filings With Same Job Title</span>
            </span>
          )}
          {job.confidence_tier === "friendly" && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium border border-emerald-200">H-1B Friendly Employer</span>
          )}
          {tnCategory && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-medium border border-blue-200">TN Friendly</span>
          )}
        </div>
        {(salary || experience) && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {salary && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{salary}</span>}
            {experience && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{experience} exp</span>}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {lastFiling && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">Last LCA filed in {lastFiling}</span>}
          {job.lca_count_2025 > 0 && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{job.lca_count_2025} LCA filings in 2025</span>}
          {formatPoc(job.poc_first_name, job.poc_last_name, job.poc_email) && (
            <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">
              PoC: {formatPoc(job.poc_first_name, job.poc_last_name, job.poc_email)}
            </span>
          )}
        </div>
      </div>
      <div className="px-5 py-4">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">Job Description</div>
        {descLoading ? (
          <DescriptionSkeleton />
        ) : descHtml ? (
          <div className="prose prose-sm prose-zinc max-w-none text-zinc-700 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-1 [&_h3]:font-semibold [&_h3]:text-zinc-900 [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:mb-2 [&_strong]:font-semibold"
            dangerouslySetInnerHTML={{ __html: descHtml }} />
        ) : descText ? (
          <p className="text-xs text-zinc-600 leading-relaxed whitespace-pre-wrap">{descText}</p>
        ) : (
          <p className="text-xs text-zinc-400 italic">Description unavailable — view full posting on company site.</p>
        )}
      </div>
    </div>
  );
}

// ── MatchesPanel ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 30;
const VISIBLE_FREE = 7;

export function MatchesPanel({ preferences, isUnlocked }: {
  preferences: MatchesPanelPrefs;
  isUnlocked: boolean;
}) {
  // Filter state — pre-filled from preferences
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState(() => prefToLocation(preferences?.location ?? null));
  const [company, setCompany] = useState("");
  const [signal, setSignal] = useState("all");
  const [postedDate, setPostedDate] = useState(() => prefToPosted(preferences?.posted_within_days ?? null));
  const [visa, setVisa] = useState(() => prefToVisa(preferences?.visa_type ?? null));
  const [department, setDepartment] = useState(() => prefToDepartment(preferences?.job_function ?? null));
  const [level, setLevel] = useState(() => prefToLevel(preferences?.job_level ?? null));
  const [salary, setSalary] = useState(() => prefToSalary(preferences?.salary_floor ?? null));
  const [viewFilter, setViewFilter] = useState("all");
  const [sortBy, setSortBy] = useState("recent");
  const [openChip, setOpenChip] = useState<string | null>(null);

  // Data state
  const [jobs, setJobs] = useState<JobWithNorm[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Meta (companies + headline stats)
  const [allCompanies, setAllCompanies] = useState<string[]>([]);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [threeDayCount, setThreeDayCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [departments, setDepartments] = useState<{ value: string; label: string }[]>([]);
  const metaInflightRef = useRef(false);

  // Detail panel
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [viewedJobs, setViewedJobs] = useState<Set<number>>(new Set());
  const [savedJobs, setSavedJobs] = useState<Set<number>>(new Set());
  const [descCache, setDescCache] = useState<Record<number, { html: string; text: string; salary?: string }>>({});
  const [descLoading, setDescLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchIdRef = useRef(0);
  const hasDataRef = useRef(false);

  const loadMetaOnce = useCallback(() => {
    if (metaInflightRef.current) return;
    metaInflightRef.current = true;
    fetch("/api/jobs/meta")
      .then((r) => r.json())
      .then((data) => {
        setAllCompanies(data.companies ?? []);
        setDepartments(data.departments ?? []);
        setThreeDayCount(data.threeDayCount ?? 0);
        setTotalCount(data.totalCount ?? 0);
        setMetaLoaded(true);
      })
      .catch(() => { metaInflightRef.current = false; });
  }, []);

  // Kick off meta load on mount — headline stats render with the page.
  useEffect(() => { loadMetaOnce(); }, [loadMetaOnce]);

  // Live unified-department vocabulary from /api/jobs/meta (department_facets); the canonical
  // taxonomy is the fallback while it loads / if the endpoint fails. Single SoT for the chip.
  const departmentOptions = useMemo(
    () => departments.length
      ? [{ label: "All departments", value: "all" }, ...departments.map((d) => ({ label: d.label, value: d.value }))]
      : DEPARTMENT_OPTIONS_FALLBACK,
    [departments],
  );

  // Cascade Account-tab preference edits into the filter chips (one-way).
  // The state initializers run once on mount; this effect re-syncs whenever the
  // preferences prop changes (e.g. user edited Job Preferences on the Account tab).
  const isInitialPrefSyncRef = useRef(true);
  useEffect(() => {
    if (isInitialPrefSyncRef.current) { isInitialPrefSyncRef.current = false; return; }
    setVisa(prefToVisa(preferences?.visa_type ?? null));
    setLevel(prefToLevel(preferences?.job_level ?? null));
    setLocation(prefToLocation(preferences?.location ?? null));
    setDepartment(prefToDepartment(preferences?.job_function ?? null));
    setSalary(prefToSalary(preferences?.salary_floor ?? null));
    setPostedDate(prefToPosted(preferences?.posted_within_days ?? null));
  }, [
    preferences?.visa_type, preferences?.job_level, preferences?.location,
    preferences?.job_function, preferences?.salary_floor, preferences?.posted_within_days,
  ]);

  const doFetch = useCallback(
    async (params: { q: string; location: string; company: string; posted: string; sort: string; signal: string; visa: string; department: string; level: string; salary: string }, append = false, pageNum = 0) => {
      const myId = ++fetchIdRef.current;
      if (!append) {
        fetchAbortRef.current?.abort();
        fetchAbortRef.current = new AbortController();
        if (!hasDataRef.current) setLoading(true);
        else setRefreshing(true);
      } else {
        setLoadingMore(true);
      }
      const qs = new URLSearchParams({
        q: params.q, location: params.location, company: params.company,
        posted: params.posted, sort: params.sort, page: String(pageNum),
        signal: params.signal, visa: params.visa,
        department: params.department, level: params.level, salary: params.salary,
      });
      try {
        const sig = append ? undefined : fetchAbortRef.current?.signal;
        const res = await fetch(`/api/jobs?${qs}`, sig ? { signal: sig } : undefined);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const rawJobs: JobRow[] = data.jobs ?? [];
        const normalized = rawJobs.map(toJobWithNorm);
        setJobs((prev) => (append ? [...prev, ...normalized] : normalized));
        setTotal(data.total ?? 0);
        setPage(pageNum);
        hasDataRef.current = true;
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === "AbortError") return;
        if (!append && myId === fetchIdRef.current) { setJobs([]); setTotal(0); }
      } finally {
        if (!append && myId === fetchIdRef.current) { setLoading(false); setRefreshing(false); }
        else if (append) setLoadingMore(false);
      }
    },
    []
  );

  // Fetch on filter change
  useEffect(() => {
    const params = { q: query, location, company, posted: postedDate, sort: sortBy, signal, visa, department, level, salary };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doFetch(params, false, 0);
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, location, company, postedDate, sortBy, signal, visa, department, level, salary]);

  // Infinite scroll — only active if user is unlocked
  const loadMore = useCallback(() => {
    if (!isUnlocked) return;
    if (loadingMore || jobs.length >= total) return;
    doFetch({ q: query, location, company, posted: postedDate, sort: sortBy, signal, visa, department, level, salary }, true, page + 1);
  }, [isUnlocked, loadingMore, jobs.length, total, query, location, company, postedDate, sortBy, signal, visa, department, level, salary, page, doFetch]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  // Restore viewed/saved from localStorage
  useEffect(() => {
    try {
      const viewed = localStorage.getItem("gdj_viewed");
      if (viewed) setViewedJobs(new Set(JSON.parse(viewed)));
      const saved = localStorage.getItem("gdj_saved");
      if (saved) setSavedJobs(new Set(JSON.parse(saved)));
    } catch {}
  }, []);

  // Close chip dropdowns on outside click.
  // Skip if the target is inside a portal chip menu — those are rendered at body,
  // outside filterBarRef, so without this guard the mousedown closes the menu
  // before the option's click event fires and the selection is lost.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("[data-matches-chip-menu]")) return;
      if (filterBarRef.current && !filterBarRef.current.contains(e.target as Node)) setOpenChip(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Auto-select first job on desktop. Re-selects whenever the current pick is missing
  // from the new result set (filter change), so the right pane always shows a job.
  useEffect(() => {
    if (loading) return;
    if (typeof window === "undefined" || window.innerWidth < 1024) return;
    if (jobs.length === 0) return;
    const stillPresent = selectedJobId !== null && jobs.some((j) => j.id === selectedJobId);
    if (!stillPresent) setSelectedJobId(jobs[0].id);
  }, [loading, jobs, selectedJobId]);

  // Lazy-load meta after first paint
  useEffect(() => {
    if (loading || metaLoaded || metaInflightRef.current) return;
    if (typeof window === "undefined") return;
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: object) => number }).requestIdleCallback;
    if (ric) {
      const handle = ric(() => loadMetaOnce(), { timeout: 2000 });
      return () => (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
    }
    const t = setTimeout(loadMetaOnce, 400);
    return () => clearTimeout(t);
  }, [loading, metaLoaded, loadMetaOnce]);

  // Fetch job description when selected
  useEffect(() => {
    if (selectedJobId === null) return;
    if (descCache[selectedJobId] !== undefined) return;
    const job = jobs.find((j) => j.id === selectedJobId);
    if (!job) return;
    setDescLoading(true);
    if (job.ats_source === "greenhouse" && job.ats_slug && job.ats_job_id) {
      const sid = selectedJobId;
      fetch(`https://boards-api.greenhouse.io/v1/boards/${job.ats_slug}/jobs/${job.ats_job_id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((data) => {
          const txt = document.createElement("textarea");
          txt.innerHTML = data.content ?? "";
          let ghSalary: string | undefined;
          const pr = data.pay_range;
          if (pr?.min_cents != null && pr?.max_cents != null) {
            const fmt = (c: number) => "$" + Math.round(c / 100).toLocaleString("en-US");
            ghSalary = `${fmt(pr.min_cents)} – ${fmt(pr.max_cents)}`;
          }
          if (!ghSalary && Array.isArray(data.metadata)) {
            for (const m of data.metadata as Array<{ value_type?: string; value?: { min_value?: string; max_value?: string } }>) {
              if (m.value_type === "salary_range" && m.value?.min_value && m.value?.max_value) {
                const fmt2 = (v: string) => "$" + Number(v).toLocaleString("en-US");
                ghSalary = `${fmt2(m.value.min_value)} – ${fmt2(m.value.max_value)}`;
                break;
              }
            }
          }
          setDescCache((c) => ({ ...c, [sid]: { html: txt.value, text: "", ...(ghSalary ? { salary: ghSalary } : {}) } }));
          setDescLoading(false);
        })
        .catch(async () => {
          const { data } = await supabase.from("jobs").select("description_text").eq("id", sid).single();
          const raw = data?.description_text ?? "";
          const isHtml = /<[a-z][^>]*>/i.test(raw);
          setDescCache((c) => ({ ...c, [sid]: isHtml ? { html: raw, text: "" } : { html: "", text: raw } }));
          setDescLoading(false);
        });
    } else if (job.ats_source === "workday" && job.url) {
      const sid = selectedJobId;
      const jobUrl = job.url;
      (async () => {
        try {
          const res = await fetch(`/api/jobs/description?url=${encodeURIComponent(jobUrl)}`);
          const json = res.ok ? await res.json() : {};
          setDescCache((c) => ({ ...c, [sid]: { html: json.html ?? "", text: json.text ?? "" } }));
        } catch {
          setDescCache((c) => ({ ...c, [sid]: { html: "", text: "" } }));
        }
        setDescLoading(false);
      })();
    } else if (job.ats_source === "ashby" && job.ats_job_id && job.ats_slug) {
      const sid = selectedJobId;
      (async () => {
        try {
          const res = await fetch(`/api/jobs/description?source=ashby&job_id=${encodeURIComponent(job.ats_job_id!)}&slug=${encodeURIComponent(job.ats_slug!)}`);
          const json = res.ok ? await res.json() : {};
          setDescCache((c) => ({ ...c, [sid]: { html: json.html ?? "", text: "", salary: json.salary ?? undefined } }));
        } catch {
          setDescCache((c) => ({ ...c, [sid]: { html: "", text: "" } }));
        }
        setDescLoading(false);
      })();
    } else if (job.ats_source === "smartrecruiters" && job.url) {
      const sid = selectedJobId;
      const jobUrl = job.url;
      (async () => {
        try {
          const res = await fetch(`/api/jobs/description?source=smartrecruiters&url=${encodeURIComponent(jobUrl)}`);
          const json = res.ok ? await res.json() : {};
          setDescCache((c) => ({ ...c, [sid]: { html: json.html ?? "", text: "" } }));
        } catch {
          setDescCache((c) => ({ ...c, [sid]: { html: "", text: "" } }));
        }
        setDescLoading(false);
      })();
    } else {
      const sid = selectedJobId;
      supabase.from("jobs").select("description_text").eq("id", sid).single().then(({ data }) => {
        const raw = data?.description_text ?? "";
        const isHtml = /<[a-z][^>]*>/i.test(raw);
        setDescCache((c) => ({ ...c, [sid]: isHtml ? { html: raw, text: "" } : { html: "", text: raw } }));
        setDescLoading(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, jobs]);

  const handleJobClick = useCallback((job: JobWithNorm) => {
    setSelectedJobId(job.id);
    setViewedJobs((prev) => {
      const next = new Set(prev);
      next.add(job.id);
      try { localStorage.setItem("gdj_viewed", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const handleClose = useCallback(() => setSelectedJobId(null), []);

  const handleShare = useCallback(() => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const handleSave = useCallback(() => {
    if (selectedJobId === null) return;
    setSavedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(selectedJobId)) next.delete(selectedJobId);
      else next.add(selectedJobId);
      try { localStorage.setItem("gdj_saved", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, [selectedJobId]);

  const companyOptions = useMemo(() => {
    if (!metaLoaded) return [{ label: "All companies", value: "" }, { label: "Loading companies…", value: "" }];
    const opts = allCompanies.map((raw) => ({ label: normalizeCompanyName(raw), value: raw }));
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return [{ label: "All companies", value: "" }, ...opts];
  }, [allCompanies, metaLoaded]);

  const selectedJob = useMemo(
    () => (selectedJobId !== null ? (jobs.find((j) => j.id === selectedJobId) ?? null) : null),
    [selectedJobId, jobs]
  );

  const prefVisa = prefToVisa(preferences?.visa_type ?? null);
  const prefLevel = prefToLevel(preferences?.job_level ?? null);
  const prefLoc = prefToLocation(preferences?.location ?? null);
  const prefDept = prefToDepartment(preferences?.job_function ?? null);
  const prefSalary = prefToSalary(preferences?.salary_floor ?? null);
  const prefPosted = prefToPosted(preferences?.posted_within_days ?? null);

  const hasActiveFilters =
    location !== prefLoc || signal !== "all" || postedDate !== prefPosted ||
    visa !== prefVisa || department !== prefDept || level !== prefLevel ||
    salary !== prefSalary || viewFilter !== "all" || query !== "";

  // Level + salary are server-side now (canonical job_level eq + min-salary gate in
  // lib/query-jobs.ts); only the view-state filters remain client-side.
  const clientFiltered = jobs.filter((j) => {
    if (viewFilter === "viewed" && !viewedJobs.has(j.id)) return false;
    if (viewFilter === "favorite" && !savedJobs.has(j.id)) return false;
    if (viewFilter === "new" && viewedJobs.has(j.id)) return false;
    return true;
  });

  const activeJobs = clientFiltered.filter((j) => j.is_active);
  const filledJobs = clientFiltered.filter((j) => !j.is_active);

  // Free-tier gate: show first VISIBLE_FREE active jobs; blur a preview of the rest
  const visibleActiveJobs = isUnlocked ? activeJobs : activeJobs.slice(0, VISIBLE_FREE);
  const gatedCount = isUnlocked ? 0 : Math.max(0, activeJobs.length - VISIBLE_FREE);
  const blurredPreview = gatedCount > 0 ? activeJobs.slice(VISIBLE_FREE, VISIBLE_FREE + 3) : [];

  return (
    <div className={s["matches-shell"]}>
      {refreshing && (
        <div className={s["matches-progress"]}><div className={s["matches-progress-bar"]} /></div>
      )}

      {/* Headline + stats */}
      <div className={s["matches-header"]}>
        <h1 className={s["matches-headline"]}>
          Updated job listings from <em>USCIS-verified</em> visa-sponsoring companies
        </h1>
        <p className={s["matches-stats"]}>
          {metaLoaded ? (
            <>
              <strong>{threeDayCount.toLocaleString()}</strong> new jobs last 3 days
              {" · "}
              <strong>{totalCount.toLocaleString()}</strong> total jobs
              {" · "}
              <strong>{allCompanies.length.toLocaleString()}</strong> sponsoring companies
            </>
          ) : (
            <span className={s["matches-stats-loading"]}>Loading stats…</span>
          )}
        </p>
      </div>

      {/* Sticky filter chip row — the ONLY thing that pins on scroll */}
      <div ref={filterBarRef} className={s["matches-controls"]}>
        <div className={s["matches-filter-row"]}>
          <FilterChip label="Visa category" value={visa} options={VISA_OPTIONS} onChange={setVisa} isOpen={openChip === "visa"} onToggle={() => setOpenChip(openChip === "visa" ? null : "visa")} icon={FilterIconVisa} />
          <FilterChip label="Sponsorship signal" value={signal} options={SIGNAL_OPTIONS} onChange={setSignal} isOpen={openChip === "signal"} onToggle={() => setOpenChip(openChip === "signal" ? null : "signal")} icon={FilterIconSponsorship} />
          <FilterChip label="Company" value={company} allValue="" options={companyOptions} onChange={setCompany} isOpen={openChip === "company"} onToggle={() => setOpenChip(openChip === "company" ? null : "company")} icon={FilterIconCompany} />
          <FilterChip label="Department" value={department} options={departmentOptions} onChange={setDepartment} isOpen={openChip === "department"} onToggle={() => setOpenChip(openChip === "department" ? null : "department")} icon={FilterIconDepartment} />
          <FilterChip label="Experience" value={level} options={LEVEL_OPTIONS} onChange={setLevel} isOpen={openChip === "level"} onToggle={() => setOpenChip(openChip === "level" ? null : "level")} icon={FilterIconExperience} />
          <FilterChip label="Compensation" value={salary} options={SALARY_OPTIONS} onChange={setSalary} isOpen={openChip === "salary"} onToggle={() => setOpenChip(openChip === "salary" ? null : "salary")} icon={FilterIconCompensation} />
          <FilterChip label="Location" value={location} options={LOCATION_OPTIONS} onChange={setLocation} isOpen={openChip === "location"} onToggle={() => setOpenChip(openChip === "location" ? null : "location")} icon={FilterIconLocation} />
          <FilterChip label="Posted past week" value={postedDate} options={POSTED_DATE_OPTIONS} onChange={setPostedDate} isOpen={openChip === "postedDate"} onToggle={() => setOpenChip(openChip === "postedDate" ? null : "postedDate")} icon={FilterIconPosted} />
          <FilterChip label="All jobs" value={viewFilter} options={VIEW_OPTIONS} onChange={setViewFilter} isOpen={openChip === "viewFilter"} onToggle={() => setOpenChip(openChip === "viewFilter" ? null : "viewFilter")} icon={FilterIconAll} />
          {hasActiveFilters && (
            <button
              onClick={() => {
                setQuery(""); setCompany("");
                setLocation(prefLoc);
                setSignal("all");
                setPostedDate(prefPosted);
                setVisa(prefVisa);
                setDepartment(prefDept);
                setLevel(prefLevel);
                setSalary(prefSalary);
                setViewFilter("all");
              }}
              className={s["matches-reset"]}
            >
              Reset to preferences
            </button>
          )}
        </div>
      </div>

      {/* Two-pane content — always rendered so the filter chips stay accessible during load */}
      {(
        <div className={s["matches-content"]}>
          {/* Left: job list with embedded search + sort */}
          <div
            ref={listScrollRef}
            className={`${s["matches-list"]} ${selectedJob ? "hidden lg:block" : "block"}`}
          >
            {/* Search + sort row INSIDE the list panel, small */}
            <div className={s["matches-list-controls"]}>
              <div className={s["matches-search"]}>
                <Search size={12} className={s["matches-search-icon"]} />
                <input
                  type="text"
                  placeholder="Search job title or company..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className={s["matches-search-input"]}
                />
              </div>
              <div className={s["matches-sort"]}>
                <span className={s["matches-sort-label"]}>Sort:</span>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={s["matches-sort-select"]}>
                  {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={10} style={{ color: "#a1a1aa", marginLeft: -12, pointerEvents: "none" }} />
              </div>
            </div>

            {loading ? (
              <div style={{ padding: "48px 24px", textAlign: "center" }}>
                <span style={{ fontSize: 13, color: "#71717a" }}>Loading jobs…</span>
              </div>
            ) : clientFiltered.length === 0 ? (
              <div className={s["matches-empty"]}>
                <p className={s["matches-empty-title"]}>No jobs match your filters</p>
                <p className={s["matches-empty-sub"]}>Try removing or extending some filters</p>
              </div>
            ) : (
              <>
                {visibleActiveJobs.map((job) => (
                  <JobCard key={job.id} job={job} isSelected={job.id === selectedJobId} isViewed={viewedJobs.has(job.id)} onClick={() => handleJobClick(job)} />
                ))}

                {/* Free-tier gate: blurred preview + centered modal */}
                {!isUnlocked && gatedCount > 0 && (
                  <div className={s["matches-gate"]}>
                    <div className={s["matches-gate-blur"]}>
                      {blurredPreview.map((job) => (
                        <JobCard key={job.id} job={job} isSelected={false} isViewed={false} onClick={() => {}} />
                      ))}
                    </div>
                    <div className={s["matches-gate-fade"]}>
                      <div className={s["matches-gate-modal"]}>
                        <h3 className={s["matches-gate-headline"]}>
                          Upgrade to see all matches to your preferences.
                        </h3>
                        <Link href="/kai" className={s["matches-gate-cta"]}>
                          Upgrade →
                        </Link>
                      </div>
                    </div>
                  </div>
                )}

                {/* Filled jobs (unlocked only) */}
                {isUnlocked && filledJobs.length > 0 && (
                  <>
                    <div className={s["matches-divider"]}>
                      <div className={s["matches-divider-line"]} />
                      <span className={s["matches-divider-label"]}>No longer active · {filledJobs.length}</span>
                      <div className={s["matches-divider-line"]} />
                    </div>
                    {filledJobs.map((job) => (
                      <JobCard key={job.id} job={job} isSelected={job.id === selectedJobId} isViewed={viewedJobs.has(job.id)} isFilled onClick={() => handleJobClick(job)} />
                    ))}
                  </>
                )}

                {/* Infinite scroll sentinel (unlocked only) */}
                {isUnlocked && (
                  <div ref={sentinelRef} className={s["matches-sentinel"]}>
                    {loadingMore && <span>Loading more…</span>}
                    {!loadingMore && jobs.length < total && (
                      <span>{jobs.length.toLocaleString()} of {total.toLocaleString()}</span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right: detail panel (desktop) */}
          <div className={`hidden lg:flex ${s["matches-detail"]}`}>
            {selectedJob ? (
              <JobDetailPanel
                job={selectedJob}
                descHtml={descCache[selectedJob.id]?.html ?? ""}
                descText={descCache[selectedJob.id]?.text ?? ""}
                descLoading={descLoading && descCache[selectedJob.id] === undefined}
                copied={copied}
                isSaved={savedJobs.has(selectedJob.id)}
                onShare={handleShare}
                onSave={handleSave}
                salaryOverride={descCache[selectedJob.id]?.salary}
              />
            ) : (
              <div className={s["matches-detail-empty"]}>
                <p style={{ fontSize: 14, fontWeight: 500, margin: "0 0 4px", color: "#3f3f46" }}>Select a job to view details</p>
                <p style={{ fontSize: 12, margin: 0, color: "#a1a1aa" }}>Click any listing on the left</p>
              </div>
            )}
          </div>

          {/* Mobile: full-screen detail (no internal scroll — the page scrolls,
              so the sticky bar inside JobDetailPanel sticks to the page top). */}
          {selectedJob && (
            <div className="flex lg:hidden" style={{ minWidth: 0, flexDirection: "column" }}>
              <button onClick={handleClose} className={s["matches-mobile-back"]}>
                <ArrowLeft size={13} /> All jobs
              </button>
              <div>
                <JobDetailPanel
                  job={selectedJob}
                  descHtml={descCache[selectedJob.id]?.html ?? ""}
                  descText={descCache[selectedJob.id]?.text ?? ""}
                  descLoading={descLoading && descCache[selectedJob.id] === undefined}
                  copied={copied}
                  isSaved={savedJobs.has(selectedJob.id)}
                  onShare={handleShare}
                  onSave={handleSave}
                  salaryOverride={descCache[selectedJob.id]?.salary}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

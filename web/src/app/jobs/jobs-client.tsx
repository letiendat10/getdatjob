"use client";

import { useState, useMemo, useEffect, useRef, useCallback, Suspense } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  Search, MapPin, ExternalLink, ChevronDown,
  Share2, ArrowLeft, CheckCircle, Bookmark,
} from "lucide-react";
import type { JobRow } from "@/lib/query-jobs";

// ── Types ───────────────────────────────────────────────────────────────────

type JobWithNorm = JobRow & {
  _normLoc: string;
  _normCompany: string;
};

// ── Helpers (same as /jobs) ──────────────────────────────────────────────────

const US_STATE_ABBREVS = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
  "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj",
  "nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt",
  "va","wa","wv","wi","wy","dc",
]);
const AMBIGUOUS_ABBREVS = new Set(["in","or","me","hi","de","la","pa","wa","ok","id","co","ga","va","ma","al","mo","ar","ms"]);

function normalizeLocation(loc: string): string {
  const l = loc?.toLowerCase().trim() ?? "";
  if (!l || l === "united states" || l === "us" || l === "usa") return "United States";
  if (l.includes("remote")) return "Remote";
  if (l.includes("san francisco") || l.includes(" sf,") || l === "sf" ||
      l.match(/,\s*(ca|california)\s*$/) || l === "ca" || l === "california" ||
      l.includes("palo alto") || l.includes("menlo park") || l.includes("mountain view") ||
      l.includes("sunnyvale") || l.includes("san jose") || l.includes("south san francisco") ||
      l === "ca - hybrid") return "San Francisco Bay Area";
  if (l.includes("new york") || l === "ny" || l === "nyc" || l.includes("brooklyn") || l.includes("manhattan"))
    return "New York City";
  if (l.includes("seattle") || l === "wa" || l === "washington") return "Seattle, WA";
  if (l.includes("chicago") || l === "il" || l === "illinois") return "Chicago, IL";
  if (l.includes("los angeles") || l.includes("santa monica") || l.includes("culver city")) return "Los Angeles, CA";
  if (l.includes("austin") || l === "tx" || l === "texas") return "Austin, TX";
  if (l.includes("boston") || l === "ma" || l === "massachusetts") return "Boston, MA";
  if (l.includes("denver") || l === "co" || l === "colorado") return "Denver, CO";
  if (l.includes("washington, dc") || l === "dc" || l.includes("arlington, va")) return "Washington, DC";
  if (l.includes("atlanta") || l === "ga") return "Atlanta, GA";
  if (l.includes("nashville") || l.includes("tennessee")) return "Nashville, TN";
  if (l.includes("miami") || l.includes("florida") || l === "fl") return "Miami, FL";
  if (l.includes("salt lake") || l === "utah") return "Salt Lake City, UT";
  if (l === "az" || l.includes("phoenix") || l.includes("arizona") || l.includes("scottsdale") || l.includes("tempe")) return "Phoenix, AZ";
  if (l === "va" || l.includes("mclean") || l.includes("reston")) return "Virginia";
  if (l === "nm" || l.includes("new mexico") || l.includes("albuquerque")) return "New Mexico";
  if (l.includes("portland") || l === "or" || l.includes("oregon")) return "Portland, OR";
  if (l.includes("pittsburgh") || l.includes("philadelphia") || l === "pa" || l.includes("pennsylvania")) return "Pennsylvania";
  if (l.includes("san diego")) return "San Diego, CA";
  return loc.split(",")[0].trim();
}

const COMPANY_NAME_OVERRIDES: Record<string, string> = {
  // Misc
  "social finance": "SoFi",
  // AT&T
  "at&t services": "AT&T",
  "at&t mobility services": "AT&T",
  "at&t": "AT&T",
  // Banking / Finance
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
  // Consulting / Big 4
  "deloitte touche tohmatsu services": "Deloitte",
  "deloitte transactions and business analytics": "Deloitte",
  "pricewaterhousecoopers advisory services": "PwC",
  "pricewaterhousecoopers": "PwC",
  "mckinsey & company united states": "McKinsey",
  "mckinsey & company": "McKinsey",
  // Tech
  "space exploration technologies": "SpaceX",
  "flextronics international usa": "Flex",
  "environmental systems research institute": "Esri",
  "cognizant trizetto software group": "Cognizant",
  "cognizant technology solutions us": "Cognizant",
  "hsbc technology & services": "HSBC",
  // Healthcare
  "cigna health and life insurance company": "Cigna",
  // Logistics / Retail
  "united parcel service general services": "UPS",
  "foot locker corporate services": "Foot Locker",
  "macy's systems and technology": "Macy's",
  // Other
  "london stock exchange group holdings": "LSEG",
  "general dynamics information technology": "GDIT",
};

function normalizeCompanyName(name: string): string {
  // 1. Extract d/b/a brand name (handles both "d/b/a Name" and "(D/B/A Name)")
  const dba = name.match(/\(?\bd\/?b\/?a\.?\)?\s+([^)]+)/i);

  const cleaned = (dba ? dba[1] : name)
    // 2. Strip f/k/a parentheticals ("formerly known as")
    .replace(/\s*\([^)]*f\.?k\.?a\.?[^)]*\)/gi, "")
    // 3. Strip trailing parentheticals like (USA), (United States), (PECNA)
    .replace(/\s*\([^)]+\)\s*$/g, "")
    // 4. Strip trailing geographic qualifiers
    .replace(/,?\s+(united states|north america|americas|usa|u\.s\.a?)\.?\s*$/i, "")
    // 5. Strip legal entity suffixes (added LLP and N.A.)
    .replace(/,?\s+(incorporated|inc\.?|l\.?l\.?c\.?|l\.?l\.?p\.?|corporation|corp\.?|limited|ltd\.?|co\.|l\.p\.?|\blp\b|pbc|p\.c\.|pllc|n\.a\.?)\.?\s*$/i, "")
    .trim();

  // 6. Manual override for well-known brands
  const override = COMPANY_NAME_OVERRIDES[cleaned.toLowerCase()];
  if (override) return override;

  // 7. ALL-CAPS names (common in LCA filings) → title-case, preserving acronyms
  const letters = cleaned.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    return cleaned
      .split(/\s+/)
      .map((w) => {
        const alpha = w.replace(/[^a-zA-Z]/g, "");
        // Keep as-is: 1–4 pure uppercase letters (IBM, KPMG) OR symbol-acronyms (AT&T, S&P)
        const isAcronym = /^[A-Z]{1,4}$/.test(w);
        const isSymbolAcronym = alpha.length > 0 && alpha === alpha.toUpperCase() && w.length > alpha.length;
        return isAcronym || isSymbolAcronym ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      })
      .join(" ");
  }
  return cleaned;
}

const DOMAIN_OVERRIDES: Record<string, string> = {
  block: "block.xyz",
  ciscosystems: "cisco.com",
  citibankna: "citi.com",
};
function companyDomain(name: string): string {
  // If the company name has an embedded TLD (e.g. "Amazon.com Services", "Cars.com"), use it directly.
  const embedded = name.match(/\b([a-zA-Z0-9-]+\.(com|org|net|io|co))\b/i);
  if (embedded) return embedded[1].toLowerCase();
  const stem = normalizeCompanyName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return DOMAIN_OVERRIDES[stem] ?? stem + ".com";
}

const LOGO_OVERRIDES: Record<string, string> = {
  "sofi.com": "https://d32ijn7u0aqfv4.cloudfront.net/git/svgs/sofi-logo.svg",
};

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
  return s
    .replace(/&[a-z]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function extractSalary(html: string): string | null {
  const text = decodeHtmlEntities(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const range = text.match(/\$[\d,]+(?:\.\d+)?K?\s*[–—\-]+\s*\$[\d,]+(?:\.\d+)?K?/i);
  if (range) return range[0].replace(/\s+/g, " ").trim();
  const single = text.match(/\$\d{2,3},\d{3}/);
  return single ? single[0] : null;
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
function inferLevel(title: string): string | null {
  const t = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(t)) return "Intern";
  if (/\b(junior|jr\.?|entry[- ]level|associate(?! director| product))\b/.test(t)) return "Junior";
  if (/\b(principal|staff engineer|distinguished|fellow)\b/.test(t)) return "Principal / Staff";
  if (/\b(senior|sr\.?)\b/.test(t)) return "Senior";
  if (/\b(lead|manager|director|head of|vp\b|vice president)\b/.test(t)) return "Lead / Manager";
  return "Mid-level";
}
function inferDepartment(title: string): string | null {
  const t = title.toLowerCase();
  if (/\b(machine learning|ml |ai |artificial intelligence|nlp|llm|research scientist)\b/.test(t)) return "AI / ML";
  if (/\b(data engineer|data scientist|data analyst|analytics|business intelligence)\b/.test(t)) return "Data";
  if (/\b(security|infosec|cybersecurity|appsec|devsecops)\b/.test(t)) return "Security";
  if (/\b(product manager|product owner|\bpm\b|product lead)\b/.test(t)) return "Product";
  if (/\b(design|ux |ui |designer|user experience)\b/.test(t)) return "Design";
  if (/\b(devops|site reliability|platform engineer|infrastructure|cloud engineer|sre)\b/.test(t)) return "Platform / DevOps";
  if (/\b(sales|account executive|business development)\b/.test(t)) return "Sales";
  if (/\b(marketing|growth|demand generation)\b/.test(t)) return "Marketing";
  if (/\b(finance|accounting|financial analyst)\b/.test(t)) return "Finance";
  if (/\b(facilities|mailroom|real estate|workplace|janitorial|custodial|maintenance tech|building)\b/.test(t)) return "Facilities";
  if (/\b(operations|ops|logistics|supply chain|fulfillment|warehouse)\b/.test(t)) return "Operations";
  if (/\b(legal|counsel|attorney|compliance|paralegal)\b/.test(t)) return "Legal";
  if (/\b(recruiter|recruiting|talent acquisition|human resources|hr |people ops|people partner)\b/.test(t)) return "HR / People";
  if (/\b(customer success|customer support|account manager|customer experience|cx |support engineer)\b/.test(t)) return "Customer Success";
  if (/\b(engineer|engineering|developer|software|backend|frontend|fullstack|full.stack|firmware|embedded|mobile|ios|android|web|api|sdk|cloud|infrastructure|platform|sre|devops|ml|machine learning|data|security|infosec)\b/.test(t)) return "Engineering";
  return null;
}

// ── Filter config ────────────────────────────────────────────────────────────

const LOCATION_OPTIONS = [
  { label: "All locations", value: "all" },
  { label: "Remote", value: "Remote" },
  { label: "San Francisco Bay Area", value: "San Francisco Bay Area" },
  { label: "New York City", value: "New York City" },
  { label: "Seattle, WA", value: "Seattle, WA" },
  { label: "Chicago, IL", value: "Chicago, IL" },
  { label: "Los Angeles, CA", value: "Los Angeles, CA" },
  { label: "Austin, TX", value: "Austin, TX" },
  { label: "Boston, MA", value: "Boston, MA" },
  { label: "Denver, CO", value: "Denver, CO" },
  { label: "Washington, DC", value: "Washington, DC" },
  { label: "Atlanta, GA", value: "Atlanta, GA" },
  { label: "Miami, FL", value: "Miami, FL" },
  { label: "Nashville, TN", value: "Nashville, TN" },
  { label: "Portland, OR", value: "Portland, OR" },
  { label: "Salt Lake City, UT", value: "Salt Lake City, UT" },
  { label: "Phoenix, AZ", value: "Phoenix, AZ" },
  { label: "San Diego, CA", value: "San Diego, CA" },
  { label: "Virginia", value: "Virginia" },
  { label: "Pennsylvania", value: "Pennsylvania" },
];

const SIGNAL_OPTIONS = [
  { label: "All signals", value: "all" },
  { label: "Verified LCA Filings With Same Job Title", value: "verified" },
  { label: "H-1B Friendly Employer", value: "friendly" },
];

const POSTED_DATE_OPTIONS = [
  { label: "Any time", value: "all" },
  { label: "Past 24 hours", value: "1d" },
  { label: "Past week", value: "7d" },
  { label: "Past month", value: "30d" },
  { label: "Past 3 months", value: "90d" },
];

const SORT_OPTIONS = [
  { label: "Most recent", value: "recent" },
  { label: "Most LCAs", value: "lcas" },
  { label: "Relevance", value: "relevance" },
];

const DEPARTMENT_OPTIONS = [
  { label: "All departments", value: "all" },
  { label: "AI / ML", value: "AI / ML" },
  { label: "Data", value: "Data" },
  { label: "Engineering", value: "Engineering" },
  { label: "Security", value: "Security" },
  { label: "Product", value: "Product" },
  { label: "Design", value: "Design" },
  { label: "Platform / DevOps", value: "Platform / DevOps" },
  { label: "Sales", value: "Sales" },
  { label: "Marketing", value: "Marketing" },
  { label: "Finance", value: "Finance" },
  { label: "Operations", value: "Operations" },
  { label: "Legal", value: "Legal" },
  { label: "HR / People", value: "HR / People" },
  { label: "Customer Success", value: "Customer Success" },
  { label: "Facilities", value: "Facilities" },
];

const LEVEL_OPTIONS = [
  { label: "All levels", value: "all" },
  { label: "Intern", value: "Intern" },
  { label: "Junior", value: "Junior" },
  { label: "Mid-level", value: "Mid-level" },
  { label: "Senior", value: "Senior" },
  { label: "Principal / Staff", value: "Principal / Staff" },
  { label: "Lead / Manager", value: "Lead / Manager" },
];

const VIEW_OPTIONS = [
  { label: "All jobs", value: "all" },
  { label: "Viewed", value: "viewed" },
  { label: "Favorite", value: "favorite" },
  { label: "New to you", value: "new" },
];

const VISA_OPTIONS = [
  { label: "All visas", value: "all" },
  { label: "H-1B", value: "H1B" },
  { label: "E-3", value: "E3" },
  { label: "TN", value: "TN" },
];

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN ?? "";

// ── Components ───────────────────────────────────────────────────────────────

function CompanyAvatar({ name, domain, size = "sm" }: { name: string; domain?: string | null; size?: "sm" | "md" | "lg" }) {
  const [imgError, setImgError] = useState(false);
  const sizeClass =
    size === "lg" ? "w-14 h-14 rounded-xl"
    : size === "md" ? "w-10 h-10 rounded-lg"
    : "w-8 h-8 rounded";
  const textClass = size === "lg" ? "text-base" : "text-xs";
  const resolvedDomain = domain || companyDomain(name);
  const logoOverride = LOGO_OVERRIDES[resolvedDomain];
  if ((LOGO_DEV_TOKEN || logoOverride) && !imgError) {
    const px = size === "lg" ? 128 : 64;
    const src = logoOverride ?? `https://img.logo.dev/${resolvedDomain}?token=${LOGO_DEV_TOKEN}&size=${px}&format=png&fallback=monogram`;
    return (
      <div className={`${sizeClass} flex-shrink-0 border border-zinc-100 bg-white overflow-hidden flex items-center justify-center`}>
        <img src={src} alt={name} onError={() => setImgError(true)} className="w-full h-full object-contain p-0.5" />
      </div>
    );
  }
  return (
    <div className={`${sizeClass} flex-shrink-0 bg-zinc-100 border border-zinc-100 flex items-center justify-center font-bold ${textClass} text-zinc-500 uppercase`}>
      {name.slice(0, 2)}
    </div>
  );
}

// ── Filter Icons (dot-grid style, 24×24 viewbox, currentColor) ──────────────

const S = 1.4; // default stroke weight

function FilterIconCompany() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 20.5V8.2L12 5l7 3.2v12.3" />
      <path d="M9.5 20.5V15.5h5v5" />
      <circle cx="8.5"  cy="11" r=".55" fill="currentColor" stroke="none" />
      <circle cx="12"   cy="11" r=".55" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="11" r=".55" fill="currentColor" stroke="none" />
      <path d="M3.5 20.5h17" />
    </g>
  );
}

function FilterIconSponsorship() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 15.5l3.2-3.2 3 2.2 4.2-5 3.8 2.8" />
      <circle cx="18.2" cy="12.3" r="1.1" fill="currentColor" stroke="none" />
      <path d="M4 20h16" opacity=".35" />
    </g>
  );
}

function FilterIconLocation() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21.5s-6.5-6.4-6.5-12A6.5 6.5 0 0 1 18.5 9.5c0 5.6-6.5 12-6.5 12z" />
      <circle cx="12" cy="9.3" r="1.4" fill="currentColor" stroke="none" />
    </g>
  );
}

function FilterIconPosted() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="5.5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17" />
      <path d="M8 3.5v3.4M16 3.5v3.4" />
      <circle cx="8"  cy="14" r=".65" fill="currentColor" stroke="none" />
      <circle cx="12" cy="14" r=".65" fill="currentColor" stroke="none" />
      <circle cx="16" cy="14" r=".65" fill="currentColor" stroke="none" />
      <circle cx="8"  cy="17.5" r=".65" fill="currentColor" stroke="none" />
      <circle cx="12" cy="17.5" r=".65" fill="currentColor" stroke="none" />
    </g>
  );
}

function FilterIconVisa() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5.5" width="16" height="13" rx="1.6" />
      <path d="M4 10h16" />
      <circle cx="8" cy="14.5" r="1.6" />
      <path d="M12 14h5.5M12 16.5h4" />
      <circle cx="16.6" cy="7.7" r="1.1" />
    </g>
  );
}

function FilterIconDepartment() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5.2"  r="1.9" />
      <circle cx="5"  cy="18.5" r="1.9" />
      <circle cx="12" cy="18.5" r="1.9" />
      <circle cx="19" cy="18.5" r="1.9" />
      <path d="M12 7.1v3.4M5 16.6v-3.1h14v3.1" />
    </g>
  );
}

function FilterIconExperience() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 20.5V12M12 20.5V8.5M16 20.5V5" />
      <circle cx="8"  cy="12"  r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="5"   r="1.1" fill="currentColor" stroke="none" />
      <path d="M3.5 20.5h17" />
    </g>
  );
}

function FilterIconAll() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={S} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="8" width="17" height="12.5" rx="2" />
      <path d="M8.5 8V6.2A2 2 0 0 1 10.5 4.2h3a2 2 0 0 1 2 2V8" />
      <circle cx="12" cy="14.2" r="1.1" fill="currentColor" stroke="none" />
      <path d="M3.5 13h7M13.5 13h7" opacity=".4" />
    </g>
  );
}

function FilterIcon({ icon: IconInner }: { icon: () => React.ReactElement }) {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" style={{ display: "block", flexShrink: 0 }}>
      <IconInner />
    </svg>
  );
}

// ── FilterChip ───────────────────────────────────────────────────────────────

function FilterChip({ label, value, defaultValue, options, onChange, isOpen, onToggle, icon }: {
  label: string; value: string; defaultValue: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void; isOpen: boolean; onToggle: () => void;
  icon?: () => React.ReactElement;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  const isActive = value !== defaultValue;
  const currentLabel = isActive ? (options.find((o) => o.value === value)?.label ?? label) : label;

  const handleToggle = () => {
    if (!isOpen && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 6, left: r.left });
    }
    onToggle();
  };

  return (
    <div className="flex-shrink-0">
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
          isActive
            ? "bg-zinc-900 text-white border-zinc-900 shadow-sm"
            : "bg-white text-zinc-700 border-zinc-300 hover:border-zinc-500 hover:bg-zinc-50"
        }`}
      >
        {icon && <FilterIcon icon={icon} />}
        {currentLabel}
        <ChevronDown size={13} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen && dropPos && (
        <div
          style={{ position: "fixed", top: dropPos.top, left: dropPos.left, zIndex: 9999 }}
          className="w-56 bg-white border border-zinc-200 rounded-xl shadow-xl py-1 max-h-72 overflow-y-auto"
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); onToggle(); }}
              className={`w-full text-left px-4 py-2 text-sm transition-colors flex items-center justify-between ${
                opt.value === value
                  ? "bg-zinc-50 text-zinc-900 font-medium"
                  : "text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {opt.label}
              {opt.value === value && <CheckCircle size={13} className="text-zinc-900" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DescriptionSkeleton() {
  return (
    <div className="space-y-3 animate-pulse mt-2">
      {[100, 88, 94, 72, 85, 60, 78, 90].map((w, i) => (
        <div key={i} className="h-3 bg-zinc-200 rounded" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function JobCard({ job, isSelected, isViewed, isFilled, onClick }: {
  job: JobWithNorm; isSelected: boolean; isViewed: boolean; isFilled?: boolean; onClick: () => void;
}) {
  const posted = timeAgo(job.posted_at);
  const isVerified = job.confidence_tier === "verified";
  const isFriendly = job.confidence_tier === "friendly";
  return (
    <div
      onClick={onClick}
      className={`group relative flex gap-3 px-4 py-4 cursor-pointer transition-colors select-none border-b border-zinc-100 ${
        isFilled ? "opacity-45" : ""
      } ${isSelected ? "bg-blue-50" : "hover:bg-zinc-50"}`}
    >
      {isSelected && <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-blue-600 rounded-r-sm" />}
      <CompanyAvatar name={job._normCompany} domain={job.domain} size="md" />
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <h3 className={`flex-1 min-w-0 text-sm font-semibold leading-snug transition-colors ${
            isSelected ? "text-blue-700" : isFilled ? "text-zinc-500" : "text-zinc-900 group-hover:text-blue-600"
          }`}>
            {job.title}
          </h3>
          {posted && <span className="flex-shrink-0 text-xs text-zinc-400 mt-px">{posted}</span>}
        </div>
        <p className="text-xs text-zinc-500 mt-0.5 truncate">
          {job._normCompany} · {job._normLoc}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {job.salary_range && (
            <span className="text-xs text-zinc-600 bg-zinc-100 px-1.5 py-0.5 rounded">
              {job.salary_range}
            </span>
          )}
          {isVerified && (
            <span
              className="inline-flex rounded-full p-[2px]"
              style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}
            >
              <span className="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-zinc-900">
                Verified LCA Filings With Same Job Title
              </span>
            </span>
          )}
          {isFriendly && (
            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-green-600">
              H-1B Friendly Employer
            </span>
          )}
          {isViewed && <span className="text-xs text-zinc-400">Viewed</span>}
        </div>
      </div>
    </div>
  );
}

function JobDetailPanel({ job, descHtml, descText, descLoading, copied, isSaved, onShare, onSave }: {
  job: JobWithNorm; descHtml: string; descText: string;
  descLoading: boolean; copied: boolean; isSaved: boolean; onShare: () => void; onSave: () => void;
}) {
  const lastFiling = formatLastFiling(job.last_filing_date);
  const posted = timeAgo(job.posted_at);
  const salary = useMemo(() => extractSalary(descHtml), [descHtml]);
  const experience = useMemo(() => extractExperience(descHtml), [descHtml]);
  const level = inferLevel(job.title);
  const department = inferDepartment(job.title);

  return (
    <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden flex flex-col h-full">
      <div className="flex-shrink-0 px-5 pt-5 pb-4 border-b border-zinc-100">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <CompanyAvatar name={job._normCompany} domain={job.domain} size="md" />
            <span className="text-sm font-semibold text-zinc-600 truncate">{job._normCompany}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-3">
            <button
              onClick={onSave}
              aria-label={isSaved ? "Unsave" : "Save"}
              className={`p-2 rounded-full border transition-all ${
                isSaved ? "bg-zinc-900 border-zinc-900 text-white" : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700"
              }`}
            >
              <Bookmark size={14} className={isSaved ? "fill-current" : ""} />
            </button>
            <button
              onClick={onShare}
              aria-label="Share"
              className={`p-2 rounded-full border transition-all ${
                copied ? "border-zinc-400 text-zinc-700 bg-zinc-100" : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-700"
              }`}
            >
              <Share2 size={14} />
            </button>
          </div>
        </div>
        <div className="flex items-start gap-4 mb-3">
          <h2 className="flex-1 text-xl font-bold text-zinc-900 leading-snug">{job.title}</h2>
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 !text-white text-sm font-semibold rounded-lg transition-colors shadow-sm"
          >
            Apply <ExternalLink size={12} />
          </a>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <MapPin size={11} className="flex-shrink-0 text-zinc-400" />
          <span>{job._normLoc}</span>
          {posted && <><span className="text-zinc-300">·</span><span>Posted {posted}</span></>}
        </div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {level && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{level}</span>}
          {department && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{department}</span>}
          {job.confidence_tier === "verified" && (
            <span
              className="inline-flex rounded-full p-[2px]"
              style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}
            >
              <span className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900">
                Verified LCA Filings With Same Job Title
              </span>
            </span>
          )}
          {job.confidence_tier === "friendly" && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium border border-green-200">
              H-1B Friendly Employer
            </span>
          )}
        </div>
        {(salary || experience) && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {salary && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{salary}</span>}
            {experience && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{experience} exp</span>}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {lastFiling && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">Last LCA filed in {lastFiling}</span>}
          {job.lca_count_2025 > 0 && <span className="px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium">{job.lca_count_2025} LCA filings in 2025</span>}
        </div>
      </div>
      <div className="overflow-y-auto flex-1 px-5 py-4">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">Job Description</div>
        {descLoading ? (
          <DescriptionSkeleton />
        ) : descHtml ? (
          <div
            className="prose prose-sm prose-zinc max-w-none text-zinc-700 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-1 [&_h3]:font-semibold [&_h3]:text-zinc-900 [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:mb-2 [&_strong]:font-semibold"
            dangerouslySetInnerHTML={{ __html: descHtml }}
          />
        ) : descText ? (
          <p className="text-xs text-zinc-600 leading-relaxed whitespace-pre-wrap">{descText}</p>
        ) : (
          <p className="text-xs text-zinc-400 italic">Description unavailable — view full posting on company site.</p>
        )}
      </div>
    </div>
  );
}

// ── Data fetching ────────────────────────────────────────────────────────────

function toJobWithNorm(raw: JobRow): JobWithNorm {
  return {
    ...raw,
    _normLoc: normalizeLocation(raw.location ?? ""),
    _normCompany: normalizeCompanyName(raw.company ?? ""),
  };
}

// fetchJobs removed — fetch logic is now inlined in doFetch (supports /api/jobs/init on first load)

// ── Page ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 30;

function PageContent({ initialData }: { initialData?: { jobs: JobRow[]; total: number } }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Filter state
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("all");
  const [company, setCompany] = useState("");
  const [signal, setSignal] = useState("all");
  const [postedDate, setPostedDate] = useState("7d");
  const [visa, setVisa] = useState("H1B");
  const [department, setDepartment] = useState("all");
  const [level, setLevel] = useState("all");
  const [viewFilter, setViewFilter] = useState("all");
  const [sortBy, setSortBy] = useState("recent");
  const [openChip, setOpenChip] = useState<string | null>(null);

  // Data state — seeded from SSR initial data when available
  const [jobs, setJobs] = useState<JobWithNorm[]>(() =>
    initialData ? initialData.jobs.map(toJobWithNorm) : []
  );
  const [total, setTotal] = useState(initialData?.total ?? 0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(!initialData);
  const [loadingMore, setLoadingMore] = useState(false);

  // Meta (company list for dropdown)
  const [allCompanies, setAllCompanies] = useState<string[]>([]);
  const [weekCount, setWeekCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // Detail panel state
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [viewedJobs, setViewedJobs] = useState<Set<number>>(new Set());
  const [savedJobs, setSavedJobs] = useState<Set<number>>(new Set());
  const [descCache, setDescCache] = useState<Record<number, { html: string; text: string }>>({});
  const [descLoading, setDescLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const autoSelectedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the first client-side fetch when we already have SSR data for the default params
  const skipInitialFetchRef = useRef(!!initialData);

  // Meta is loaded via /api/jobs/init on first mount (P2/P4).
  // No separate meta fetch needed.

  // Restore selected job from URL
  useEffect(() => {
    const jobParam = searchParams.get("job");
    if (jobParam) setSelectedJobId(Number(jobParam));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore viewed/saved from localStorage
  useEffect(() => {
    try {
      const viewed = localStorage.getItem("gdj_viewed");
      if (viewed) setViewedJobs(new Set(JSON.parse(viewed)));
      const saved = localStorage.getItem("gdj_saved");
      if (saved) setSavedJobs(new Set(JSON.parse(saved)));
    } catch {}
  }, []);

  // Close chip dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (filterBarRef.current && !filterBarRef.current.contains(e.target as Node)) {
        setOpenChip(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // P4: First load uses /api/jobs/init (jobs + meta in one request).
  // All subsequent calls use /api/jobs (meta already in state).
  const useInitEndpointRef = useRef(true);

  // Main fetch: fires when filters change (page resets to 0)
  const doFetch = useCallback(
    async (params: { q: string; location: string; company: string; posted: string; sort: string; signal: string; visa: string; department: string; level: string }, append = false, pageNum = 0) => {
      if (!append) setLoading(true);
      else setLoadingMore(true);

      const qs = new URLSearchParams({
        q:          params.q,
        location:   params.location,
        company:    params.company,
        posted:     params.posted,
        sort:       params.sort,
        page:       String(pageNum),
        signal:     params.signal,
        visa:       params.visa,
        department: params.department,
        level:      params.level,
      });

      let rawJobs: JobRow[];
      let total: number;

      if (useInitEndpointRef.current && !append) {
        // P4: first non-append load — use init endpoint for jobs + meta in one shot
        useInitEndpointRef.current = false;
        const data = await fetch(`/api/jobs/init?${qs}`).then((r) => r.json());
        setAllCompanies(data.companies ?? []);
        setWeekCount(data.weekCount ?? 0);
        setTotalCount(data.totalCount ?? 0);
        rawJobs = data.jobs;
        total   = data.total;
      } else {
        const data = await fetch(`/api/jobs?${qs}`).then((r) => r.json());
        rawJobs = data.jobs;
        total   = data.total;
      }

      const normalized = (rawJobs as JobRow[]).map(toJobWithNorm);
      setJobs((prev) => (append ? [...prev, ...normalized] : normalized));
      setTotal(total);
      setPage(pageNum);

      if (!append) setLoading(false);
      else setLoadingMore(false);
    },
    []
  );

  // Fetch on filter change (debounce search query only)
  // P3: department + level now included as server-side params
  useEffect(() => {
    const params = { q: query, location, company, posted: postedDate, sort: sortBy, signal, visa, department, level };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const delay = query ? 300 : 0;
    debounceRef.current = setTimeout(() => {
      if (skipInitialFetchRef.current) {
        skipInitialFetchRef.current = false;
        return;
      }
      autoSelectedRef.current = false;
      doFetch(params, false, 0);
    }, delay);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, location, company, postedDate, sortBy, signal, visa, department, level]);

  // Infinite scroll: load next page
  const loadMore = useCallback(() => {
    const nextPage = page + 1;
    if (loadingMore || jobs.length >= total) return;
    doFetch({ q: query, location, company, posted: postedDate, sort: sortBy, signal, visa, department, level }, true, nextPage);
  }, [page, loadingMore, jobs.length, total, query, location, company, postedDate, sortBy, signal, visa, department, level, doFetch]);

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

  // Auto-select first job on desktop
  useEffect(() => {
    if (loading || autoSelectedRef.current || selectedJobId !== null) return;
    if (typeof window === "undefined" || window.innerWidth < 1024) return;
    const first = jobs[0];
    if (first) {
      setSelectedJobId(first.id);
      autoSelectedRef.current = true;
    }
  }, [loading, jobs, selectedJobId]);

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
          setDescCache((c) => ({ ...c, [sid]: { html: txt.value, text: "" } }));
          setDescLoading(false);
        })
        .catch(async () => {
          const { data } = await supabase.from("jobs").select("description_text").eq("id", sid).single();
          setDescCache((c) => ({ ...c, [sid]: { html: "", text: data?.description_text ?? "" } }));
          setDescLoading(false);
        });
    } else {
      const sid = selectedJobId;
      supabase.from("jobs").select("description_text").eq("id", sid).single().then(({ data }) => {
        setDescCache((c) => ({ ...c, [sid]: { html: "", text: data?.description_text ?? "" } }));
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
    const params = new URLSearchParams(searchParams.toString());
    params.set("job", String(job.id));
    router.replace(pathname + "?" + params.toString(), { scroll: false });
  }, [router, pathname, searchParams]);

  const handleClose = useCallback(() => {
    setSelectedJobId(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("job");
    const qs = params.toString();
    router.replace(pathname + (qs ? "?" + qs : ""), { scroll: false });
  }, [router, pathname, searchParams]);

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
    const opts = allCompanies.map((raw) => ({ label: normalizeCompanyName(raw), value: raw }));
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return [{ label: "All companies", value: "" }, ...opts];
  }, [allCompanies]);

  const selectedJob = useMemo(
    () => (selectedJobId !== null ? (jobs.find((j) => j.id === selectedJobId) ?? null) : null),
    [selectedJobId, jobs]
  );
  const hasActiveFilters = company !== "" || location !== "all" || signal !== "all" || postedDate !== "7d" || visa !== "H1B" || department !== "all" || level !== "all" || viewFilter !== "all";

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-sm text-zinc-400">Loading jobs…</div>
      </div>
    );
  }

  const clientFiltered = jobs.filter((j) => {
    // P3: department + most levels are now server-side.
    // "Mid-level" is the only level that remains client-side — it's a catch-all
    // ("not intern/junior/senior/principal/lead") that can't be expressed as an
    // ILIKE filter without many NOT conditions. Accept the limitation: Mid-level
    // filters within the current page of results.
    if (level === "Mid-level" && inferLevel(j.title) !== "Mid-level") return false;
    // viewFilter is always client-side (depends on localStorage state)
    if (viewFilter === "viewed"    && !viewedJobs.has(j.id)) return false;
    if (viewFilter === "favorite"  && !savedJobs.has(j.id))  return false;
    if (viewFilter === "new"       && viewedJobs.has(j.id))   return false;
    return true;
  });
  const activeJobs = clientFiltered.filter((j) => j.is_active);
  const filledJobs = clientFiltered.filter((j) => !j.is_active);

  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white border-b border-zinc-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2 flex-shrink-0">
            <Link href="/" className="font-semibold text-zinc-900 text-[17px] tracking-[-0.015em] hover:opacity-80 transition-opacity">
              getdatjob
            </Link>
          </div>
          <div className="flex-1 max-w-xl relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search job title or company..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-transparent placeholder:text-zinc-400"
            />
          </div>
        </div>
      </header>

      {/* Hero */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-8 pb-6">
        <h1 className="font-bold text-3xl sm:text-4xl lg:text-5xl tracking-tight text-black leading-[1.1]">
          Updated job listings from{" "}
          <em className="italic font-bold">USCIS-verified</em>{" "}
          visa-sponsoring companies
        </h1>
        <p className="text-base text-zinc-500 mt-2">
          <span className="font-semibold text-zinc-700">{weekCount.toLocaleString()} new jobs this week</span>
          {" · "}
          <span className="font-semibold text-zinc-700">{totalCount.toLocaleString()} total jobs</span>
          {" · "}
          <span className="font-semibold text-zinc-700">{(companyOptions.length - 1).toLocaleString()} sponsoring companies</span>
        </p>
      </div>

      {/* Filter chips */}
      <div ref={filterBarRef} className="sticky top-14 z-40 bg-white border-y border-zinc-100 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-2 py-2.5 overflow-x-auto scrollbar-none">
          <FilterChip
            label="Company"
            value={company}
            defaultValue=""
            options={companyOptions}
            onChange={setCompany}
            isOpen={openChip === "company"}
            onToggle={() => setOpenChip(openChip === "company" ? null : "company")}
            icon={FilterIconCompany}
          />
          <FilterChip
            label="Sponsorship signal"
            value={signal}
            defaultValue="all"
            options={SIGNAL_OPTIONS}
            onChange={setSignal}
            isOpen={openChip === "signal"}
            onToggle={() => setOpenChip(openChip === "signal" ? null : "signal")}
            icon={FilterIconSponsorship}
          />
          <FilterChip
            label="Location"
            value={location}
            defaultValue="all"
            options={LOCATION_OPTIONS}
            onChange={setLocation}
            isOpen={openChip === "location"}
            onToggle={() => setOpenChip(openChip === "location" ? null : "location")}
            icon={FilterIconLocation}
          />
          <FilterChip
            label="Posted past week"
            value={postedDate}
            defaultValue="7d"
            options={POSTED_DATE_OPTIONS}
            onChange={setPostedDate}
            isOpen={openChip === "postedDate"}
            onToggle={() => setOpenChip(openChip === "postedDate" ? null : "postedDate")}
            icon={FilterIconPosted}
          />
          <FilterChip
            label="Visa category"
            value={visa}
            defaultValue="all"
            options={VISA_OPTIONS}
            onChange={setVisa}
            isOpen={openChip === "visa"}
            onToggle={() => setOpenChip(openChip === "visa" ? null : "visa")}
            icon={FilterIconVisa}
          />
          <FilterChip
            label="Department"
            value={department}
            defaultValue="all"
            options={DEPARTMENT_OPTIONS}
            onChange={setDepartment}
            isOpen={openChip === "department"}
            onToggle={() => setOpenChip(openChip === "department" ? null : "department")}
            icon={FilterIconDepartment}
          />
          <FilterChip
            label="Experience"
            value={level}
            defaultValue="all"
            options={LEVEL_OPTIONS}
            onChange={setLevel}
            isOpen={openChip === "level"}
            onToggle={() => setOpenChip(openChip === "level" ? null : "level")}
            icon={FilterIconExperience}
          />
          <FilterChip
            label="All jobs"
            value={viewFilter}
            defaultValue="all"
            options={VIEW_OPTIONS}
            onChange={setViewFilter}
            isOpen={openChip === "viewFilter"}
            onToggle={() => setOpenChip(openChip === "viewFilter" ? null : "viewFilter")}
            icon={FilterIconAll}
          />
          {hasActiveFilters && (
            <button
              onClick={() => { setCompany(""); setLocation("all"); setSignal("all"); setPostedDate("7d"); setVisa("H1B"); setDepartment("all"); setLevel("all"); setViewFilter("all"); }}
              className="flex-shrink-0 text-xs text-zinc-500 hover:text-zinc-900 px-2 py-1 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Split pane */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-0">
        {/* Left: job list */}
        <div className={`flex flex-col min-w-0 w-full lg:w-[400px] lg:flex-shrink-0 lg:border-r lg:border-zinc-100 ${
          selectedJob ? "hidden lg:flex" : "flex"
        }`}>
          <div className="flex items-center justify-between px-1 py-3 border-b border-zinc-100">
            <div />
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-400">Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="text-xs text-zinc-700 font-medium bg-transparent border-none focus:outline-none cursor-pointer appearance-none pr-4"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <ChevronDown size={11} className="text-zinc-400 -ml-3 pointer-events-none" />
            </div>
          </div>

          {jobs.length === 0 ? (
            <div className="text-center py-16 text-zinc-400">
              <p className="text-base font-medium text-zinc-600">No jobs match your filters</p>
              <p className="text-sm mt-1">Try removing some filters</p>
            </div>
          ) : (
            <>
              {activeJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  isSelected={job.id === selectedJobId}
                  isViewed={viewedJobs.has(job.id)}
                  onClick={() => handleJobClick(job)}
                />
              ))}
              {filledJobs.length > 0 && (
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-100 bg-white sticky top-0 z-10">
                  <div className="flex-1 h-px bg-zinc-200" />
                  <span className="text-xs text-zinc-400 font-medium whitespace-nowrap">
                    No longer active · {filledJobs.length}
                  </span>
                  <div className="flex-1 h-px bg-zinc-200" />
                </div>
              )}
              {filledJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  isSelected={job.id === selectedJobId}
                  isViewed={viewedJobs.has(job.id)}
                  isFilled
                  onClick={() => handleJobClick(job)}
                />
              ))}
              <div ref={sentinelRef} className="h-10 flex items-center justify-center">
                {loadingMore && <p className="text-xs text-zinc-400">Loading more…</p>}
                {!loadingMore && jobs.length < total && (
                  <p className="text-xs text-zinc-400">{jobs.length.toLocaleString()} of {total.toLocaleString()}</p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right: detail panel */}
        <div className="flex-1 min-w-0 lg:pl-6 lg:sticky lg:top-[6.75rem] lg:self-start lg:max-h-[calc(100vh-7rem)] lg:overflow-hidden flex-col py-4 hidden lg:flex">
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
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center rounded-xl border border-dashed border-zinc-200 h-full min-h-[400px]">
              <p className="text-sm font-medium text-zinc-500">Select a job to view details</p>
              <p className="text-xs text-zinc-400 mt-1">Click any listing on the left</p>
            </div>
          )}
        </div>

        {/* Mobile: full-screen detail */}
        {selectedJob && (
          <div className="flex flex-col min-w-0 w-full py-4 lg:hidden">
            <button
              onClick={handleClose}
              className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 mb-3 transition-colors"
            >
              <ArrowLeft size={13} /> All jobs
            </button>
            <JobDetailPanel
              job={selectedJob}
              descHtml={descCache[selectedJob.id]?.html ?? ""}
              descText={descCache[selectedJob.id]?.text ?? ""}
              descLoading={descLoading && descCache[selectedJob.id] === undefined}
              copied={copied}
              isSaved={savedJobs.has(selectedJob.id)}
              onShare={handleShare}
              onSave={handleSave}
            />
          </div>
        )}
      </div>

      <footer className="max-w-7xl mx-auto px-4 sm:px-6 py-6 mt-4 border-t border-zinc-100">
        <p className="text-xs text-zinc-400">
          <a href="https://logo.dev" target="_blank" rel="noopener" className="hover:text-zinc-600 transition-colors">
            Logos provided by Logo.dev
          </a>
        </p>
      </footer>
    </div>
  );
}

export function JobsClient({ initialData }: { initialData?: { jobs: JobRow[]; total: number } }) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      <PageContent initialData={initialData} />
    </Suspense>
  );
}

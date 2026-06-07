// Single source of truth for the canonical department + job-level taxonomies.
//
// This is the TypeScript mirror of `scrapers/classify.py` (DEPARTMENTS / LEVELS and the
// _DEPT_KEYWORDS priority ladder). The Python classifier writes `jobs.department` and
// `jobs.job_level`; this file is what every UI/search surface must use to translate a
// user-facing label back into the EXACT stored value. If you change classify.py's
// taxonomy, change it here too.
//
// IMPORTANT: keep this module import-pure (no `@supabase/...`, no `kai-tools`). It is
// imported by client components, so it must not drag a server client into the bundle.

// ── Canonical departments (15) — classify.py:30 order ─────────────────────────
export const DEPARTMENTS = [
  "AI / ML",
  "Data",
  "Security",
  "Design",
  "Product",
  "Finance",
  "Legal",
  "HR / People",
  "Customer Success",
  "Marketing/Growth",
  "Sales",
  "Platform / DevOps",
  "Facilities",
  "Operations",
  "Engineering",
] as const;

export type CanonicalDepartment = (typeof DEPARTMENTS)[number];

// Display label overrides — for canonical values that don't read nicely as-is.
// (The rest already contain spaces, e.g. "AI / ML", "HR / People".)
export const DEPARTMENT_LABELS: Partial<Record<CanonicalDepartment, string>> = {
  "Marketing/Growth": "Marketing / Growth",
};

export function departmentLabel(d: CanonicalDepartment): string {
  return DEPARTMENT_LABELS[d] ?? d;
}

// ── Canonical job levels (6) — classify.py:26 order, low → high ───────────────
export const LEVELS = [
  "Entry/Junior",
  "Senior",
  "Principal / Staff",
  "Lead/Manager",
  "Director",
  "VP",
] as const;

export type CanonicalLevel = (typeof LEVELS)[number];

// ── Normalizer ────────────────────────────────────────────────────────────────
// Collapse all the slash/spacing variants the UI produces into ONE key:
//   "Marketing / Growth", "marketing / growth", "Marketing/Growth" → "marketing/growth"
const norm = (s: string): string =>
  s.trim().toLowerCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");

// ── Department aliases (normalized key → canonical value(s)) ───────────────────
// Covers every vocabulary the Kai page + chat tools can emit: Q4 quick-reply values,
// funcLabelMap outputs, inferDepartment freeform, inferJobFunction Title Case, and the
// raw stored canonical values fed back in. Values are arrays because some UX buckets map
// to more than one canonical department (notably "Data / AI" → Data + AI/ML).
const DEPT_ALIASES: Record<string, CanonicalDepartment[]> = {
  // Marketing/Growth (the headline bug: "marketing" used to map to a non-existent "Marketing")
  "marketing/growth": ["Marketing/Growth"],
  marketing: ["Marketing/Growth"],
  growth: ["Marketing/Growth"],
  "product marketing": ["Marketing/Growth"],
  "growth marketing": ["Marketing/Growth"],
  "demand gen": ["Marketing/Growth"],
  "demand generation": ["Marketing/Growth"],
  brand: ["Marketing/Growth"],
  communications: ["Marketing/Growth"],
  content: ["Marketing/Growth"],
  seo: ["Marketing/Growth"],

  // Data
  data: ["Data"],
  "data science": ["Data"],
  analytics: ["Data"],
  "business intelligence": ["Data"],

  // Data / AI — the combined UX bucket must hit BOTH canonical departments
  "data/ai": ["Data", "AI / ML"],
  "data and ai": ["Data", "AI / ML"],
  "data & ai": ["Data", "AI / ML"],

  // AI / ML
  "ai/ml": ["AI / ML"],
  ai: ["AI / ML"],
  ml: ["AI / ML"],
  "machine learning": ["AI / ML"],
  "artificial intelligence": ["AI / ML"],
  "deep learning": ["AI / ML"],

  // HR / People
  "hr/people": ["HR / People"],
  hr: ["HR / People"],
  "people ops": ["HR / People"],
  "people operations": ["HR / People"],
  people: ["HR / People"],
  "human resources": ["HR / People"],
  recruiting: ["HR / People"],
  recruiter: ["HR / People"],
  talent: ["HR / People"],
  "talent acquisition": ["HR / People"],

  // Platform / DevOps
  "platform/devops": ["Platform / DevOps"],
  platform: ["Platform / DevOps"],
  devops: ["Platform / DevOps"],
  sre: ["Platform / DevOps"],
  "site reliability": ["Platform / DevOps"],
  infrastructure: ["Platform / DevOps"],

  // Customer Success
  "customer success": ["Customer Success"],
  "customer support": ["Customer Success"],
  "customer experience": ["Customer Success"],
  support: ["Customer Success"],

  // Operations
  operations: ["Operations"],
  ops: ["Operations"],
  "supply chain": ["Operations"],
  logistics: ["Operations"],

  // Legal
  legal: ["Legal"],
  counsel: ["Legal"],
  compliance: ["Legal"],

  // Facilities
  facilities: ["Facilities"],
  workplace: ["Facilities"],

  // Security
  security: ["Security"],
  infosec: ["Security"],
  cybersecurity: ["Security"],

  // Product
  product: ["Product"],

  // Design
  design: ["Design"],
  ux: ["Design"],
  ui: ["Design"],

  // Sales
  sales: ["Sales"],
  "account executive": ["Sales"],
  "business development": ["Sales"],

  // Finance
  finance: ["Finance"],
  accounting: ["Finance"],

  // Engineering
  engineering: ["Engineering"],
  software: ["Engineering"],
  developer: ["Engineering"],
  swe: ["Engineering"],
  backend: ["Engineering"],
  frontend: ["Engineering"],
  "full stack": ["Engineering"],
  fullstack: ["Engineering"],
};

// Substring fallback — a faithful port of classify.py's _DEPT_KEYWORDS, in the same
// priority order (specific depts before the "engineer" catch-all). Matched against a
// space-padded lowercased haystack so boundary tokens (" ai ", " ml ", " hr ", " ops",
// " pm ", " ux") match at the edges, exactly like the Python classifier. This makes
// unforeseen freeform input classify the same way the stored column was built.
const DEPT_KEYWORDS: ReadonlyArray<readonly [CanonicalDepartment, readonly string[]]> = [
  ["AI / ML", ["machine learning", "deep learning", "artificial intelligence", " ai ", "ai/ml", " ml ", "ml engineer", "mlops", "nlp", "llm", "research scientist", "applied scientist"]],
  ["Data", ["data engineer", "data scientist", "data analyst", "data science", "data architect", "analytics", "business intelligence", " bi "]],
  ["Security", ["security", "infosec", "cybersecurity", "appsec", "devsecops", "soc analyst"]],
  ["Design", ["designer", "design", " ux", "ux ", " ui", "ui ", "user experience", "user research"]],
  ["Product", ["product manager", "product owner", "product lead", "product management", "head of product", " pm "]],
  ["Finance", ["finance", "financial", "accounting", "accountant", "controller", "fp&a", "treasury", "bookkeep"]],
  ["Legal", ["legal", "counsel", "attorney", "lawyer", "paralegal", "compliance"]],
  ["HR / People", ["recruit", "talent acquisition", "human resources", " hr ", "people ops", "people operations", "people partner", "hrbp"]],
  ["Customer Success", ["customer success", "customer support", "customer experience", "account manager", " cx ", "support engineer", "client success"]],
  ["Marketing/Growth", ["marketing", "growth", "seo", "brand", "demand generation", "communications", "social media", "content "]],
  ["Sales", ["sales", "account executive", "business development", "revenue", " sdr", " bdr"]],
  ["Platform / DevOps", ["devops", "site reliability", " sre", "platform engineer", "infrastructure", "cloud engineer", "reliability engineer"]],
  ["Facilities", ["facilities", "mailroom", "real estate", "workplace", "janitorial", "custodial", "maintenance tech"]],
  ["Operations", ["operations", " ops", "logistics", "supply chain", "fulfillment", "warehouse", "procurement"]],
  ["Engineering", ["engineer", "developer", "swe", "software", "back end", "backend", "front end", "frontend", "full stack", "fullstack", "programmer", "architect", "sdet", "firmware", "embedded"]],
];

/**
 * Translate any user-facing department label/freeform into the canonical stored value(s).
 * Returns `[]` when there's no confident match — callers treat `[]` as "no department filter".
 */
export function toCanonicalDepartments(input?: string | null): CanonicalDepartment[] {
  if (!input) return [];
  const hit = DEPT_ALIASES[norm(input)];
  if (hit) return hit;
  const hay = ` ${input.trim().toLowerCase()} `;
  for (const [dept, kws] of DEPT_KEYWORDS) {
    if (kws.some((kw) => hay.includes(kw))) return [dept];
  }
  return [];
}

// ── Level aliases (normalized key → canonical value) ──────────────────────────
// Includes the LEGACY preference vocabularies that predate canonicalization, so old stored
// enriched.profiles.job_level values ("Lead", "People Manager", "Senior IC", "Manager/Lead")
// still read correctly while data is migrated to the canonical set.
const LEVEL_ALIASES: Record<string, CanonicalLevel> = {
  "entry/junior": "Entry/Junior",
  entry: "Entry/Junior",
  junior: "Entry/Junior",
  associate: "Entry/Junior",
  intern: "Entry/Junior",
  "new grad": "Entry/Junior",
  senior: "Senior",
  sr: "Senior",
  senior_ic: "Senior",
  "senior ic": "Senior",
  "principal/staff": "Principal / Staff",
  principal: "Principal / Staff",
  staff: "Principal / Staff",
  "lead/manager": "Lead/Manager",
  "manager/lead": "Lead/Manager",
  lead: "Lead/Manager",
  manager: "Lead/Manager",
  "people manager": "Lead/Manager",
  director: "Director",
  vp: "VP",
  "vice president": "VP",
  executive: "VP",
};

/**
 * Translate a user-facing level label or onboarding token (senior_ic/manager/either) — or a
 * legacy stored preference value — into the canonical job_level value. Returns `null` for
 * "any level" (e.g. "either").
 */
export function toCanonicalLevel(input?: string | null): CanonicalLevel | null {
  if (!input) return null;
  return LEVEL_ALIASES[norm(input)] ?? null;
}

// ── Display labels for the 6 canonical levels ─────────────────────────────────
export const LEVEL_LABELS: Record<CanonicalLevel, string> = {
  "Entry/Junior": "Entry / Junior",
  Senior: "Senior",
  "Principal / Staff": "Principal / Staff",
  "Lead/Manager": "Lead / Manager",
  Director: "Director",
  VP: "VP",
};

export function levelLabel(l: CanonicalLevel): string {
  return LEVEL_LABELS[l] ?? l;
}

// ── Title → canonical level ───────────────────────────────────────────────────
// TypeScript port of classify.py:classify_level (the Python classifier writes jobs.job_level;
// this mirrors it so client surfaces derive the SAME level from a raw title/headline). Keep in
// sync with classify.py. Highest match wins; checked top → bottom. Returns null for plain
// mid-level ICs ("Software Engineer") == "any level".
const _RX_VP = /\b(svp|evp|vp|vice\s+president|chief|ceo|cto|cfo|coo|cmo|cpo|cro|cio|cdo)\b/i;
const _RX_DIRECTOR = /\bdirector\b|\bhead\s+of\b/i;
const _RX_PRINCIPAL = /\b(principal|staff|distinguished|fellow)\b/i;
const _RX_MANAGER =
  /\b(manager|mgr|supervisor)\b|\b(team|tech|technical|engineering|eng|group|squad|project|delivery|program|product|design|data|qa|it|dev)\s+lead\b|^lead\s+(?!gen)/i;
const _RX_SENIOR = /\b(senior|sr\.?)\b/i;
const _RX_ENTRY =
  /\b(intern|internship|junior|jr\.?|associate|entry[- ]?level|new\s*grad|graduate|apprentice|trainee|co[- ]?op|early\s+career)\b/i;
const _RX_LEVEL_NUM = /\b(?:level|l|e)[-\s]?([3-9]|1[0-9])\b|\b(?:ic|sw|swe)[-\s]?([3-9])\b|(?<!\d)\b(\d)\s*$/i;

function _levelFromNum(m: RegExpMatchArray): CanonicalLevel {
  const n = parseInt(m.slice(1).find((g) => g != null) ?? "0", 10);
  if (n <= 3) return "Entry/Junior";
  if (n <= 5) return "Senior";
  return "Principal / Staff";
}

/**
 * Derive the canonical job_level from a raw job title or LinkedIn headline. Single source for
 * every client/enrichment surface that needs title→level (replaces the old per-file inferLevel/
 * deriveJobLevel copies). Returns null for untagged mid-level IC roles.
 */
export function levelFromTitle(title?: string | null): CanonicalLevel | null {
  const t = title ?? "";
  if (_RX_VP.test(t)) return "VP";
  if (_RX_DIRECTOR.test(t)) return "Director";
  if (_RX_PRINCIPAL.test(t)) return "Principal / Staff";
  if (_RX_MANAGER.test(t)) return "Lead/Manager";
  if (_RX_SENIOR.test(t)) return "Senior";
  if (_RX_ENTRY.test(t)) return "Entry/Junior";
  const m = t.match(_RX_LEVEL_NUM);
  if (m) return _levelFromNum(m);
  return null;
}

// ── Shared filter option lists (department + level) ───────────────────────────
// The single source for the /jobs + /me/job-matches filter bars and the /me profile editor.
// Values are the EXACT stored jobs.job_level / jobs.department strings (so server-side
// `eq()` matches); labels are display-only.
export type FilterOption = { label: string; value: string };

export const LEVEL_FILTER_OPTIONS: FilterOption[] = [
  { label: "All levels", value: "all" },
  ...LEVELS.map((l) => ({ label: levelLabel(l), value: l })),
];

export const DEPARTMENT_FILTER_OPTIONS: FilterOption[] = [
  { label: "All departments", value: "all" },
  ...DEPARTMENTS.map((d) => ({ label: departmentLabel(d), value: d })),
];

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

  // Operations — no "logistics" alias: it's a coined live bucket, and the Operations
  // keyword fallback already catches the freeform intent for Kai.
  operations: ["Operations"],
  ops: ["Operations"],
  "supply chain": ["Operations"],

  // Legal — no "compliance" alias: "Compliance" is a coined live bucket that must pass
  // through toStoredDepartments literally; the Legal keyword fallback covers Kai freeform.
  legal: ["Legal"],
  counsel: ["Legal"],

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

  // Sales — no "business development" alias: it's a coined live bucket; the Sales keyword
  // fallback covers Kai freeform.
  sales: ["Sales"],
  "account executive": ["Sales"],

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
  // " llm"/"llm " (not bare "llm"): "fulfi-llm-ent" used to classify warehouse roles as AI / ML.
  ["AI / ML", ["machine learning", "deep learning", "artificial intelligence", " ai ", "ai/ml", " ml ", "ml engineer", "mlops", "nlp", " llm", "llm ", "research scientist", "applied scientist"]],
  // "data engineer" is NOT here — it's Engineering (2026-06-18 taxonomy call); Data = analysts/scientists/BI.
  ["Data", ["data scientist", "data analyst", "data science", "data architect", "analytics", "business intelligence", " bi "]],
  ["Security", ["security", "infosec", "cybersecurity", "appsec", "devsecops", "soc analyst"]],
  // No bare "design" (it outranks the Engineering catch-all and hijacked chip/civil
  // engineering titles); design-dept roles must match a designer-shaped phrase.
  ["Design", ["designer", " ux", "ux ", " ui", "ui ", "user experience", "user research", "product design", "graphic design", "visual design", "design lead", "design manager", "head of design", "design director", "design system"]],
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
  ["Engineering", ["engineer", "developer", "swe", "software", "back end", "backend", "front end", "frontend", "full stack", "fullstack", "programmer", "architect", "sdet", "firmware", "embedded", "asic", "physical design", "design verification", "rtl design", "analog design", "ip design"]],
];

// Strong title role-phrases — TS mirror of classify.py `_STRONG_TITLE`. An unambiguous
// discipline named in a freeform title; LONGEST match wins. Used so Kai matches the way
// jobs.department was built (e.g. "account executive … growth" → Sales, not Marketing).
const STRONG_TITLE: ReadonlyArray<readonly [string, CanonicalDepartment]> = [
  ["data analyst", "Data"], ["data scientist", "Data"], ["data science", "Data"],
  ["data analytics", "Data"], ["business intelligence", "Data"], ["bi analyst", "Data"],
  ["quantitative analyst", "Data"],
  ["machine learning engineer", "AI / ML"], ["ml engineer", "AI / ML"],
  ["applied scientist", "AI / ML"], ["research scientist", "AI / ML"],
  ["ai engineer", "AI / ML"], ["nlp engineer", "AI / ML"],
  ["data engineer", "Engineering"], ["data engineering", "Engineering"],
  ["software engineer", "Engineering"], ["software developer", "Engineering"],
  ["software development engineer", "Engineering"], ["sdet", "Engineering"],
  ["engineering manager", "Engineering"], ["full stack engineer", "Engineering"],
  ["fullstack engineer", "Engineering"], ["backend engineer", "Engineering"],
  ["back end engineer", "Engineering"], ["frontend engineer", "Engineering"],
  ["front end engineer", "Engineering"], ["firmware engineer", "Engineering"],
  ["embedded engineer", "Engineering"], ["systems engineer", "Engineering"],
  ["qa engineer", "Engineering"], ["quality engineer", "Engineering"],
  ["hardware engineer", "Engineering"], ["marketing engineer", "Engineering"],
  ["site reliability engineer", "Platform / DevOps"], ["devops engineer", "Platform / DevOps"],
  ["platform engineer", "Platform / DevOps"], ["infrastructure engineer", "Platform / DevOps"],
  ["cloud engineer", "Platform / DevOps"], ["reliability engineer", "Platform / DevOps"],
  ["security engineer", "Security"], ["security analyst", "Security"],
  ["security architect", "Security"], ["security operations", "Security"],
  ["account executive", "Sales"], ["sales associate", "Sales"],
  ["sales representative", "Sales"], ["sales manager", "Sales"], ["sales director", "Sales"],
  ["sales engineer", "Sales"], ["sales development representative", "Sales"],
  ["business development representative", "Sales"],
  ["product designer", "Design"], ["ux designer", "Design"], ["ui designer", "Design"],
  ["graphic designer", "Design"], ["visual designer", "Design"], ["design manager", "Design"],
  ["design director", "Design"], ["ux researcher", "Design"], ["user experience designer", "Design"],
  ["product manager", "Product"], ["product owner", "Product"],
  ["technical product manager", "Product"], ["group product manager", "Product"],
  ["marketing manager", "Marketing/Growth"], ["brand manager", "Marketing/Growth"],
  ["growth manager", "Marketing/Growth"], ["content manager", "Marketing/Growth"],
  ["social media manager", "Marketing/Growth"], ["product marketing manager", "Marketing/Growth"],
  ["growth marketing", "Marketing/Growth"],
  ["financial analyst", "Finance"], ["accountant", "Finance"], ["controller", "Finance"],
  ["accounting manager", "Finance"], ["finance manager", "Finance"],
  ["attorney", "Legal"], ["paralegal", "Legal"], ["general counsel", "Legal"], ["legal counsel", "Legal"],
  ["recruiter", "HR / People"], ["talent acquisition", "HR / People"],
  ["hr business partner", "HR / People"], ["people partner", "HR / People"], ["technical recruiter", "HR / People"],
  ["customer success manager", "Customer Success"], ["account manager", "Customer Success"],
  ["customer success", "Customer Success"],
  ["operations manager", "Operations"], ["supply chain manager", "Operations"], ["logistics manager", "Operations"],
  ["facilities manager", "Facilities"],
];
const STRONG_SORTED = [...STRONG_TITLE].sort((a, b) => b[0].length - a[0].length);

function strongTitleDepartment(input: string): CanonicalDepartment | null {
  const hay = ` ${input.trim().toLowerCase()} `;
  for (const [phrase, bucket] of STRONG_SORTED) if (hay.includes(phrase)) return bucket;
  return null;
}

/**
 * Translate any user-facing department label/freeform into the canonical stored value(s).
 * Returns `[]` when there's no confident match — callers treat `[]` as "no department filter".
 *
 * FREEFORM ONLY (Kai chat/onboarding): curated alias → strong title role-phrase → generic
 * keyword fallback. The keyword fallback will hijack exact stored values that merely CONTAIN
 * a keyword ("Product Management" → Product), so dropdowns/prefs use toStoredDepartments.
 */
export function toCanonicalDepartments(input?: string | null): CanonicalDepartment[] {
  if (!input) return [];
  const hit = DEPT_ALIASES[norm(input)];
  if (hit) return hit;
  const strong = strongTitleDepartment(input);
  if (strong) return [strong];
  const hay = ` ${input.trim().toLowerCase()} `;
  for (const [dept, kws] of DEPT_KEYWORDS) {
    if (kws.some((kw) => hay.includes(kw))) return [dept];
  }
  return [];
}

const CANONICAL_BY_NORM: Record<string, CanonicalDepartment> = Object.fromEntries(
  DEPARTMENTS.map((d) => [norm(d), d]),
) as Record<string, CanonicalDepartment>;

/**
 * Strict variant for STORED values — filter dropdowns and saved prefs, whose inputs are
 * real jobs.department values (live department_facets) or explicit UX tokens ("Data / AI").
 * Canonical names/labels and the alias table resolve; everything else returns `[]` so the
 * caller filters on the literal value. No keyword fallback: a coined live bucket like
 * "Product Management" or "Compliance" must filter on itself, or facet counts disagree
 * with filtered results.
 */
export function toStoredDepartments(input?: string | null): CanonicalDepartment[] {
  if (!input) return [];
  const n = norm(input);
  const exact = CANONICAL_BY_NORM[n];
  if (exact) return [exact];
  return DEPT_ALIASES[n] ?? [];
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

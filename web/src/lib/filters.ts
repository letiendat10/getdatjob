// Single source of truth for every job-filter option list shown across the app:
//   • /jobs                 (jobs-client.tsx)        — filter bar
//   • /me/job-matches       (matches-panel.tsx)      — filter bar
//   • /me/profile           (me-client.tsx)          — preference editor
//   • /kai onboarding       (kai/page.tsx)           — intake → preference write
//
// Department + level live in ./taxonomy (they mirror the Python classifier and the
// jobs.department / jobs.job_level check constraints); this module owns visa, location,
// posted-date and salary, and re-exports the taxonomy filter lists so a surface can pull
// everything from one place. Import-pure (no server clients) — safe for client components.
//
// Two flavours per dimension where they legitimately differ:
//   *_FILTER_OPTIONS  — for the /jobs & /me/job-matches filter bars (values are what the
//                       shared server query in lib/query-jobs.ts understands; include "all").
//   *_PREF_OPTIONS    — for the /me/profile editor (values are what's STORED in
//                       enriched.profiles, e.g. visa_type "E-3/TN", posted_within_days "7").

import {
  DEPARTMENT_FILTER_OPTIONS,
  LEVEL_FILTER_OPTIONS,
  DEPARTMENTS,
  LEVELS,
  departmentLabel,
  levelLabel,
  type FilterOption,
} from "./taxonomy";

export { DEPARTMENT_FILTER_OPTIONS, LEVEL_FILTER_OPTIONS };
export type { FilterOption };

// Preference-editor variants (no "all" entry — the editor uses a "Select" placeholder, and an
// empty value means "any"). Values are the canonical jobs.job_level / jobs.department strings,
// which the profiles table now shares.
export const LEVEL_PREF_OPTIONS: FilterOption[] = LEVELS.map((l) => ({ label: levelLabel(l), value: l }));
export const DEPARTMENT_PREF_OPTIONS: FilterOption[] = DEPARTMENTS.map((d) => ({ label: departmentLabel(d), value: d }));

// ── Locations (one canonical list; all metros in "City, ST" or named-region format) ──
export const US_LOCATIONS = [
  "Remote",
  "San Francisco Bay Area",
  "New York City",
  "Seattle, WA",
  "Chicago, IL",
  "Los Angeles, CA",
  "Austin, TX",
  "Boston, MA",
  "Denver, CO",
  "Washington, DC",
  "Atlanta, GA",
  "Miami, FL",
  "Nashville, TN",
  "Portland, OR",
  "Salt Lake City, UT",
  "Phoenix, AZ",
  "San Diego, CA",
  "Northern Virginia",
  "Philadelphia, PA",
  "Pittsburgh, PA",
] as const;

export const LOCATION_FILTER_OPTIONS: FilterOption[] = [
  { label: "All locations", value: "all" },
  ...US_LOCATIONS.map((l) => ({ label: l, value: l })),
];

export const LOCATION_PREF_OPTIONS: FilterOption[] = [
  { label: "Any location", value: "" },
  ...US_LOCATIONS.map((l) => ({ label: l, value: l })),
];

// ── Visa ──────────────────────────────────────────────────────────────────────
// Filter bar: maps to lib/query-jobs.ts VISA_PATTERNS keys (H1B/E3/TN).
export const VISA_FILTER_OPTIONS: FilterOption[] = [
  { label: "All visas", value: "all" },
  { label: "H-1B", value: "H1B" },
  { label: "E-3", value: "E3" },
  { label: "TN", value: "TN" },
];

// Preference editor: values are the stored enriched.profiles.visa_type
// (constraint: 'H-1B' | 'OPT' | 'E-3/TN' | 'Other').
export const VISA_PREF_OPTIONS: FilterOption[] = [
  { label: "H-1B", value: "H-1B" },
  { label: "E-3 / TN", value: "E-3/TN" },
  { label: "OPT", value: "OPT" },
  { label: "O-1 / Other", value: "Other" },
];

// ── Posted date ────────────────────────────────────────────────────────────────
// Filter bar: keys of lib/query-jobs.ts POSTED_DAYS.
export const POSTED_FILTER_OPTIONS: FilterOption[] = [
  { label: "Any time", value: "all" },
  { label: "Past 24 hours", value: "1d" },
  { label: "Past 2 days", value: "2d" },
  { label: "Past 3 days", value: "3d" },
  { label: "Past week", value: "7d" },
  { label: "Past month", value: "30d" },
  { label: "Past 3 months", value: "90d" },
];

// Preference editor: stored as enriched.profiles.posted_within_days (integer days; "" = any).
export const POSTED_PREF_OPTIONS: FilterOption[] = [
  { label: "Any time", value: "" },
  { label: "Last 24h", value: "1" },
  { label: "Last 3 days", value: "3" },
  { label: "Last week", value: "7" },
  { label: "Last month", value: "30" },
];

// ── Salary / compensation (annual min floor; "keep unknown salaries visible") ──
export const SALARY_FILTER_OPTIONS: FilterOption[] = [
  { label: "Any compensation", value: "all" },
  { label: "$100K+", value: "100000" },
  { label: "$150K+", value: "150000" },
  { label: "$200K+", value: "200000" },
];

// Preference editor: stored as enriched.profiles.salary_floor (integer; "" = any).
export const SALARY_PREF_OPTIONS: FilterOption[] = [
  { label: "Any", value: "" },
  { label: "$100K+", value: "100000" },
  { label: "$150K+", value: "150000" },
  { label: "$200K+", value: "200000" },
];

// ── Non-canonical bar controls shared by /jobs and /me/job-matches ────────────
export const SIGNAL_OPTIONS: FilterOption[] = [
  { label: "All signals", value: "all" },
  { label: "Verified LCA Filings With Same Job Title", value: "verified" },
  { label: "H-1B Friendly Employer", value: "friendly" },
];

export const SORT_OPTIONS: FilterOption[] = [
  { label: "Most recent", value: "recent" },
  { label: "Most LCAs", value: "lcas" },
  { label: "Relevance", value: "relevance" },
];

export const VIEW_OPTIONS: FilterOption[] = [
  { label: "All jobs", value: "all" },
  { label: "Viewed", value: "viewed" },
  { label: "Favorite", value: "favorite" },
  { label: "New to you", value: "new" },
];

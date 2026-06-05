import { NextRequest } from "next/server";
import { handleSearchJobs, METRO_TOKENS } from "@/lib/kai-tools";

export const runtime = "nodejs";

type Body = {
  visa?: string;
  location?: string;        // single city — "Staying in <city>" local mode
  location_metro?: string;  // "bay_area" | "nyc" — metro local mode
  locationMode?: string;    // "local" | "remote" | "anywhere"
  salary_min?: number;
  intent?: string;
  department?: string;
  level?: string;
};

// How a search stage was widened relative to the user's exact ask (null = strict hit).
type Broadened =
  | { kind: "window"; days: number }     // same place, wider time window
  | { kind: "salary"; days: number }     // dropped the salary floor
  | { kind: "nationwide"; days: number } // dropped the location (last resort)
  | null;

// A stage's geography. Produces inputs for handleSearchJobs.
type Geo =
  | { mode: "remote" }
  | { mode: "tokens"; tokens: string[]; label: string }
  | { mode: "anywhere" };

// We fetch (never an exact COUNT) because counting jobs_kai_view without a LIMIT is slow
// enough to time out on broad result sets — which would wrongly read as "nothing matched".
// The RPC fetch is LIMIT-bounded; total_count is the deduped-by-company count it returns
// (capped at SHOW_LIMIT, surfaced as "N+" in the UI).
const SHOW_LIMIT = 24;

export async function POST(req: NextRequest) {
  try {
    const body: Body = await req.json();
    const { visa, location, location_metro, locationMode, salary_min, department, level } = body;

    const visa_category = visa && visa !== "Other" ? visa : undefined;
    const salaryMin = salary_min && salary_min > 0 ? salary_min : undefined;

    // Resolve the user's chosen geography into a base Geo + a human place label.
    let baseGeo: Geo;
    let placeLabel: string;
    if (locationMode === "remote") {
      baseGeo = { mode: "remote" };
      placeLabel = "remote";
    } else if (locationMode === "local" && location_metro && METRO_TOKENS[location_metro]) {
      const m = METRO_TOKENS[location_metro];
      baseGeo = { mode: "tokens", tokens: m.tokens, label: m.display };
      placeLabel = m.display;
    } else if (locationMode === "local" && location) {
      baseGeo = { mode: "tokens", tokens: [location.toLowerCase().trim()], label: location };
      placeLabel = location;
    } else {
      baseGeo = { mode: "anywhere" };
      placeLabel = "anywhere in the US";
    }

    const geoFetch = (geo: Geo) =>
      geo.mode === "remote" ? { location: "remote" } : geo.mode === "tokens" ? { location_tokens: geo.tokens } : {};

    const fetchWith = (geo: Geo, useSalary: boolean, days: number) =>
      handleSearchJobs({
        visa_category,
        salary_min: useSalary ? salaryMin : undefined,
        department,
        level,
        limit: SHOW_LIMIT,
        posted_within: `${days}d` as "3d" | "7d" | "14d" | "30d",
        ...geoFetch(geo),
      });

    // Broaden ladder — strict (highest relevance) first; visa + department are NEVER relaxed.
    //  1. base geo, salary kept, last 14 days (RPC ranks freshest first)
    //  2. base geo, salary kept, last 30 days
    //  3. base geo, drop salary floor, last 30 days (low leverage; ~78% of rows have no salary)
    //  4. nationwide (only when the user picked a place) — last resort before a true zero
    type Stage = { geo: Geo; useSalary: boolean; days: number; kind: "base" | "window" | "salary" | "nationwide" };
    const stages: Stage[] = [
      { geo: baseGeo, useSalary: true, days: 14, kind: "base" },
      { geo: baseGeo, useSalary: true, days: 30, kind: "window" },
    ];
    if (salaryMin) stages.push({ geo: baseGeo, useSalary: false, days: 30, kind: "salary" });
    if (baseGeo.mode === "tokens") stages.push({ geo: { mode: "anywhere" }, useSalary: true, days: 30, kind: "nationwide" });

    const reasonFor = (stage: Stage): Broadened => {
      if (stage.kind === "base") return null;
      if (stage.kind === "window") return { kind: "window", days: stage.days };
      if (stage.kind === "salary") return { kind: "salary", days: stage.days };
      return { kind: "nationwide", days: stage.days };
    };

    const sortRecent = <T extends { posted_at?: string | null }>(jobs: T[]) =>
      [...jobs].sort((a, b) => {
        const da = a.posted_at ? new Date(a.posted_at).getTime() : 0;
        const db = b.posted_at ? new Date(b.posted_at).getTime() : 0;
        return db - da;
      });

    let fetchedJobs: Awaited<ReturnType<typeof handleSearchJobs>>["jobs"] = [];
    let totalCount = 0;
    let windowDays = 0;
    let broadened: Broadened = null;

    // First stage with ANY results wins (strictest, most relevant). A thin hit (1–4) is
    // kept rather than discarded; we only widen when a stage is truly empty. No exact
    // count, so a slow/broad query can never time out into a false "nothing matched".
    for (const stage of stages) {
      const jobs = sortRecent((await fetchWith(stage.geo, stage.useSalary, stage.days)).jobs);
      if (jobs.length < 1) continue;
      fetchedJobs = jobs;
      totalCount = jobs.length;
      windowDays = stage.days;
      broadened = reasonFor(stage);
      break;
    }

    return Response.json({
      jobs: fetchedJobs,
      total_count: totalCount,   // deduped-by-company count from the fetch (≤ SHOW_LIMIT)
      capped: totalCount >= SHOW_LIMIT, // true → UI shows "N+"
      window_days: windowDays,   // 14 | 30 | 0
      broadened,                 // null on a strict hit; else how the search was widened
      place: placeLabel,
    });
  } catch {
    return Response.json(
      { error: "Failed to fetch jobs", jobs: [], total_count: 0, capped: false, window_days: 0, broadened: null, place: null },
      { status: 500 },
    );
  }
}

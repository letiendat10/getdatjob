// Server component — fetches default jobs at build/revalidate time so the
// initial HTML already contains job data. JobsClient receives it as initialData,
// skips its own first fetch, and shows content immediately without a loading screen.
// Filter changes still happen client-side (JobsClient takes over from there).

import { unstable_cache } from "next/cache";
import { queryJobs } from "@/lib/query-jobs";
import { JobsClient } from "./jobs-client";

const DEFAULT_PARAMS = {
  q: "", location: "all", company: "", posted: "7d",
  sort: "recent", page: 0, signal: "all", visa: "H1B",
  department: "all", level: "all",
};

const getDefaultJobs = unstable_cache(
  async () => {
    const result = await queryJobs(DEFAULT_PARAMS);
    // Guard: refuse to cache empty responses — Supabase transient failure should
    // not be stored. Next.js won't cache a thrown error, so next request retries.
    if (!result.jobs.length) throw new Error("[jobs] empty result — skipping cache");
    return result;
  },
  ["jobs-default-v1"],
  { revalidate: 1800 }
);

export default async function JobsPage() {
  const initialData = await getDefaultJobs().catch(() => undefined);
  return <JobsClient initialData={initialData} />;
}

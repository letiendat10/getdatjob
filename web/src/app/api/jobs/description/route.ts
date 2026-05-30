import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

const ALLOWED_WORKDAY = /^([a-z0-9-]+\.)+myworkdayjobs\.com$/i;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const source = sp.get("source") ?? "workday";
  const url = sp.get("url") ?? "";
  const jobId = sp.get("job_id") ?? "";

  if (source === "amazon") return handleAmazon(jobId);
  if (source === "ashby") return handleAshby(jobId, sp.get("slug") ?? "");
  if (source === "smartrecruiters") return handleSmartRecruiters(url);
  if (source === "db") return handleDb(sp.get("id") ?? "");
  if (url) return handleWorkday(url);
  return Response.json({ error: "missing params" }, { status: 400 });
}

// ── DB fallback (server-side, bypasses any browser RLS issues) ────────────────

async function handleDb(id: string) {
  if (!id || isNaN(Number(id))) return Response.json({ text: "" });
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { data } = await supabase
      .from("jobs")
      .select("description_text")
      .eq("id", Number(id))
      .single();
    const raw: string = data?.description_text ?? "";
    const isHtml = /<[a-z][^>]*>/i.test(raw);
    const payload = isHtml ? { html: raw.slice(0, 20000) } : { text: raw };
    return Response.json(
      payload,
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600" } }
    );
  } catch {
    return Response.json({ text: "" });
  }
}

// ── Ashby ────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleAshby(jobId: string, slug: string) {
  if (!UUID_RE.test(jobId) || !slug) return Response.json({ html: "", text: "" });
  try {
    const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        operationName: "ApiJobPosting",
        variables: { jobPostingId: jobId, organizationHostedJobsPageName: slug },
        query: `query ApiJobPosting($jobPostingId: String!, $organizationHostedJobsPageName: String!) {
          jobPosting(jobPostingId: $jobPostingId, organizationHostedJobsPageName: $organizationHostedJobsPageName) {
            descriptionHtml
          }
        }`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return Response.json({ html: "", text: "" });
    const data = await res.json();
    const posting = data?.data?.jobPosting;
    if (!posting) return Response.json({ html: "", text: "" });
    const html = (posting.descriptionHtml ?? "").slice(0, 20000);
    return Response.json(
      { html },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600" } }
    );
  } catch {
    return Response.json({ html: "", text: "" });
  }
}

// ── Amazon ───────────────────────────────────────────────────────────────────

async function handleAmazon(jobId: string) {
  if (!jobId) return Response.json({ html: "", text: "" });

  try {
    const res = await fetch(
      `https://www.amazon.jobs/en/search.json?job_id=${encodeURIComponent(jobId)}`,
      {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      }
    );
    if (!res.ok) return Response.json({ html: "", text: "" });

    const data = await res.json();
    const job = data?.jobs?.[0];
    if (!job) return Response.json({ html: "", text: "" });

    const desc: string = job.description ?? "";
    const basic: string = job.basic_qualifications ?? "";
    const preferred: string = job.preferred_qualifications ?? "";

    const html = [
      desc ? `<p>${desc.replace(/\n/g, "<br/>")}</p>` : "",
      basic ? `<h3>Basic Qualifications</h3>${basic}` : "",
      preferred ? `<h3>Preferred Qualifications</h3>${preferred}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return Response.json(
      { html },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600" } }
    );
  } catch {
    return Response.json({ html: "", text: "" });
  }
}

// ── SmartRecruiters ───────────────────────────────────────────────────────────

async function handleSmartRecruiters(jobUrl: string) {
  // URL format: https://jobs.smartrecruiters.com/{company}/{job-id}
  let company = "";
  let jobId = "";
  try {
    const parsed = new URL(jobUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    // parts = ["CompanySlug", "744000115709972"]
    if (parts.length < 2) return Response.json({ html: "", text: "" });
    company = parts[0];
    jobId = parts[1];
  } catch {
    return Response.json({ html: "", text: "" });
  }

  if (!company || !jobId) return Response.json({ html: "", text: "" });

  try {
    const res = await fetch(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(jobId)}`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return Response.json({ html: "", text: "" });
    const data = await res.json();
    const sections = data?.jobAd?.sections ?? {};
    const html = [
      sections.companyDescription?.text ?? "",
      sections.jobDescription?.text ?? "",
      sections.qualifications?.text ?? "",
      sections.additionalInformation?.text ?? "",
    ].filter(Boolean).join("").slice(0, 20000);
    return Response.json(
      { html },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600" } }
    );
  } catch {
    return Response.json({ html: "", text: "" });
  }
}

// ── Workday ──────────────────────────────────────────────────────────────────

async function handleWorkday(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Response.json({ error: "invalid url" }, { status: 400 });
  }

  if (!ALLOWED_WORKDAY.test(parsed.hostname)) {
    return Response.json({ error: "disallowed host" }, { status: 400 });
  }

  // Workday CXS API returns HTML description.
  // Use redirect:"manual" so we detect bot-blocking redirects (303→maintenance) instantly
  // rather than following them and burning the full timeout.
  let cxsBlocked = false;
  try {
    const tenant = parsed.hostname.split(".")[0];
    const apiUrl = `${parsed.origin}/wday/cxs/${tenant}${parsed.pathname}`;

    const res = await fetch(apiUrl, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const html: string = data?.jobPostingInfo?.jobDescription ?? "";
      if (html.length > 50) {
        return Response.json(
          { html: html.slice(0, 20000) },
          { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600" } }
        );
      }
    } else if (res.status >= 300 && res.status < 400) {
      // Bot-blocked redirect — skip HTML fallback too, it'll be blocked the same way
      cxsBlocked = true;
    }
  } catch {
    // fall through to JSON-LD fallback
  }

  // Fallback: JSON-LD plain text (skip if CXS was blocked — HTML page redirects too)
  if (!cxsBlocked) {
    try {
      const res = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const pageHtml = await res.text();
        const text = extractJsonLdDescription(pageHtml);
        return Response.json(
          { html: "", text },
          { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600" } }
        );
      }
    } catch {
      // ignore
    }
  }

  return Response.json({ html: "", text: "" });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function extractJsonLdDescription(html: string): string {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const desc: string = data?.description ?? "";
      if (desc.length > 50) return desc.slice(0, 8000);
    } catch {
      // skip malformed block
    }
  }
  return "";
}

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

const ALLOWED_WORKDAY = /^([a-z0-9-]+\.)+myworkdayjobs\.com$/i;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const source = sp.get("source") ?? "workday";
  const url = sp.get("url") ?? "";
  const jobId = sp.get("job_id") ?? "";

  if (source === "amazon") return handleAmazon(jobId);
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

  // Workday CXS API returns HTML description
  try {
    const tenant = parsed.hostname.split(".")[0];
    const apiUrl = `${parsed.origin}/wday/cxs/${tenant}${parsed.pathname}`;

    const res = await fetch(apiUrl, {
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(12000),
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
    }
  } catch {
    // fall through to JSON-LD fallback
  }

  // Fallback: JSON-LD plain text
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(12000),
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

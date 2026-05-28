// POST /api/import-linkedin
// Body: { linkedin_url: string }
// Pulls the user's LinkedIn data via Proxycurl and writes it into
// linkedin.profiles + public.user_work_history. Returns a small preview
// for the UI to render.

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { importLinkedInFromUrl } from "@/lib/enrich-scrapingdog";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  // Auth check — only the signed-in user can import their own profile.
  const supabase = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let body: { linkedin_url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const url = typeof body.linkedin_url === "string" ? body.linkedin_url : "";
  if (!url) {
    return NextResponse.json(
      { error: "linkedin_url is required" },
      { status: 400 }
    );
  }

  const result = await importLinkedInFromUrl(user.id, url);

  switch (result.status) {
    case "ok":
      return NextResponse.json({ ok: true, profile: result.profile });
    case "invalid_url":
      return NextResponse.json(
        {
          error:
            "That doesn't look like a LinkedIn profile URL. Use https://www.linkedin.com/in/your-handle",
        },
        { status: 400 }
      );
    case "not_found":
      return NextResponse.json(
        { error: "Couldn't find that LinkedIn profile. Double-check the URL." },
        { status: 404 }
      );
    case "rate_limited":
      return NextResponse.json(
        { error: "Too many requests — try again in a minute." },
        { status: 429 }
      );
    case "error":
      console.error("[import-linkedin]", result.message);
      return NextResponse.json(
        { error: "Something went wrong importing your LinkedIn." },
        { status: 502 }
      );
  }
}

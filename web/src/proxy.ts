import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

const AI_CRAWLER_PATTERNS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "anthropic-ai",
  "Claude-Web",
  "PerplexityBot",
  "Bytespider",
  "CCBot",
  "omgili",
  "omgilibot",
  "Diffbot",
  "ImagesiftBot",
  "YouBot",
  "Applebot-Extended",
  "GoogleOther",
  "Google-Extended",
  "cohere-ai",
  "Meta-ExternalAgent",
  "FacebookBot",
];

export async function proxy(request: NextRequest) {
  // 1. Supabase session refresh — must run before any early returns
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getUser() refreshes the session token and writes the updated cookie via setAll above.
  // Do NOT add any early return between createServerClient and this call.
  await supabase.auth.getUser();

  // 2. AI crawler blocking
  const ua = request.headers.get("user-agent") ?? "";
  const isAiCrawler = AI_CRAWLER_PATTERNS.some((pattern) =>
    ua.toLowerCase().includes(pattern.toLowerCase())
  );

  if (isAiCrawler) {
    return new NextResponse("Access denied", { status: 403 });
  }

  return response;
}

export const config = {
  matcher: "/(.*)",
};

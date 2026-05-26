import Anthropic from "@anthropic-ai/sdk";

export type EnrichedData = {
  linkedin_url: string | null;
  current_title: string | null;
  current_company: string | null;
  location: string | null;
  work_history: Record<string, string>[] | null;
  education: Record<string, string>[] | null;
  skills: string[] | null;
  raw_text: string | null;
};

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

async function findLinkedInUrl(fullName: string): Promise<string | null> {
  try {
    const q = encodeURIComponent(`"${fullName}" site:linkedin.com/in`);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();
    const match = html.match(
      /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_%\-]+/
    );
    return match?.[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchLinkedInProfile(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // LinkedIn returns a thin login-wall page (< 5 KB) when unauthenticated
    if (html.length < 5000) return null;
    return html;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

async function parseWithClaude(
  text: string,
  fullName: string
): Promise<Partial<EnrichedData>> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Extract the LinkedIn profile for "${fullName}" from this text. Return ONLY valid JSON matching this schema exactly:

{
  "current_title": "string or null",
  "current_company": "string or null",
  "location": "city, state or null",
  "work_history": [{"title":"string","company":"string","start":"string","end":"string or null"}],
  "education": [{"school":"string","degree":"string or null","field":"string or null"}],
  "skills": ["string"]
}

Text:
${text}`,
      },
    ],
  });

  const block = res.content[0];
  if (block.type !== "text") return {};
  try {
    const m = block.text.match(/\{[\s\S]+\}/);
    return m ? (JSON.parse(m[0]) as Partial<EnrichedData>) : {};
  } catch {
    return {};
  }
}

export async function enrichLinkedInProfile(
  fullName: string | null,
  knownUrl: string | null = null
): Promise<{
  status: "done" | "failed";
  data: Partial<EnrichedData>;
}> {
  if (!fullName) return { status: "failed", data: {} };

  // Use the exact URL from OAuth if we have it; fall back to search
  const linkedinUrl = knownUrl ?? (await findLinkedInUrl(fullName));
  if (!linkedinUrl) return { status: "failed", data: {} };

  const html = await fetchLinkedInProfile(linkedinUrl);
  if (!html) return { status: "failed", data: { linkedin_url: linkedinUrl } };

  const text = stripHtml(html);
  const parsed = await parseWithClaude(text, fullName);

  return {
    status: "done",
    data: {
      linkedin_url: linkedinUrl,
      raw_text: text.slice(0, 2000),
      ...parsed,
    },
  };
}

#!/usr/bin/env node
// Background enrichment daemon — runs on your Mac, processes new sign-ups automatically.
// Prerequisites: linkedin-login.js run once, env vars set, puppeteer installed.
// Start: node scripts/enrich-daemon.js
// Keep alive: pm2 start scripts/enrich-daemon.js --name enrich-daemon

require("dotenv").config({ path: require("path").join(__dirname, "../web/.env.local") });

const { createClient } = require("@supabase/supabase-js");
const puppeteer = require("puppeteer");
const Anthropic = require("@anthropic-ai/sdk").default;
const path = require("path");

// ── Clients ───────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CHROME_PROFILE =
  process.env.LINKEDIN_CHROME_PROFILE ||
  path.join(process.env.HOME, ".getdatjob", "chrome-profile");

// ── Extraction ────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
}

async function extractWithClaude(text) {
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `Extract from this LinkedIn profile page text. Return ONLY valid JSON, no other text.

{
  "location": "City, State — e.g. San Francisco, CA — or null if not found",
  "current_title": "exact current job title or null",
  "department": "one of exactly: Engineering | Product | Design | Data | Marketing | Sales | Finance | Operations | Other",
  "level": "IC or Manager"
}

Department rules:
- Engineering: Software Engineer, SWE, SDE, Developer, DevOps, Platform, Infrastructure, ML, Backend, Frontend, Full Stack
- Product: Product Manager, PM, APM, GPM, Head of Product
- Design: Designer, UX, UI, Creative Director, Brand
- Data: Data Scientist, Data Analyst, BI, Analytics, Research Scientist
- Marketing: Marketing, Growth, Brand, Content, SEO, Demand Gen
- Sales: Sales, Account Executive, AE, SDR, BDR, Business Development
- Finance: Finance, Accounting, FP&A, Controller, CFO
- Operations: Operations, COO, Chief of Staff, Program Manager, Strategy
- Other: anything else

Level rules:
- Manager: Engineering Manager, Director, VP, Head of [people team], Chief, President, Managing [anything]
- IC: everything else including Staff, Principal, Lead (technical), Architect, Senior

Text:
${text}`,
      },
    ],
  });

  try {
    const match = res.content[0].text.match(/\{[\s\S]+\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch {
    return {};
  }
}

// ── Puppeteer ─────────────────────────────────────────────────────────────────

function launchBrowser() {
  return puppeteer.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    userDataDir: CHROME_PROFILE,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

// Extract the unique photo segment from a LinkedIn CDN URL.
// e.g. "https://media.licdn.com/dms/image/v2/C5603AQE6yYA3T6bTkA/..." → "C5603AQE6yYA3T6bTkA"
function extractLinkedInPhotoId(url) {
  if (!url) return null;
  const match = url.match(/\/dms\/image\/v\d+\/\w+\/([A-Za-z0-9_-]+)\//);
  return match?.[1] ?? null;
}

// Resolve a profile URL by searching LinkedIn.
// Uses avatar photo ID to verify we found the right person for common names.
async function findLinkedInUrlByName(fullName, avatarUrl) {
  const knownPhotoId = extractLinkedInPhotoId(avatarUrl);
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(fullName)}&origin=GLOBAL_SEARCH_HEADER`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

    const finalUrl = page.url();
    if (finalUrl.includes("authwall") || finalUrl.includes("/login")) {
      throw new Error("LinkedIn session expired. Re-run: node scripts/linkedin-login.js");
    }

    // Try to match by photo ID first, then fall back to first result
    const profileUrl = await page.evaluate((knownId) => {
      const cards = Array.from(document.querySelectorAll('li'));
      for (const card of cards) {
        const link = card.querySelector('a[href*="/in/"]');
        if (!link) continue;
        const href = link.href.match(/(https:\/\/www\.linkedin\.com\/in\/[^/?#]+)/)?.[1];
        if (!href) continue;

        // If we have a known photo ID, check if this card's image matches
        if (knownId) {
          const img = card.querySelector('img');
          if (img?.src?.includes(knownId)) return href;
        } else {
          return href; // No photo to match — take first result
        }
      }
      // Photo match failed — fall back to first profile link
      const fallback = document.querySelector('a[href*="/in/"]');
      return fallback?.href?.match(/(https:\/\/www\.linkedin\.com\/in\/[^/?#]+)/)?.[1] ?? null;
    }, knownPhotoId);

    if (knownPhotoId && profileUrl) {
      console.log(`[enrich] photo-matched: ${knownPhotoId}`);
    }

    return profileUrl ?? null;
  } finally {
    await browser?.close();
  }
}

async function scrapeLinkedIn(linkedinUrl) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.goto(linkedinUrl, {
      waitUntil: "networkidle2",
      timeout: 25000,
    });

    // Detect login wall — session expired
    const finalUrl = page.url();
    if (finalUrl.includes("authwall") || finalUrl.includes("/login")) {
      throw new Error(
        "LinkedIn session expired. Re-run: node scripts/linkedin-login.js"
      );
    }

    const html = await page.content();
    return html;
  } finally {
    await browser?.close();
  }
}

// ── Core logic ────────────────────────────────────────────────────────────────

// Track in-flight user IDs so Realtime events don't double-process
const processing = new Set();

async function processUser(userId) {
  if (processing.has(userId)) return;
  processing.add(userId);

  try {
    // Get LinkedIn URL via security-definer RPC (bypasses schema exposure restriction)
    const { data: liRows, error: liErr } = await supabase.rpc(
      "enrich_get_linkedin_profile",
      { p_user_id: userId }
    );

    if (liErr) throw new Error(`enrich_get_linkedin_profile: ${liErr.message}`);

    const liProfile = liRows?.[0];

    let linkedinUrl = liProfile?.linkedin_url ?? null;

    // Fallback: LinkedIn OIDC no longer returns vanityName, so search by name
    if (!linkedinUrl && liProfile?.full_name) {
      console.log(`[enrich] ${userId} — no URL, searching LinkedIn for "${liProfile.full_name}"`);
      linkedinUrl = await findLinkedInUrlByName(liProfile.full_name, liProfile.avatar_url);
      if (linkedinUrl) {
        console.log(`[enrich] ${userId} — found via search: ${linkedinUrl}`);
        // Persist so future re-runs skip the search
        await supabase.rpc("enrich_save_linkedin_url", {
          p_user_id: userId,
          p_linkedin_url: linkedinUrl,
        });
      }
    }

    if (!linkedinUrl) {
      console.log(`[enrich] ${userId} — could not resolve LinkedIn URL, marking failed`);
      await supabase.rpc("enrich_set_failed", { p_user_id: userId });
      return;
    }

    console.log(`[enrich] ${userId} — scraping ${linkedinUrl}`);
    const html = await scrapeLinkedIn(linkedinUrl);
    const text = stripHtml(html);
    const extracted = await extractWithClaude(text);

    await supabase.rpc("enrich_set_result", {
      p_user_id:       userId,
      p_location:      extracted.location ?? null,
      p_current_title: extracted.current_title ?? null,
      p_job_function:  extracted.department ?? null,
      p_job_level:     extracted.level ?? null,
    });

    console.log(`[enrich] ${userId} — done:`, extracted);
  } catch (err) {
    console.error(`[enrich] ${userId} — error:`, err.message);
    await supabase.rpc("enrich_set_failed", { p_user_id: userId });
  } finally {
    processing.delete(userId);
  }
}

// ── Startup: drain any pending rows from while daemon was offline ──────────────

async function drainPending() {
  const { data, error } = await supabase.rpc("enrich_get_pending");

  if (error) {
    console.error("[enrich] Could not query pending rows:", error.message);
    return;
  }

  if (data?.length) {
    console.log(`[enrich] Found ${data.length} pending row(s) from before startup — processing...`);
    for (const row of data) {
      await processUser(row.user_id);
    }
  }
}

// ── Realtime: new sign-ups trigger immediately ────────────────────────────────

supabase
  .channel("enrichment-watch")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "enriched", table: "profiles" },
    (payload) => {
      if (payload.new?.enrich_status === "pending") {
        processUser(payload.new.user_id);
      }
    }
  )
  .subscribe((status) => {
    if (status === "SUBSCRIBED") {
      console.log("[enrich] Realtime subscribed — watching for new sign-ups");
    }
  });

// ── Boot ──────────────────────────────────────────────────────────────────────

drainPending().then(() => {
  console.log("[enrich] Daemon ready.");
});

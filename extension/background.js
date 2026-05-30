// getdatjob LinkedIn Enrichment — background service worker
// Polls linkedin_import_queue every 30s, opens LinkedIn profile in a
// background tab, extracts headline/location/experience from the DOM,
// and POSTs the result to /api/import-linkedin/from-dom.

const SUPABASE_URL   = "https://tdgptapfspleoobiyiqx.supabase.co";
const SUPABASE_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkZ3B0YXBmc3BsZW9vYml5aXF4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODc0MjAxNCwiZXhwIjoyMDk0MzE4MDE0fQ.SrC20Kgg5Xga1SuLD2komW7LZ2Cu3vbXS5SEofsLp70";
const API_URL        = "https://getdatjob.vercel.app/api/import-linkedin/from-dom";
const API_SECRET     = "linkedin-dom-import-v1";   // must match LINKEDIN_DOM_SECRET env var

const HEADERS = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

// ── Log helper ──────────────────────────────────────────────────────────────

const MAX_LOG = 200;
async function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  const { lines = [] } = await chrome.storage.local.get("lines");
  lines.push(line);
  if (lines.length > MAX_LOG) lines.splice(0, lines.length - MAX_LOG);
  await chrome.storage.local.set({ lines });
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function getNextJob() {
  const url = `${SUPABASE_URL}/rest/v1/linkedin_import_queue?status=eq.pending&order=created_at.asc&limit=1`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function setJobStatus(id, status, errorMsg = null) {
  const body = { status, processed_at: new Date().toISOString() };
  if (errorMsg) body.error_msg = errorMsg;
  await fetch(
    `${SUPABASE_URL}/rest/v1/linkedin_import_queue?id=eq.${id}`,
    { method: "PATCH", headers: HEADERS, body: JSON.stringify(body) }
  );
}

// ── LinkedIn DOM extraction (runs inside the LinkedIn tab) ───────────────────

function extractProfile() {
  // Helpers
  const text = (el) => el?.innerText?.trim() || null;
  const first = (selectors) => {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return text(el);
    }
    return null;
  };

  // ── Name ──
  const fullName = first(["h1.text-heading-xlarge", "h1"]);

  // ── Headline ──
  // LinkedIn puts the headline right below the name in a .text-body-medium span
  let headline = null;
  const h1 = document.querySelector("h1");
  if (h1) {
    // Walk siblings / parent to find .text-body-medium
    const section = h1.closest("section") || h1.parentElement?.parentElement;
    headline = text(section?.querySelector(".text-body-medium.break-words"))
            || text(section?.querySelector(".text-body-medium"));
  }
  // Broad fallback
  if (!headline) {
    headline = text(document.querySelector(".text-body-medium.break-words"))
            || text(document.querySelector(".pv-text-details__left-panel .text-body-medium"));
  }

  // ── Location ──
  let location = null;
  if (h1) {
    const section = h1.closest("section") || h1.parentElement?.parentElement;
    const candidates = section?.querySelectorAll(".text-body-small") ?? [];
    for (const el of candidates) {
      let t = text(el);
      if (!t) continue;
      // Strip " · ..." suffix — e.g. "San Francisco Bay Area · Contact info" → "San Francisco Bay Area"
      t = t.split("·")[0].trim();
      if (!t) continue;
      // Skip follower/connection counts
      if (/follower|connection|contact/i.test(t)) continue;
      // Skip pronouns (He/Him, She/Her, They/Them)
      if (/\b(he|she|they|him|her|them)\b.*\//i.test(t)) continue;
      // Skip single-word values — these are almost always company names (e.g. "Caffeine"),
      // not locations. Real locations are multi-word ("San Francisco Bay Area") or "Remote".
      if (!t.includes(' ') && !/^remote$/i.test(t)) continue;
      // Skip institution names — universities/schools appear in the same DOM slot for students.
      if (/university|college|school|institute|academy|polytechnic/i.test(t)) continue;
      location = t;
      break;
    }
  }

  // ── Experience ──
  const experiences = [];
  try {
    // Find the experience section by its heading text
    const allDivs = document.querySelectorAll("div[id]");
    let expContainer = null;
    for (const d of allDivs) {
      if (d.id === "experience") { expContainer = d; break; }
    }

    // Navigate to the list items
    const listItems = expContainer
      ? expContainer.closest("section")?.querySelectorAll("li.artdeco-list__item") ?? []
      : document.querySelectorAll("#experience ~ div li.artdeco-list__item");

    for (const item of listItems) {
      // Each item has aria-hidden spans: [title, company·type, dateRange, location?]
      const spans = [...item.querySelectorAll("span[aria-hidden='true']")]
        .map(s => s.innerText?.trim()).filter(Boolean);

      if (spans.length < 2) continue;

      const title       = spans[0];
      const companyLine = spans[1]; // "Caffeine · Full-time"
      const company     = companyLine.split("·")[0].trim();
      const dateLine    = spans.find(s => /\d{4}|Present/i.test(s)) ?? "";
      const isCurrent   = /Present/i.test(dateLine);

      // Parse dates: "Jan 2021 – Present" or "2021 – 2023"
      const [rawStart, rawEnd] = dateLine.split(/[–—-]/).map(s => s?.trim());
      const parseDate = (s) => {
        if (!s || /Present/i.test(s)) return null;
        const m = s.match(/([A-Za-z]+)\s+(\d{4})/);
        if (m) {
          const months = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
                          jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
          const mon = months[m[1].slice(0,3).toLowerCase()] ?? "01";
          return `${m[2]}-${mon}-01`;
        }
        const yr = s.match(/(\d{4})/);
        return yr ? `${yr[1]}-01-01` : null;
      };

      if (title && company) {
        experiences.push({
          title,
          company,
          start_date: parseDate(rawStart),
          end_date:   isCurrent ? null : parseDate(rawEnd),
          is_current: isCurrent,
        });
      }
    }
  } catch (e) {
    console.warn("[extract] experience parse error:", e);
  }

  return { fullName, headline, location, experiences };
}

// ── Process one job ──────────────────────────────────────────────────────────

async function processJob(job) {
  const { id, user_id, linkedin_url } = job;
  await log(`Processing job ${id.slice(0,8)} — ${linkedin_url}`);
  await setJobStatus(id, "processing");

  let tabId = null;
  try {
    // Open LinkedIn profile in a background tab
    const tab = await chrome.tabs.create({ url: linkedin_url, active: false });
    tabId = tab.id;

    // Wait for the tab to fully load — best-effort.
    // Background tabs can be throttled by Chrome; after 15s we proceed anyway
    // rather than hard-failing. The extra render wait below gives more time
    // for the React DOM to hydrate even if the load event was late.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      // Proceed after 8s regardless — LinkedIn DOM is ready well before full page load
      const giveUp = setTimeout(finish, 8_000);

      // Check immediately — tab may already be complete (race condition guard)
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError) return;
        if (t.status === "complete") { clearTimeout(giveUp); finish(); }
      });

      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          clearTimeout(giveUp);
          chrome.tabs.onUpdated.removeListener(listener);
          finish();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // Extra wait for JS / React rendering
    await new Promise(r => setTimeout(r, 2000));

    // Extract data from the page
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractProfile,
    });

    const data = results?.[0]?.result;
    if (!data) throw new Error("extractProfile returned null");

    // If the page didn't load properly, all fields will be null/empty.
    // Treat this as a retryable failure rather than writing empty data.
    const hasContent = data.fullName || data.headline || data.location || data.experiences.length > 0;
    if (!hasContent) throw new Error("page loaded but all fields empty — possible challenge/redirect page");

    await log(`Extracted: headline="${data.headline}" location="${data.location}" exp=${data.experiences.length}`);

    // Send to API
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "x-import-secret": API_SECRET,
      },
      body: JSON.stringify({ userId: user_id, linkedinUrl: linkedin_url, data }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
    }

    const result = await res.json();
    await log(`Done: ${JSON.stringify(result)}`);
    await setJobStatus(id, "done");

  } catch (err) {
    await log(`ERROR: ${err.message}`);
    await setJobStatus(id, "failed", err.message);
  } finally {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ── Reset stuck jobs ─────────────────────────────────────────────────────────
// If the service worker was killed mid-job, jobs can be stuck at "processing".
// On startup, reset them back to "pending" so they get retried.

async function resetStuckJobs() {
  try {
    // Reset "processing" (service worker killed mid-job) and "failed" (retryable errors)
    for (const status of ["processing", "failed"]) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/linkedin_import_queue?status=eq.${status}`,
        { method: "PATCH", headers: HEADERS, body: JSON.stringify({ status: "pending", error_msg: null }) }
      );
      if (!res.ok) {
        const text = await res.text();
        await log(`resetStuck(${status}): ${res.status} ${text.slice(0, 80)}`);
      }
    }
    await log("resetStuck: processing+failed → pending");
  } catch (e) {
    await log(`resetStuck error: ${e.message}`);
  }
}

// ── Supabase Realtime — instant queue notification ───────────────────────────
// Subscribe to INSERT events on linkedin_import_queue so we react the moment
// the server writes a row — no waiting for the 1-minute alarm.

let _realtimeWs  = null;
let _heartbeatId = null;

function startRealtime() {
  // Already open or connecting — skip
  if (_realtimeWs && _realtimeWs.readyState < 2) return;

  const wsUrl =
    `wss://${SUPABASE_URL.replace("https://", "")}/realtime/v1/websocket` +
    `?apikey=${SUPABASE_KEY}&vsn=1.0.0`;

  _realtimeWs = new WebSocket(wsUrl);

  _realtimeWs.addEventListener("open", () => {
    log("Realtime: connected");
    // Subscribe to all INSERTs on the queue table
    _realtimeWs.send(JSON.stringify({
      topic:   "realtime:queue-watcher",
      event:   "phx_join",
      payload: {
        config: {
          postgres_changes: [{
            event:  "INSERT",
            schema: "public",
            table:  "linkedin_import_queue",
          }],
        },
      },
      ref: "1",
    }));

    // Keep the connection (and service worker) alive with a heartbeat
    clearInterval(_heartbeatId);
    _heartbeatId = setInterval(() => {
      if (_realtimeWs?.readyState === 1) {
        _realtimeWs.send(JSON.stringify({
          topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb",
        }));
      }
    }, 25_000);
  });

  _realtimeWs.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.event === "postgres_changes") {
      log("Realtime: new queue entry detected — processing immediately");
      pollQueue();
    }
  });

  _realtimeWs.addEventListener("close", () => {
    log("Realtime: disconnected — will reconnect in 5 s");
    clearInterval(_heartbeatId);
    _realtimeWs = null;
    setTimeout(startRealtime, 5_000);
  });

  _realtimeWs.addEventListener("error", () => {
    // "close" fires right after "error", triggering the reconnect above
  });
}

// ── Poll loop ────────────────────────────────────────────────────────────────

async function pollQueue() {
  try {
    const job = await getNextJob();
    if (job) {
      await chrome.storage.local.set({ lastPoll: new Date().toISOString(), queueEmpty: false });
      await processJob(job);
    } else {
      await chrome.storage.local.set({ lastPoll: new Date().toISOString(), queueEmpty: true });
    }
  } catch (err) {
    await log(`Poll error: ${err.message}`);
  }
}

// Run on alarm (Chrome minimum is 1 minute)
// Also reconnect Realtime in case the service worker was terminated
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll-queue") {
    startRealtime();
    pollQueue();
  }
});

// Set up alarm on install / startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.clear("poll-queue", () => {
    chrome.alarms.create("poll-queue", { periodInMinutes: 1 });
  });
  log("Extension installed — polling every 1 min");
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.clear("poll-queue", () => {
    chrome.alarms.create("poll-queue", { periodInMinutes: 1 });
  });
});

// "Run now" button in popup / content script triggers an immediate poll
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "pollNow") {
    pollQueue().then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async response
  }
});

// On startup: reset stuck jobs, poll immediately, and subscribe to Realtime
resetStuckJobs().then(() => pollQueue());
startRealtime();

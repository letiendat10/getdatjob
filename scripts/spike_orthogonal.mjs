// Throwaway spike to evaluate Orthogonal vs current SerpAPI on 5 personal-Gmail profiles.
// See /Users/dat/.claude/plans/you-are-the-principal-snoopy-treasure.md for context.
// Run: node scripts/spike_orthogonal.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(path.join(__dirname, "..", "web", ".env.local"));
loadEnv(path.join(__dirname, "..", ".env.local"));

const ORTH_KEY = process.env.ORTHOGONAL_API_KEY || "orth_live_de8OsNjjRnEGYnxuqFTssoPxWLzENMGc";
const SERP_KEY = process.env.SERP_API_KEY;
if (!SERP_KEY) console.warn("WARN: SERP_API_KEY missing — SerpAPI column will be blank.");

const COHORT = [
  {
    name: "Alanna Gregory",
    email: "alanna.gregory@gmail.com",
    country: "US",
    expect: {
      slug: "alannagregory",
      titleKeywords: ["marketing", "growth"],
      cityKeywords: ["new york"],
    },
  },
  {
    name: "Bruno Calabretta",
    email: "brunocalabretta88@gmail.com",
    country: "ID",
    expect: {
      slug: "bruno-calabretta",
      titleKeywords: ["engineer", "forward deployed", "ai"],
      cityKeywords: ["bali", "indonesia"],
    },
  },
  {
    name: "Patrick Degenhardt",
    email: "pat.degen@gmail.com",
    country: "CH",
    expect: {
      slug: "patdegenhardt",
      titleKeywords: ["marketing"],
      cityKeywords: ["zurich", "zürich", "switzerland", "schweiz"],
    },
  },
  {
    name: "Sigal Bareket",
    email: "sigalbareket@gmail.com",
    country: "US",
    expect: {
      slug: "sigalbareket",
      titleKeywords: ["marketing", "growth", "operator"],
      cityKeywords: ["atlanta"],
    },
  },
  {
    name: "Joshua Mack",
    email: "josh.m.mack@gmail.com",
    country: "US",
    expect: {
      slug: "joshuammack",
      titleKeywords: ["marketing", "crm", "lifecycle", "thumbtack"],
      cityKeywords: ["palm springs", "california"],
    },
  },
];

function normalizeSlug(url) {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/in\/([a-zA-Z0-9._%-]+)\/?/i);
  return m ? m[1].toLowerCase() : null;
}

function gradeRow(found, expect) {
  const slug = normalizeSlug(found.url);
  const urlMatch = slug && slug === expect.slug.toLowerCase();
  const titleLower = (found.title || "").toLowerCase();
  const titleMatch = expect.titleKeywords.some((k) => titleLower.includes(k.toLowerCase()));
  const locLower = (found.location || "").toLowerCase();
  const locMatch = expect.cityKeywords.some((k) => locLower.includes(k.toLowerCase()));
  return { urlMatch, titleMatch, locMatch };
}

async function orth(api, p, payload) {
  const t0 = Date.now();
  const res = await fetch("https://api.orthogonal.com/v1/run", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ORTH_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ api, path: p, ...payload }),
  });
  const ms = Date.now() - t0;
  const json = await res.json().catch(() => ({}));
  return { ms, json };
}

// --- Strategy A: ContactOut /v1/people/enrich (name + email) — single call
async function strategyA(person) {
  const { ms, json } = await orth("contactout", "/v1/people/enrich", {
    body: { full_name: person.name, email: person.email },
  });
  const p = json?.data?.profile || {};
  const cents = json?.priceCents ?? null;
  return {
    ms,
    cents,
    url: p.url || null,
    title: p.headline || null,
    company: p.company?.name || null,
    location: p.location || null,
    success: !!json?.success && !!p.url,
    raw: json,
  };
}

// --- Strategy B: Tomba (email → URL) → ContactOut /v1/linkedin/enrich (URL → profile)
async function strategyB(person) {
  const tomba = await orth("tomba", "/v1/enrich", {
    query: { email: person.email },
  });
  const tombaCents = tomba.json?.priceCents ?? null;
  const url = tomba.json?.data?.data?.linkedin || null;
  if (!url) {
    return {
      ms: tomba.ms,
      cents: tombaCents,
      url: null,
      title: null,
      company: null,
      location: null,
      success: false,
      raw: { tomba: tomba.json },
    };
  }
  const co = await orth("contactout", "/v1/linkedin/enrich", {
    query: { profile: url, profile_only: "true" },
  });
  const coCents = co.json?.priceCents ?? null;
  const p = co.json?.data?.profile || {};
  return {
    ms: tomba.ms + co.ms,
    cents: (tombaCents || 0) + (coCents || 0),
    url: p.url || url,
    title: p.headline || null,
    company: p.company?.name || null,
    location: p.location || null,
    success: !!co.json?.success && !!p.headline,
    raw: { tomba: tomba.json, contactout: co.json },
  };
}

// --- Strategy D: SerpAPI (cheap URL discovery) → ContactOut /v1/linkedin/enrich (URL → profile)
async function strategyD(person) {
  const c = await strategyC(person);
  if (!c.url) return { ms: c.ms, cents: c.cents, url: null, title: null, company: null, location: null, success: false, raw: { serpapi: c.raw } };
  const co = await orth("contactout", "/v1/linkedin/enrich", {
    query: { profile: c.url, profile_only: "true" },
  });
  const coCents = co.json?.priceCents ?? null;
  const p = co.json?.data?.profile || {};
  return {
    ms: c.ms + co.ms,
    cents: (c.cents || 0) + (coCents || 0),
    url: p.url || c.url,
    title: p.headline || null,
    company: p.company?.name || null,
    location: p.location || null,
    success: !!co.json?.success && !!p.headline,
    raw: { serpapi: c.raw, contactout: co.json },
  };
}

// --- Strategy C: Current SerpAPI flow (mirrors web/src/lib/enrich-apollo.ts:trySerpAPI)
async function strategyC(person) {
  if (!SERP_KEY) return { ms: 0, cents: null, url: null, title: null, location: null, success: false };
  const q = ["linkedin", person.name, person.email, person.country].filter(Boolean).join(" ");
  const t0 = Date.now();
  const res = await fetch(
    `https://serpapi.com/search?engine=google&q=${encodeURIComponent(q)}&api_key=${SERP_KEY}`,
  );
  const ms = Date.now() - t0;
  const json = await res.json().catch(() => ({}));
  const results = (json.organic_results || []).filter(
    (r) =>
      /linkedin\.com\/in\//i.test(r.link || "") &&
      !/linkedin\.com\/(pub|dir)\//i.test(r.link || ""),
  );
  const localPart = (person.email.split("@")[0] || "").replace(/\./g, "").toLowerCase();
  const scored = results.map((r) => {
    const slug = normalizeSlug(r.link);
    let score = 0;
    if (slug) {
      const slugNorm = slug.replace(/-/g, "");
      if (slugNorm === localPart) score = 3;
      else if (slugNorm.includes(localPart)) score = 2;
      else if (slugNorm.replace(/\d+/g, "") === localPart) score = 1;
    }
    return { ...r, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);
  const top = scored[0];
  let title = null;
  if (top?.title) {
    const m = top.title.match(/- (.+?) \| LinkedIn/i);
    title = m ? m[1] : null;
  }
  return {
    ms,
    cents: 0.5, // SerpAPI ~$0.005/call ≈ 0.5¢
    url: top?.link || null,
    title,
    company: null,
    location: null, // SerpAPI doesn't give location
    success: !!top?.link,
    raw: { top, count: scored.length },
  };
}

function fmtCents(c) {
  if (c == null) return "—";
  return `${(c / 100).toFixed(2)}$`;
}

function check(b) {
  return b ? "✓" : "✗";
}

const ROWS = [];

console.log("\n  Spike: Orthogonal vs SerpAPI — n=5 personal-Gmail cohort\n");

for (const person of COHORT) {
  console.log(`\n--- ${person.name} (${person.email}) ---`);
  const [a, b, c, d] = await Promise.all([strategyA(person), strategyB(person), strategyC(person), strategyD(person)]);

  for (const [label, r] of [
    ["A: ContactOut people/enrich", a],
    ["B: Tomba → ContactOut linkedin/enrich", b],
    ["C: SerpAPI (current)", c],
    ["D: SerpAPI → ContactOut linkedin/enrich", d],
  ]) {
    const g = gradeRow(r, person.expect);
    const ok3 = [g.urlMatch, g.titleMatch, g.locMatch];
    console.log(
      `  ${label.padEnd(40)} ${r.ms}ms ${fmtCents(r.cents).padStart(7)}  url:${check(g.urlMatch)} title:${check(g.titleMatch)} loc:${check(g.locMatch)}`,
    );
    console.log(
      `    → url=${r.url || "—"} | title=${(r.title || "—").slice(0, 80)} | loc=${r.location || "—"}`,
    );
    ROWS.push({
      person: person.name,
      strategy: label,
      ms: r.ms,
      cents: r.cents,
      url: r.url || "",
      title: r.title || "",
      company: r.company || "",
      location: r.location || "",
      urlMatch: g.urlMatch,
      titleMatch: g.titleMatch,
      locMatch: g.locMatch,
      success: r.success,
    });
  }
}

// --- Summary
console.log("\n\n=========== Summary ===========\n");
const byStrategy = {};
for (const r of ROWS) {
  byStrategy[r.strategy] ||= { n: 0, urlOk: 0, titleOk: 0, locOk: 0, ms: [], cents: 0 };
  const s = byStrategy[r.strategy];
  s.n++;
  if (r.urlMatch) s.urlOk++;
  if (r.titleMatch) s.titleOk++;
  if (r.locMatch) s.locOk++;
  s.ms.push(r.ms);
  s.cents += r.cents || 0;
}

function p(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

console.log("Strategy".padEnd(42), "URL".padStart(6), "Title".padStart(6), "Loc".padStart(6), "p50ms".padStart(7), "p95ms".padStart(7), "total¢".padStart(8));
for (const [label, s] of Object.entries(byStrategy)) {
  console.log(
    label.padEnd(42),
    `${s.urlOk}/${s.n}`.padStart(6),
    `${s.titleOk}/${s.n}`.padStart(6),
    `${s.locOk}/${s.n}`.padStart(6),
    String(p(s.ms, 0.5)).padStart(7),
    String(p(s.ms, 0.95)).padStart(7),
    fmtCents(s.cents).padStart(8),
  );
}

// --- CSV
const outCsv = path.join(__dirname, "spike_orthogonal_results.csv");
const headers = ["person", "strategy", "ms", "cents", "url", "title", "company", "location", "urlMatch", "titleMatch", "locMatch", "success"];
const csv = [
  headers.join(","),
  ...ROWS.map((r) =>
    headers
      .map((h) => {
        const v = r[h];
        if (typeof v === "string" && (v.includes(",") || v.includes('"'))) {
          return `"${v.replace(/"/g, '""')}"`;
        }
        return v == null ? "" : String(v);
      })
      .join(","),
  ),
].join("\n");
fs.writeFileSync(outCsv, csv);
console.log(`\nCSV written: ${outCsv}\n`);

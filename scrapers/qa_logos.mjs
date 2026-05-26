#!/usr/bin/env node
/**
 * Biweekly logo QA — run with: node scrapers/qa_logos.mjs
 *
 * Catches two failure modes:
 *   1. companyDomain() produces the wrong domain for a known company.
 *   2. A logo.dev URL returns an error or monogram fallback instead of a real logo.
 *
 * Add a row to KNOWN_COMPANIES whenever a new override is added to DOMAIN_OVERRIDES
 * in web/src/app/jobs/page.tsx, or when a new high-profile employer is onboarded.
 */

import * as fs from "fs";

// ── Mirror of the logic in page.tsx ─────────────────────────────────────────

const DOMAIN_OVERRIDES = {
  block: "block.xyz", // Block, Inc. (formerly Square) — block.com is unrelated
};

function normalizeCompanyName(name) {
  const cleaned = name
    .replace(
      /,?\s+(incorporated|inc\.?|l\.?l\.?c\.?|corporation|corp\.?|limited|ltd\.?|co\.|l\.p\.?|\blp\b|pbc|p\.c\.|pllc)\.?\s*$/i,
      ""
    )
    .trim();
  const letters = cleaned.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    return cleaned
      .split(/\s+/)
      .map((w) =>
        /^[A-Z]{1,4}$/.test(w)
          ? w
          : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      )
      .join(" ");
  }
  return cleaned;
}

function companyDomain(name) {
  const stem = normalizeCompanyName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return DOMAIN_OVERRIDES[stem] ?? stem + ".com";
}

// ── Known-correct assertions ─────────────────────────────────────────────────
// Format: [storedEmployerName, expectedDomain]
// When you add an entry to DOMAIN_OVERRIDES in page.tsx, add a row here too.

const KNOWN_COMPANIES = [
  // Overrides (non-.com companies — the bug class we're guarding against)
  ["Block, Inc.", "block.xyz"],
  ["Block", "block.xyz"],

  // Standard .com companies (regression guard — ensure we didn't break the default path)
  ["Okta, Inc.", "okta.com"],
  ["DoorDash, Inc.", "doordash.com"],
  ["Waymo LLC", "waymo.com"],
  ["Reddit, Inc.", "reddit.com"],
  ["Zscaler, Inc.", "zscaler.com"],
  ["CoreWeave, Inc.", "coreweave.com"],
  ["Anthropic PBC", "anthropic.com"],
  ["OpenAI, LLC", "openai.com"],
];

// ── Logo.dev HTTP probe ───────────────────────────────────────────────────────
// Checks that the image URL resolves and does NOT return a monogram (text fallback).
// logo.dev returns Content-Type: image/png for real logos and image/svg+xml for
// monograms — we treat svg as "no real logo found".

async function probeLogo(domain) {
  const token = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN;
  if (!token) return { ok: true, skipped: true };

  // fallback=404 makes logo.dev return 404 when it has no real logo for the domain,
  // so a 200 here means a genuine logo exists (not a generated monogram).
  const url = `https://img.logo.dev/${domain}?token=${token}&size=64&format=png&fallback=404`;
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Load env ──────────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const raw = fs.readFileSync(
      new URL("../web/.env.local", import.meta.url),
      "utf8"
    );
    for (const line of raw.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] ||= m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* env not present — probe step will be skipped */
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  loadEnv();
  const hasToken = !!process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN;

  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log("\n=== Logo QA — companyDomain() assertions ===\n");

  for (const [name, expectedDomain] of KNOWN_COMPANIES) {
    const got = companyDomain(name);
    if (got === expectedDomain) {
      console.log(`  ✓  "${name}"  →  ${got}`);
      passed++;
    } else {
      console.log(`  ✗  "${name}"  →  got ${got}, expected ${expectedDomain}`);
      failed++;
      failures.push(`Domain mismatch: "${name}" → ${got} (expected ${expectedDomain})`);
    }
  }

  if (hasToken) {
    console.log("\n=== Logo.dev HTTP probe ===\n");
    const seen = new Set();
    for (const [name, domain] of KNOWN_COMPANIES) {
      if (seen.has(domain)) continue;
      seen.add(domain);
      const result = await probeLogo(domain);
      if (result.skipped) continue;
      if (result.ok) {
        console.log(`  ✓  ${domain}`);
        passed++;
      } else {
        const detail = result.error ?? `HTTP ${result.status}`;
        console.log(`  ✗  ${domain}  (${detail})`);
        failed++;
        failures.push(`Logo probe failed for ${domain}: ${detail}`);
      }
    }
  } else {
    console.log(
      "\n[skip] Logo.dev HTTP probe — set NEXT_PUBLIC_LOGO_DEV_TOKEN to enable\n"
    );
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);

  if (failures.length) {
    console.log("\nFailed checks:");
    failures.forEach((f) => console.log(`  • ${f}`));
    console.log(
      "\nTo fix: add an entry to DOMAIN_OVERRIDES in web/src/app/jobs/page.tsx,\n" +
        "then add a KNOWN_COMPANIES row here.\n"
    );
    process.exit(1);
  } else {
    console.log("\nAll checks passed.\n");
  }
}

run();

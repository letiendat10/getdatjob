"use client";

/**
 * JobChips — canonical chip rows for all job cards across the app.
 *
 * This is the single source of truth for chip styles and layout.
 * Update here; all pages get the change automatically.
 *
 * Row 1: salary + sponsorship badges (H-1B, E-3, TN)
 * Row 2: LCA date + LCA count
 * Row 3: PoC (shown only when present)
 *
 * Field naming notes:
 *   /kai uses visa_tier + lca_last_filed
 *   /jobs + /me matches use confidence_tier + last_filing_date
 *   Both naming conventions are accepted via optional props.
 */

import { getTnCategory } from "@/lib/tn-eligible";

// ── helpers ───────────────────────────────────────────────────────────────────

function formatLcaDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const parts = dateStr.split("-");
  if (parts.length < 2) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[month]} ${year}`;
}

function formatPoc(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const first = firstName ? firstName.split(/[\s/,]+/)[0].trim() : null;
  const lastInitial = lastName ? lastName.trim()[0].toUpperCase() : null;
  if (first && lastInitial) return `${first} ${lastInitial} (${email})`;
  if (first) return `${first} (${email})`;
  return email;
}

// ── shared className constants ────────────────────────────────────────────────

const ZINC_PILL = "px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium";
const ROW = "flex flex-wrap gap-1.5 mb-1.5";

// ── component ─────────────────────────────────────────────────────────────────

export type JobChipsProps = {
  // salary
  salary_range?: string | null;
  // sponsorship tier — accepts either field name
  visa_tier?: string | null;        // /kai: "verified" | "friendly"
  confidence_tier?: string | null;  // /jobs + /me matches: same values
  // E-3 & TN
  e3_lca_count?: number | null;
  title?: string | null;            // used for client-side TN inference
  // LCA stats — accepts either field name
  lca_last_filed?: string | null;   // /kai
  last_filing_date?: string | null; // /jobs + /me matches
  lca_count_2025?: number | null;
  // PoC
  poc_first_name?: string | null;
  poc_last_name?: string | null;
  poc_email?: string | null;
};

export function JobChips({
  salary_range,
  visa_tier,
  confidence_tier,
  e3_lca_count,
  title,
  lca_last_filed,
  last_filing_date,
  lca_count_2025,
  poc_first_name,
  poc_last_name,
  poc_email,
}: JobChipsProps) {
  const tier = visa_tier ?? confidence_tier ?? null;
  const isVerified = tier === "verified";
  const isFriendly = tier === "friendly";
  const isE3 = !!(e3_lca_count && e3_lca_count > 0);
  const tnCategory = title ? getTnCategory(title) : null;
  const lcaDate = formatLcaDate(lca_last_filed ?? last_filing_date);
  const poc = formatPoc(poc_first_name, poc_last_name, poc_email);
  const hasRow1 = salary_range || isVerified || isFriendly || isE3 || tnCategory;
  const hasRow2 = lcaDate || (lca_count_2025 && lca_count_2025 > 0);

  if (!hasRow1 && !hasRow2 && !poc) return null;

  return (
    <>
      {/* Row 1: salary + sponsorship badges */}
      {hasRow1 && (
        <div className={ROW}>
          {salary_range && (
            <span className={ZINC_PILL}>Salary: {salary_range}</span>
          )}
          {isVerified && (
            <span
              className="inline-flex rounded-full p-[2px]"
              style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}
            >
              <span className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900">
                Verified LCA Filings With Similar Job Title
              </span>
            </span>
          )}
          {isFriendly && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-green-50 text-[var(--ink-2)] text-xs font-medium border border-green-200">
              H-1B Friendly Employer
            </span>
          )}
          {isE3 && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-medium border border-amber-200">
              E-3 Friendly
            </span>
          )}
          {tnCategory && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-medium border border-blue-200">
              TN Friendly
            </span>
          )}
        </div>
      )}

      {/* Row 2: LCA date + count */}
      {hasRow2 && (
        <div className={ROW}>
          {lcaDate && (
            <span className={ZINC_PILL}>Last LCA filed in {lcaDate}</span>
          )}
          {lca_count_2025 && lca_count_2025 > 0 ? (
            <span className={ZINC_PILL}>{lca_count_2025} LCA filings in 2025</span>
          ) : null}
        </div>
      )}

      {/* Row 3: PoC */}
      {poc && (
        <div className={ROW}>
          <span className={ZINC_PILL}>PoC: {poc}</span>
        </div>
      )}
    </>
  );
}

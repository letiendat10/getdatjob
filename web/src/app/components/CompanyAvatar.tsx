"use client";

/**
 * CompanyAvatar — canonical company logo/initials component for all job cards.
 *
 * Single source of truth for:
 *   - Domain overrides (Block, Cisco, Citi)
 *   - Logo overrides (SoFi CloudFront SVG)
 *   - Embedded TLD detection ("Amazon.com Services" → "amazon.com")
 *   - logo.dev integration
 *   - Fallback initials
 */

import { useState } from "react";

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN ?? "";

const DOMAIN_OVERRIDES: Record<string, string> = {
  block: "block.xyz",
  ciscosystems: "cisco.com",
  citibankna: "citi.com",
};

/** Direct logo URL overrides for companies where logo.dev returns a wrong/missing logo. */
const SOFI_LOGO = "https://d32ijn7u0aqfv4.cloudfront.net/git/svgs/sofi-logo.svg";
const LOGO_OVERRIDES: Record<string, string> = {
  "sofi.com": SOFI_LOGO,
};
/** Same logo overrides, keyed by cleaned name stem — fires even when no domain is
 *  passed and the name (e.g. "Social Finance, LLC") wouldn't infer the brand domain. */
const NAME_LOGO_OVERRIDES: Record<string, string> = {
  sofi: SOFI_LOGO,
  socialfinance: SOFI_LOGO,
};

function nameStem(name: string): string {
  return name
    .replace(/,?\s+(incorporated|inc\.?|l\.?l\.?c\.?|corporation|corp\.?|limited|ltd\.?|co\.|pbc|n\.a\.?|\bopco\b)\.?\s*$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function companyDomain(name: string): string {
  // If the company name has an embedded TLD (e.g. "Amazon.com Services", "Cars.com"), use it directly.
  const embedded = name.match(/\b([a-zA-Z0-9-]+\.(com|org|net|io|co))\b/i);
  if (embedded) return embedded[1].toLowerCase();
  const stem = nameStem(name);
  return DOMAIN_OVERRIDES[stem] ?? stem + ".com";
}

export function CompanyAvatar({
  name,
  domain,
  size = "md",
}: {
  name: string;
  domain?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const [imgError, setImgError] = useState(false);

  const sizeClass =
    size === "lg" ? "w-14 h-14 rounded-xl"
    : size === "md" ? "w-10 h-10 rounded-lg"
    : "w-8 h-8 rounded";
  const textClass = size === "lg" ? "text-base" : "text-xs";
  const px = size === "lg" ? 128 : 64;

  const resolvedDomain = domain || companyDomain(name);
  const logoOverride = LOGO_OVERRIDES[resolvedDomain] ?? NAME_LOGO_OVERRIDES[nameStem(name)];
  const src = logoOverride ?? (LOGO_DEV_TOKEN
    ? `https://img.logo.dev/${resolvedDomain}?token=${LOGO_DEV_TOKEN}&size=${px}&format=png&fallback=monogram`
    : null);

  if (src && !imgError) {
    return (
      <div className={`${sizeClass} flex-shrink-0 border border-zinc-100 bg-white overflow-hidden flex items-center justify-center`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={name}
          onError={() => setImgError(true)}
          className="w-full h-full object-contain p-0.5"
        />
      </div>
    );
  }

  return (
    <div className={`${sizeClass} flex-shrink-0 bg-zinc-100 border border-zinc-100 flex items-center justify-center font-bold ${textClass} text-zinc-500 uppercase`}>
      {name.slice(0, 2)}
    </div>
  );
}

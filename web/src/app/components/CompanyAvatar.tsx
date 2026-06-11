"use client";

/**
 * CompanyAvatar — the SINGLE source of truth for company logos on every surface
 * (/jobs, /kai, /me, hero). Builds the logo.dev URL from the employer's
 * `company_domain_url` (passed as `domain`); falls back to initials when there is
 * no domain.
 *
 * Domain correctness lives in `employers.company_domain_url` (the DB), NOT here.
 * Do NOT add per-company domain/logo override maps to this file or any caller —
 * fix the domain at the source instead.
 */

import { useState } from "react";

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN ?? "";

/** logo.dev URL for a brand domain, or null when we have no domain / token. */
export function logoUrl(domain?: string | null, px = 64): string | null {
  const d = domain?.trim().toLowerCase();
  if (!d || !LOGO_DEV_TOKEN) return null;
  return `https://img.logo.dev/${d}?token=${LOGO_DEV_TOKEN}&size=${px}&format=png&fallback=monogram`;
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

  const src = logoUrl(domain, px);

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

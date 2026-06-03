"use client";

// Daily HITL review UI. Each card shows the public-card fields plus the internal
// title_clean (the LCA-match key behind the H-1B verified tag — never shown on the
// real card). Editing dept/level/title_clean and saving propagates corpus-wide and
// removes every card with the same raw title from the queue.

import { useState } from "react";

const DEPARTMENTS = [
  "AI / ML", "Data", "Security", "Design", "Product", "Finance", "Legal",
  "HR / People", "Customer Success", "Marketing/Growth", "Sales",
  "Platform / DevOps", "Facilities", "Operations", "Engineering",
];
const LEVELS = ["Entry/Junior", "Senior", "Lead/Manager", "Director", "VP"];

export type ReviewCard = {
  id: number;
  title: string;
  company: string;
  location: string | null;
  url: string;
  effective_posted_at: string | null;
  department: string | null;
  job_level: string | null;
  title_clean: string | null;
  salary_range: string | null;
  company_domain: string | null;
  e3_lca_count: number | null;
  lca_count: number | null;
  lca_count_2025: number | null;
  confidence_tier: string | null;
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (d < 1) return "today";
  if (d < 2) return "1d ago";
  return `${Math.floor(d)}d ago`;
}

export function ReviewClient({ initial, loadError }: { initial: ReviewCard[]; loadError: string | null }) {
  const [cards, setCards] = useState<ReviewCard[]>(initial);
  const [err, setErr] = useState<string | null>(loadError);
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState(0);

  async function save(card: ReviewCard, dept: string | null, level: string | null, clean: string | null) {
    const changed = dept !== card.department || level !== card.job_level || clean !== card.title_clean;
    setBusy(card.id);
    setErr(null);
    try {
      const res = await fetch("/api/admin/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title_norm: card.title,
          decision: changed ? "corrected" : "approved",
          department: dept,
          job_level: level,
          title_clean: clean,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`);
      const norm = card.title.toLowerCase();
      setCards((cs) => cs.filter((c) => c.title.toLowerCase() !== norm));
      setDone((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-zinc-900">Daily card review</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Verified jobs posted in the last 24h, one per title, highest-LCA sponsors first.
        Approving or correcting a title applies to every job that shares it.
        <span className="ml-1 text-zinc-400">({done} reviewed this session)</span>
      </p>

      {err && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>
      )}

      {cards.length === 0 ? (
        <div className="mt-10 rounded-xl border border-zinc-200 bg-white p-8 text-center text-zinc-500">
          Nothing to review right now — no unreviewed verified jobs in the last 24h. Check back tomorrow.
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {cards.map((card) => (
            <ReviewItem key={card.id} card={card} busy={busy === card.id} onSave={save} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewItem({
  card, busy, onSave,
}: {
  card: ReviewCard;
  busy: boolean;
  onSave: (c: ReviewCard, dept: string | null, level: string | null, clean: string | null) => void;
}) {
  const [dept, setDept] = useState<string>(card.department ?? "");
  const [level, setLevel] = useState<string>(card.job_level ?? "");
  const [clean, setClean] = useState<string>(card.title_clean ?? "");

  const norm = (s: string) => (s === "" ? null : s);

  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-zinc-900">{card.title}</h2>
            {card.confidence_tier === "verified" && (
              <span
                className="inline-flex shrink-0 rounded-full p-[2px]"
                style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}
              >
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-zinc-900">Verified</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            {card.company} · {card.location ?? "—"} · posted {timeAgo(card.effective_posted_at)} ·{" "}
            {card.lca_count ?? 0} LCAs{card.salary_range ? ` · ${card.salary_range}` : ""}
          </div>
        </div>
        <a
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold !text-white hover:bg-zinc-800"
        >
          Open ↗
        </a>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs text-zinc-500">
          Department
          <select
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900"
          >
            <option value="">— none —</option>
            {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="text-xs text-zinc-500">
          Level
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900"
          >
            <option value="">— none —</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="text-xs text-zinc-500">
          title_clean <span className="text-zinc-400">(internal — LCA match)</span>
          <input
            value={clean}
            onChange={(e) => setClean(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900"
          />
        </label>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          disabled={busy}
          onClick={() => onSave(card, card.department, card.job_level, card.title_clean)}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Approve as-is
        </button>
        <button
          disabled={busy}
          onClick={() => onSave(card, norm(dept), norm(level), norm(clean))}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save correction"}
        </button>
      </div>
    </li>
  );
}

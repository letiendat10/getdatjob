"use client";

import { useMemo, useState } from "react";

export type SocRow = {
  title_clean: string;
  soc_code: string;
  soc_name: string | null;
  mapped_by: "rule" | "llm" | "human";
  sample_raw: string | null;
  examples: string | null;
  example_jobs: { title: string; url: string }[] | null;
  n_jobs: number;
  n_verify: number;
  updated_at: string;
};

type Filter = "all" | "llm" | "rule" | "human";

const SOC_RE = /^\d{2}-\d{4}(\.\d{2})?$/;

export function SocClient({ initial, loadError }: { initial: SocRow[]; loadError: string | null }) {
  const [rows, setRows] = useState<SocRow[]>(initial);
  const [edits, setEdits] = useState<Record<string, { code: string; name: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (filter === "all" || r.mapped_by === filter) &&
        (!needle ||
          r.title_clean.toLowerCase().includes(needle) ||
          (r.sample_raw ?? "").toLowerCase().includes(needle) ||
          r.soc_code.includes(needle) ||
          (r.soc_name ?? "").toLowerCase().includes(needle) ||
          (r.examples ?? "").toLowerCase().includes(needle)),
    );
  }, [rows, filter, q]);

  async function save(r: SocRow) {
    const e = edits[r.title_clean] ?? { code: r.soc_code, name: r.soc_name ?? "" };
    const code = e.code.trim();
    const name = e.name.trim();
    if (!SOC_RE.test(code)) {
      setMsg(`"${code}" isn't a valid SOC code (e.g. 15-1252.00)`);
      return;
    }
    if (code === r.soc_code && name === (r.soc_name ?? "")) return;
    setSaving(r.title_clean);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/soc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title_clean: r.title_clean,
          soc_code: code,
          soc_name: name || null,
          sample_raw: r.sample_raw,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "save failed");
      setRows((prev) =>
        prev.map((x) =>
          x.title_clean === r.title_clean
            ? { ...x, soc_code: code, soc_name: name || null, mapped_by: "human" }
            : x,
        ),
      );
      setMsg(`Saved "${r.sample_raw ?? r.title_clean}" → ${code} · re-stamped ${data.restamped} jobs`);
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    } finally {
      setSaving(null);
    }
  }

  const badge = (m: SocRow["mapped_by"]) => ({
    rule: { background: "#eef2ff", color: "#3730a3" },
    llm: { background: "#fef3c7", color: "#92400e" },
    human: { background: "#dcfce7", color: "#166534" },
  })[m];

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Title → SOC occupation</h1>
      <p style={{ color: "#52525b", fontSize: 13, marginBottom: 16 }}>
        Job title → DOL SOC occupation. Edits become <code>human</code> (never overwritten by the daily
        batch) and re-stamp <code>job_signals.soc_code</code> corpus-wide, upgrading friendly → verified
        where the employer sponsored that occupation. {rows.length} distinct titles.
      </p>

      {loadError && <p style={{ color: "#b91c1c" }}>Load error: {loadError}</p>}
      {msg && (
        <p style={{ fontSize: 13, padding: "8px 12px", background: "#f4f4f5", borderRadius: 8, marginBottom: 12 }}>{msg}</p>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        {(["all", "llm", "rule", "human"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: "4px 10px", borderRadius: 999, fontSize: 12, cursor: "pointer",
              border: "1px solid #e4e4e7", background: filter === f ? "#18181b" : "#fff",
              color: filter === f ? "#fff" : "#3f3f46",
            }}
          >
            {f}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search title / SOC…"
          style={{ marginLeft: "auto", padding: "5px 10px", border: "1px solid #e4e4e7", borderRadius: 8, fontSize: 13, width: 240 }}
        />
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#71717a", borderBottom: "1px solid #e4e4e7" }}>
            <th style={{ padding: "8px 6px" }}>Title (sample)</th>
            <th style={{ padding: "8px 6px" }}>Verifies</th>
            <th style={{ padding: "8px 6px" }}>Jobs</th>
            <th style={{ padding: "8px 6px" }}>By</th>
            <th style={{ padding: "8px 6px" }}>SOC code</th>
            <th style={{ padding: "8px 6px" }}>Occupation</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const e = edits[r.title_clean] ?? { code: r.soc_code, name: r.soc_name ?? "" };
            const dirty = (e.code.trim() !== r.soc_code || e.name.trim() !== (r.soc_name ?? "")) && SOC_RE.test(e.code.trim());
            const setE = (patch: Partial<{ code: string; name: string }>) =>
              setEdits((p) => ({ ...p, [r.title_clean]: { ...e, ...patch } }));
            return (
              <tr key={r.title_clean} style={{ borderBottom: "1px solid #f4f4f5" }}>
                <td style={{ padding: "8px 6px", maxWidth: 420 }}>
                  {r.example_jobs && r.example_jobs.length > 0 ? (
                    r.example_jobs.map((ex, i) => (
                      <div key={i}>
                        <a
                          href={ex.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#2563eb", textDecoration: "underline" }}
                        >
                          {ex.title}
                        </a>
                      </div>
                    ))
                  ) : (
                    <div>{r.sample_raw ?? "—"}</div>
                  )}
                  <div style={{ color: "#a1a1aa", fontSize: 11 }}>clean: {r.title_clean}</div>
                </td>
                <td style={{ padding: "8px 6px", fontWeight: 700, color: r.n_verify > 0 ? "#166534" : "#a1a1aa" }}>
                  {r.n_verify.toLocaleString()}
                </td>
                <td style={{ padding: "8px 6px", color: "#52525b" }}>{r.n_jobs.toLocaleString()}</td>
                <td style={{ padding: "8px 6px" }}>
                  <span style={{ ...badge(r.mapped_by), padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                    {r.mapped_by}
                  </span>
                </td>
                <td style={{ padding: "8px 6px" }}>
                  <input
                    value={e.code}
                    onChange={(ev) => setE({ code: ev.target.value })}
                    placeholder="15-1252.00"
                    style={{ padding: "5px 8px", border: "1px solid #e4e4e7", borderRadius: 6, fontSize: 13, width: 110, fontFamily: "ui-monospace, monospace" }}
                  />
                </td>
                <td style={{ padding: "8px 6px" }}>
                  <input
                    value={e.name}
                    onChange={(ev) => setE({ name: ev.target.value })}
                    placeholder="Software Developers"
                    style={{ padding: "5px 8px", border: "1px solid #e4e4e7", borderRadius: 6, fontSize: 13, width: 200 }}
                  />
                </td>
                <td style={{ padding: "8px 6px" }}>
                  <button
                    disabled={!dirty || saving === r.title_clean}
                    onClick={() => save(r)}
                    style={{
                      padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                      border: "none", cursor: dirty ? "pointer" : "default",
                      background: dirty ? "#2563eb" : "#e4e4e7", color: dirty ? "#fff" : "#a1a1aa",
                    }}
                  >
                    {saving === r.title_clean ? "Saving…" : "Save"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {visible.length === 0 && <p style={{ color: "#a1a1aa", padding: 24, textAlign: "center" }}>No rows.</p>}
    </div>
  );
}

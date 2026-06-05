"use client";

import { useMemo, useState } from "react";

export type DeptRow = {
  source_norm: string;
  unified_department: string;
  mapped_by: "rule" | "llm" | "human";
  sample_raw: string | null;
  n_jobs: number;
  updated_at: string;
};

type Filter = "all" | "llm" | "rule" | "human";

export function DepartmentsClient({ initial, loadError }: { initial: DeptRow[]; loadError: string | null }) {
  const [rows, setRows] = useState<DeptRow[]>(initial);
  const [edits, setEdits] = useState<Record<string, string>>({});
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
          r.source_norm.includes(needle) ||
          (r.sample_raw ?? "").toLowerCase().includes(needle) ||
          r.unified_department.toLowerCase().includes(needle)),
    );
  }, [rows, filter, q]);

  async function save(r: DeptRow) {
    const next = (edits[r.source_norm] ?? r.unified_department).trim();
    if (!next || next === r.unified_department) return;
    setSaving(r.source_norm);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_norm: r.source_norm, unified_department: next, sample_raw: r.sample_raw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "save failed");
      setRows((prev) =>
        prev.map((x) =>
          x.source_norm === r.source_norm ? { ...x, unified_department: next, mapped_by: "human" } : x,
        ),
      );
      setMsg(`Saved "${r.sample_raw ?? r.source_norm}" → ${next} · re-stamped ${data.restamped} jobs`);
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(null);
    }
  }

  const badge = (m: DeptRow["mapped_by"]) => ({
    rule: { background: "#eef2ff", color: "#3730a3" },
    llm: { background: "#fef3c7", color: "#92400e" },
    human: { background: "#dcfce7", color: "#166534" },
  })[m];

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Department mapping</h1>
      <p style={{ color: "#52525b", fontSize: 13, marginBottom: 16 }}>
        Raw ATS department → unified department. Edits become <code>human</code> (never overwritten by the
        daily batch) and re-stamp jobs corpus-wide. {rows.length} distinct values.
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
          placeholder="search raw / unified…"
          style={{ marginLeft: "auto", padding: "5px 10px", border: "1px solid #e4e4e7", borderRadius: 8, fontSize: 13, width: 240 }}
        />
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#71717a", borderBottom: "1px solid #e4e4e7" }}>
            <th style={{ padding: "8px 6px" }}>Raw (sample)</th>
            <th style={{ padding: "8px 6px" }}>Jobs</th>
            <th style={{ padding: "8px 6px" }}>By</th>
            <th style={{ padding: "8px 6px" }}>Unified department</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const val = edits[r.source_norm] ?? r.unified_department;
            const dirty = val.trim() !== r.unified_department && val.trim() !== "";
            return (
              <tr key={r.source_norm} style={{ borderBottom: "1px solid #f4f4f5" }}>
                <td style={{ padding: "8px 6px" }}>
                  <div>{r.sample_raw ?? "—"}</div>
                  <div style={{ color: "#a1a1aa", fontSize: 11 }}>{r.source_norm}</div>
                </td>
                <td style={{ padding: "8px 6px", color: "#52525b" }}>{r.n_jobs.toLocaleString()}</td>
                <td style={{ padding: "8px 6px" }}>
                  <span style={{ ...badge(r.mapped_by), padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                    {r.mapped_by}
                  </span>
                </td>
                <td style={{ padding: "8px 6px" }}>
                  <input
                    value={val}
                    onChange={(e) => setEdits((p) => ({ ...p, [r.source_norm]: e.target.value }))}
                    style={{ padding: "5px 8px", border: "1px solid #e4e4e7", borderRadius: 6, fontSize: 13, width: 200 }}
                  />
                </td>
                <td style={{ padding: "8px 6px" }}>
                  <button
                    disabled={!dirty || saving === r.source_norm}
                    onClick={() => save(r)}
                    style={{
                      padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                      border: "none", cursor: dirty ? "pointer" : "default",
                      background: dirty ? "#2563eb" : "#e4e4e7", color: dirty ? "#fff" : "#a1a1aa",
                    }}
                  >
                    {saving === r.source_norm ? "Saving…" : "Save"}
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

"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, tdStyle, labelStyle, inputStyle, secondaryBtnStyle, EmptyState, SortTh } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

const MASTERS = ["Categories", "Storage Locations", "Units", "Roles"];
const FORMATS = ["CSV", "Excel", "PDF"];

type Job = { id: string; type: string; master: string; by: string; rows: number; when: string; result: string };

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export default function ImportExportPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [importTarget, setImportTarget] = useState("Categories");
  const [hasFile, setHasFile] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [exportSel, setExportSel] = useState(["Categories", "Units"]);
  const [format, setFormat] = useState("Excel");
  const [exported, setExported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Job[]>("/api/import-jobs")
      .then((data) => {
        if (!cancelled) setJobs(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { sorted: sortedJobs, sortKey, dir, toggleSort } = useSort<Job, keyof Job>(jobs);

  async function commitImport() {
    if (!hasFile) return;
    setCommitted(true);
    const job = await api.post<Job>("/api/import-jobs", { type: "Import", master: importTarget, by: "Asha Sharma", rows: 128, result: "6 skipped" });
    setJobs((prev) => [job, ...prev]);
  }

  async function runExport() {
    setExported(true);
    const job = await api.post<Job>("/api/import-jobs", { type: "Export", master: exportSel.join(", "), by: "Asha Sharma", rows: 0, result: "Success" });
    setJobs((prev) => [job, ...prev]);
  }

  return (
    <PageShell section="Data Operations" page="Import / Export">
      <div style={{ marginBottom: 22 }}>
        <PageIntro
          title="Import / Export"
          description="Bulk-load masters from Excel or CSV, or export a clean snapshot. Every import is validated for duplicates and dependencies before it commits."
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 22 }}>
        <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: 20, boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45", marginBottom: 4 }}>Import</div>
          <div style={{ fontSize: 12.5, color: "#8a97b0", marginBottom: 16 }}>Upload a filled template to create or update records in bulk.</div>
          <label style={labelStyle}>Target master</label>
          <select value={importTarget} onChange={(e) => setImportTarget(e.target.value)} style={{ ...inputStyle, background: "#fff", marginBottom: 14 }}>
            {MASTERS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div
            onClick={() => {
              setHasFile(true);
              setCommitted(false);
            }}
            style={{ border: "2px dashed #cdd7e6", borderRadius: 12, padding: "26px 18px", textAlign: "center", cursor: "pointer", background: "#fbfcfe" }}
          >
            <div style={{ fontSize: 26, marginBottom: 6 }}>⬆</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#3a4a68" }}>{hasFile ? "categories_bulk_v3.xlsx — 128 rows" : "Click to choose a file or drop it here"}</div>
            <div style={{ fontSize: 11.5, color: "#98a4bd", marginTop: 2 }}>XLSX or CSV · up to 5,000 rows</div>
          </div>
          {hasFile ? (
            <div style={{ marginTop: 14, background: "#f8fafd", border: "1px solid #eef2f7", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12.5 }}>
                <span style={{ color: "#0f9d63", fontWeight: 700 }}>✓ 120 valid</span>
                <span style={{ color: "#d98207", fontWeight: 700 }}>⚠ 6 to update</span>
                <span style={{ color: "#d63a3a", fontWeight: 700 }}>✕ 2 errors</span>
              </div>
              <div style={{ fontSize: 11.5, color: "#8a97b0", marginTop: 8 }}>Row 42: duplicate name &ldquo;Meter&rdquo; · Row 51: unknown parent category</div>
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button style={{ ...secondaryBtnStyle, flex: 1, padding: 10 }}>Download template</button>
            <button
              onClick={commitImport}
              style={{
                flex: 1,
                padding: 10,
                border: "none",
                background: hasFile ? "#0f9d63" : "#c3ccda",
                color: "#fff",
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 600,
                cursor: hasFile ? "pointer" : "not-allowed",
              }}
            >
              {committed ? "✓ Imported" : "Validate & Import"}
            </button>
          </div>
        </section>

        <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: 20, boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45", marginBottom: 4 }}>Export</div>
          <div style={{ fontSize: 12.5, color: "#8a97b0", marginBottom: 16 }}>Download a snapshot of the masters you select.</div>
          <label style={{ ...labelStyle, marginBottom: 8 }}>Masters to export</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
            {MASTERS.map((m) => {
              const on = exportSel.includes(m);
              return (
                <button
                  key={m}
                  onClick={() => {
                    setExportSel((prev) => (on ? prev.filter((x) => x !== m) : [...prev, m]));
                    setExported(false);
                  }}
                  style={{
                    padding: "7px 13px",
                    borderRadius: 20,
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    border: `1px solid ${on ? "#bcd4ff" : "#e0e5ee"}`,
                    background: on ? "#f2f7ff" : "#fff",
                    color: on ? "#1560f0" : "#8a97b0",
                  }}
                >
                  {m}
                </button>
              );
            })}
          </div>
          <label style={{ ...labelStyle, marginBottom: 8 }}>Format</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            {FORMATS.map((fmt) => {
              const on = format === fmt;
              return (
                <button
                  key={fmt}
                  onClick={() => {
                    setFormat(fmt);
                    setExported(false);
                  }}
                  style={{
                    flex: 1,
                    padding: 9,
                    borderRadius: 9,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    border: `1px solid ${on ? "#1560f0" : "#e0e5ee"}`,
                    background: on ? "#eaf2ff" : "#fff",
                    color: on ? "#1560f0" : "#5a6a86",
                  }}
                >
                  {fmt}
                </button>
              );
            })}
          </div>
          <button
            onClick={runExport}
            style={{ width: "100%", padding: 11, border: "none", background: "#1560f0", color: "#fff", borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}
          >
            {exported ? `✓ Exported ${exportSel.length} masters (${format})` : `Export ${exportSel.length} masters as ${format}`}
          </button>
        </section>
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Recent jobs</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="Job" leftPad="18px" active={sortKey === "type"} dir={dir} onClick={() => toggleSort("type")} />
              <SortTh label="Master" active={sortKey === "master"} dir={dir} onClick={() => toggleSort("master")} />
              <SortTh label="By" active={sortKey === "by"} dir={dir} onClick={() => toggleSort("by")} />
              <SortTh label="Rows" align="center" active={sortKey === "rows"} dir={dir} onClick={() => toggleSort("rows")} />
              <SortTh label="When" active={sortKey === "when"} dir={dir} onClick={() => toggleSort("when")} />
              <SortTh label="Result" leftPad="14px" rightPad="18px" active={sortKey === "result"} dir={dir} onClick={() => toggleSort("result")} />
            </tr>
          </thead>
          <tbody>
            {sortedJobs.map((j) => (
              <tr key={j.id}>
                <td style={tdStyle("18px")}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "3px 10px",
                      borderRadius: 20,
                      fontSize: 11.5,
                      fontWeight: 700,
                      background: j.type === "Import" ? "#eaf2ff" : "#f0ecff",
                      color: j.type === "Import" ? "#1560f0" : "#7c4ddb",
                    }}
                  >
                    {j.type}
                  </span>
                </td>
                <td style={{ ...tdStyle(), fontWeight: 600, color: "#1a2b4a" }}>{j.master}</td>
                <td style={{ ...tdStyle(), color: "#67748e" }}>{j.by}</td>
                <td style={{ ...tdStyle(), textAlign: "center", color: "#4a5878", fontFamily: "var(--font-mono)" }}>{j.rows}</td>
                <td style={{ ...tdStyle(), color: "#8a97b0" }}>{relativeTime(j.when)}</td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "3px 10px",
                      borderRadius: 20,
                      fontSize: 11.5,
                      fontWeight: 700,
                      background: j.result === "Success" ? "#e9f7f0" : "#fff4e5",
                      color: j.result === "Success" ? "#0f9d63" : "#d98207",
                    }}
                  >
                    {j.result}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>
    </PageShell>
  );
}

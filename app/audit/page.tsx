"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, Modal, EmptyState, thStyle, tdStyle, secondaryBtnStyle, SortTh } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

const TYPES = ["Category", "Storage Location", "Unit", "Role"];

type LogEntry = {
  id: string;
  ts: string;
  user: string;
  action: "Created" | "Edited" | "Deleted";
  dataType: string;
  entity: string;
  field: string;
  before: string;
  after: string;
  ip: string;
  device: string;
  session: string;
  beforeFields: [string, string][];
  afterFields: [string, string][];
};

const AV = ["#1560f0", "#0d9488", "#f59e0b", "#8b5cf6", "#ec4899", "#6366f1"];

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function initials(n: string) {
  return n.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function actionStyle(a: string) {
  const m: Record<string, [string, string]> = { Created: ["#e9f7f0", "#0f9d63"], Edited: ["#eaf2ff", "#1560f0"], Deleted: ["#fdecec", "#d63a3a"] };
  const c = m[a] || ["#eef2f9", "#5a6a86"];
  return { display: "inline-block", padding: "3px 11px", borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: c[0], color: c[1] } as const;
}

function fmt(ts: string) {
  const d = new Date(ts);
  return { date: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }), time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) };
}

export default function AuditLogPage() {
  const [rows, setRows] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<string[]>([]);

  const [typeFilter, setTypeFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [recordSearch, setRecordSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [viewId, setViewId] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  // Distinct users only needs to be fetched once.
  useEffect(() => {
    api.get<string[]>("/api/audit-log/users").then(setUsers);
  }, []);

  // Debounce free-text search so we don't fire a request on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setRecordSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (typeFilter) params.set("dataType", typeFilter);
    if (userFilter) params.set("user", userFilter);
    if (actionFilter) params.set("action", actionFilter);
    if (recordSearch) params.set("q", recordSearch);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    let cancelled = false;
    api
      .get<{ rows: LogEntry[]; total: number }>(`/api/audit-log?${params.toString()}`)
      .then((data) => {
        if (!cancelled) {
          setRows(data.rows);
          setTotal(data.total);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [typeFilter, userFilter, actionFilter, recordSearch, fromDate, toDate]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const v = rows.find((l) => l.id === viewId);
  const vf = v ? fmt(v.ts) : null;
  const { sorted: sortedRows, sortKey, dir, toggleSort } = useSort<LogEntry, keyof LogEntry>(rows);

  function reset() {
    setTypeFilter("");
    setUserFilter("");
    setActionFilter("");
    setFromDate("");
    setToDate("");
    setSearchInput("");
  }

  return (
    <PageShell section="System" page="Audit Log">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Audit Log"
          description="Every create, edit and delete across all master data — who, when, and exactly what changed. Click a row to see the full before/after."
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setToast("Exported audit log as CSV")} style={{ ...secondaryBtnStyle, padding: "9px 14px" }}>
            ⭳ CSV
          </button>
          <button onClick={() => setToast("Exported audit log as Excel")} style={{ ...secondaryBtnStyle, padding: "9px 14px" }}>
            ⭳ Excel
          </button>
          <button onClick={() => setToast("Exported audit log as PDF")} style={{ ...secondaryBtnStyle, padding: "9px 14px" }}>
            ⭳ PDF
          </button>
        </div>
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "14px 18px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "#9aa6bd", fontSize: 13 }}>⌕</span>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search record e.g. Plumbing…"
              style={{ width: 220, padding: "8px 11px 8px 29px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fbfcfe" }}
            />
          </div>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ padding: "8px 11px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fbfcfe", color: "#3a4a68" }}>
            <option value="">All data types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} style={{ padding: "8px 11px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fbfcfe", color: "#3a4a68" }}>
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} style={{ padding: "8px 11px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fbfcfe", color: "#3a4a68" }}>
            <option value="">All actions</option>
            <option value="Created">Created</option>
            <option value="Edited">Edited</option>
            <option value="Deleted">Deleted</option>
          </select>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#8a97b0" }}>
            <input value={fromDate} onChange={(e) => setFromDate(e.target.value)} type="date" style={{ padding: "7px 10px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, color: "#3a4a68" }} />
            <span>→</span>
            <input value={toDate} onChange={(e) => setToDate(e.target.value)} type="date" style={{ padding: "7px 10px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, color: "#3a4a68" }} />
          </div>
          <button onClick={reset} style={{ marginLeft: "auto", padding: "8px 13px", border: "1px solid #dfe5ee", background: "#fff", color: "#3a4a68", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
            Reset
          </button>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="When" leftPad="18px" active={sortKey === "ts"} dir={dir} onClick={() => toggleSort("ts")} />
              <SortTh label="Admin" active={sortKey === "user"} dir={dir} onClick={() => toggleSort("user")} />
              <SortTh label="Action" active={sortKey === "action"} dir={dir} onClick={() => toggleSort("action")} />
              <SortTh label="Data Type" active={sortKey === "dataType"} dir={dir} onClick={() => toggleSort("dataType")} />
              <th style={thStyle()}>Change</th>
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}></th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((l) => {
              const f = fmt(l.ts);
              const del = l.action === "Deleted";
              const cre = l.action === "Created";
              return (
                <tr key={l.id} onClick={() => setViewId(l.id)} style={{ cursor: "pointer" }}>
                  <td style={{ ...tdStyle("18px"), color: "#8a97b0", whiteSpace: "nowrap" }}>
                    <div style={{ color: "#1a2b4a", fontWeight: 500 }}>{f.date}</div>
                    <div style={{ fontSize: 11.5 }}>{f.time}</div>
                  </td>
                  <td style={tdStyle()}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <div
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: "50%",
                          background: AV[hashCode(l.user) % AV.length],
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        {initials(l.user)}
                      </div>
                      <span style={{ fontWeight: 500, color: "#1a2b4a" }}>{l.user}</span>
                    </div>
                  </td>
                  <td style={tdStyle()}>
                    <span style={actionStyle(l.action)}>{l.action}</span>
                  </td>
                  <td style={tdStyle()}>
                    <div style={{ fontWeight: 600, color: "#1a2b4a" }}>{l.dataType}</div>
                    <div style={{ fontSize: 11.5, color: "#98a4bd" }}>{l.entity}</div>
                  </td>
                  <td style={tdStyle()}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span
                        style={{
                          padding: "2px 9px",
                          borderRadius: 6,
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                          background: del ? "#fdecec" : "#f1f4f9",
                          color: del ? "#c0392b" : "#7a8aa6",
                          opacity: cre ? 0.5 : 1,
                        }}
                      >
                        {l.before}
                      </span>
                      <span style={{ color: "#c4ccda" }}>→</span>
                      <span
                        style={{
                          padding: "2px 9px",
                          borderRadius: 6,
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                          background: del ? "#f1f4f9" : "#e9f5ef",
                          color: del ? "#7a8aa6" : "#0f7a4d",
                        }}
                      >
                        {l.after}
                      </span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "#98a4bd", marginTop: 3 }}>{l.field}</div>
                  </td>
                  <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px", textAlign: "right" }}>
                    <span style={{ color: "#c4ccda", fontSize: 16 }}>›</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && rows.length === 0 ? <EmptyState text="No log entries match these filters." /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
        <div style={{ padding: "12px 18px", borderTop: "1px solid #f1f4f8", fontSize: 12, color: "#98a4bd" }}>
          Showing {rows.length} of {total} entries
        </div>
      </section>

      {v && vf ? (
        <Modal onClose={() => setViewId(null)} maxWidth={620}>
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #f1f4f8", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={actionStyle(v.action)}>{v.action}</span>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.3px" }}>
                  {v.dataType} · {v.entity}
                </h3>
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "#8a97b0" }}>
                by {v.user} · {vf.date}, {vf.time}
              </p>
            </div>
            <button
              onClick={() => setViewId(null)}
              style={{ width: 32, height: 32, border: "none", background: "#f4f7fb", borderRadius: 8, color: "#67748e", fontSize: 17, cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
          <div style={{ padding: "22px 24px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
              <div style={{ border: "1px solid #eef2f7", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ background: "#fbf3f3", color: "#c0392b", fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", padding: "9px 14px" }}>Before</div>
                <div style={{ padding: 14 }}>
                  {v.beforeFields.map(([k, val]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", fontSize: 13, borderTop: "1px solid #f6f8fb" }}>
                      <span style={{ color: "#8a97b0" }}>{k}</span>
                      <span style={{ color: "#1a2b4a", fontWeight: 600, textAlign: "right" }}>{val}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ border: "1px solid #d7ecdf", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ background: "#eefaf2", color: "#0f7a4d", fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", padding: "9px 14px" }}>After</div>
                <div style={{ padding: 14 }}>
                  {v.afterFields.map(([k, val], i) => {
                    const changed = v.beforeFields[i] && v.beforeFields[i][1] !== val;
                    return (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", fontSize: 13, borderTop: "1px solid #f6f8fb" }}>
                        <span style={{ color: "#8a97b0" }}>{k}</span>
                        <span style={{ fontWeight: 600, textAlign: "right", color: changed ? "#0f7a4d" : "#1a2b4a" }}>{val}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
              <div style={{ background: "#f8fafd", border: "1px solid #eef2f7", borderRadius: 10, padding: "11px 13px" }}>
                <div style={{ fontSize: 11, color: "#98a4bd", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".3px" }}>IP Address</div>
                <div style={{ fontSize: 12.5, color: "#1a2b4a", fontFamily: "var(--font-mono)", marginTop: 3 }}>{v.ip}</div>
              </div>
              <div style={{ background: "#f8fafd", border: "1px solid #eef2f7", borderRadius: 10, padding: "11px 13px" }}>
                <div style={{ fontSize: 11, color: "#98a4bd", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".3px" }}>Device</div>
                <div style={{ fontSize: 12.5, color: "#1a2b4a", marginTop: 3 }}>{v.device}</div>
              </div>
              <div style={{ background: "#f8fafd", border: "1px solid #eef2f7", borderRadius: 10, padding: "11px 13px" }}>
                <div style={{ fontSize: 11, color: "#98a4bd", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".3px" }}>Session</div>
                <div style={{ fontSize: 12.5, color: "#1a2b4a", fontFamily: "var(--font-mono)", marginTop: 3 }}>{v.session}</div>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {toast ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#0b1b45",
            color: "#fff",
            padding: "12px 20px",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "0 8px 24px rgba(11,27,69,.35)",
            zIndex: 60,
          }}
        >
          {toast}
        </div>
      ) : null}
    </PageShell>
  );
}

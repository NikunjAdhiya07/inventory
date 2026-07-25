"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, EmptyState, thStyle, tdStyle, SortTh } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

const TYPE_COLORS: Record<string, [string, string]> = {
  Category: ["#eaf2ff", "#1560f0"],
  Subcategory: ["#f0ecff", "#7c4ddb"],
  "Storage Location": ["#e9f7f4", "#0d9488"],
  Unit: ["#fff2e5", "#c9760a"],
  Role: ["#fdecec", "#d63a3a"],
};

type Item = { id: string; name: string; detail: string; type: string; by: string; deletedAt: string; daysLeft: number };

export default function RecycleBinPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<Item[]>("/api/recycle-bin")
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const types = [...new Set(items.map((i) => i.type))];
  const filtered = items.filter((i) => !typeFilter || i.type === typeFilter);
  const { sorted: sortedItems, sortKey, dir, toggleSort } = useSort<Item, keyof Item>(filtered);

  // Derived from the server-computed daysLeft (30-day purge window) instead of
  // calling Date.now() during render, which React treats as an impure read.
  function relDeleted(daysLeft: number) {
    const days = Math.max(0, 30 - daysLeft);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    return `${days} days ago`;
  }

  async function emptyBin() {
    setItems([]);
    setToast("Recycle bin emptied");
    await api.del("/api/recycle-bin");
  }

  async function restore(i: Item) {
    setItems((prev) => prev.filter((x) => x.id !== i.id));
    setToast(`Restored "${i.name}" to ${i.type}`);
    await api.post(`/api/recycle-bin/${i.id}`);
  }

  async function purge(i: Item) {
    setItems((prev) => prev.filter((x) => x.id !== i.id));
    setToast(`Permanently deleted "${i.name}"`);
    await api.del(`/api/recycle-bin/${i.id}`);
  }

  return (
    <PageShell section="Data Operations" page="Recycle Bin">
      <div style={{ marginBottom: 22 }}>
        <PageIntro
          title="Recycle Bin"
          description="Nothing is ever hard-deleted. Removed masters live here for 30 days and can be restored to their previous state — after which they're purged automatically."
        />
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Deleted records</span>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ padding: "7px 10px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fbfcfe", color: "#3a4a68" }}>
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={emptyBin}
            style={{ padding: "8px 13px", border: "1px solid #f4d0d0", background: "#fff", color: "#d63a3a", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
          >
            Empty bin
          </button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="Record" leftPad="18px" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Type" active={sortKey === "type"} dir={dir} onClick={() => toggleSort("type")} />
              <SortTh label="Deleted by" active={sortKey === "by"} dir={dir} onClick={() => toggleSort("by")} />
              <SortTh label="Deleted" active={sortKey === "deletedAt"} dir={dir} onClick={() => toggleSort("deletedAt")} />
              <SortTh label="Auto-purge" active={sortKey === "daysLeft"} dir={dir} onClick={() => toggleSort("daysLeft")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((i) => {
              const c = TYPE_COLORS[i.type] || ["#eef2f9", "#5a6a86"];
              const urgent = i.daysLeft <= 7;
              return (
                <tr key={i.id}>
                  <td style={tdStyle("18px")}>
                    <div style={{ fontWeight: 600, color: "#1a2b4a" }}>{i.name}</div>
                    <div style={{ fontSize: 11.5, color: "#98a4bd" }}>{i.detail}</div>
                  </td>
                  <td style={tdStyle()}>
                    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: c[0], color: c[1] }}>{i.type}</span>
                  </td>
                  <td style={{ ...tdStyle(), color: "#67748e" }}>{i.by}</td>
                  <td style={{ ...tdStyle(), color: "#8a97b0" }}>{relDeleted(i.daysLeft)}</td>
                  <td style={tdStyle()}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 9px",
                        borderRadius: 6,
                        fontSize: 11.5,
                        fontWeight: 600,
                        background: urgent ? "#fdecec" : "#f1f4f9",
                        color: urgent ? "#d63a3a" : "#8a97b0",
                      }}
                    >
                      in {i.daysLeft} days
                    </span>
                  </td>
                  <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => restore(i)}
                        style={{ padding: "6px 12px", border: "1px solid #bcdcc9", background: "#f2fbf6", color: "#0f7a4d", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                      >
                        ↺ Restore
                      </button>
                      <button
                        onClick={() => purge(i)}
                        style={{ padding: "6px 12px", border: "1px solid #f4d0d0", background: "#fff", color: "#d63a3a", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                      >
                        Delete forever
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && filtered.length === 0 ? <EmptyState text="The recycle bin is empty." /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

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
            animation: "om-pop .2s ease",
          }}
        >
          {toast}
        </div>
      ) : null}
    </PageShell>
  );
}

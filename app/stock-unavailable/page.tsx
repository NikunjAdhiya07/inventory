"use client";

import { useEffect, useMemo, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, thStyle, tdStyle, EmptyState, secondaryBtnStyle } from "@/components/dc-ui";

type Row = {
  id: string;
  productName: string;
  productNumber: string;
  locationPath: string;
  qtyRequested: number;
  qtyAvailable: number;
  unit: string;
  movementName: string;
  requesterName: string;
  ticketNumber: string | number | null;
  source: string;
  status: string;
  createdAt: string;
};

export default function StockUnavailablePage() {
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ items: Row[] }>("/api/stock-unavailable");
      setItems(res.items ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (r) =>
        r.productName.toLowerCase().includes(q) ||
        r.productNumber.toLowerCase().includes(q) ||
        r.locationPath.toLowerCase().includes(q) ||
        r.movementName.toLowerCase().includes(q) ||
        r.requesterName.toLowerCase().includes(q)
    );
  }, [items, search]);

  return (
    <PageShell section="Inventory" page="Out of Stock">
      <PageIntro
        title="Out of stock"
        description="Shortages recorded from Telegram workflows when outbound quantity exceeds live on-hand. These events are saved even when the cart line is not added."
      />

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product, location, movement…"
          style={{
            flex: "1 1 220px",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #e2e8f0",
            fontSize: 13,
          }}
        />
        <button type="button" onClick={() => void load()} style={secondaryBtnStyle}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div style={{ color: "#8a97b0", fontSize: 13 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState text="No shortages recorded yet. Outbound Telegram attempts that fail the live stock check will appear here." />
      ) : (
        <div style={{ overflow: "auto", border: "1px solid #e8edf5", borderRadius: 14, background: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle()}>When</th>
                <th style={thStyle()}>Item</th>
                <th style={thStyle()}>Location</th>
                <th style={thStyle()}>Requested</th>
                <th style={thStyle()}>Available</th>
                <th style={thStyle()}>Movement</th>
                <th style={thStyle()}>By</th>
                <th style={thStyle()}>Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td style={tdStyle()}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td style={tdStyle()}>
                    <div style={{ fontWeight: 650 }}>{r.productName}</div>
                    {r.productNumber ? (
                      <div style={{ fontSize: 11, color: "#8a97b0" }}>{r.productNumber}</div>
                    ) : null}
                  </td>
                  <td style={tdStyle()}>{r.locationPath}</td>
                  <td style={tdStyle()}>
                    {r.qtyRequested} {r.unit}
                  </td>
                  <td style={{ ...tdStyle(), color: "#d63a3a", fontWeight: 650 }}>
                    {r.qtyAvailable} {r.unit}
                  </td>
                  <td style={tdStyle()}>{r.movementName || "—"}</td>
                  <td style={tdStyle()}>
                    {r.requesterName || "—"}
                    {r.ticketNumber != null && r.ticketNumber !== "" ? (
                      <div style={{ fontSize: 11, color: "#8a97b0" }}>#{r.ticketNumber}</div>
                    ) : null}
                  </td>
                  <td style={tdStyle()}>{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

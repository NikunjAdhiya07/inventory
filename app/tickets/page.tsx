"use client";

import { useEffect, useMemo, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { ErrorBanner, PageIntro, SearchInput, EmptyState, thStyle, tdStyle, Modal, ModalHeader, ModalFooter, secondaryBtnStyle } from "@/components/dc-ui";
import type { ProductAttribute } from "@/lib/products";

type Entry = {
  id: string;
  ticketNumber?: string;
  submittedByName: string;
  createdAt: string;
  status: string;
  approval?: { status: string; by: string };
  fields: {
    itemName: string;
    productName?: string;
    productNumber?: string;
    attributes?: ProductAttribute[];
    category: string;
    subcategory: string;
    locationPath: string;
    quantity: number | null;
    unit: string;
    custom: Record<string, string>;
  };
};

function when(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function TicketsPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Entry[]>("/api/inventory-entries")
      .then((d) => !cancelled && setEntries(d))
      .catch((err: Error) => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      [e.ticketNumber, e.fields?.itemName, e.fields?.productNumber, e.fields?.category, e.fields?.locationPath, e.submittedByName]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [entries, search]);

  const open = entries.find((e) => e.id === openId);

  return (
    <PageShell section="Overview" page="Tickets" maxWidth={1320}>
      <div style={{ marginBottom: 22 }}>
        <PageIntro
          title="Tickets"
          description="Every entry the bot has completed, newest first. The ticket number is generated once per entry and is what a user quotes when they ask about one."
        />
      </div>

      {loadError && <ErrorBanner message={loadError} />}

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Latest tickets</span>
          <SearchInput value={search} onChange={setSearch} placeholder="Search ticket, item, location…" width={280} />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <th style={thStyle("18px")}>Ticket</th>
              <th style={thStyle()}>Item / Product</th>
              <th style={thStyle()}>Category</th>
              <th style={thStyle()}>Location</th>
              <th style={{ ...thStyle(), textAlign: "right" }}>Qty</th>
              <th style={thStyle()}>Submitted By</th>
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px" }}>When</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} onClick={() => setOpenId(e.id)} style={{ cursor: "pointer" }}>
                <td style={{ ...tdStyle("18px"), fontFamily: "var(--font-mono)", fontWeight: 700, color: e.ticketNumber ? "#1560f0" : "#c4ccda" }}>
                  {e.ticketNumber || "—"}
                </td>
                <td style={{ ...tdStyle(), color: "#1a2b4a", fontWeight: 600 }}>
                  {e.fields?.itemName || "—"}
                  {e.fields?.productNumber ? (
                    <div style={{ fontSize: 11.5, color: "#98a4bd", fontWeight: 400, marginTop: 2, fontFamily: "var(--font-mono)" }}>{e.fields.productNumber}</div>
                  ) : null}
                </td>
                <td style={{ ...tdStyle(), color: "#4a5878" }}>{e.fields?.category || "—"}</td>
                <td style={{ ...tdStyle(), color: "#8a97b0", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.fields?.locationPath || "—"}
                </td>
                <td style={{ ...tdStyle(), textAlign: "right", fontFamily: "var(--font-mono)", color: "#3a4a68" }}>
                  {e.fields?.quantity ?? "—"} <span style={{ color: "#98a4bd" }}>{e.fields?.unit}</span>
                </td>
                <td style={{ ...tdStyle(), color: "#4a5878" }}>{e.submittedByName}</td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px", color: "#98a4bd", whiteSpace: "nowrap" }}>{when(e.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 ? <EmptyState text={entries.length ? "No tickets match." : "No tickets yet — completed bot entries appear here."} /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {open ? (
        <Modal onClose={() => setOpenId(null)} maxWidth={520}>
          <ModalHeader title={open.ticketNumber || "Ticket"} subtitle={`${open.submittedByName} · ${when(open.createdAt)}`} onClose={() => setOpenId(null)} />
          <div style={{ padding: "18px 24px", fontSize: 13 }}>
            <Row label="Item" value={open.fields?.itemName} />
            {open.fields?.productName ? <Row label="Product" value={`${open.fields.productName} (${open.fields.productNumber})`} /> : null}
            {(open.fields?.attributes ?? []).map((a) => (
              <Row key={a.name} label={a.name} value={a.value} indent />
            ))}
            <Row label="Category" value={open.fields?.category} />
            <Row label="Subcategory" value={open.fields?.subcategory} />
            <Row label="Location" value={open.fields?.locationPath} />
            <Row label="Quantity" value={open.fields?.quantity === null || open.fields?.quantity === undefined ? "" : `${open.fields.quantity} ${open.fields.unit}`} />
            {Object.entries(open.fields?.custom ?? {}).map(([k, v]) => (
              <Row key={k} label={k} value={v} />
            ))}
            {open.approval ? <Row label="Approval" value={`${open.approval.status} · ${open.approval.by}`} /> : null}
          </div>
          <ModalFooter>
            <button onClick={() => setOpenId(null)} style={secondaryBtnStyle}>
              Close
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

function Row({ label, value, indent }: { label: string; value?: string | number; indent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "8px 0", borderBottom: "1px solid #f1f4f8" }}>
      <span style={{ color: "#8a97b0", paddingLeft: indent ? 14 : 0 }}>{label}</span>
      <span style={{ color: "#1a2b4a", fontWeight: 600, textAlign: "right" }}>{value || "—"}</span>
    </div>
  );
}

"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

export type TicketCardModel = {
  id: string;
  ticketId: string;
  kind: "entry" | "request" | "purchase" | "issue" | "return";
  series: string;
  status: string;
  boardStatus: "PENDING" | "COMPLETED" | "REJECTED" | "CANCELLED";
  description: string;
  category: string;
  subCategory?: string;
  location: string;
  quantity?: number | null;
  unit?: string;
  productNumber?: string;
  createdBy: string;
  completedBy?: string;
  createdAt: string;
  completedAt?: string | null;
  lines?: {
    productName?: string;
    productNumber?: string;
    locationPath?: string;
    qty?: number;
    unit?: string;
    outcome?: string;
  }[];
  history?: { at?: string; by?: string; what?: string }[];
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : null;
}

function lighten(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.min(255, Math.floor(rgb.r + (255 - rgb.r) * percent));
  const g = Math.min(255, Math.floor(rgb.g + (255 - rgb.g) * percent));
  const b = Math.min(255, Math.floor(rgb.b + (255 - rgb.b) * percent));
  return `rgb(${r}, ${g}, ${b})`;
}

function darken(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.max(0, Math.floor(rgb.r * (1 - percent)));
  const g = Math.max(0, Math.floor(rgb.g * (1 - percent)));
  const b = Math.max(0, Math.floor(rgb.b * (1 - percent)));
  return `rgb(${r}, ${g}, ${b})`;
}

function kindColor(kind: TicketCardModel["kind"]): string {
  if (kind === "request") return "#1560f0";
  if (kind === "purchase") return "#0d9488";
  return "#6d5bd0";
}

function durationLabel(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function elapsedLabel(iso?: string | null, endIso?: string | null): string {
  if (!iso) return "—";
  const start = new Date(iso).getTime();
  if (!Number.isFinite(start)) return "—";
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(end)) return "—";
  // Closed tickets show turnaround (created → actioned); open ones show time since creation.
  return endIso ? durationLabel(end - start) : `${durationLabel(end - start)} ago`;
}

function whenShort(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function clockShort(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function spanLabel(iso?: string | null, endIso?: string | null): string {
  const start = clockShort(iso);
  if (!start) return "";
  const end = clockShort(endIso);
  return end ? `${start} → ${end}` : start;
}

const badgeBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
};

export default function TicketCard({ ticket }: { ticket: TicketCardModel }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const base = kindColor(ticket.kind);
  const colors = {
    bg: lighten(base, 0.94),
    border: lighten(base, 0.72),
    accentLight: lighten(base, 0.88),
    accentMedium: lighten(base, 0.78),
    text: darken(base, 0.45),
    textDark: darken(base, 0.78),
  };
  const left = kindColor(ticket.kind);

  return (
    <article
      style={{
        background: colors.bg,
        borderRadius: 14,
        border: `1px solid ${colors.border}`,
        borderLeft: `4px solid ${left}`,
        boxShadow: "0 1px 2px rgba(16,30,54,.05)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          background: colors.accentLight,
          borderBottom: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: colors.textDark, fontFamily: "var(--font-mono)" }}>
            {ticket.ticketId}
          </span>
              <span style={{ ...badgeBase, background: lighten(base, 0.7), color: colors.textDark, border: `1px solid ${colors.border}` }}>
            {ticket.series}
          </span>
          {ticket.kind === "request" || ticket.kind === "purchase" ? (
            <span
              style={{
                ...badgeBase,
                background: "#fff",
                color: colors.textDark,
                border: `1px solid ${colors.border}`,
              }}
            >
              {String(ticket.status || "").replace(/_/g, " ") || ticket.kind}
            </span>
          ) : (
            <span
              style={{
                ...badgeBase,
                background: "#fff",
                color: colors.textDark,
                border: `1px solid ${colors.border}`,
              }}
            >
              entry
            </span>
          )}
        </div>
        {(ticket.history?.length ?? 0) > 0 ? (
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            style={{
              border: `1px solid ${colors.border}`,
              background: "#fff",
              borderRadius: 8,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: colors.textDark,
              cursor: "pointer",
            }}
          >
            {historyOpen ? "Hide history" : "History"}
          </button>
        ) : null}
      </div>

      <div style={{ padding: 16 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: colors.textDark, lineHeight: 1.35 }}>
          {ticket.description}
        </h3>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px", fontSize: 13, color: colors.text, marginBottom: 12 }}>
          <Meta label="Category">
            <span
              style={{
                padding: "1px 8px",
                borderRadius: 6,
                background: colors.accentMedium,
                color: colors.textDark,
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              {ticket.category || "—"}
            </span>
            {ticket.subCategory ? <span style={{ marginLeft: 6 }}>· {ticket.subCategory}</span> : null}
          </Meta>
          <Meta label="📍">{ticket.location || "—"}</Meta>
          {ticket.quantity != null ? (
            <Meta label="Qty">
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: colors.textDark }}>
                {ticket.quantity} {ticket.unit}
              </span>
            </Meta>
          ) : null}
          {ticket.productNumber ? (
            <Meta label="PN">
              <span style={{ fontFamily: "var(--font-mono)" }}>{ticket.productNumber}</span>
            </Meta>
          ) : null}
        </div>

        {ticket.lines && ticket.lines.length > 0 ? (
          <div
            style={{
              marginBottom: 12,
              borderRadius: 10,
              border: `1px solid ${colors.border}`,
              background: "#fff",
              overflow: "hidden",
            }}
          >
            {ticket.lines.map((l, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "8px 12px",
                  borderTop: i === 0 ? "none" : `1px solid ${colors.border}`,
                  fontSize: 12.5,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: colors.textDark }}>{String(l.productName || "—")}</div>
                  <div style={{ color: colors.text, marginTop: 2 }}>{String(l.locationPath || "")}</div>
                </div>
                <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: colors.textDark, fontWeight: 700 }}>
                  {l.outcome === "issued" ? "−" : ""}
                  {l.qty} {l.unit}
                  {l.outcome === "unavailable" ? (
                    <div style={{ fontSize: 10, color: "#d63a3a", fontWeight: 600, fontFamily: "inherit" }}>unavailable</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
            borderRadius: 10,
            padding: 12,
            background: colors.accentMedium,
            fontSize: 12.5,
          }}
        >
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: colors.text, marginBottom: 4 }}>
              Created by
            </div>
            <div style={{ fontWeight: 700, color: colors.textDark }}>{ticket.createdBy || "—"}</div>
            <div style={{ fontSize: 10, color: colors.text, marginTop: 2 }}>{whenShort(ticket.createdAt)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: colors.text, marginBottom: 4 }}>
              Time
            </div>
            <div style={{ fontWeight: 700, color: colors.textDark }}>
              {elapsedLabel(ticket.createdAt, ticket.completedAt)}
            </div>
            <div style={{ fontSize: 10, color: colors.text, marginTop: 2 }}>
              {spanLabel(ticket.createdAt, ticket.completedAt)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: colors.text, marginBottom: 4 }}>
              {ticket.completedBy ? "Actioned by" : "Requester"}
            </div>
            <div style={{ fontWeight: 700, color: colors.textDark }}>
              {ticket.completedBy || "—"}
            </div>
            <div style={{ fontSize: 10, color: colors.text, marginTop: 2 }}>{whenShort(ticket.completedAt)}</div>
          </div>
        </div>

        {historyOpen && ticket.history?.length ? (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${colors.border}` }}>
            {ticket.history.slice(-8).map((h, i) => (
              <div key={i} style={{ fontSize: 12, color: colors.text, marginBottom: 6, lineHeight: 1.4 }}>
                <span style={{ fontWeight: 700, color: colors.textDark }}>{h.by || "—"}</span>
                {" — "}
                {h.what}
                <span style={{ color: "#98a4bd", marginLeft: 6 }}>{whenShort(h.at)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontWeight: 600 }}>{label}:</span>
      <span>{children}</span>
    </span>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import PageShell from "@/components/page-shell";
import TicketCard, { type TicketCardModel } from "@/components/ticket-card";
import { api } from "@/lib/api-client";
import { ErrorBanner, PageIntro, SearchInput, EmptyState } from "@/components/dc-ui";

type KindFilter = "all" | "request" | "purchase";

const CATEGORY_COLORS = ["#1560f0", "#0d9488", "#6d5bd0", "#d97706", "#e11d48", "#0891b2", "#4f46e5", "#059669"];

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

function lighten(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.min(255, Math.floor(rgb.r + (255 - rgb.r) * percent));
  const g = Math.min(255, Math.floor(rgb.g + (255 - rgb.g) * percent));
  const b = Math.min(255, Math.floor(rgb.b + (255 - rgb.b) * percent));
  return `rgb(${r}, ${g}, ${b})`;
}

function CategoryCapsule({
  title,
  total,
  req,
  pur,
  color,
  active,
  onClick,
}: {
  title: string;
  total: number;
  req: number;
  pur: number;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const leftBg = lighten(color, active ? 0.78 : 0.88);
  const midBg = lighten(color, active ? 0.68 : 0.78);
  const rightBg = lighten(color, active ? 0.82 : 0.92);

  return (
    <button
      type="button"
      onClick={onClick}
      id={`category-${title}`}
      style={{
        display: "flex",
        width: "100%",
        height: 112,
        padding: 0,
        borderRadius: 14,
        overflow: "hidden",
        borderTop: `1px solid ${lighten(color, 0.55)}`,
        borderRight: `1px solid ${lighten(color, 0.55)}`,
        borderBottom: `1px solid ${lighten(color, 0.55)}`,
        borderLeft: `4px solid ${color}`,
        boxShadow: active ? `0 0 0 2px ${color}55` : "0 1px 2px rgba(16,30,54,.05)",
        cursor: "pointer",
        background: "#fff",
        textAlign: "left",
      }}
    >
      <div style={{ flex: 1, padding: "10px 12px", background: leftBg, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "#4a5878", marginBottom: 6 }}>
          Series
        </div>
        <Row label="REQ" value={req} color="#1560f0" />
        <Row label="PUR" value={pur} color="#0d9488" />
      </div>
      <div
        style={{
          flex: 1,
          maxWidth: 150,
          padding: "10px 12px",
          background: midBg,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#4a5878", textAlign: "center", marginBottom: 2, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </div>
        <div style={{ fontSize: 32, fontWeight: 800, color: "#0b1b45", lineHeight: 1 }}>{total}</div>
      </div>
      <div style={{ flex: 1, padding: "10px 12px", background: rightBg, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "#4a5878", marginBottom: 6 }}>
          Mix
        </div>
        <div style={{ fontSize: 11, color: "#4a5878" }}>
          {total === 0 ? "No tickets" : `${Math.round((req / Math.max(total, 1)) * 100)}% issues`}
        </div>
        <div style={{ fontSize: 11, color: "#4a5878", marginTop: 4 }}>
          {total === 0 ? "—" : `${Math.round((pur / Math.max(total, 1)) * 100)}% purchase`}
        </div>
      </div>
    </button>
  );
}

function Row({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
      <span style={{ color, fontWeight: 700 }}>{label}</span>
      <span style={{ color: "#0b1b45", fontWeight: 700 }}>({value})</span>
    </div>
  );
}

const chip = (active: boolean, color: string): CSSProperties => ({
  padding: "7px 12px",
  borderRadius: 999,
  border: `1px solid ${active ? color : "#dfe5ee"}`,
  background: active ? `${color}18` : "#fbfcfe",
  color: active ? color : "#4a5878",
  fontSize: 12.5,
  fontWeight: 700,
  cursor: "pointer",
});

export default function TicketsPage() {
  const [tickets, setTickets] = useState<TicketCardModel[]>([]);
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [category, setCategory] = useState<string>("");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(30);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [d, cats] = await Promise.all([
        api.get<TicketCardModel[]>("/api/tickets"),
        api.get<{ name: string; color?: string }[]>("/api/categories").catch(() => []),
      ]);
      // INV stock-in entries live on Item Master — tickets = operational REQ/PUR only.
      setTickets(d.filter((t) => t.kind !== "entry"));
      const map: Record<string, string> = {};
      for (const c of cats) {
        if (c.name && c.color) map[c.name.toLowerCase()] = c.color;
      }
      setCategoryColors(map);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load tickets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    setVisibleCount(30);
  }, [kind, category, search]);

  const reqCount = useMemo(() => tickets.filter((t) => t.kind === "request").length, [tickets]);
  const purchaseCount = useMemo(() => tickets.filter((t) => t.kind === "purchase").length, [tickets]);

  const categoryStats = useMemo(() => {
    const map = new Map<string, { total: number; req: number; pur: number }>();
    for (const t of tickets) {
      const name = (t.category || "Uncategorized").trim() || "Uncategorized";
      const cur = map.get(name) || { total: 0, req: 0, pur: 0 };
      cur.total += 1;
      if (t.kind === "request") cur.req += 1;
      else if (t.kind === "purchase") cur.pur += 1;
      map.set(name, cur);
    }
    return [...map.entries()]
      .map(([name, stats], i) => ({
        name,
        ...stats,
        color: categoryColors[name.toLowerCase()] || CATEGORY_COLORS[i % CATEGORY_COLORS.length],
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [tickets, categoryColors]);

  const allStats = useMemo(
    () => ({
      name: "All",
      total: tickets.length,
      req: reqCount,
      pur: purchaseCount,
      color: "#0b1b45",
    }),
    [tickets.length, reqCount, purchaseCount]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tickets.filter((t) => {
      if (kind !== "all" && t.kind !== kind) return false;
      if (category && (t.category || "Uncategorized").toLowerCase() !== category.toLowerCase()) return false;
      if (!q) return true;
      return [t.ticketId, t.description, t.category, t.location, t.createdBy, t.productNumber, t.status]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [tickets, kind, category, search]);

  const visible = filtered.slice(0, visibleCount);

  function selectCategory(name: string) {
    const next = category.toLowerCase() === name.toLowerCase() ? "" : name === "All" ? "" : name;
    setCategory(next);
    setTimeout(() => {
      listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  return (
    <PageShell section="Overview" page="Tickets" maxWidth={1320}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
        <div>
          <PageIntro
            title="Tickets"
            description="Stock issues (REQ) and purchases (PUR). Inventory entries and AI reference tags live on Item Master."
          />
          <Link href="/item-master" style={{ fontSize: 12.5, fontWeight: 600, color: "#1560f0", textDecoration: "none" }}>
            Open Item Master →
          </Link>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            load().catch(() => {});
          }}
          style={{
            padding: "9px 14px",
            borderRadius: 10,
            border: "1px solid #dfe5ee",
            background: "#fff",
            fontSize: 12.5,
            fontWeight: 700,
            color: "#3a4a68",
            cursor: "pointer",
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {loadError && <ErrorBanner message={loadError} />}

      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#0b1b45", marginBottom: 12 }}>By Category</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 12,
          }}
        >
          <CategoryCapsule {...allStats} title="All" active={!category} onClick={() => selectCategory("All")} />
          {categoryStats.map((cat) => (
            <CategoryCapsule
              key={cat.name}
              title={cat.name}
              total={cat.total}
              req={cat.req}
              pur={cat.pur}
              color={cat.color}
              active={category.toLowerCase() === cat.name.toLowerCase()}
              onClick={() => selectCategory(cat.name)}
            />
          ))}
        </div>
      </div>

      <section
        ref={listRef}
        style={{
          background: "#fff",
          border: "1px solid #e9edf3",
          borderRadius: 14,
          boxShadow: "0 1px 2px rgba(16,30,54,.04)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid #f1f4f8",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#0b1b45", marginRight: 4 }}>
              {category || "All tickets"}
              <span style={{ color: "#98a4bd", fontWeight: 600, marginLeft: 6 }}>({filtered.length})</span>
            </span>
            {(
              [
                ["all", "All", "#3a4a68"],
                ["request", `REQ (${reqCount})`, "#1560f0"],
                ["purchase", `PUR (${purchaseCount})`, "#0d9488"],
              ] as const
            ).map(([k, label, color]) => (
              <button key={k} type="button" onClick={() => setKind(k)} style={chip(kind === k, color)}>
                {label}
              </button>
            ))}
            {category ? (
              <button
                type="button"
                onClick={() => setCategory("")}
                style={{ ...chip(false, "#d63a3a"), color: "#d63a3a" }}
              >
                Clear category
              </button>
            ) : null}
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search ticket, item, location…" width={260} />
        </div>

        <div style={{ padding: 16, background: "#f6f8fb", minHeight: 280 }}>
          {loading && tickets.length === 0 ? <EmptyState text="Loading tickets…" /> : null}
          {!loading && filtered.length === 0 ? <EmptyState text="No tickets match these filters." /> : null}

          <div style={{ display: "grid", gap: 12 }}>
            {visible.map((t) => (
              <TicketCard key={t.id} ticket={t} />
            ))}
          </div>

          {filtered.length > visibleCount ? (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setVisibleCount((n) => n + 30)}
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "1px solid #dfe5ee",
                  background: "#fff",
                  fontWeight: 700,
                  color: "#1560f0",
                  cursor: "pointer",
                }}
              >
                Show more ({filtered.length - visibleCount} left)
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </PageShell>
  );
}

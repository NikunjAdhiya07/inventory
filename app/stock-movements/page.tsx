"use client";

import { useEffect, useMemo, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { DIRECTION_GROUPS, directionGroup, pathOf, type Direction } from "@/lib/movement-ui";
import {
  ErrorBanner,
  PageIntro,
  EmptyState,
  SearchInput,
  labelStyle,
  inputStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
  thStyle,
  tdStyle,
} from "@/components/dc-ui";

type StockLine = { productId: string; locationId: string; locationPath: string; qty: number; unit: string };
type Item = {
  productId: string;
  name: string;
  productNumber: string;
  category: string;
  subcategory: string;
  unit: string;
  attributes: { name: string; value: string }[];
  lines: StockLine[];
  total: number;
};

type MovementType = {
  id: string;
  code: string;
  name: string;
  direction: Direction;
  desc: string;
  requireRemarks: boolean;
  requireReference: boolean;
  allowNegative: boolean;
  isSystem: boolean;
  order: number;
  status: string;
};

type LocationNode = { id: string; parent: string | null; name: string; status: string };

type HistoryRow = {
  id: string;
  createdAt: string;
  productName: string;
  productNumber: string;
  typeName: string;
  typeCode: string;
  direction: Direction;
  locationPath: string;
  counterpartLocationPath: string;
  qty: number;
  unit: string;
  remarks: string;
  reference: string;
  refType: string;
  by: string;
};

type Confirmation = {
  movement: string;
  direction: Direction;
  productName: string;
  qty: number;
  balances: { locationId: string; locationPath: string; qty: number }[];
};

export default function StockMovementsPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [item, setItem] = useState<Item | null>(null);
  const [types, setTypes] = useState<MovementType[]>([]);
  const [locations, setLocations] = useState<LocationNode[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyScope, setHistoryScope] = useState<"item" | "all">("all");

  const [typeCode, setTypeCode] = useState("");
  const [locationId, setLocationId] = useState("");
  const [toLocationId, setToLocationId] = useState("");
  const [qty, setQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [reference, setReference] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<MovementType[]>("/api/movement-types"),
      api.get<LocationNode[]>("/api/locations"),
      api.get<Item[]>("/api/stock/lookup?q="),
    ])
      .then(([t, l, items]) => {
        if (cancelled) return;
        setTypes(t);
        setLocations(l);
        setResults(items);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced item search (AC-01).
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .get<Item[]>(`/api/stock/lookup?q=${encodeURIComponent(query)}`)
        .then((d) => !cancelled && setResults(d))
        .catch((e: Error) => !cancelled && setError(e.message));
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const historyKey = `${historyScope}:${item?.productId ?? ""}`;
  useEffect(() => {
    let cancelled = false;
    const [scope, productId] = historyKey.split(":");
    const url = scope === "item" && productId ? `/api/stock/movements?productId=${productId}` : "/api/stock/movements?limit=60";
    api
      .get<HistoryRow[]>(url)
      .then((d) => !cancelled && setHistory(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [historyKey, confirmation]);

  // System types are written by the entry bot, the request bot and the storage
  // map. Offering them here would let someone claim a ticket happened.
  const offered = useMemo(
    () => types.filter((t) => !t.isSystem && t.status === "Active").sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [types]
  );
  const type = offered.find((t) => t.code === typeCode) ?? null;
  const activeLocations = useMemo(() => locations.filter((l) => l.status === "Active"), [locations]);
  const locationOptions = useMemo(
    () =>
      activeLocations
        .map((l) => ({ id: l.id, path: pathOf(activeLocations, l.id) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [activeLocations]
  );

  // Where the stock is leaving from is offered from the item's OWN holdings —
  // picking a box that has none of it is not a mistake worth allowing.
  const sourceOptions = item?.lines ?? [];
  const source = sourceOptions.find((l) => l.locationId === locationId) ?? null;
  const outward = type?.direction === "out" || type?.direction === "transfer";
  const available = source?.qty ?? 0;
  const wanted = Number(qty) || 0;
  const short = outward && wanted > available && !type?.allowNegative;

  function chooseItem(next: Item) {
    setItem(next);
    setHistoryScope("item");
    setConfirmation(null);
    setError(null);
    setLocationId("");
    setToLocationId("");
  }

  function resetForm() {
    setQty("");
    setRemarks("");
    setReference("");
  }

  async function submit() {
    if (!item || !type) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        typeCode: type.code,
        productId: item.productId,
        qty: Number(qty),
        ...(type.direction === "transfer" ? { fromLocationId: locationId, toLocationId } : { locationId }),
        remarks,
        reference,
      };
      const res = await api.post<Confirmation>("/api/stock/movements", body);
      setConfirmation(res);
      resetForm();
      // The panel above must show what the shelf now holds, not what it held
      // when the item was picked.
      const refreshed = await api.get<Item[]>(`/api/stock/lookup?q=${encodeURIComponent(item.productNumber || item.name)}`);
      const updated = refreshed.find((r) => r.productId === item.productId);
      if (updated) {
        setItem(updated);
        setResults((prev) => prev.map((r) => (r.productId === updated.productId ? updated : r)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the movement.");
    } finally {
      setSaving(false);
    }
  }

  const canSubmit =
    Boolean(item && type && wanted > 0 && !short) &&
    (type?.direction === "transfer" ? Boolean(locationId && toLocationId && locationId !== toLocationId) : Boolean(locationId)) &&
    (!type?.requireRemarks || remarks.trim().length > 0) &&
    (!type?.requireReference || reference.trim().length > 0);

  return (
    <PageShell section="Inventory" page="Stock Movements" maxWidth={1400}>
      <PageIntro
        title="Stock Movements"
        description="Record what happened to an item — received, issued, returned, damaged, moved — and the ledger and its history update together. Movement types are configurable in Movement Types."
      />

      {error && <ErrorBanner message={error} />}

      <div style={{ display: "grid", gridTemplateColumns: "330px 1fr", gap: 16, alignItems: "start", marginTop: 20 }}>
        {/* 1. Find the item */}
        <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #f1f4f8" }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0b1b45", marginBottom: 10 }}>1 · Find the item</div>
            <SearchInput value={query} onChange={setQuery} placeholder="Name, number or attribute…" />
          </div>
          <div style={{ maxHeight: 520, overflowY: "auto" }}>
            {results.map((r) => (
              <button
                key={r.productId}
                onClick={() => chooseItem(r)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "11px 16px",
                  border: "none",
                  borderTop: "1px solid #f1f4f8",
                  background: item?.productId === r.productId ? "#eef4ff" : "#fff",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#1a2b4a" }}>{r.name}</div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 3 }}>
                  <span style={{ fontSize: 11, color: "#98a4bd", fontFamily: "var(--font-mono)" }}>{r.productNumber}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: r.total > 0 ? "#0f9d63" : "#c4ccda" }}>
                    {r.total} {r.unit}
                  </span>
                </div>
              </button>
            ))}
            {!loading && results.length === 0 ? <EmptyState text="No items match." /> : null}
            {loading ? <EmptyState text="Loading…" /> : null}
          </div>
        </section>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {item ? (
            <>
              {/* 2. Current stock */}
              <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0b1b45" }}>{item.name}</div>
                    <div style={{ fontSize: 12, color: "#8a97b0", marginTop: 3, fontFamily: "var(--font-mono)" }}>{item.productNumber}</div>
                    <div style={{ fontSize: 11.5, color: "#67748e", marginTop: 6 }}>
                      {[item.category, item.subcategory].filter(Boolean).join(" › ")}
                      {item.attributes.length ? ` · ${item.attributes.map((a) => `${a.name}: ${a.value}`).join(" · ")}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 11.5, color: "#8a97b0", fontWeight: 600 }}>On hand</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: item.total > 0 ? "#0b1b45" : "#c4ccda", letterSpacing: "-.5px" }}>
                      {item.total} <span style={{ fontSize: 13, fontWeight: 600, color: "#8a97b0" }}>{item.unit}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  {item.lines.map((l) => (
                    <span key={l.locationId} style={{ padding: "5px 11px", borderRadius: 8, background: "#f6f8fb", border: "1px solid #eef2f7", fontSize: 12, color: "#3a4a68" }}>
                      {l.locationPath} · <b>{l.qty}</b>
                    </span>
                  ))}
                  {item.lines.length === 0 ? (
                    <span style={{ fontSize: 12.5, color: "#98a4bd" }}>Nothing on hand anywhere yet — receive stock via the Entries bot, or record a purchase / return.</span>
                  ) : null}
                </div>
              </section>

              {confirmation ? (
                <div style={{ background: "#eafaf1", border: "1px solid #b9e7cf", borderRadius: 12, padding: "13px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 18 }}>✅</span>
                  <div style={{ fontSize: 13, color: "#0b6b45", lineHeight: 1.5 }}>
                    <b>{confirmation.movement}</b> recorded — {confirmation.direction === "out" ? "-" : "+"}
                    {confirmation.qty} {item.unit} of {confirmation.productName}.
                    <span style={{ display: "block", color: "#3a7a5f" }}>
                      Now on hand — {confirmation.balances.map((b) => `${b.locationPath}: ${b.qty}`).join(" · ")}
                    </span>
                  </div>
                </div>
              ) : null}

              {/* 3. Record the movement */}
              <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0b1b45", marginBottom: 12 }}>2 · What happened?</div>

                {DIRECTION_GROUPS.filter((g) => g.direction !== "adjust").map((g) => {
                  const rows = offered.filter((t) => t.direction === g.direction);
                  if (!rows.length) return null;
                  return (
                    <div key={g.direction} style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: g.color, marginBottom: 7 }}>{g.title}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                        {rows.map((t) => {
                          const on = typeCode === t.code;
                          return (
                            <button
                              key={t.code}
                              onClick={() => {
                                setTypeCode(t.code);
                                setConfirmation(null);
                                setError(null);
                                // A transfer's source must hold the item; an
                                // inward movement's does not. Switching between
                                // them makes the old pick meaningless.
                                setLocationId("");
                                setToLocationId("");
                              }}
                              title={t.desc}
                              style={{
                                padding: "7px 13px",
                                borderRadius: 8,
                                border: `1px solid ${on ? g.color : "#e4e9f0"}`,
                                background: on ? g.tint : "#fff",
                                color: on ? g.color : "#4a5878",
                                fontSize: 12.5,
                                fontWeight: on ? 700 : 500,
                                cursor: "pointer",
                              }}
                            >
                              {t.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {offered.length === 0 && !loading ? (
                  <EmptyState text="No movement types configured. Run npm run seed:movement-types, or add them in Movement Types." />
                ) : null}

                {type ? (
                  <div style={{ borderTop: "1px solid #f1f4f8", marginTop: 14, paddingTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
                    {type.desc ? <div style={{ fontSize: 12, color: "#67748e" }}>{type.desc}</div> : null}

                    <div style={{ display: "grid", gridTemplateColumns: type.direction === "transfer" ? "1fr 1fr 140px" : "1fr 160px", gap: 14 }}>
                      <div>
                        <label style={labelStyle}>
                          {type.direction === "transfer" ? "Move from" : type.direction === "out" ? "Take out of" : "Put into"}{" "}
                          <span style={{ color: "#e0524f" }}>*</span>
                        </label>
                        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                          <option value="">Select…</option>
                          {outward
                            ? sourceOptions.map((l) => (
                                <option key={l.locationId} value={l.locationId}>
                                  {l.locationPath} — {l.qty} on hand
                                </option>
                              ))
                            : locationOptions.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.path}
                                </option>
                              ))}
                        </select>
                        {outward && sourceOptions.length === 0 ? (
                          <div style={{ fontSize: 11.5, color: "#d63a3a", marginTop: 5 }}>Nothing on hand anywhere — there is nothing to take out.</div>
                        ) : null}
                      </div>

                      {type.direction === "transfer" ? (
                        <div>
                          <label style={labelStyle}>
                            Move to <span style={{ color: "#e0524f" }}>*</span>
                          </label>
                          <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                            <option value="">Select…</option>
                            {locationOptions
                              .filter((l) => l.id !== locationId)
                              .map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.path}
                                </option>
                              ))}
                          </select>
                        </div>
                      ) : null}

                      <div>
                        <label style={labelStyle}>
                          Quantity <span style={{ color: "#e0524f" }}>*</span>
                        </label>
                        <input
                          type="number"
                          min={0}
                          value={qty}
                          onChange={(e) => {
                            setQty(e.target.value);
                            setConfirmation(null);
                          }}
                          placeholder="0"
                          style={{ ...inputStyle, borderColor: short ? "#e0524f" : undefined }}
                        />
                        {short ? (
                          <div style={{ fontSize: 11.5, color: "#d63a3a", marginTop: 5 }}>
                            Only {available} on hand there — can&apos;t take out {wanted}.
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                      <div>
                        <label style={labelStyle}>
                          Reference {type.requireReference ? <span style={{ color: "#e0524f" }}>*</span> : <span style={{ color: "#aab4c8" }}>(optional)</span>}
                        </label>
                        <input
                          value={reference}
                          onChange={(e) => setReference(e.target.value)}
                          placeholder="Invoice / PO / challan / ticket no."
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>
                          Remarks {type.requireRemarks ? <span style={{ color: "#e0524f" }}>*</span> : <span style={{ color: "#aab4c8" }}>(optional)</span>}
                        </label>
                        <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Why this movement happened…" style={inputStyle} />
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
                      {type.allowNegative && outward ? (
                        <span style={{ fontSize: 11.5, color: "#d98207", marginRight: "auto" }}>
                          This type may take stock below zero — the balance will go negative if you exceed what is on hand.
                        </span>
                      ) : null}
                      <button
                        onClick={() => {
                          setTypeCode("");
                          resetForm();
                        }}
                        style={secondaryBtnStyle}
                      >
                        Clear
                      </button>
                      <button onClick={submit} disabled={!canSubmit || saving} style={{ ...primaryBtnStyle, opacity: canSubmit && !saving ? 1 : 0.5, cursor: canSubmit && !saving ? "pointer" : "not-allowed" }}>
                        {saving ? "Recording…" : "Record movement"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
            </>
          ) : (
            <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: "48px 0" }}>
              <EmptyState text="Search for an item on the left to record a movement against it." />
            </section>
          )}

          {/* History */}
          <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
            <div style={{ padding: "13px 18px", borderBottom: "1px solid #f1f4f8", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0b1b45" }}>Movement history</div>
              <div style={{ display: "flex", gap: 6 }}>
                {(["item", "all"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setHistoryScope(s)}
                    disabled={s === "item" && !item}
                    style={{
                      padding: "5px 11px",
                      borderRadius: 7,
                      border: `1px solid ${historyScope === s ? "#cfe0ff" : "#e4e9f0"}`,
                      background: historyScope === s ? "#eef4ff" : "#fff",
                      color: s === "item" && !item ? "#c4ccda" : historyScope === s ? "#1560f0" : "#4a5878",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: s === "item" && !item ? "not-allowed" : "pointer",
                    }}
                  >
                    {s === "item" ? "This item" : "Everything"}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
                    <th style={thStyle("18px")}>When</th>
                    <th style={thStyle()}>Item</th>
                    <th style={thStyle()}>Movement</th>
                    <th style={thStyle()}>Location</th>
                    <th style={{ ...thStyle(), textAlign: "right" }}>Qty</th>
                    <th style={thStyle()}>Reference / remarks</th>
                    <th style={{ ...thStyle(), padding: "11px 18px 11px 14px" }}>By</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const g = directionGroup(h.direction);
                    return (
                      <tr key={h.id}>
                        <td style={{ ...tdStyle("18px"), color: "#8a97b0", whiteSpace: "nowrap" }}>
                          {new Date(h.createdAt).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td style={{ ...tdStyle(), color: "#1a2b4a", fontWeight: 600 }}>{h.productName}</td>
                        <td style={tdStyle()}>
                          <span style={{ padding: "2px 8px", borderRadius: 6, background: g.tint, color: g.color, fontSize: 11.5, fontWeight: 600 }}>{h.typeName}</span>
                        </td>
                        <td style={{ ...tdStyle(), color: "#4a5878" }}>
                          {h.locationPath}
                          {h.counterpartLocationPath ? (
                            <span style={{ color: "#98a4bd" }}> {h.qty < 0 ? "→" : "←"} {h.counterpartLocationPath}</span>
                          ) : null}
                        </td>
                        <td style={{ ...tdStyle(), textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700, color: h.qty < 0 ? "#d63a3a" : "#0f9d63" }}>
                          {h.qty > 0 ? "+" : ""}
                          {h.qty}
                        </td>
                        <td style={{ ...tdStyle(), color: "#67748e", maxWidth: 260 }}>
                          {h.reference ? <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{h.reference}</span> : null}
                          {h.reference && h.remarks ? " · " : ""}
                          {h.remarks}
                          {!h.reference && !h.remarks ? <span style={{ color: "#c4ccda" }}>—</span> : null}
                        </td>
                        <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px", color: "#8a97b0" }}>{h.by}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {history.length === 0 ? <EmptyState text="No movements recorded yet." /> : null}
            </div>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
  ErrorBanner,
  PageIntro,
  SearchInput,
  EmptyState,
  Modal,
  ModalHeader,
  ModalFooter,
  thStyle,
  tdStyle,
  labelStyle,
  inputStyle,
  secondaryBtnStyle,
  primaryBtnStyle,
  actionBtnStyle,
  chipStyle,
  SortTh,
} from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

type RefName = { id: string; alias: string; source: string; hits: number };

type ItemRow = {
  id: string;
  name: string;
  productNumber: string;
  category: string;
  subcategory: string;
  unit: string;
  desc: string;
  status: string;
  attributes?: { name: string; value: string }[];
  referenceNames: RefName[];
  entryCount: number;
  lastEntryTicket: string | null;
  lastEntryAt: string | null;
  lastEntryQty: number | null;
  lastEntryLocation: string | null;
};

function sourceChip(source: string): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 11px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid",
  };
  if (source === "ai") {
    return { ...base, background: "#eef2ff", color: "#3730a3", borderColor: "#c7d2fe" };
  }
  if (source === "user") {
    return { ...base, background: "#ecfdf5", color: "#065f46", borderColor: "#a7f3d0" };
  }
  return { ...base, background: "#f1f5f9", color: "#475569", borderColor: "#e2e8f0" };
}

export default function ItemMasterPage() {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [taggedOnly, setTaggedOnly] = useState(false);

  const [viewId, setViewId] = useState<string | null>(null);
  const [tagId, setTagId] = useState<string | null>(null);
  const [newAlias, setNewAlias] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const [tagSaving, setTagSaving] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      const data = await api.get<ItemRow[]>("/api/item-master");
      setItems(data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category).filter(Boolean))].sort(),
    [items]
  );

  const filtered = items.filter((i) => {
    if (categoryFilter && i.category !== categoryFilter) return false;
    if (taggedOnly && !i.referenceNames.length) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      i.name,
      i.productNumber,
      i.category,
      i.subcategory,
      i.desc,
      ...i.referenceNames.map((r) => r.alias),
      ...(i.attributes || []).map((a) => `${a.name} ${a.value}`),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  const { sorted, sortKey, dir, toggleSort } = useSort<ItemRow, keyof ItemRow>(filtered, "name");
  const viewing = items.find((i) => i.id === viewId) || null;
  const tagging = items.find((i) => i.id === tagId) || null;

  async function addAlias() {
    if (!tagging || !newAlias.trim()) return;
    setTagSaving(true);
    setTagError(null);
    try {
      await api.post("/api/product-aliases", {
        productId: tagging.id,
        productName: tagging.name,
        alias: newAlias.trim(),
        source: "manual",
      });
      setNewAlias("");
      await load();
    } catch (e) {
      setTagError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setTagSaving(false);
    }
  }

  async function removeAlias(aliasId: string) {
    if (!tagging) return;
    setTagSaving(true);
    setTagError(null);
    try {
      await api.del(`/api/product-aliases?id=${encodeURIComponent(aliasId)}`);
      await load();
    } catch (e) {
      setTagError(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setTagSaving(false);
    }
  }

  return (
    <PageShell section="Catalog" page="Item Master" maxWidth={1280}>
      <PageIntro
        title="Item Master"
        description="Product catalog with AI reference names and inventory entry history. Tags help Telegram search & autocorrect."
      />

      {loadError && <ErrorBanner message={loadError} />}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, SKU, reference tags…" />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={{ ...inputStyle, width: "auto", minWidth: 160 }}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569", cursor: "pointer" }}>
          <input type="checkbox" checked={taggedOnly} onChange={(e) => setTaggedOnly(e.target.checked)} />
          With reference tags
        </label>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>
          {filtered.length} item{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {loading ? (
        <EmptyState text="Loading…" />
      ) : filtered.length === 0 ? (
        <EmptyState text="No items — add products in Product Master, or clear filters." />
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                <SortTh label="Item" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
                <SortTh
                  label="SKU"
                  active={sortKey === "productNumber"}
                  dir={dir}
                  onClick={() => toggleSort("productNumber")}
                />
                <SortTh
                  label="Category"
                  active={sortKey === "category"}
                  dir={dir}
                  onClick={() => toggleSort("category")}
                />
                <th style={thStyle()}>Reference names</th>
                <SortTh
                  label="Entries"
                  active={sortKey === "entryCount"}
                  dir={dir}
                  onClick={() => toggleSort("entryCount")}
                />
                <th style={thStyle()}>Last entry</th>
                <th style={thStyle()} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={tdStyle()}>
                    <div style={{ fontWeight: 600, color: "#0f172a" }}>{item.name}</div>
                    {item.unit ? (
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{item.unit}</div>
                    ) : null}
                  </td>
                  <td style={{ ...tdStyle(), fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                    {item.productNumber || "—"}
                  </td>
                  <td style={tdStyle()}>
                    <div>{item.category || "—"}</div>
                    {item.subcategory ? (
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>{item.subcategory}</div>
                    ) : null}
                  </td>
                  <td style={tdStyle()}>
                    {item.referenceNames.length === 0 ? (
                      <span style={{ color: "#94a3b8", fontSize: 12 }}>No tags yet</span>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 320 }}>
                        {item.referenceNames.slice(0, 6).map((r) => (
                          <span key={r.id} style={sourceChip(r.source)} title={`${r.source} · ${r.hits} hits`}>
                            {r.alias}
                          </span>
                        ))}
                        {item.referenceNames.length > 6 ? (
                          <span style={{ ...chipStyle(false), cursor: "default" }}>
                            +{item.referenceNames.length - 6}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdStyle(), fontVariantNumeric: "tabular-nums" }}>{item.entryCount}</td>
                  <td style={tdStyle()}>
                    {item.lastEntryTicket ? (
                      <div>
                        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{item.lastEntryTicket}</div>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>
                          {item.lastEntryAt ? new Date(item.lastEntryAt).toLocaleString() : ""}
                        </div>
                      </div>
                    ) : (
                      <span style={{ color: "#94a3b8" }}>—</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle(), whiteSpace: "nowrap" }}>
                    <button type="button" style={actionBtnStyle("#3a4a68", "#dfe5ee")} onClick={() => setViewId(item.id)}>
                      View
                    </button>{" "}
                    <button
                      type="button"
                      style={actionBtnStyle("#3a4a68", "#dfe5ee")}
                      onClick={() => {
                        setTagId(item.id);
                        setNewAlias("");
                        setTagError(null);
                      }}
                    >
                      Tags
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewing && (
        <Modal onClose={() => setViewId(null)} maxWidth={560}>
          <ModalHeader title={viewing.name} onClose={() => setViewId(null)} />
          <div style={{ padding: "16px 20px", display: "grid", gap: 12, fontSize: 13 }}>
            <Row label="SKU" value={viewing.productNumber || "—"} mono />
            <Row label="Category" value={[viewing.category, viewing.subcategory].filter(Boolean).join(" / ") || "—"} />
            <Row label="Unit" value={viewing.unit || "—"} />
            <Row label="Status" value={viewing.status || "—"} />
            {viewing.desc ? <Row label="Description" value={viewing.desc} /> : null}
            {(viewing.attributes || []).length > 0 ? (
              <div>
                <div style={{ ...labelStyle, marginBottom: 6 }}>Attributes</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {viewing.attributes!.map((a) => (
                    <span key={a.name} style={{ ...chipStyle(false), cursor: "default" }}>
                      {a.name}: {a.value}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            <div>
              <div style={{ ...labelStyle, marginBottom: 6 }}>Reference names</div>
              {viewing.referenceNames.length === 0 ? (
                <span style={{ color: "#94a3b8" }}>None yet — AI adds these when photos are identified in Telegram.</span>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {viewing.referenceNames.map((r) => (
                    <span key={r.id} style={sourceChip(r.source)} title={`${r.source} · ${r.hits} hits`}>
                      {r.alias}
                      <span style={{ opacity: 0.7, marginLeft: 4, fontSize: 10 }}>{r.source}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: 12 }}>
              <div style={{ ...labelStyle, marginBottom: 6 }}>Inventory entries</div>
              <Row label="Total entries" value={String(viewing.entryCount)} />
              {viewing.lastEntryTicket ? (
                <>
                  <Row label="Last ticket" value={viewing.lastEntryTicket} mono />
                  <Row
                    label="Last qty / location"
                    value={[
                      viewing.lastEntryQty != null ? String(viewing.lastEntryQty) : null,
                      viewing.lastEntryLocation,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  />
                </>
              ) : (
                <span style={{ color: "#94a3b8" }}>No stock-in entries yet.</span>
              )}
            </div>
          </div>
          <ModalFooter>
            <button type="button" style={secondaryBtnStyle} onClick={() => setViewId(null)}>
              Close
            </button>
            <button
              type="button"
              style={primaryBtnStyle}
              onClick={() => {
                setViewId(null);
                setTagId(viewing.id);
                setNewAlias("");
                setTagError(null);
              }}
            >
              Manage tags
            </button>
          </ModalFooter>
        </Modal>
      )}

      {tagging && (
        <Modal onClose={() => setTagId(null)} maxWidth={480}>
          <ModalHeader title={`Tags · ${tagging.name}`} onClose={() => setTagId(null)} />
          <div style={{ padding: "16px 20px", display: "grid", gap: 14 }}>
            <p style={{ margin: 0, fontSize: 13, color: "#64748b", lineHeight: 1.45 }}>
              Reference names from AI photo ID, Telegram confirmations, or manual entry. Search and autocorrect use these.
            </p>
            {tagError && <ErrorBanner message={tagError} />}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 28 }}>
              {tagging.referenceNames.length === 0 ? (
                <span style={{ color: "#94a3b8", fontSize: 13 }}>No tags yet</span>
              ) : (
                tagging.referenceNames.map((r) => (
                  <span key={r.id} style={{ ...sourceChip(r.source), display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {r.alias}
                    <button
                      type="button"
                      disabled={tagSaving}
                      onClick={() => void removeAlias(r.id)}
                      style={{
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        padding: 0,
                        fontSize: 12,
                        color: "inherit",
                        opacity: 0.7,
                        lineHeight: 1,
                      }}
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            <div>
              <label style={labelStyle}>Add reference name</label>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  placeholder="e.g. mouse wireless, logitech M185"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addAlias();
                  }}
                />
                <button type="button" style={primaryBtnStyle} disabled={tagSaving || !newAlias.trim()} onClick={() => void addAlias()}>
                  Add
                </button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, fontSize: 11, color: "#94a3b8" }}>
              <span style={sourceChip("ai")}>ai</span>
              <span style={sourceChip("user")}>user</span>
              <span style={sourceChip("manual")}>manual</span>
            </div>
          </div>
          <ModalFooter>
            <button type="button" style={secondaryBtnStyle} onClick={() => setTagId(null)}>
              Done
            </button>
          </ModalFooter>
        </Modal>
      )}
    </PageShell>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, alignItems: "baseline" }}>
      <span style={{ color: "#94a3b8", fontSize: 12 }}>{label}</span>
      <span style={{ color: "#0f172a", fontFamily: mono ? "ui-monospace, monospace" : undefined, fontSize: mono ? 12 : 13 }}>
        {value}
      </span>
    </div>
  );
}

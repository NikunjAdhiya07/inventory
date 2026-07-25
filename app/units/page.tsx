"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Sidebar from "@/components/sidebar";
import { api } from "@/lib/api-client";
import { SortTh } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

type UnitType = "Count" | "Weight" | "Volume" | "Length" | "Area";
type Status = "Active" | "Inactive";

type Unit = {
  id: string;
  name: string;
  symbol: string;
  type: UnitType;
  decimals: boolean;
  precision: string;
  factor: string;
  baseUnit: string;
  status: Status;
  refCount: number;
};

type UnitForm = {
  name: string;
  symbol: string;
  type: UnitType;
  decimals: boolean;
  precision: string;
  factor: string;
  baseUnit: string;
  status: Status;
};

const TYPE_COLORS: Record<UnitType, [string, string]> = {
  Count: ["#eaf2ff", "#1560f0"],
  Weight: ["#fff2e5", "#c9760a"],
  Volume: ["#e9f7f4", "#0d9488"],
  Length: ["#f0ecff", "#7c4ddb"],
  Area: ["#fdecf4", "#c026a8"],
};

const EMPTY_FORM: UnitForm = {
  name: "",
  symbol: "",
  type: "Count",
  decimals: false,
  precision: "2",
  factor: "",
  baseUnit: "",
  status: "Active",
};

function chipStyle(status: Status): CSSProperties {
  const active = status === "Active";
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 11px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: `1px solid ${active ? "#c7ecd8" : "#e4e9f0"}`,
    background: active ? "#eafaf1" : "#f4f6f9",
    color: active ? "#0f9d63" : "#8a97b0",
  };
}

export default function UnitsPage() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<UnitForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [delOpen, setDelOpen] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<Unit[]>("/api/units")
      .then((data) => {
        if (!cancelled) setUnits(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = units.filter(
    (u) => !q || u.name.toLowerCase().includes(q) || u.symbol.toLowerCase().includes(q)
  );
  const { sorted: sortedUnits, sortKey, dir, toggleSort } = useSort<Unit, keyof Unit>(filtered);

  const delUnit = units.find((u) => u.id === delId);
  const delBlocked = delOpen && (delUnit?.refCount || 0) > 0;
  const delClear = delOpen && !delBlocked;

  function setFormField<K extends keyof UnitForm>(key: K, value: UnitForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(u: Unit) {
    setEditingId(u.id);
    setForm({
      name: u.name,
      symbol: u.symbol,
      type: u.type,
      decimals: u.decimals,
      precision: u.precision,
      factor: u.factor,
      baseUnit: u.baseUnit,
      status: u.status,
    });
    setModalOpen(true);
  }

  function openDelete(u: Unit) {
    setDelId(u.id);
    setReassignTo(units.find((x) => x.id !== u.id)?.name || "");
    setDelOpen(true);
  }

  async function toggleStatus(u: Unit) {
    const status: Status = u.status === "Active" ? "Inactive" : "Active";
    setUnits((prev) => prev.map((x) => (x.id === u.id ? { ...x, status } : x)));
    try {
      await api.patch(`/api/units/${u.id}`, { status });
    } catch {
      setUnits((prev) => prev.map((x) => (x.id === u.id ? { ...x, status: u.status } : x)));
    }
  }

  async function save() {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      if (editingId) {
        const updated = await api.patch<Unit>(`/api/units/${editingId}`, form);
        setUnits((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
      } else {
        const created = await api.post<Unit>("/api/units", { ...form, refCount: 0 });
        setUnits((prev) => [...prev, created]);
      }
      setModalOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!delId) return;
    setDelOpen(false);
    const id = delId;
    setUnits((prev) => prev.filter((u) => u.id !== id));
    await api.del(`/api/units/${id}`);
  }

  const baseOptions = units.filter((u) => u.id !== editingId).map((u) => u.name);
  const reassignOptions = units.filter((u) => u.id !== delId).map((u) => u.name);
  const symbolLabel = form.symbol || "unit";

  return (
    <div style={{ minHeight: "100vh" }}>
      <Sidebar />
      <div style={{ marginLeft: 238, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <header
          style={{
            height: 62,
            background: "#fff",
            borderBottom: "1px solid #e9edf3",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 28px",
            position: "sticky",
            top: 0,
            zIndex: 20,
          }}
        >
          <div style={{ fontSize: 12.5, color: "#8a97b0", fontWeight: 500 }}>
            Catalog <span style={{ color: "#c4ccda" }}>/</span>{" "}
            <span style={{ color: "#1a2b4a", fontWeight: 600 }}>Units</span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 12px 5px 5px",
              background: "#f6f8fb",
              border: "1px solid #e9edf3",
              borderRadius: 24,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "linear-gradient(135deg,#0d9488,#0f766e)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              AS
            </div>
            <div style={{ lineHeight: 1.15 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Asha Sharma</div>
              <div style={{ fontSize: 10.5, color: "#98a4bd" }}>Inventory Admin</div>
            </div>
          </div>
        </header>

        <main style={{ flex: 1, padding: "26px 28px 60px", maxWidth: 1240, width: "100%" }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 20,
              marginBottom: 22,
            }}
          >
            <div>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: "-.5px", color: "#0b1b45" }}>
                Units
              </h1>
              <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "#67748e", maxWidth: 600 }}>
                Measurement units for the bot&apos;s quick-select list. Group by type and define
                conversions so the bot can normalise quantities.
              </p>
            </div>
            <button
              onClick={openAdd}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                background: "#1560f0",
                color: "#fff",
                border: "none",
                padding: "11px 18px",
                borderRadius: 9,
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "0 1px 2px rgba(21,96,240,.35),0 2px 8px rgba(21,96,240,.18)",
                whiteSpace: "nowrap",
              }}
            >
              ＋ New Unit
            </button>
          </div>

          <section
            style={{
              background: "#fff",
              border: "1px solid #e9edf3",
              borderRadius: 14,
              overflow: "hidden",
              boxShadow: "0 1px 2px rgba(16,30,54,.04)",
            }}
          >
            <div
              style={{
                padding: "15px 18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                borderBottom: "1px solid #f1f4f8",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>All units</div>
              <div style={{ position: "relative" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: "#9aa6bd",
                    fontSize: 13,
                  }}
                >
                  ⌕
                </span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search units…"
                  style={{
                    width: 230,
                    padding: "9px 12px 9px 30px",
                    border: "1px solid #dfe5ee",
                    borderRadius: 9,
                    fontSize: 13,
                    background: "#fbfcfe",
                  }}
                />
              </div>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
                  <SortTh label="Unit" leftPad="18px" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
                  <SortTh label="Symbol" active={sortKey === "symbol"} dir={dir} onClick={() => toggleSort("symbol")} />
                  <SortTh label="Type" active={sortKey === "type"} dir={dir} onClick={() => toggleSort("type")} />
                  <th style={thStyle()}>Decimals</th>
                  <th style={thStyle()}>Conversion</th>
                  <SortTh label="Status" active={sortKey === "status"} dir={dir} onClick={() => toggleSort("status")} />
                  <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedUnits.map((u) => {
                  const c = TYPE_COLORS[u.type] || ["#eef2f9", "#5a6a86"];
                  const base = units.find((x) => x.name === u.baseUnit);
                  const isBase = !u.baseUnit;
                  const decimalsLabel = u.decimals ? `Yes · ${u.precision}dp` : "No";
                  const conversion =
                    u.baseUnit && u.factor
                      ? `1 ${u.symbol} = ${u.factor} ${base ? base.symbol : u.baseUnit}`
                      : "—";
                  return (
                    <tr key={u.id}>
                      <td style={tdStyle("18px")}>
                        <div style={{ fontWeight: 600, color: "#1a2b4a" }}>
                          {u.name}
                          {isBase ? (
                            <span
                              style={{
                                marginLeft: 7,
                                fontSize: 10,
                                fontWeight: 700,
                                color: "#0f9d63",
                                background: "#e9f7f0",
                                padding: "1px 7px",
                                borderRadius: 20,
                              }}
                            >
                              base
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td style={tdStyle()}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 9px",
                            background: "#f1f4f9",
                            borderRadius: 6,
                            color: "#5a6a86",
                            fontFamily: "var(--font-mono)",
                            fontSize: 12,
                          }}
                        >
                          {u.symbol}
                        </span>
                      </td>
                      <td style={tdStyle()}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "3px 10px",
                            borderRadius: 6,
                            fontSize: 11.5,
                            fontWeight: 600,
                            background: c[0],
                            color: c[1],
                          }}
                        >
                          {u.type}
                        </span>
                      </td>
                      <td style={{ ...tdStyle(), color: "#4a5878" }}>{decimalsLabel}</td>
                      <td style={{ ...tdStyle(), color: "#8a97b0", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {conversion}
                      </td>
                      <td style={tdStyle()}>
                        <button onClick={() => toggleStatus(u)} style={chipStyle(u.status)}>
                          {u.status}
                        </button>
                      </td>
                      <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button onClick={() => openEdit(u)} style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                            Edit
                          </button>
                          <button onClick={() => openDelete(u)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && filtered.length === 0 ? (
              <div style={{ padding: 44, textAlign: "center", color: "#98a4bd", fontSize: 13.5 }}>
                No units match.
              </div>
            ) : null}
            {loading ? (
              <div style={{ padding: 44, textAlign: "center", color: "#98a4bd", fontSize: 13.5 }}>Loading…</div>
            ) : null}
          </section>
        </main>
      </div>

      {modalOpen ? (
        <div
          onClick={() => setModalOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(11,27,69,.42)",
            backdropFilter: "blur(2px)",
            zIndex: 50,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "56px 20px",
            overflowY: "auto",
            animation: "om-fade .15s ease",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              width: "100%",
              maxWidth: 540,
              borderRadius: 16,
              boxShadow: "0 24px 60px rgba(11,27,69,.28)",
              animation: "om-pop .2s cubic-bezier(.2,.9,.3,1)",
            }}
          >
            <div
              style={{
                padding: "20px 24px",
                borderBottom: "1px solid #f1f4f8",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.3px" }}>
                {editingId ? "Edit Unit" : "New Unit"}
              </h3>
              <button
                onClick={() => setModalOpen(false)}
                style={{
                  width: 32,
                  height: 32,
                  border: "none",
                  background: "#f4f7fb",
                  borderRadius: 8,
                  color: "#67748e",
                  fontSize: 17,
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
                <div>
                  <label style={labelStyle}>
                    Unit Name <span style={{ color: "#e0524f" }}>*</span>
                  </label>
                  <input
                    value={form.name}
                    onChange={(e) => setFormField("name", e.target.value)}
                    placeholder="e.g. Kilogram"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Symbol</label>
                  <input
                    value={form.symbol}
                    onChange={(e) => setFormField("symbol", e.target.value)}
                    placeholder="kg"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Unit Type</label>
                <select
                  value={form.type}
                  onChange={(e) => setFormField("type", e.target.value as UnitType)}
                  style={{ ...inputStyle, background: "#fff" }}
                >
                  <option value="Count">Count</option>
                  <option value="Weight">Weight</option>
                  <option value="Volume">Volume</option>
                  <option value="Length">Length</option>
                  <option value="Area">Area</option>
                </select>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  background: "#f8fafd",
                  border: "1px solid #eef2f7",
                  borderRadius: 11,
                  padding: 14,
                }}
              >
                <button
                  onClick={() => setFormField("decimals", !form.decimals)}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    border: `1.5px solid ${form.decimals ? "#1560f0" : "#cfd8e6"}`,
                    background: form.decimals ? "#1560f0" : "#fff",
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 700,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {form.decimals ? "✓" : ""}
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1a2b4a" }}>Allow decimals</div>
                  <div style={{ fontSize: 11.5, color: "#8a97b0" }}>
                    e.g. 2.5 kg — turn off for whole-count units like Pieces
                  </div>
                </div>
                {form.decimals ? (
                  <select
                    value={form.precision}
                    onChange={(e) => setFormField("precision", e.target.value)}
                    style={{
                      padding: "8px 10px",
                      border: "1px solid #dfe5ee",
                      borderRadius: 8,
                      fontSize: 12.5,
                      background: "#fff",
                    }}
                  >
                    <option value="2">2 places</option>
                    <option value="3">3 places</option>
                    <option value="5">5 places</option>
                  </select>
                ) : null}
              </div>
              <div style={{ border: "1px solid #eef2f7", borderRadius: 11, padding: 14 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4a68", marginBottom: 10 }}>
                  Conversion
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    fontSize: 13,
                    color: "#67748e",
                  }}
                >
                  <span>1 {symbolLabel} =</span>
                  <input
                    value={form.factor}
                    onChange={(e) => setFormField("factor", e.target.value)}
                    type="number"
                    placeholder="1"
                    style={{
                      width: 90,
                      padding: "8px 10px",
                      border: "1px solid #dfe5ee",
                      borderRadius: 8,
                      fontSize: 13,
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                  <select
                    value={form.baseUnit}
                    onChange={(e) => setFormField("baseUnit", e.target.value)}
                    style={{
                      padding: "8px 10px",
                      border: "1px solid #dfe5ee",
                      borderRadius: 8,
                      fontSize: 12.5,
                      background: "#fff",
                    }}
                  >
                    <option value="">— itself (base) —</option>
                    {baseOptions.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4a68" }}>Status</label>
                <button
                  onClick={() => setFormField("status", form.status === "Active" ? "Inactive" : "Active")}
                  style={chipStyle(form.status)}
                >
                  {form.status}
                </button>
              </div>
            </div>
            <div
              style={{
                padding: "16px 24px",
                borderTop: "1px solid #f1f4f8",
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
              }}
            >
              <button onClick={() => setModalOpen(false)} style={secondaryBtnStyle}>
                Cancel
              </button>
              <button onClick={save} disabled={saving} style={{ ...primaryBtnStyle, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Save Unit"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {delOpen ? (
        <div
          onClick={() => setDelOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(11,27,69,.42)",
            backdropFilter: "blur(2px)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            animation: "om-fade .15s ease",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              width: "100%",
              maxWidth: 460,
              borderRadius: 16,
              boxShadow: "0 24px 60px rgba(11,27,69,.28)",
              animation: "om-pop .2s cubic-bezier(.2,.9,.3,1)",
              overflow: "hidden",
            }}
          >
            {delBlocked ? (
              <>
                <div style={{ padding: 24 }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 11,
                      background: "#fff4e5",
                      color: "#d98207",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 22,
                      marginBottom: 14,
                    }}
                  >
                    ⚠
                  </div>
                  <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>
                    Can&apos;t delete &ldquo;{delUnit?.name}&rdquo;
                  </h3>
                  <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
                    This unit is referenced by{" "}
                    <strong style={{ color: "#1a2b4a" }}>{delUnit?.refCount} inventory items</strong>.
                    Reassign them to another unit before deleting.
                  </p>
                  <div
                    style={{
                      marginTop: 16,
                      background: "#f8fafd",
                      border: "1px solid #eef2f7",
                      borderRadius: 11,
                      padding: 14,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11.5,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: ".4px",
                        color: "#8a97b0",
                        marginBottom: 8,
                      }}
                    >
                      Reassign items to
                    </div>
                    <select
                      value={reassignTo}
                      onChange={(e) => setReassignTo(e.target.value)}
                      style={{ ...inputStyle, background: "#fff" }}
                    >
                      {reassignOptions.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div
                  style={{
                    padding: "14px 24px",
                    borderTop: "1px solid #f1f4f8",
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 10,
                  }}
                >
                  <button onClick={() => setDelOpen(false)} style={secondaryBtnStyle}>
                    Cancel
                  </button>
                  <button onClick={confirmDelete} style={primaryBtnStyle}>
                    Reassign &amp; Delete
                  </button>
                </div>
              </>
            ) : null}
            {delClear ? (
              <>
                <div style={{ padding: 24 }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 11,
                      background: "#fdecec",
                      color: "#d63a3a",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 22,
                      marginBottom: 14,
                    }}
                  >
                    ⌫
                  </div>
                  <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>
                    Delete &ldquo;{delUnit?.name}&rdquo;?
                  </h3>
                  <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
                    No inventory items use this unit. It moves to the Recycle Bin and can be restored for
                    30 days.
                  </p>
                </div>
                <div
                  style={{
                    padding: "14px 24px",
                    borderTop: "1px solid #f1f4f8",
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 10,
                  }}
                >
                  <button onClick={() => setDelOpen(false)} style={secondaryBtnStyle}>
                    Cancel
                  </button>
                  <button
                    onClick={confirmDelete}
                    style={{ ...primaryBtnStyle, background: "#d63a3a" }}
                  >
                    Move to Recycle Bin
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function thStyle(leftPad?: string): CSSProperties {
  return {
    padding: `11px 14px 11px ${leftPad || "14px"}`,
    fontWeight: 600,
    fontSize: 11.5,
    letterSpacing: ".3px",
    textTransform: "uppercase",
  };
}

function tdStyle(leftPad?: string): CSSProperties {
  return {
    padding: `12px 14px 12px ${leftPad || "14px"}`,
    borderTop: "1px solid #f1f4f8",
  };
}

function actionBtnStyle(color: string, border: string): CSSProperties {
  return {
    padding: "6px 12px",
    border: `1px solid ${border}`,
    background: "#fff",
    color,
    borderRadius: 7,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
  };
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12.5,
  fontWeight: 600,
  color: "#3a4a68",
  marginBottom: 6,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #dfe5ee",
  borderRadius: 9,
  fontSize: 13.5,
};

const secondaryBtnStyle: CSSProperties = {
  padding: "10px 18px",
  border: "1px solid #dfe5ee",
  background: "#fff",
  color: "#3a4a68",
  borderRadius: 9,
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
};

const primaryBtnStyle: CSSProperties = {
  padding: "10px 20px",
  border: "none",
  background: "#1560f0",
  color: "#fff",
  borderRadius: 9,
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
};

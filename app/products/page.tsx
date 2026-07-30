"use client";

import { useEffect, useMemo, useState } from "react";
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
  addBtnStyle,
  actionBtnStyle,
  chipStyle,
  SortTh,
} from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";
import { MAX_ATTRIBUTES, productMatches, type Product, type ProductAttribute, type ProductAttributeDef } from "@/lib/products";

type Named = { id: string; name: string };
type SubRef = { id: string; name: string; parent: string };

type Form = {
  name: string;
  productNumber: string;
  category: string;
  subcategory: string;
  unit: string;
  desc: string;
  status: "Active" | "Inactive";
};

const EMPTY_FORM: Form = { name: "", productNumber: "", category: "", subcategory: "", unit: "", desc: "", status: "Active" };

const CUSTOM = "__custom__";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [defs, setDefs] = useState<ProductAttributeDef[]>([]);
  const [categories, setCategories] = useState<Named[]>([]);
  const [subcategories, setSubcategories] = useState<SubRef[]>([]);
  const [units, setUnits] = useState<Named[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [rows, setRows] = useState<ProductAttribute[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [delId, setDelId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const onError = (err: Error) => !cancelled && setLoadError(err.message);
    Promise.all([
      api.get<Product[]>("/api/products"),
      api.get<ProductAttributeDef[]>("/api/product-attributes"),
      api.get<Named[]>("/api/categories"),
      api.get<SubRef[]>("/api/subcategories"),
      api.get<Named[]>("/api/units"),
    ])
      .then(([p, d, c, s, u]) => {
        if (cancelled) return;
        setProducts(p);
        setDefs(d);
        setCategories(c);
        setSubcategories(s);
        setUnits(u);
      })
      .catch(onError)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const activeDefs = useMemo(() => defs.filter((d) => d.status !== "Inactive"), [defs]);
  const defByName = useMemo(
    () => new Map(activeDefs.map((d) => [d.name.toLowerCase(), d])),
    [activeDefs]
  );

  const filtered = products.filter(
    (p) => (!categoryFilter || p.category === categoryFilter) && productMatches(p, search)
  );
  const { sorted, sortKey, dir, toggleSort } = useSort<Product, keyof Product>(filtered);
  const del = products.find((p) => p.id === delId);
  const viewing = products.find((p) => p.id === viewId);

  function setF<K extends keyof Form>(k: K, v: Form[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function openNew() {
    setEditingId(null);
    setSaveError(null);
    setForm(EMPTY_FORM);
    setRows([]);
    setModalOpen(true);
  }

  function openEdit(p: Product) {
    setEditingId(p.id);
    setSaveError(null);
    setForm({
      name: p.name,
      productNumber: p.productNumber,
      category: p.category || "",
      subcategory: p.subcategory || "",
      unit: p.unit || "",
      desc: p.desc || "",
      status: p.status,
    });
    setRows((p.attributes || []).map((a) => ({ ...a })));
    setModalOpen(true);
  }

  // ---------------- attribute rows ----------------
  function addAttribute(name: string) {
    if (rows.length >= MAX_ATTRIBUTES) return;
    setRows((r) => [...r, { name: name === CUSTOM ? "" : name, value: "" }]);
  }
  function setRow(i: number, patch: Partial<ProductAttribute>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
  }

  const usedNames = new Set(rows.map((r) => r.name.toLowerCase()));
  const availableDefs = activeDefs.filter((d) => !usedNames.has(d.name.toLowerCase()));

  async function save() {
    if (!form.name.trim()) return setSaveError("Product Name is required.");
    if (!form.productNumber.trim()) return setSaveError("Product Number is required.");
    const named = rows.filter((r) => r.name.trim());
    if (named.some((r) => !r.value.trim())) {
      return setSaveError("Every attribute needs a value — remove the ones that don't apply to this product.");
    }
    const payload = { ...form, attributes: named };
    setSaving(true);
    setSaveError(null);
    try {
      if (editingId) {
        const updated = await api.patch<Product>(`/api/products/${editingId}`, payload);
        setProducts((prev) => prev.map((p) => (p.id === editingId ? updated : p)));
      } else {
        const created = await api.post<Product>("/api/products", payload);
        setProducts((prev) => [...prev, created]);
      }
      setModalOpen(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(p: Product) {
    const status = p.status === "Active" ? "Inactive" : "Active";
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, status } : x)));
    await api.patch(`/api/products/${p.id}`, { status });
  }

  async function doDelete() {
    const id = delId;
    setDelId(null);
    setProducts((prev) => prev.filter((p) => p.id !== id));
    if (id) await api.del(`/api/products/${id}`);
  }

  const subsForCategory = form.category ? subcategories.filter((s) => s.parent === form.category) : subcategories;
  const activeCount = products.filter((p) => p.status === "Active").length;

  return (
    <PageShell section="Catalog" page="Product Master" maxWidth={1320}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Product Master"
          description="Every product the bot can log against, with the attributes that actually apply to it. Size, Grade, Colour and anything else are optional per product — define what a product has, leave out what it doesn't."
        />
        <button onClick={openNew} style={addBtnStyle}>
          ＋ New Product
        </button>
      </div>

      {loadError && <ErrorBanner message={loadError} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 22 }}>
        <Stat label="Total Products" value={products.length} />
        <Stat label="Active" value={activeCount} color="#0f9d63" />
        <Stat label="Attributes Defined" value={activeDefs.length} />
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>All products</span>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              style={{ padding: "7px 10px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fbfcfe", color: "#3a4a68" }}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, number, attribute…" width={280} />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="Product" leftPad="18px" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Product No." active={sortKey === "productNumber"} dir={dir} onClick={() => toggleSort("productNumber")} />
              <SortTh label="Category" active={sortKey === "category"} dir={dir} onClick={() => toggleSort("category")} />
              <th style={thStyle()}>Attributes</th>
              <SortTh label="Unit" active={sortKey === "unit"} dir={dir} onClick={() => toggleSort("unit")} />
              <SortTh label="Status" active={sortKey === "status"} dir={dir} onClick={() => toggleSort("status")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.id}>
                <td style={{ ...tdStyle("18px"), fontWeight: 600, color: "#1a2b4a" }}>
                  {p.name}
                  {p.subcategory ? <div style={{ fontSize: 11.5, color: "#98a4bd", fontWeight: 400, marginTop: 2 }}>{p.subcategory}</div> : null}
                </td>
                <td style={{ ...tdStyle(), fontFamily: "var(--font-mono)", color: "#4a5878" }}>{p.productNumber}</td>
                <td style={{ ...tdStyle(), color: "#4a5878" }}>{p.category || <span style={{ color: "#c4ccda" }}>—</span>}</td>
                <td style={{ ...tdStyle(), maxWidth: 320 }}>
                  {p.attributes?.length ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {p.attributes.slice(0, 3).map((a) => (
                        <span key={a.name} style={attrChipStyle}>
                          <span style={{ color: "#8a97b0" }}>{a.name}</span> {a.value}
                        </span>
                      ))}
                      {p.attributes.length > 3 ? (
                        <button onClick={() => setViewId(p.id)} style={{ ...attrChipStyle, cursor: "pointer", border: "1px solid #cfe0ff", color: "#1560f0" }}>
                          +{p.attributes.length - 3} more
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <span style={{ color: "#c4ccda" }}>None</span>
                  )}
                </td>
                <td style={{ ...tdStyle(), color: "#8a97b0" }}>{p.unit || <span style={{ color: "#c4ccda" }}>—</span>}</td>
                <td style={tdStyle()}>
                  <button onClick={() => toggleStatus(p)} style={chipStyle(p.status === "Active")}>
                    {p.status}
                  </button>
                </td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button onClick={() => openEdit(p)} style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                      Edit
                    </button>
                    <button onClick={() => setDelId(p.id)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 ? (
          <EmptyState text={products.length ? "No products match." : "No products yet. Add the first one to make it selectable in the bot."} />
        ) : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {/* Create / edit */}
      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={640}>
          <ModalHeader
            title={editingId ? "Edit Product" : "New Product"}
            subtitle="Only the name and number are mandatory — everything else applies to the products that need it."
            onClose={() => setModalOpen(false)}
          />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            {saveError ? <ErrorBanner message={saveError} /> : null}
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>
                  Product Name <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. MS Round Pipe" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>
                  Product Number <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input
                  value={form.productNumber}
                  onChange={(e) => setF("productNumber", e.target.value)}
                  placeholder="e.g. MSP-1024"
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>Category</label>
                <select
                  value={form.category}
                  onChange={(e) => {
                    setF("category", e.target.value);
                    setF("subcategory", "");
                  }}
                  style={{ ...inputStyle, background: "#fff" }}
                >
                  <option value="">—</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Subcategory</label>
                <select value={form.subcategory} onChange={(e) => setF("subcategory", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                  <option value="">—</option>
                  {subsForCategory.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Default Unit</label>
                <select value={form.unit} onChange={(e) => setF("unit", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                  <option value="">—</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.name}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Flexible attributes */}
            <div style={{ border: "1px solid #eef1f6", borderRadius: 12, padding: 14, background: "#fafbfd" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: rows.length ? 12 : 0 }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4a68" }}>Attributes</div>
                  <div style={{ fontSize: 11.5, color: "#98a4bd", marginTop: 2 }}>
                    Add only what this product has. Size, Grade, Colour — or something it alone needs.
                  </div>
                </div>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) addAttribute(e.target.value);
                    e.target.value = "";
                  }}
                  style={{ padding: "8px 10px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fff", color: "#1560f0", fontWeight: 600 }}
                >
                  <option value="">＋ Add attribute…</option>
                  {availableDefs.map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                  <option value={CUSTOM}>Custom attribute…</option>
                </select>
              </div>

              {rows.map((row, i) => {
                const def = defByName.get(row.name.trim().toLowerCase());
                return (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                    {def ? (
                      <div style={{ width: 170, fontSize: 12.5, fontWeight: 600, color: "#3a4a68", flexShrink: 0 }}>
                        {def.name}
                        {def.unit ? <span style={{ color: "#98a4bd", fontWeight: 400 }}> ({def.unit})</span> : null}
                      </div>
                    ) : (
                      <input
                        value={row.name}
                        onChange={(e) => setRow(i, { name: e.target.value })}
                        placeholder="Attribute name"
                        style={{ ...inputStyle, width: 170, flexShrink: 0 }}
                      />
                    )}
                    {def?.inputType === "select" && def.options?.length ? (
                      <select value={row.value} onChange={(e) => setRow(i, { value: e.target.value })} style={{ ...inputStyle, background: "#fff" }}>
                        <option value="">Select…</option>
                        {def.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={row.value}
                        onChange={(e) => setRow(i, { value: e.target.value })}
                        type={def?.inputType === "number" ? "number" : "text"}
                        placeholder="Value"
                        style={inputStyle}
                      />
                    )}
                    <button onClick={() => removeRow(i)} style={actionBtnStyle("#d63a3a", "#f4d0d0")} title="Remove attribute">
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>

            <div>
              <label style={labelStyle}>Description</label>
              <textarea
                value={form.desc}
                onChange={(e) => setF("desc", e.target.value)}
                rows={2}
                placeholder="Free-form notes…"
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4a68" }}>Status</label>
              <button onClick={() => setF("status", form.status === "Active" ? "Inactive" : "Active")} style={chipStyle(form.status === "Active")}>
                {form.status}
              </button>
              <span style={{ fontSize: 11.5, color: "#98a4bd" }}>Only Active products are offered in the bot.</span>
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setModalOpen(false)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={save} style={{ ...primaryBtnStyle, opacity: saving ? 0.6 : 1 }} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {/* All attributes of one product */}
      {viewing ? (
        <Modal onClose={() => setViewId(null)} maxWidth={460}>
          <ModalHeader title={viewing.name} subtitle={viewing.productNumber} onClose={() => setViewId(null)} />
          <div style={{ padding: "18px 24px" }}>
            {viewing.attributes.map((a) => (
              <div key={a.name} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f1f4f8", fontSize: 13 }}>
                <span style={{ color: "#8a97b0" }}>{a.name}</span>
                <span style={{ color: "#1a2b4a", fontWeight: 600 }}>{a.value}</span>
              </div>
            ))}
          </div>
          <ModalFooter>
            <button onClick={() => setViewId(null)} style={secondaryBtnStyle}>
              Close
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {/* Delete */}
      {delId ? (
        <Modal onClose={() => setDelId(null)} maxWidth={440} align="center">
          <div style={{ padding: 24 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
              🗑
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete &ldquo;{del?.name}&rdquo;?</h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
              It moves to the recycle bin and stops being offered in the bot. Tickets already raised against it keep the product details they captured.
            </p>
          </div>
          <ModalFooter>
            <button onClick={() => setDelId(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={doDelete} style={{ ...primaryBtnStyle, background: "#d63a3a" }}>
              Delete
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

const attrChipStyle = {
  display: "inline-flex",
  gap: 4,
  padding: "3px 9px",
  borderRadius: 20,
  background: "#f4f7fb",
  border: "1px solid #eef1f6",
  fontSize: 11.5,
  fontWeight: 600,
  color: "#3a4a68",
  whiteSpace: "nowrap" as const,
};

function Stat({ label, value, color = "#0b1b45" }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 13, padding: "18px 20px" }}>
      <div style={{ fontSize: 12.5, color: "#8a97b0", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color, letterSpacing: "-.5px", marginTop: 4 }}>{value}</div>
    </div>
  );
}

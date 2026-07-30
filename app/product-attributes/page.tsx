"use client";

import { useEffect, useState } from "react";
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
import type { ProductAttributeDef, ProductAttributeType } from "@/lib/products";

type Form = {
  name: string;
  inputType: ProductAttributeType;
  options: string;
  unit: string;
  desc: string;
  order: number | string;
  status: "Active" | "Inactive";
};

const EMPTY_FORM: Form = { name: "", inputType: "text", options: "", unit: "", desc: "", order: 1, status: "Active" };

const TYPE_HINT: Record<ProductAttributeType, string> = {
  text: "Free text — anything the product needs.",
  number: "Digits only, with an optional unit suffix.",
  select: "One of a fixed list of allowed values.",
};

export default function ProductAttributesPage() {
  const [attrs, setAttrs] = useState<ProductAttributeDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [delId, setDelId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ProductAttributeDef[]>("/api/product-attributes")
      .then((d) => !cancelled && setAttrs(d))
      .catch((err: Error) => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = attrs.filter((a) => !q || a.name.toLowerCase().includes(q));
  const { sorted, sortKey, dir, toggleSort } = useSort<ProductAttributeDef, keyof ProductAttributeDef>(filtered);
  const del = attrs.find((a) => a.id === delId);

  function setF<K extends keyof Form>(k: K, v: Form[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function openNew() {
    setEditingId(null);
    setSaveError(null);
    setForm({ ...EMPTY_FORM, order: attrs.length + 1 });
    setModalOpen(true);
  }

  function openEdit(a: ProductAttributeDef) {
    setEditingId(a.id);
    setSaveError(null);
    setForm({
      name: a.name,
      inputType: a.inputType || "text",
      options: (a.options || []).join(", "),
      unit: a.unit || "",
      desc: a.desc || "",
      order: a.order ?? 1,
      status: a.status,
    });
    setModalOpen(true);
  }

  async function save() {
    if (!form.name.trim()) {
      setSaveError("Attribute name is required.");
      return;
    }
    const payload = {
      name: form.name.trim(),
      inputType: form.inputType,
      // A select with no allowed values would render an empty dropdown on every
      // product form, so the type quietly falls back to free text instead.
      options:
        form.inputType === "select"
          ? form.options.split(",").map((o) => o.trim()).filter(Boolean)
          : [],
      unit: form.unit.trim(),
      desc: form.desc.trim(),
      order: Number(form.order) || 1,
      status: form.status,
    };
    try {
      if (editingId) {
        const updated = await api.patch<ProductAttributeDef>(`/api/product-attributes/${editingId}`, payload);
        setAttrs((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
      } else {
        const created = await api.post<ProductAttributeDef>("/api/product-attributes", payload);
        setAttrs((prev) => [...prev, created]);
      }
      setModalOpen(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    }
  }

  async function toggleStatus(a: ProductAttributeDef) {
    const status = a.status === "Active" ? "Inactive" : "Active";
    setAttrs((prev) => prev.map((x) => (x.id === a.id ? { ...x, status } : x)));
    await api.patch(`/api/product-attributes/${a.id}`, { status });
  }

  async function doDelete() {
    const id = delId;
    setDelId(null);
    setAttrs((prev) => prev.filter((x) => x.id !== id));
    if (id) await api.del(`/api/product-attributes/${id}`);
  }

  return (
    <PageShell section="Catalog" page="Product Attributes">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Product Attributes"
          description="The reusable attributes products can carry — Size, Grade, Colour, and anything else. Defining one here means it is spelled and entered the same way on every product; a product only carries the ones that apply to it."
        />
        <button onClick={openNew} style={addBtnStyle}>
          ＋ New Attribute
        </button>
      </div>

      {loadError && <ErrorBanner message={loadError} />}

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>All attributes</span>
          <SearchInput value={search} onChange={setSearch} placeholder="Search attributes…" />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="Attribute" leftPad="18px" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Input Type" active={sortKey === "inputType"} dir={dir} onClick={() => toggleSort("inputType")} />
              <th style={thStyle()}>Allowed Values</th>
              <th style={thStyle()}>Unit</th>
              <SortTh label="Order" align="center" active={sortKey === "order"} dir={dir} onClick={() => toggleSort("order")} />
              <SortTh label="Status" active={sortKey === "status"} dir={dir} onClick={() => toggleSort("status")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id}>
                <td style={{ ...tdStyle("18px"), fontWeight: 600, color: "#1a2b4a" }}>
                  {a.name}
                  {a.desc ? <div style={{ fontSize: 11.5, color: "#98a4bd", fontWeight: 400, marginTop: 2 }}>{a.desc}</div> : null}
                </td>
                <td style={{ ...tdStyle(), color: "#4a5878" }}>{a.inputType || "text"}</td>
                <td style={{ ...tdStyle(), color: "#8a97b0", maxWidth: 300 }}>
                  {a.options?.length ? a.options.join(" · ") : <span style={{ color: "#c4ccda" }}>—</span>}
                </td>
                <td style={{ ...tdStyle(), color: "#8a97b0" }}>{a.unit || <span style={{ color: "#c4ccda" }}>—</span>}</td>
                <td style={{ ...tdStyle(), textAlign: "center", color: "#8a97b0", fontFamily: "var(--font-mono)" }}>{a.order}</td>
                <td style={tdStyle()}>
                  <button onClick={() => toggleStatus(a)} style={chipStyle(a.status === "Active")}>
                    {a.status}
                  </button>
                </td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button onClick={() => openEdit(a)} style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                      Edit
                    </button>
                    <button onClick={() => setDelId(a.id)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 ? <EmptyState text="No attributes defined yet." /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={520}>
          <ModalHeader
            title={editingId ? "Edit Attribute" : "New Attribute"}
            subtitle="Products pick from these when they need the attribute."
            onClose={() => setModalOpen(false)}
          />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            {saveError ? <ErrorBanner message={saveError} /> : null}
            <div>
              <label style={labelStyle}>
                Attribute Name <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Grade" style={inputStyle} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 90px", gap: 14 }}>
              <div>
                <label style={labelStyle}>Input Type</label>
                <select
                  value={form.inputType}
                  onChange={(e) => setF("inputType", e.target.value as ProductAttributeType)}
                  style={{ ...inputStyle, background: "#fff" }}
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="select">Choice list</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Unit</label>
                <input value={form.unit} onChange={(e) => setF("unit", e.target.value)} placeholder="mm, kg…" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Order</label>
                <input value={form.order} onChange={(e) => setF("order", e.target.value)} type="number" style={inputStyle} />
              </div>
            </div>
            <div style={{ fontSize: 12, color: "#98a4bd", marginTop: -6 }}>{TYPE_HINT[form.inputType]}</div>
            {form.inputType === "select" ? (
              <div>
                <label style={labelStyle}>
                  Allowed Values <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input
                  value={form.options}
                  onChange={(e) => setF("options", e.target.value)}
                  placeholder="Comma separated — e.g. A, B, C"
                  style={inputStyle}
                />
              </div>
            ) : null}
            <div>
              <label style={labelStyle}>Description</label>
              <textarea
                value={form.desc}
                onChange={(e) => setF("desc", e.target.value)}
                rows={2}
                placeholder="What this attribute means…"
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4a68" }}>Status</label>
              <button onClick={() => setF("status", form.status === "Active" ? "Inactive" : "Active")} style={chipStyle(form.status === "Active")}>
                {form.status}
              </button>
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setModalOpen(false)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={save} style={primaryBtnStyle}>
              Save
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {delId ? (
        <Modal onClose={() => setDelId(null)} maxWidth={440} align="center">
          <div style={{ padding: 24 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
              🗑
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete &ldquo;{del?.name}&rdquo;?</h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
              Products that already carry this attribute keep their values — only the definition is removed, so it stops being offered on new products. It moves to the recycle bin.
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

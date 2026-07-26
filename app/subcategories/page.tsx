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

type Sub = {
  id: string;
  name: string;
  parent: string;
  desc: string;
  order: number;
  status: "Active" | "Inactive";
};

type CategoryRef = { id: string; name: string; color: string };

type SubForm = { name: string; parent: string; desc: string; order: number | string; status: "Active" | "Inactive" };

const EMPTY_FORM: SubForm = { name: "", parent: "", desc: "", order: 1, status: "Active" };

export default function SubcategoriesPage() {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [categories, setCategories] = useState<CategoryRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [parentFilter, setParentFilter] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SubForm>(EMPTY_FORM);

  const [delOpen, setDelOpen] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<Sub[]>("/api/subcategories"), api.get<CategoryRef[]>("/api/categories")])
      .then(([subData, catData]) => {
        if (cancelled) return;
        setSubs(subData);
        setCategories(catData);
        setForm((f) => (f.parent ? f : { ...f, parent: catData[0]?.name || "" }));
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const PARENTS = categories.map((c) => c.name);
  const CAT_COLORS: Record<string, string> = Object.fromEntries(categories.map((c) => [c.name, c.color]));

  const q = search.trim().toLowerCase();
  const filtered = subs.filter((x) => (!q || x.name.toLowerCase().includes(q)) && (!parentFilter || x.parent === parentFilter));
  const { sorted: sortedSubs, sortKey, dir, toggleSort } = useSort<Sub, keyof Sub>(filtered);
  const del = subs.find((x) => x.id === delId);

  function setF<K extends keyof SubForm>(k: K, v: SubForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!form.name.trim()) return;
    const payload = { ...form, order: Number(form.order) || 1 };
    if (editingId) {
      const updated = await api.patch<Sub>(`/api/subcategories/${editingId}`, payload);
      setSubs((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
    } else {
      const created = await api.post<Sub>("/api/subcategories", payload);
      setSubs((prev) => [...prev, created]);
    }
    setModalOpen(false);
  }

  async function toggleStatus(x: Sub) {
    const status = x.status === "Active" ? "Inactive" : "Active";
    setSubs((prev) => prev.map((y) => (y.id === x.id ? { ...y, status } : y)));
    await api.patch(`/api/subcategories/${x.id}`, { status });
  }

  async function doDelete() {
    setDelOpen(false);
    const id = delId;
    setSubs((prev) => prev.filter((x) => x.id !== id));
    if (id) await api.del(`/api/subcategories/${id}`);
  }

  return (
    <PageShell section="Master Data" page="Subcategories">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro title="Subcategories" description="Nested groupings under a parent category. Reassign the parent anytime without losing history." />
        <button
          onClick={() => {
            setEditingId(null);
            setForm({ ...EMPTY_FORM, parent: categories[0]?.name || "" });
            setModalOpen(true);
          }}
          style={addBtnStyle}
        >
          ＋ New Subcategory
        </button>
      </div>

      {loadError && <ErrorBanner message={loadError} />}

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>All subcategories</span>
            <select
              value={parentFilter}
              onChange={(e) => setParentFilter(e.target.value)}
              style={{ padding: "7px 10px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fbfcfe", color: "#3a4a68" }}
            >
              <option value="">All parents</option>
              {PARENTS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search subcategories…" />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="Subcategory" leftPad="18px" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Parent Category" active={sortKey === "parent"} dir={dir} onClick={() => toggleSort("parent")} />
              <th style={thStyle()}>Description</th>
              <SortTh label="Order" align="center" active={sortKey === "order"} dir={dir} onClick={() => toggleSort("order")} />
              <SortTh label="Status" active={sortKey === "status"} dir={dir} onClick={() => toggleSort("status")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedSubs.map((x) => (
              <tr key={x.id}>
                <td style={{ ...tdStyle("18px"), fontWeight: 600, color: "#1a2b4a" }}>{x.name}</td>
                <td style={tdStyle()}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 500, color: "#3a4a68" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: CAT_COLORS[x.parent] || "#94a3b8", flexShrink: 0 }} />
                    {x.parent}
                  </span>
                </td>
                <td style={{ ...tdStyle(), color: "#8a97b0", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.desc}</td>
                <td style={{ ...tdStyle(), textAlign: "center", color: "#8a97b0", fontFamily: "var(--font-mono)" }}>{x.order}</td>
                <td style={tdStyle()}>
                  <button onClick={() => toggleStatus(x)} style={chipStyle(x.status === "Active")}>
                    {x.status}
                  </button>
                </td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => {
                        setEditingId(x.id);
                        setForm({ name: x.name, parent: x.parent, desc: x.desc, order: x.order, status: x.status });
                        setModalOpen(true);
                      }}
                      style={actionBtnStyle("#3a4a68", "#dfe5ee")}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        setDelId(x.id);
                        setDelOpen(true);
                      }}
                      style={actionBtnStyle("#d63a3a", "#f4d0d0")}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 ? <EmptyState text="No subcategories match." /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={520}>
          <ModalHeader title={editingId ? "Edit Subcategory" : "New Subcategory"} onClose={() => setModalOpen(false)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>
                Subcategory Name <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Pipe Fittings" style={inputStyle} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>
                  Parent Category <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <select value={form.parent} onChange={(e) => setF("parent", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                  {PARENTS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Order</label>
                <input value={form.order} onChange={(e) => setF("order", e.target.value)} type="number" style={inputStyle} />
              </div>
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

      {delOpen ? (
        <Modal onClose={() => setDelOpen(false)} maxWidth={440} align="center">
          <div style={{ padding: 24 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
              🗑
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete &ldquo;{del?.name}&rdquo;?</h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
              This subcategory has no linked inventory items. The delete is recorded in the audit trail.
            </p>
          </div>
          <ModalFooter>
            <button onClick={() => setDelOpen(false)} style={secondaryBtnStyle}>
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

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

const PALETTE = ["#3392ff", "#0d9488", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#10b981", "#6366f1", "#f97316", "#14b8a6", "#e11d48", "#0ea5e9"];
const UNITS = ["Pieces", "Kilogram", "Meter", "Liter", "Box", "Roll"];

type Category = {
  id: string;
  name: string;
  code: string;
  desc: string;
  defaultUnit: string;
  order: number;
  priority: number;
  color: string;
  status: "Active" | "Inactive";
  subCount: number;
  refCount: number;
};

type CategoryForm = {
  name: string;
  code: string;
  desc: string;
  defaultUnit: string;
  order: number | string;
  priority: number | string;
  color: string;
  status: "Active" | "Inactive";
};

type Sub = { id: string; name: string; parent: string; desc: string; order: number; status: "Active" | "Inactive" };
type SubForm = { name: string; desc: string; order: number | string; status: "Active" | "Inactive" };

const EMPTY_FORM: CategoryForm = { name: "", code: "", desc: "", defaultUnit: "Pieces", order: 1, priority: 0, color: PALETTE[0], status: "Active" };
const EMPTY_SUB_FORM: SubForm = { name: "", desc: "", order: 1, status: "Active" };

export default function CategoriesPage() {
  const [cats, setCats] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CategoryForm>(EMPTY_FORM);

  const [delOpen, setDelOpen] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState("");

  const [subs, setSubs] = useState<Sub[]>([]);
  const [subsCat, setSubsCat] = useState<Category | null>(null);
  const [subEditingId, setSubEditingId] = useState<string | null>(null);
  const [subFormOpen, setSubFormOpen] = useState(false);
  const [subForm, setSubForm] = useState<SubForm>(EMPTY_SUB_FORM);
  const [subDelId, setSubDelId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<Category[]>("/api/categories"), api.get<Sub[]>("/api/subcategories")])
      .then(([catData, subData]) => {
        if (cancelled) return;
        setCats(catData);
        setSubs(subData);
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

  const q = search.trim().toLowerCase();
  const filtered = cats.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
  const { sorted: sortedCats, sortKey, dir, toggleSort, resetSort } = useSort<Category, keyof Category>(filtered);
  const manualOrder = sortKey === null;

  const del = cats.find((c) => c.id === delId);
  const delBlocked = delOpen && (del?.refCount || 0) > 0;
  const delClear = delOpen && !delBlocked;

  function setF<K extends keyof CategoryForm>(k: K, v: CategoryForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function openAdd() {
    const order = Math.max(0, ...cats.map((c) => c.order)) + 1;
    setEditingId(null);
    setForm({ ...EMPTY_FORM, order, color: PALETTE[Math.floor(Math.random() * PALETTE.length)] });
    setModalOpen(true);
  }

  function openEdit(c: Category) {
    setEditingId(c.id);
    setForm({ name: c.name, code: c.code, desc: c.desc, defaultUnit: c.defaultUnit, order: c.order, priority: c.priority, color: c.color, status: c.status });
    setModalOpen(true);
  }

  async function save() {
    if (!form.name.trim()) return;
    const payload = { ...form, order: Number(form.order) || 1, priority: Number(form.priority) || 0 };
    if (editingId) {
      const updated = await api.patch<Category>(`/api/categories/${editingId}`, payload);
      setCats((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
    } else {
      const created = await api.post<Category>("/api/categories", { ...payload, subCount: 0, refCount: 0 });
      setCats((prev) => [...prev, created]);
    }
    setModalOpen(false);
  }

  async function doDelete() {
    setDelOpen(false);
    const id = delId;
    setCats((prev) => prev.filter((c) => c.id !== id));
    if (id) await api.del(`/api/categories/${id}`);
  }

  function reorder(targetId: string) {
    let ids: string[] | null = null;
    setCats((prev) => {
      const arr = [...prev];
      const from = arr.findIndex((c) => c.id === dragId);
      const to = arr.findIndex((c) => c.id === targetId);
      if (from < 0 || to < 0 || from === to) return prev;
      const [m] = arr.splice(from, 1);
      arr.splice(to, 0, m);
      arr.forEach((c, i) => (c.order = i + 1));
      ids = arr.map((c) => c.id);
      return arr;
    });
    setDragId(null);
    if (ids) api.post("/api/categories/reorder", { ids });
  }

  const catSubs = subsCat ? subs.filter((s) => s.parent === subsCat.name).sort((a, b) => a.order - b.order) : [];
  const subDel = subs.find((s) => s.id === subDelId);

  function openSubs(c: Category) {
    setSubsCat(c);
    setSubFormOpen(false);
    setSubEditingId(null);
  }

  function setSF<K extends keyof SubForm>(k: K, v: SubForm[K]) {
    setSubForm((f) => ({ ...f, [k]: v }));
  }

  function openSubAdd() {
    setSubEditingId(null);
    setSubForm({ ...EMPTY_SUB_FORM, order: catSubs.length + 1 });
    setSubFormOpen(true);
  }

  function openSubEdit(s: Sub) {
    setSubEditingId(s.id);
    setSubForm({ name: s.name, desc: s.desc, order: s.order, status: s.status });
    setSubFormOpen(true);
  }

  async function saveSub() {
    if (!subForm.name.trim() || !subsCat) return;
    const payload = { ...subForm, order: Number(subForm.order) || 1, parent: subsCat.name };
    if (subEditingId) {
      const updated = await api.patch<Sub>(`/api/subcategories/${subEditingId}`, payload);
      setSubs((prev) => prev.map((x) => (x.id === subEditingId ? updated : x)));
    } else {
      const created = await api.post<Sub>("/api/subcategories", payload);
      setSubs((prev) => [...prev, created]);
    }
    setSubFormOpen(false);
  }

  async function toggleSubStatus(s: Sub) {
    const status = s.status === "Active" ? "Inactive" : "Active";
    setSubs((prev) => prev.map((x) => (x.id === s.id ? { ...x, status } : x)));
    await api.patch(`/api/subcategories/${s.id}`, { status });
  }

  async function confirmDeleteSub() {
    const id = subDelId;
    setSubDelId(null);
    setSubs((prev) => prev.filter((x) => x.id !== id));
    if (id) await api.del(`/api/subcategories/${id}`);
  }

  return (
    <PageShell section="Master Data" page="Categories">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro title="Categories" description="Top-level groupings for every inventory item. Each carries a color used across the bot, lists and reports." />
        <button onClick={openAdd} style={addBtnStyle}>
          ＋ New Category
        </button>
      </div>

      {loadError && <ErrorBanner message={loadError} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 22 }}>
        <div style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 13, padding: "18px 20px" }}>
          <div style={{ fontSize: 12.5, color: "#8a97b0", fontWeight: 600 }}>Total Categories</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.5px", marginTop: 4 }}>{cats.length}</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 13, padding: "18px 20px" }}>
          <div style={{ fontSize: 12.5, color: "#8a97b0", fontWeight: 600 }}>Active</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#0f9d63", letterSpacing: "-.5px", marginTop: 4 }}>
            {cats.filter((c) => c.status === "Active").length}
          </div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 13, padding: "18px 20px" }}>
          <div style={{ fontSize: 12.5, color: "#8a97b0", fontWeight: 600 }}>Subcategories linked</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.5px", marginTop: 4 }}>
            {cats.reduce((a, c) => a + c.subCount, 0)}
          </div>
        </div>
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>All categories</div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name or code…" width={250} />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <th style={{ width: 34, padding: "11px 8px 11px 16px" }} title={manualOrder ? "Drag rows to reorder" : "Reset sort to drag-reorder"} onClick={manualOrder ? undefined : resetSort}>
                {manualOrder ? "" : <span style={{ cursor: "pointer", fontSize: 10.5, color: "#1560f0" }}>↺</span>}
              </th>
              <SortTh label="Category" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Default Unit" active={sortKey === "defaultUnit"} dir={dir} onClick={() => toggleSort("defaultUnit")} />
              <SortTh label="Subcats" align="center" active={sortKey === "subCount"} dir={dir} onClick={() => toggleSort("subCount")} />
              <SortTh label="Order" align="center" active={sortKey === "order"} dir={dir} onClick={() => toggleSort("order")} />
              <SortTh label="Priority" align="center" active={sortKey === "priority"} dir={dir} onClick={() => toggleSort("priority")} />
              <SortTh label="Status" active={sortKey === "status"} dir={dir} onClick={() => toggleSort("status")} />
              <th style={{ ...thStyle(), padding: "11px 16px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedCats.map((c) => (
              <tr
                key={c.id}
                draggable={manualOrder}
                onDragStart={() => manualOrder && setDragId(c.id)}
                onDragOver={(e) => manualOrder && e.preventDefault()}
                onDrop={() => manualOrder && reorder(c.id)}
                onDragEnd={() => setDragId(null)}
                style={{ transition: "background .12s", background: dragId === c.id ? "#eef4ff" : undefined }}
              >
                <td style={{ padding: "12px 8px 12px 16px", color: manualOrder ? "#c4ccda" : "#e9edf3", fontSize: 15, cursor: manualOrder ? "grab" : "default", textAlign: "center" }}>⠿</td>
                <td style={tdStyle()}>
                  <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                    <span style={{ width: 11, height: 11, borderRadius: 4, background: c.color, boxShadow: `0 0 0 3px ${c.color}22`, flexShrink: 0 }} />
                    <div style={{ lineHeight: 1.3 }}>
                      <div style={{ fontWeight: 600, color: "#1a2b4a" }}>{c.name}</div>
                      <div style={{ fontSize: 11.5, color: "#98a4bd", fontFamily: "var(--font-mono)" }}>{c.code}</div>
                    </div>
                  </div>
                </td>
                <td style={{ ...tdStyle(), color: "#4a5878" }}>{c.defaultUnit}</td>
                <td style={{ ...tdStyle(), textAlign: "center" }}>
                  <button
                    onClick={() => openSubs(c)}
                    title="View subcategories"
                    style={{
                      border: "none",
                      background: "#f1f4f9",
                      color: "#3a4a68",
                      fontWeight: 700,
                      fontSize: 12.5,
                      padding: "4px 10px",
                      borderRadius: 20,
                      cursor: "pointer",
                    }}
                  >
                    {c.subCount}
                  </button>
                </td>
                <td style={{ ...tdStyle(), textAlign: "center", color: "#8a97b0", fontFamily: "var(--font-mono)" }}>{c.order}</td>
                <td style={{ ...tdStyle(), textAlign: "center" }}>
                  {c.priority > 0 ? (
                    <span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: "#fff4e5", color: "#d98207" }}>
                      {c.priority}
                    </span>
                  ) : (
                    <span style={{ color: "#c4ccda" }}>—</span>
                  )}
                </td>
                <td style={tdStyle()}>
                  <button
                    onClick={() => {
                      const status = c.status === "Active" ? "Inactive" : "Active";
                      setCats((prev) => prev.map((x) => (x.id === c.id ? { ...x, status } : x)));
                      api.patch(`/api/categories/${c.id}`, { status });
                    }}
                    style={chipStyle(c.status === "Active")}
                  >
                    {c.status}
                  </button>
                </td>
                <td style={{ ...tdStyle(), padding: "12px 16px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button onClick={() => openSubs(c)} style={actionBtnStyle("#1560f0", "#cfe0ff")}>
                      Subcategories
                    </button>
                    <button onClick={() => openEdit(c)} style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        setDelId(c.id);
                        setReassignTo(cats.find((x) => x.id !== c.id)?.name || "");
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
        {!loading && filtered.length === 0 ? <EmptyState text="No categories match your search." /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)}>
          <ModalHeader
            title={editingId ? "Edit Category" : "New Category"}
            subtitle="Changes are logged and sync instantly to the bot."
            onClose={() => setModalOpen(false)}
          />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>
                Category Name <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Plumbing" style={inputStyle} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>Category Code</label>
                <input value={form.code} onChange={(e) => setF("code", e.target.value)} placeholder="PLM" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
              </div>
              <div>
                <label style={labelStyle}>Display Order</label>
                <input value={form.order} onChange={(e) => setF("order", e.target.value)} type="number" style={inputStyle} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Priority</label>
              <input value={form.priority} onChange={(e) => setF("priority", e.target.value)} type="number" placeholder="0" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Default Unit</label>
              <select value={form.defaultUnit} onChange={(e) => setF("defaultUnit", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
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
            <div>
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5, fontWeight: 600, color: "#3a4a68", marginBottom: 8 }}>
                Color
                <button
                  onClick={() => setF("color", PALETTE[Math.floor(Math.random() * PALETTE.length)])}
                  style={{ border: "none", background: "none", color: "#1560f0", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}
                >
                  ↻ Random
                </button>
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {PALETTE.map((col) => (
                  <button
                    key={col}
                    onClick={() => setF("color", col)}
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: col,
                      cursor: "pointer",
                      border: `2px solid ${form.color === col ? "#0b1b45" : "transparent"}`,
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 2 }}>
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
              Save Category
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {delOpen ? (
        <Modal onClose={() => setDelOpen(false)} maxWidth={460} align="center">
          {delBlocked ? (
            <>
              <div style={{ padding: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fff4e5", color: "#d98207", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
                  ⚠
                </div>
                <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Can&apos;t delete &ldquo;{del?.name}&rdquo;</h3>
                <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
                  This category is referenced by <strong style={{ color: "#1a2b4a" }}>{del?.refCount} inventory items</strong>. Reassign them to another
                  category before deleting.
                </p>
                <div style={{ marginTop: 16, background: "#f8fafd", border: "1px solid #eef2f7", borderRadius: 11, padding: 14 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", color: "#8a97b0", marginBottom: 8 }}>
                    Reassign items to
                  </div>
                  <select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                    {cats
                      .filter((c) => c.id !== delId)
                      .map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <ModalFooter>
                <button onClick={() => setDelOpen(false)} style={secondaryBtnStyle}>
                  Cancel
                </button>
                <button onClick={doDelete} style={primaryBtnStyle}>
                  Reassign &amp; Delete
                </button>
              </ModalFooter>
            </>
          ) : null}
          {delClear ? (
            <>
              <div style={{ padding: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
                  🗑
                </div>
                <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete &ldquo;{del?.name}&rdquo;?</h3>
                <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
                  No inventory items reference this category. This action is logged in the audit trail and can&apos;t be undone.
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
            </>
          ) : null}
        </Modal>
      ) : null}

      {subsCat ? (
        <Modal onClose={() => setSubsCat(null)} maxWidth={560}>
          <ModalHeader
            title={`${subsCat.name} — Subcategories`}
            subtitle={`${catSubs.length} of ${subsCat.subCount} tracked in the database`}
            onClose={() => setSubsCat(null)}
          />
          <div style={{ padding: "18px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            {catSubs.length === 0 ? (
              <div style={{ padding: "18px 0", textAlign: "center", color: "#98a4bd", fontSize: 13 }}>No subcategories added yet.</div>
            ) : (
              <div style={{ border: "1px solid #eef1f6", borderRadius: 12, overflow: "hidden" }}>
                {catSubs.map((s, i) => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 14px",
                      borderTop: i === 0 ? "none" : "1px solid #f1f4f8",
                    }}
                  >
                    <span style={{ fontSize: 11, color: "#c4ccda", fontFamily: "var(--font-mono)", width: 16, flexShrink: 0 }}>{s.order}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: "#1a2b4a", fontSize: 13 }}>{s.name}</div>
                      {s.desc ? (
                        <div style={{ fontSize: 11.5, color: "#98a4bd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.desc}</div>
                      ) : null}
                    </div>
                    <button onClick={() => toggleSubStatus(s)} style={chipStyle(s.status === "Active")}>
                      {s.status}
                    </button>
                    <button onClick={() => openSubEdit(s)} style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                      Edit
                    </button>
                    <button onClick={() => setSubDelId(s.id)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}

            {subFormOpen ? (
              <div style={{ border: "1px solid #eef2f7", borderRadius: 11, padding: 14, background: "#f8fafd", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
                  <div>
                    <label style={labelStyle}>
                      Name <span style={{ color: "#e0524f" }}>*</span>
                    </label>
                    <input value={subForm.name} onChange={(e) => setSF("name", e.target.value)} placeholder="e.g. Wiring" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Order</label>
                    <input value={subForm.order} onChange={(e) => setSF("order", e.target.value)} type="number" style={inputStyle} />
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Description</label>
                  <input value={subForm.desc} onChange={(e) => setSF("desc", e.target.value)} placeholder="Optional" style={inputStyle} />
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <label style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4a68" }}>Status</label>
                    <button onClick={() => setSF("status", subForm.status === "Active" ? "Inactive" : "Active")} style={chipStyle(subForm.status === "Active")}>
                      {subForm.status}
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setSubFormOpen(false)} style={secondaryBtnStyle}>
                      Cancel
                    </button>
                    <button onClick={saveSub} style={primaryBtnStyle}>
                      {subEditingId ? "Save" : "Add"}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button onClick={openSubAdd} style={{ ...addBtnStyle, alignSelf: "flex-start" }}>
                ＋ Add Subcategory
              </button>
            )}
          </div>
        </Modal>
      ) : null}

      {subDelId ? (
        <Modal onClose={() => setSubDelId(null)} maxWidth={420} align="center">
          <div style={{ padding: 24 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
              🗑
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete &ldquo;{subDel?.name}&rdquo;?</h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
              This removes the subcategory record. The delete is recorded in the audit trail.
            </p>
          </div>
          <ModalFooter>
            <button onClick={() => setSubDelId(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={confirmDeleteSub} style={{ ...primaryBtnStyle, background: "#d63a3a" }}>
              Delete
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

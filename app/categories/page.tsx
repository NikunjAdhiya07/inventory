"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
  ErrorBanner,
  PageIntro,
  Modal,
  ModalFooter,
  thStyle,
  tdStyle,
  labelStyle,
  inputStyle,
  secondaryBtnStyle,
  primaryBtnStyle,
  addBtnStyle,
  chipStyle,
  EmptyState,
} from "@/components/dc-ui";

const PALETTE = ["#3392ff", "#0d9488", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#10b981", "#6366f1", "#f97316", "#14b8a6", "#e11d48", "#0ea5e9"];
const UNITS = ["Pieces", "Kilogram", "Meter", "Liter", "Box", "Roll"];

type Node = {
  id: string;
  parent: string | null;
  name: string;
  code: string;
  desc: string;
  level: string;
  defaultUnit: string;
  color: string;
  order: number;
  status: "Active" | "Inactive";
  refCount: number;
};

type NodeForm = {
  name: string;
  code: string;
  desc: string;
  level: string;
  defaultUnit: string;
  color: string;
  status: "Active" | "Inactive";
};

const EMPTY_FORM: NodeForm = {
  name: "",
  code: "",
  desc: "",
  level: "",
  defaultUnit: "Pieces",
  color: PALETTE[0],
  status: "Active",
};

export default function CategoriesPage() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [form, setForm] = useState<NodeForm>(EMPTY_FORM);

  const [delOpen, setDelOpen] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);
  const [infoId, setInfoId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Node[]>("/api/categories")
      .then((data) => {
        if (cancelled) return;
        const normalized = normalizeNodes(data);
        setNodes(normalized);
        // Closed by default — only roots are visible until the user expands.
        const collapse: Record<string, boolean> = {};
        for (const n of normalized) {
          if (normalized.some((c) => (c.parent ?? null) === n.id)) collapse[n.id] = true;
        }
        setCollapsed(collapse);
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

  function childrenOf(id: string | null) {
    return nodes
      .filter((n) => (n.parent ?? null) === id)
      .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
  }
  function hasChildren(id: string) {
    return nodes.some((n) => (n.parent ?? null) === id);
  }

  function pathOf(id: string): string {
    const names: string[] = [];
    let cur: Node | undefined = nodes.find((n) => n.id === id);
    for (let hops = 0; cur && hops < 24; hops++) {
      names.unshift(cur.name);
      cur = cur.parent ? nodes.find((n) => n.id === cur!.parent) : undefined;
    }
    return names.join(" › ");
  }

  function descendantCount(id: string): number {
    let total = 0;
    const walk = (pid: string) => {
      for (const c of childrenOf(pid)) {
        total += 1;
        walk(c.id);
      }
    };
    walk(id);
    return total;
  }

  function flatten() {
    const out: { node: Node; depth: number }[] = [];
    const walk = (pid: string | null, depth: number) => {
      childrenOf(pid).forEach((n) => {
        out.push({ node: n, depth });
        if (!collapsed[n.id]) walk(n.id, depth + 1);
      });
    };
    walk(null, 0);
    return out;
  }

  function setF<K extends keyof NodeForm>(k: K, v: NodeForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function openAdd(pid: string | null) {
    setEditingId(null);
    setParentId(pid);
    const siblingCount = childrenOf(pid).length;
    setForm({
      ...EMPTY_FORM,
      level: pid ? "Subcategory" : "Category",
      color: PALETTE[siblingCount % PALETTE.length],
    });
    setModalOpen(true);
  }

  function openEdit(n: Node) {
    setEditingId(n.id);
    setParentId(n.parent);
    setForm({
      name: n.name,
      code: n.code || "",
      desc: n.desc || "",
      level: n.level || (n.parent ? "Subcategory" : "Category"),
      defaultUnit: n.defaultUnit || "Pieces",
      color: n.color || PALETTE[0],
      status: n.status,
    });
    setModalOpen(true);
  }

  async function save() {
    if (!form.name.trim()) return;
    if (editingId) {
      const updated = await api.patch<Node>(`/api/categories/${editingId}`, form);
      setNodes((prev) => prev.map((x) => (x.id === editingId ? normalizeNode(updated) : x)));
    } else {
      const siblings = childrenOf(parentId);
      const created = await api.post<Node>("/api/categories", {
        ...form,
        parent: parentId,
        order: siblings.length + 1,
        refCount: 0,
      });
      setNodes((prev) => [...prev, normalizeNode(created)]);
      // Keep the parent expanded so the new subcategory is visible immediately.
      if (parentId) setCollapsed((c) => ({ ...c, [parentId]: false }));
    }
    setModalOpen(false);
  }

  async function toggleStatus(n: Node) {
    const status = n.status === "Active" ? "Inactive" : "Active";
    setNodes((prev) => prev.map((x) => (x.id === n.id ? { ...x, status } : x)));
    await api.patch(`/api/categories/${n.id}`, { status });
  }

  const del = nodes.find((n) => n.id === delId);
  const delHasKids = delId != null && hasChildren(delId);
  const delRefs = (del?.refCount || 0) > 0;
  const delBlocked = delOpen && (delHasKids || delRefs);
  const delClear = delOpen && !delBlocked;
  const delReason = delHasKids
    ? "This node has child categories. Remove or move them first, then delete this node."
    : `This node is referenced by ${del?.refCount} inventory items. Reassign them before deleting.`;
  const parentNode = parentId ? nodes.find((n) => n.id === parentId) : null;
  const infoNode = infoId ? nodes.find((n) => n.id === infoId) : null;
  const infoParent = infoNode?.parent ? nodes.find((n) => n.id === infoNode.parent) : null;
  const infoKids = infoNode ? childrenOf(infoNode.id) : [];
  const rows = flatten();

  return (
    <PageShell section="Master Data" page="Categories">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Categories"
          description="An arbitrary-depth tree. Nest categories under categories — the same pattern as storage locations."
        />
        <button onClick={() => openAdd(null)} style={addBtnStyle}>
          ＋ New Category
        </button>
      </div>

      {loadError ? <ErrorBanner message={loadError} /> : null}

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Category tree</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setCollapsed({})} style={secondaryBtnStyle}>
              Expand all
            </button>
            <button
              onClick={() => {
                const c: Record<string, boolean> = {};
                nodes.forEach((n) => {
                  if (hasChildren(n.id)) c[n.id] = true;
                });
                setCollapsed(c);
              }}
              style={secondaryBtnStyle}
            >
              Collapse all
            </button>
          </div>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <th style={thStyle("18px")}>Node</th>
              <th style={thStyle()}>Level</th>
              <th style={thStyle()}>Code</th>
              <th style={thStyle()}>Unit</th>
              <th style={thStyle()}>Status</th>
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node: n, depth }) => {
              const kids = hasChildren(n.id);
              const childCount = kids ? childrenOf(n.id).length : 0;
              const isCol = collapsed[n.id];
              return (
                <tr key={n.id}>
                  <td style={{ padding: "10px 14px 10px 18px", borderTop: "1px solid #f1f4f8" }}>
                    <div
                      role={kids ? "button" : undefined}
                      tabIndex={kids ? 0 : undefined}
                      title={kids ? (isCol ? "Expand" : "Collapse") : undefined}
                      aria-expanded={kids ? !isCol : undefined}
                      onClick={
                        kids
                          ? () => setCollapsed((c) => ({ ...c, [n.id]: !c[n.id] }))
                          : undefined
                      }
                      onKeyDown={
                        kids
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setCollapsed((c) => ({ ...c, [n.id]: !c[n.id] }));
                              }
                            }
                          : undefined
                      }
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        paddingLeft: depth * 22,
                        cursor: kids ? "pointer" : "default",
                        borderRadius: 8,
                        margin: "-4px -6px",
                        paddingTop: 4,
                        paddingBottom: 4,
                        paddingRight: 6,
                      }}
                    >
                      {kids ? (
                        <button
                          type="button"
                          title={isCol ? "Expand" : "Collapse"}
                          aria-label={isCol ? "Expand" : "Collapse"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCollapsed((c) => ({ ...c, [n.id]: !c[n.id] }));
                          }}
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 8,
                            border: "1px solid #cfe0ff",
                            background: isCol ? "#f2f7ff" : "#1560f0",
                            color: isCol ? "#1560f0" : "#fff",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 800,
                            lineHeight: 1,
                            flexShrink: 0,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            boxShadow: isCol ? "none" : "0 1px 2px rgba(21,96,240,.25)",
                          }}
                        >
                          {isCol ? "▶" : "▼"}
                        </button>
                      ) : (
                        <span style={{ width: 28, height: 28, flexShrink: 0 }} />
                      )}
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 3,
                          background: n.color || "#3392ff",
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: depth === 0 ? 700 : kids ? 600 : 500, color: "#1a2b4a" }}>{n.name}</span>
                      {kids ? (
                        <span style={{ fontSize: 11, fontWeight: 700, color: "#8a97b0", background: "#f1f4f8", borderRadius: 20, padding: "2px 8px" }}>
                          {childCount}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td style={tdStyle()}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "3px 9px",
                        background: "#eef2f9",
                        color: "#5a6a86",
                        borderRadius: 6,
                        fontSize: 11.5,
                        fontWeight: 600,
                      }}
                    >
                      {n.level || (depth === 0 ? "Category" : "Subcategory")}
                    </span>
                  </td>
                  <td style={{ ...tdStyle(), color: "#8a97b0", fontFamily: "var(--font-mono)" }}>{n.code || "—"}</td>
                  <td style={{ ...tdStyle(), color: "#4a5878" }}>{n.defaultUnit || "—"}</td>
                  <td style={tdStyle()}>
                    <button onClick={() => toggleStatus(n)} style={chipStyle(n.status === "Active")}>
                      {n.status}
                    </button>
                  </td>
                  <td style={{ padding: "10px 18px 10px 14px", borderTop: "1px solid #f1f4f8" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        title="More info"
                        onClick={() => setInfoId(n.id)}
                        style={{
                          padding: "6px 12px",
                          border: "1px solid #dfe5ee",
                          background: "#fff",
                          color: "#3a4a68",
                          borderRadius: 7,
                          fontSize: 12.5,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Info
                      </button>
                      <button
                        onClick={() => openAdd(n.id)}
                        style={{
                          padding: "6px 10px",
                          border: "1px solid #cfe0ff",
                          background: "#f2f7ff",
                          color: "#1560f0",
                          borderRadius: 7,
                          fontSize: 12.5,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        ＋ Child
                      </button>
                      <button
                        onClick={() => openEdit(n)}
                        style={{
                          padding: "6px 12px",
                          border: "1px solid #dfe5ee",
                          background: "#fff",
                          color: "#3a4a68",
                          borderRadius: 7,
                          fontSize: 12.5,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          setDelId(n.id);
                          setDelOpen(true);
                        }}
                        style={{
                          padding: "6px 12px",
                          border: "1px solid #f4d0d0",
                          background: "#fff",
                          color: "#d63a3a",
                          borderRadius: 7,
                          fontSize: 12.5,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading ? <EmptyState text="Loading…" /> : null}
        {!loading && rows.length === 0 ? <EmptyState text="No categories yet. Add a root category to start the tree." /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={520}>
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #f1f4f8" }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.3px" }}>
              {editingId ? "Edit Category" : "New Category"}
            </h3>
            <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "#8a97b0" }}>
              {editingId
                ? "Update this category node."
                : parentId
                  ? "Add a nested category under the selected node."
                  : "Create a new root category."}
            </p>
          </div>
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>
                  Name <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Plumbing" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Code</label>
                <input
                  value={form.code}
                  onChange={(e) => setF("code", e.target.value)}
                  placeholder="PL"
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>Level Label</label>
                <input
                  value={form.level}
                  onChange={(e) => setF("level", e.target.value)}
                  placeholder="e.g. Category / Subcategory"
                  style={inputStyle}
                />
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
            </div>
            <div>
              <label style={labelStyle}>Description</label>
              <input value={form.desc} onChange={(e) => setF("desc", e.target.value)} placeholder="Optional" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Color</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setF("color", c)}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: c,
                      border: form.color === c ? "2px solid #0b1b45" : "2px solid transparent",
                      cursor: "pointer",
                      boxShadow: form.color === c ? "0 0 0 2px #fff, 0 0 0 4px " + c : "none",
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ background: "#f8fafd", border: "1px solid #eef2f7", borderRadius: 10, padding: "12px 14px", fontSize: 12.5, color: "#67748e" }}>
              Parent: <strong style={{ color: "#1a2b4a" }}>{parentNode ? parentNode.name : "— Root level —"}</strong>
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
        <Modal onClose={() => setDelOpen(false)} maxWidth={460} align="center">
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
                  Can&apos;t delete &ldquo;{del?.name}&rdquo;
                </h3>
                <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>{delReason}</p>
              </div>
              <ModalFooter>
                <button onClick={() => setDelOpen(false)} style={primaryBtnStyle}>
                  Got it
                </button>
              </ModalFooter>
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
                  🗑
                </div>
                <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>
                  Delete &ldquo;{del?.name}&rdquo;?
                </h3>
                <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
                  This node has no children and no linked items. The delete is recorded in the audit trail.
                </p>
              </div>
              <ModalFooter>
                <button onClick={() => setDelOpen(false)} style={secondaryBtnStyle}>
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    setDelOpen(false);
                    const id = delId;
                    setNodes((prev) => prev.filter((n) => n.id !== id));
                    if (id) await api.del(`/api/categories/${id}`);
                  }}
                  style={{ ...primaryBtnStyle, background: "#d63a3a" }}
                >
                  Delete
                </button>
              </ModalFooter>
            </>
          ) : null}
        </Modal>
      ) : null}

      {infoNode ? (
        <Modal onClose={() => setInfoId(null)} maxWidth={520}>
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #f1f4f8" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: infoNode.color || "#3392ff",
                  flexShrink: 0,
                  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.06)",
                }}
              />
              <div style={{ minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.3px" }}>{infoNode.name}</h3>
                <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "#8a97b0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pathOf(infoNode.id)}
                </p>
              </div>
            </div>
          </div>
          <div style={{ padding: "18px 24px", display: "flex", flexDirection: "column", gap: 0 }}>
            <InfoRow label="Level" value={infoNode.level || (infoNode.parent ? "Subcategory" : "Category")} />
            <InfoRow label="Code" value={infoNode.code || "—"} mono />
            <InfoRow label="Description" value={infoNode.desc || "—"} />
            <InfoRow label="Default unit" value={infoNode.defaultUnit || "—"} />
            <InfoRow label="Status" value={infoNode.status} />
            <InfoRow label="Order" value={String(infoNode.order || "—")} />
            <InfoRow label="Linked items" value={String(infoNode.refCount || 0)} />
            <InfoRow label="Parent" value={infoParent ? infoParent.name : "— Root level —"} />
            <InfoRow label="Direct children" value={String(infoKids.length)} />
            <InfoRow label="All descendants" value={String(descendantCount(infoNode.id))} />
            {infoKids.length ? (
              <div style={{ paddingTop: 14, marginTop: 6, borderTop: "1px solid #f1f4f8" }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: "#8a97b0", letterSpacing: ".4px", textTransform: "uppercase", marginBottom: 8 }}>
                  Children
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {infoKids.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setInfoId(c.id)}
                      style={{
                        padding: "5px 10px",
                        border: "1px solid #e9edf3",
                        background: "#f8fafd",
                        color: "#3a4a68",
                        borderRadius: 7,
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <ModalFooter>
            <button onClick={() => setInfoId(null)} style={secondaryBtnStyle}>
              Close
            </button>
            <button
              onClick={() => {
                const n = infoNode;
                setInfoId(null);
                openEdit(n);
              }}
              style={primaryBtnStyle}
            >
              Edit
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr",
        gap: 12,
        padding: "9px 0",
        borderBottom: "1px solid #f5f7fa",
        fontSize: 13,
      }}
    >
      <div style={{ color: "#8a97b0", fontWeight: 600 }}>{label}</div>
      <div style={{ color: "#1a2b4a", fontWeight: 600, fontFamily: mono ? "var(--font-mono)" : undefined, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

function normalizeNode(n: Partial<Node> & { id: string }): Node {
  return {
    id: n.id,
    parent: n.parent == null || n.parent === "" ? null : String(n.parent),
    name: n.name || "",
    code: n.code || "",
    desc: n.desc || "",
    level: n.level || "",
    defaultUnit: n.defaultUnit || "",
    color: n.color || PALETTE[0],
    order: typeof n.order === "number" ? n.order : 0,
    status: n.status === "Inactive" ? "Inactive" : "Active",
    refCount: typeof n.refCount === "number" ? n.refCount : 0,
  };
}

function normalizeNodes(list: Partial<Node>[]): Node[] {
  return list.map((n) => normalizeNode(n as Partial<Node> & { id: string }));
}

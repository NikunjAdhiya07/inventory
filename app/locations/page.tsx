"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
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

type Node = {
  id: string;
  parent: string | null;
  name: string;
  level: string;
  code: string;
  capacity: number | "";
  status: "Active" | "Inactive";
  refCount: number;
};

type NodeForm = { name: string; code: string; level: string; capacity: number | string; status: "Active" | "Inactive" };

const EMPTY_FORM: NodeForm = { name: "", code: "", level: "", capacity: "", status: "Active" };

export default function StorageLocationsPage() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [form, setForm] = useState<NodeForm>(EMPTY_FORM);

  const [delOpen, setDelOpen] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Node[]>("/api/locations")
      .then((data) => {
        if (!cancelled) setNodes(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function childrenOf(id: string | null) {
    return nodes.filter((n) => n.parent === id);
  }
  function hasChildren(id: string) {
    return nodes.some((n) => n.parent === id);
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
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(n: Node) {
    setEditingId(n.id);
    setParentId(n.parent);
    setForm({ name: n.name, code: n.code, level: n.level, capacity: n.capacity, status: n.status });
    setModalOpen(true);
  }

  async function save() {
    if (!form.name.trim()) return;
    const payload = { ...form, capacity: form.capacity === "" ? "" : Number(form.capacity) };
    if (editingId) {
      const updated = await api.patch<Node>(`/api/locations/${editingId}`, payload);
      setNodes((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
    } else {
      const created = await api.post<Node>("/api/locations", { ...payload, parent: parentId, refCount: 0 });
      setNodes((prev) => [...prev, created]);
    }
    setModalOpen(false);
  }

  async function toggleStatus(n: Node) {
    const status = n.status === "Active" ? "Inactive" : "Active";
    setNodes((prev) => prev.map((x) => (x.id === n.id ? { ...x, status } : x)));
    await api.patch(`/api/locations/${n.id}`, { status });
  }

  const del = nodes.find((n) => n.id === delId);
  const delHasKids = delId != null && hasChildren(delId);
  const delRefs = (del?.refCount || 0) > 0;
  const delBlocked = delOpen && (delHasKids || delRefs);
  const delClear = delOpen && !delBlocked;
  const delReason = delHasKids
    ? "This node has child nodes. Remove or move them first, then delete this node."
    : `This node is referenced by ${del?.refCount} inventory items. Reassign them to another location before deleting.`;
  const parentNode = parentId ? nodes.find((n) => n.id === parentId) : null;

  const rows = flatten();

  return (
    <PageShell section="Master Data" page="Storage Locations">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Storage Locations"
          description="An arbitrary-depth tree. You define the level names — Site → Area → Floor, or any depth per branch."
        />
        <button onClick={() => openAdd(null)} style={addBtnStyle}>
          ＋ New Site
        </button>
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Location tree</div>
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
              <th style={{ ...thStyle(), textAlign: "center" }}>Capacity</th>
              <th style={thStyle()}>Status</th>
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node: n, depth }) => {
              const kids = hasChildren(n.id);
              const isCol = collapsed[n.id];
              return (
                <tr key={n.id}>
                  <td style={{ padding: "10px 14px 10px 18px", borderTop: "1px solid #f1f4f8" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: depth * 22 }}>
                      <button
                        onClick={kids ? () => setCollapsed((c) => ({ ...c, [n.id]: !c[n.id] })) : undefined}
                        style={{
                          width: 18,
                          height: 18,
                          border: "none",
                          background: "none",
                          color: "#8a97b0",
                          cursor: kids ? "pointer" : "default",
                          fontSize: 11,
                          flexShrink: 0,
                        }}
                      >
                        {kids ? (isCol ? "▸" : "▾") : ""}
                      </button>
                      <span style={{ fontSize: 13, color: depth === 0 ? "#1560f0" : "#9aa6bd", flexShrink: 0 }}>{depth === 0 ? "▦" : kids ? "▤" : "▢"}</span>
                      <span style={{ fontWeight: depth === 0 ? 700 : kids ? 600 : 500, color: "#1a2b4a" }}>{n.name}</span>
                    </div>
                  </td>
                  <td style={tdStyle()}>
                    <span style={{ display: "inline-block", padding: "3px 9px", background: "#eef2f9", color: "#5a6a86", borderRadius: 6, fontSize: 11.5, fontWeight: 600 }}>
                      {n.level}
                    </span>
                  </td>
                  <td style={{ ...tdStyle(), color: "#8a97b0", fontFamily: "var(--font-mono)" }}>{n.code}</td>
                  <td style={{ ...tdStyle(), textAlign: "center", color: "#4a5878" }}>{n.capacity || "—"}</td>
                  <td style={tdStyle()}>
                    <button onClick={() => toggleStatus(n)} style={chipStyle(n.status === "Active")}>
                      {n.status}
                    </button>
                  </td>
                  <td style={{ padding: "10px 18px 10px 14px", borderTop: "1px solid #f1f4f8" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => openAdd(n.id)}
                        style={{ padding: "6px 10px", border: "1px solid #cfe0ff", background: "#f2f7ff", color: "#1560f0", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                      >
                        ＋ Child
                      </button>
                      <button
                        onClick={() => openEdit(n)}
                        style={{ padding: "6px 12px", border: "1px solid #dfe5ee", background: "#fff", color: "#3a4a68", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          setDelId(n.id);
                          setDelOpen(true);
                        }}
                        style={{ padding: "6px 12px", border: "1px solid #f4d0d0", background: "#fff", color: "#d63a3a", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
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
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={520}>
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #f1f4f8" }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.3px" }}>{editingId ? "Edit Node" : "New Node"}</h3>
            <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "#8a97b0" }}>
              {editingId ? "Update this location node." : parentId ? "Add a child under the selected node." : "Create a new root site."}
            </p>
          </div>
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>
                  Node Name <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Rack B" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Code</label>
                <input value={form.code} onChange={(e) => setF("code", e.target.value)} placeholder="RB" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>Level Label</label>
                <input value={form.level} onChange={(e) => setF("level", e.target.value)} placeholder="e.g. Rack" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Capacity</label>
                <input value={form.capacity} onChange={(e) => setF("capacity", e.target.value)} type="number" placeholder="—" style={inputStyle} />
              </div>
            </div>
            <div style={{ background: "#f8fafd", border: "1px solid #eef2f7", borderRadius: 10, padding: "12px 14px", fontSize: 12.5, color: "#67748e" }}>
              Parent: <strong style={{ color: "#1a2b4a" }}>{parentNode ? `${parentNode.name} (${parentNode.level})` : "— Root level —"}</strong>
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
              Save Node
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
                <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
                  🗑
                </div>
                <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete &ldquo;{del?.name}&rdquo;?</h3>
                <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>This node is empty and holds no inventory. The delete is recorded in the audit trail.</p>
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
                    if (id) await api.del(`/api/locations/${id}`);
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
    </PageShell>
  );
}

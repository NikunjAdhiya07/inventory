"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, Modal, ModalHeader, ModalFooter, thStyle, tdStyle, labelStyle, inputStyle, secondaryBtnStyle, primaryBtnStyle, addBtnStyle, checkboxStyle, EmptyState, SortTh } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

const PALETTE = ["#8a97b0", "#f59e0b", "#0f9d63", "#1560f0", "#6366f1", "#94a3b8", "#ec4899", "#d63a3a"];
const APPLIES = ["Categories", "Locations", "Units", "Roles"];

type StatusItem = {
  id: string;
  name: string;
  color: string;
  behavior: string;
  applies: string[];
  records: number;
  isDefault: boolean;
};

type StatusForm = { name: string; color: string; behavior: string; applies: string[]; isDefault: boolean };

const EMPTY_FORM: StatusForm = { name: "", color: PALETTE[2], behavior: "Editable, visible to bot", applies: ["Categories", "Locations", "Units"], isDefault: false };

function pillStyle(c: string) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "4px 12px",
    borderRadius: 20,
    fontSize: 12.5,
    fontWeight: 600,
    background: `${c}18`,
    color: c,
  } as const;
}
function dotStyle(c: string) {
  return { width: 8, height: 8, borderRadius: "50%", background: c } as const;
}

export default function StatusMasterPage() {
  const [items, setItems] = useState<StatusItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragId, setDragId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<StatusForm>(EMPTY_FORM);

  useEffect(() => {
    let cancelled = false;
    api
      .get<StatusItem[]>("/api/statuses")
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setF<K extends keyof StatusForm>(k: K, v: StatusForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function reorder(targetId: string) {
    let ids: string[] | null = null;
    setItems((prev) => {
      const arr = [...prev];
      const from = arr.findIndex((x) => x.id === dragId);
      const to = arr.findIndex((x) => x.id === targetId);
      if (from < 0 || to < 0 || from === to) return prev;
      const [m] = arr.splice(from, 1);
      arr.splice(to, 0, m);
      ids = arr.map((x) => x.id);
      return arr;
    });
    setDragId(null);
    if (ids) api.post("/api/statuses/reorder", { ids });
  }

  async function save() {
    if (!form.name.trim()) return;
    if (editingId) {
      const updated = await api.patch<StatusItem>(`/api/statuses/${editingId}`, form);
      setItems((prev) => {
        let list = prev;
        if (form.isDefault) list = list.map((x) => ({ ...x, isDefault: x.id === editingId }));
        return list.map((x) => (x.id === editingId ? updated : x));
      });
    } else {
      const created = await api.post<StatusItem>("/api/statuses", { ...form, records: 0 });
      setItems((prev) => {
        const list = form.isDefault ? prev.map((x) => ({ ...x, isDefault: false })) : prev;
        return [...list, created];
      });
    }
    setModalOpen(false);
  }

  async function remove(id: string) {
    setItems((prev) => prev.filter((x) => x.id !== id));
    await api.del(`/api/statuses/${id}`);
  }

  const { sorted: sortedItems, sortKey, dir, toggleSort, resetSort } = useSort<StatusItem, keyof StatusItem>(items);
  const manualOrder = sortKey === null;

  return (
    <PageShell section="Configuration" page="Status Master">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Status Master"
          description="One shared lifecycle of statuses used by every master — instead of a plain Active / Inactive toggle. Reorder to define the workflow sequence."
        />
        <button
          onClick={() => {
            setEditingId(null);
            setForm(EMPTY_FORM);
            setModalOpen(true);
          }}
          style={addBtnStyle}
        >
          ＋ New Status
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 22 }}>
        {items.map((i) => (
          <span key={i.id} style={pillStyle(i.color)}>
            <span style={dotStyle(i.color)} />
            {i.name}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", color: "#c4ccda", fontSize: 13, padding: "0 2px" }}>defines the flow →</span>
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>All statuses</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <th style={{ width: 34, padding: "11px 8px 11px 16px" }} title={manualOrder ? "Drag rows to reorder" : "Reset sort to drag-reorder"} onClick={manualOrder ? undefined : resetSort}>
                {manualOrder ? "" : <span style={{ cursor: "pointer", fontSize: 10.5, color: "#1560f0" }}>↺</span>}
              </th>
              <SortTh label="Status" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Behavior" active={sortKey === "behavior"} dir={dir} onClick={() => toggleSort("behavior")} />
              <th style={thStyle()}>Applies to</th>
              <SortTh label="Records" align="center" active={sortKey === "records"} dir={dir} onClick={() => toggleSort("records")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((i) => (
              <tr
                key={i.id}
                draggable={manualOrder}
                onDragStart={() => manualOrder && setDragId(i.id)}
                onDragOver={(e) => manualOrder && e.preventDefault()}
                onDrop={() => manualOrder && reorder(i.id)}
                onDragEnd={() => setDragId(null)}
                style={{ transition: "background .12s", background: dragId === i.id ? "#eef4ff" : undefined }}
              >
                <td style={{ padding: "12px 8px 12px 16px", color: manualOrder ? "#c4ccda" : "#e9edf3", fontSize: 15, cursor: manualOrder ? "grab" : "default", textAlign: "center" }}>⠿</td>
                <td style={tdStyle()}>
                  <span style={pillStyle(i.color)}>
                    <span style={dotStyle(i.color)} />
                    {i.name}
                    {i.isDefault ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#8a97b0" }}>· default</span> : null}
                  </span>
                </td>
                <td style={{ ...tdStyle(), color: "#67748e" }}>{i.behavior}</td>
                <td style={{ ...tdStyle(), color: "#8a97b0" }}>{i.applies.length === APPLIES.length ? "All masters" : i.applies.join(", ")}</td>
                <td style={{ ...tdStyle(), textAlign: "center", color: "#4a5878", fontWeight: 600 }}>{i.records}</td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => {
                        setEditingId(i.id);
                        setForm({ name: i.name, color: i.color, behavior: i.behavior, applies: [...i.applies], isDefault: i.isDefault });
                        setModalOpen(true);
                      }}
                      style={{ padding: "6px 12px", border: "1px solid #dfe5ee", background: "#fff", color: "#3a4a68", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => remove(i.id)}
                      style={{ padding: "6px 12px", border: "1px solid #f4d0d0", background: "#fff", color: "#d63a3a", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={520}>
          <ModalHeader title={editingId ? "Edit Status" : "New Status"} onClose={() => setModalOpen(false)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>
                Status Name <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Pending Approval" style={inputStyle} />
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
                    style={{ width: 30, height: 30, borderRadius: 8, background: col, cursor: "pointer", border: `2px solid ${form.color === col ? "#0b1b45" : "transparent"}` }}
                  />
                ))}
              </div>
            </div>
            <div>
              <label style={labelStyle}>Behavior</label>
              <select value={form.behavior} onChange={(e) => setF("behavior", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                <option value="Editable, visible to bot">Editable, visible to bot</option>
                <option value="Locked, awaiting approval">Locked, awaiting approval</option>
                <option value="Hidden from bot">Hidden from bot</option>
                <option value="Read-only archive">Read-only archive</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Applies to</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {APPLIES.map((a) => {
                  const on = form.applies.includes(a);
                  return (
                    <button
                      key={a}
                      onClick={() => setF("applies", on ? form.applies.filter((x) => x !== a) : [...form.applies, a])}
                      style={{
                        padding: "7px 12px",
                        borderRadius: 20,
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: "pointer",
                        border: `1px solid ${on ? "#bcd4ff" : "#e0e5ee"}`,
                        background: on ? "#f2f7ff" : "#fff",
                        color: on ? "#1560f0" : "#8a97b0",
                      }}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#3a4a68", cursor: "pointer" }}>
              <button onClick={() => setF("isDefault", !form.isDefault)} style={checkboxStyle(form.isDefault, 20)}>
                {form.isDefault ? "✓" : ""}
              </button>
              Set as default status for new records
            </label>
          </div>
          <ModalFooter>
            <button onClick={() => setModalOpen(false)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={save} style={primaryBtnStyle}>
              Save Status
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

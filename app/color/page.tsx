"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, Modal, ModalHeader, ModalFooter, labelStyle, inputStyle, secondaryBtnStyle, primaryBtnStyle, addBtnStyle, EmptyState } from "@/components/dc-ui";

const GROUP_ORDER = ["Corporate Colors", "Inventory Colors", "Tag Colors", "Status Colors"];

type ColorItem = { id: string; name: string; hex: string; group: string };
type ColorForm = { name: string; hex: string; group: string };

const EMPTY_FORM: ColorForm = { name: "", hex: "#3392ff", group: "Inventory Colors" };

export default function ColorMasterPage() {
  const [colors, setColors] = useState<ColorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ColorForm>(EMPTY_FORM);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ColorItem[]>("/api/colors")
      .then((data) => {
        if (!cancelled) setColors(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setF<K extends keyof ColorForm>(k: K, v: ColorForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!form.name.trim()) return;
    if (editingId) {
      const updated = await api.patch<ColorItem>(`/api/colors/${editingId}`, form);
      setColors((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
    } else {
      const created = await api.post<ColorItem>("/api/colors", form);
      setColors((prev) => [...prev, created]);
    }
    setModalOpen(false);
  }

  const groups = GROUP_ORDER.map((t) => ({ title: t, colors: colors.filter((c) => c.group === t) })).filter((g) => g.colors.length);

  return (
    <PageShell section="Configuration" page="Color Master">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Color Master"
          description="Reusable named colors so every master pulls from one palette. Categories, tags and statuses reference these instead of ad-hoc hex values."
        />
        <button
          onClick={() => {
            setEditingId(null);
            setForm(EMPTY_FORM);
            setModalOpen(true);
          }}
          style={addBtnStyle}
        >
          ＋ New Color
        </button>
      </div>

      {loading ? <EmptyState text="Loading…" /> : null}

      {groups.map((g) => (
        <section key={g.title} style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: "18px 20px", marginBottom: 18, boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45", marginBottom: 16 }}>{g.title}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 14 }}>
            {g.colors.map((c) => (
              <div key={c.id} style={{ border: "1px solid #eef1f6", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ height: 64, background: c.hex }} />
                <div style={{ padding: "11px 13px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ lineHeight: 1.3, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1a2b4a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
                    <div style={{ fontSize: 11.5, color: "#98a4bd", fontFamily: "var(--font-mono)", textTransform: "uppercase" }}>{c.hex}</div>
                  </div>
                  <button
                    onClick={() => {
                      setEditingId(c.id);
                      setForm({ name: c.name, hex: c.hex, group: c.group });
                      setModalOpen(true);
                    }}
                    style={{ border: "1px solid #dfe5ee", background: "#fff", color: "#5a6a86", borderRadius: 7, fontSize: 12, fontWeight: 600, padding: "5px 9px", cursor: "pointer", flexShrink: 0 }}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={460}>
          <ModalHeader title={editingId ? "Edit Color" : "New Color"} onClose={() => setModalOpen(false)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 52, height: 52, borderRadius: 12, flexShrink: 0, background: form.hex, boxShadow: `0 2px 8px ${form.hex}55` }} />
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>
                  Color Name <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Brand Primary" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 12, alignItems: "end" }}>
              <div>
                <label style={labelStyle}>Pick</label>
                <input value={form.hex} onChange={(e) => setF("hex", e.target.value)} type="color" style={{ width: 64, height: 42, borderRadius: 9, padding: 0, border: "none", cursor: "pointer" }} />
              </div>
              <div>
                <label style={labelStyle}>Hex value</label>
                <input
                  value={form.hex}
                  onChange={(e) => setF("hex", e.target.value)}
                  placeholder="#3392ff"
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)", textTransform: "uppercase" }}
                />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Group</label>
              <select value={form.group} onChange={(e) => setF("group", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                <option value="Corporate Colors">Corporate Colors</option>
                <option value="Inventory Colors">Inventory Colors</option>
                <option value="Tag Colors">Tag Colors</option>
                <option value="Status Colors">Status Colors</option>
              </select>
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setModalOpen(false)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={save} style={primaryBtnStyle}>
              Save Color
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

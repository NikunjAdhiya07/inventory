"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
  ErrorBanner,
  PageIntro,
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
  toggleStyle,
  toggleKnobStyle,
} from "@/components/dc-ui";

import { DIRECTION_GROUPS, type Direction } from "@/lib/movement-ui";

type MovementType = {
  id: string;
  code: string;
  name: string;
  direction: Direction;
  desc: string;
  requireRemarks: boolean;
  requireReference: boolean;
  allowNegative: boolean;
  isSystem: boolean;
  order: number;
  status: "Active" | "Inactive";
  usedCount: number;
};

type Form = {
  name: string;
  desc: string;
  direction: Direction;
  requireRemarks: boolean;
  requireReference: boolean;
  allowNegative: boolean;
  order: number | string;
};

const EMPTY_FORM: Form = { name: "", desc: "", direction: "in", requireRemarks: false, requireReference: false, allowNegative: false, order: 100 };

const GROUPS = DIRECTION_GROUPS;

export default function MovementTypesPage() {
  const [types, setTypes] = useState<MovementType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<MovementType | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MovementType[]>("/api/movement-types")
      .then((d) => !cancelled && setTypes(d))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function setF<K extends keyof Form>(k: K, v: Form[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function openNew() {
    setEditing(null);
    setForm({ ...EMPTY_FORM, order: (types.reduce((m, t) => Math.max(m, t.order), 0) || 0) + 1 });
    setError(null);
    setModalOpen(true);
  }

  function openEdit(t: MovementType) {
    setEditing(t);
    setForm({
      name: t.name,
      desc: t.desc,
      direction: t.direction,
      requireRemarks: t.requireRemarks,
      requireReference: t.requireReference,
      allowNegative: t.allowNegative,
      order: t.order,
    });
    setError(null);
    setModalOpen(true);
  }

  async function save() {
    if (!form.name.trim()) {
      setError("A movement type needs a name.");
      return;
    }
    setSaving(true);
    setError(null);
    const payload = { ...form, order: Number(form.order) || 0 };
    try {
      if (editing) {
        const updated = await api.patch<MovementType>(`/api/movement-types/${editing.id}`, payload);
        setTypes((prev) => prev.map((t) => (t.id === editing.id ? { ...t, ...updated } : t)));
      } else {
        const created = await api.post<MovementType>("/api/movement-types", payload);
        setTypes((prev) => [...prev, created]);
      }
      setModalOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(t: MovementType) {
    const status = t.status === "Active" ? "Inactive" : "Active";
    setTypes((prev) => prev.map((x) => (x.id === t.id ? { ...x, status } : x)));
    try {
      await api.patch(`/api/movement-types/${t.id}`, { status });
    } catch (e) {
      setTypes((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: t.status } : x)));
      setError(e instanceof Error ? e.message : "Update failed");
    }
  }

  async function remove(t: MovementType) {
    try {
      await api.del(`/api/movement-types/${t.id}`);
      setTypes((prev) => prev.filter((x) => x.id !== t.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <PageShell section="Configuration" page="Movement Types" maxWidth={1180}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Movement Types"
          description="Why stock moved. Every movement in the ledger names one of these, so adding a type here makes a new kind of movement recordable — no code change, no deploy."
        />
        <button onClick={openNew} style={addBtnStyle}>
          ＋ New Movement Type
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {GROUPS.map((g) => {
        const rows = types.filter((t) => t.direction === g.direction).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
        if (!rows.length) return null;
        return (
          <section
            key={g.direction}
            style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)", marginBottom: 18 }}
          >
            <div style={{ padding: "14px 18px", borderBottom: "1px solid #f1f4f8", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: g.color }}>{g.title}</span>
              <span style={{ fontSize: 11.5, color: "#98a4bd" }}>{g.hint}</span>
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: "#98a4bd" }}>{rows.length}</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
                  <th style={thStyle("18px")}>Movement</th>
                  <th style={thStyle()}>Code</th>
                  <th style={thStyle()}>Requires</th>
                  <th style={{ ...thStyle(), textAlign: "center" }}>Used</th>
                  <th style={thStyle()}>Status</th>
                  <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td style={tdStyle("18px")}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontWeight: 600, color: "#1a2b4a" }}>{t.name}</span>
                        {t.isSystem ? (
                          <span
                            style={{ fontSize: 10.5, fontWeight: 700, background: "#f2f4f8", color: "#8a97b0", borderRadius: 20, padding: "1px 8px" }}
                            title="Written by the entry bot, the request bot or the storage map — not offered on the manual form."
                          >
                            SYSTEM
                          </span>
                        ) : null}
                      </div>
                      {t.desc ? <div style={{ fontSize: 11.5, color: "#98a4bd", marginTop: 2 }}>{t.desc}</div> : null}
                    </td>
                    <td style={{ ...tdStyle(), color: "#8a97b0", fontFamily: "var(--font-mono)", fontSize: 12 }}>{t.code}</td>
                    <td style={tdStyle()}>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {t.requireReference ? <Tag text="Reference" /> : null}
                        {t.requireRemarks ? <Tag text="Remarks" /> : null}
                        {t.allowNegative ? <Tag text="May go negative" tone="#d98207" tint="#fff4e5" /> : null}
                        {!t.requireReference && !t.requireRemarks && !t.allowNegative ? <span style={{ color: "#c4ccda" }}>—</span> : null}
                      </div>
                    </td>
                    <td style={{ ...tdStyle(), textAlign: "center", color: "#4a5878", fontFamily: "var(--font-mono)" }}>{t.usedCount || "—"}</td>
                    <td style={tdStyle()}>
                      <button onClick={() => toggleStatus(t)} style={chipStyle(t.status === "Active")}>
                        {t.status}
                      </button>
                    </td>
                    <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button onClick={() => openEdit(t)} style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                          Edit
                        </button>
                        {!t.isSystem && !t.usedCount ? (
                          <button onClick={() => remove(t)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      {loading ? <EmptyState text="Loading…" /> : null}
      {!loading && types.length === 0 ? <EmptyState text="No movement types yet. Run npm run seed:movement-types, or add your own." /> : null}

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={560}>
          <ModalHeader
            title={editing ? `Edit — ${editing.name}` : "New movement type"}
            subtitle="Direction decides the sign and what the form asks for. The rest are the rules this movement is captured under."
            onClose={() => setModalOpen(false)}
          />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            {error ? <ErrorBanner message={error} /> : null}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>
                  Name <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Scrap to Vendor" style={inputStyle} autoFocus />
              </div>
              <div>
                <label style={labelStyle}>Order</label>
                <input type="number" value={form.order} onChange={(e) => setF("order", e.target.value)} style={inputStyle} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Description</label>
              <input value={form.desc} onChange={(e) => setF("desc", e.target.value)} placeholder="When a storekeeper should pick this…" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Direction</label>
              <div style={{ display: "flex", gap: 8 }}>
                {GROUPS.filter((g) => g.direction !== "adjust").map((g) => {
                  const on = form.direction === g.direction;
                  const locked = Boolean(editing?.usedCount) && editing?.direction !== g.direction;
                  return (
                    <button
                      key={g.direction}
                      onClick={() => !locked && setF("direction", g.direction)}
                      disabled={locked}
                      title={locked ? "This type already has movements recorded — its direction is fixed." : g.hint}
                      style={{
                        flex: 1,
                        padding: "10px 12px",
                        borderRadius: 9,
                        border: `1px solid ${on ? g.color : "#e4e9f0"}`,
                        background: on ? g.tint : locked ? "#f8f9fb" : "#fff",
                        color: on ? g.color : locked ? "#c4ccda" : "#4a5878",
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: locked ? "not-allowed" : "pointer",
                        textAlign: "left",
                      }}
                    >
                      {g.title}
                      <span style={{ display: "block", fontWeight: 500, fontSize: 11, opacity: 0.8, marginTop: 2 }}>{g.hint}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <ToggleRow
              label="Reference is mandatory"
              hint="Invoice, PO, challan or ticket number — recorded with the movement."
              on={form.requireReference}
              onChange={(v) => setF("requireReference", v)}
            />
            <ToggleRow
              label="Remarks are mandatory"
              hint="For the movements that mean nothing without an explanation — damage, disposal, corrections."
              on={form.requireRemarks}
              onChange={(v) => setF("requireRemarks", v)}
            />
            {form.direction === "out" ? (
              <ToggleRow
                label="May take out more than is on hand"
                hint="Off by default: stock-out is blocked when it would exceed the balance. Turn it on only where the shelf is reconciled later."
                on={form.allowNegative}
                onChange={(v) => setF("allowNegative", v)}
              />
            ) : null}
            {editing?.isSystem ? (
              <div style={{ padding: "11px 13px", borderRadius: 9, background: "#f6f8fb", border: "1px solid #e4e9f0", fontSize: 11.5, color: "#67748e", lineHeight: 1.5 }}>
                This type is written by the software itself, so it never appears on the manual form. Renaming it changes how it reads in history and reports.
              </div>
            ) : null}
          </div>
          <ModalFooter>
            <button onClick={() => setModalOpen(false)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={save} style={primaryBtnStyle} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

function Tag({ text, tone = "#5a6a86", tint = "#eef2f9" }: { text: string; tone?: string; tint?: string }) {
  return <span style={{ padding: "2px 8px", borderRadius: 6, background: tint, color: tone, fontSize: 11, fontWeight: 600 }}>{text}</span>;
}

function ToggleRow({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
      <label style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4a68" }}>
        {label}
        <span style={{ display: "block", fontWeight: 500, fontSize: 11.5, color: "#98a4bd", marginTop: 2, maxWidth: 380 }}>{hint}</span>
      </label>
      <button onClick={() => onChange(!on)} style={toggleStyle(on)}>
        <span style={toggleKnobStyle(on)} />
      </button>
    </div>
  );
}

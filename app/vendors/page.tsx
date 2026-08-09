"use client";

import { useEffect, useState, type CSSProperties } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
  PageIntro,
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
  EmptyState,
  SortTh,
} from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

type Status = "Active" | "Inactive";

type Vendor = {
  id: string;
  name: string;
  code: string;
  contact: string;
  phone: string;
  email: string;
  notes: string;
  status: Status;
  order: number;
};

type VendorForm = {
  name: string;
  code: string;
  contact: string;
  phone: string;
  email: string;
  notes: string;
  status: Status;
  order: number;
};

const EMPTY_FORM: VendorForm = {
  name: "",
  code: "",
  contact: "",
  phone: "",
  email: "",
  notes: "",
  status: "Active",
  order: 0,
};

function statusChip(status: Status): CSSProperties {
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

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<VendorForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Vendor[]>("/api/vendors")
      .then((data) => {
        if (!cancelled) setVendors(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = vendors.filter(
    (v) =>
      !q ||
      v.name.toLowerCase().includes(q) ||
      String(v.code ?? "")
        .toLowerCase()
        .includes(q) ||
      String(v.contact ?? "")
        .toLowerCase()
        .includes(q)
  );
  const { sorted, sortKey, dir, toggleSort } = useSort<Vendor, keyof Vendor>(filtered);

  function setF<K extends keyof VendorForm>(k: K, v: VendorForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function openAdd() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, order: (vendors.length + 1) * 10 });
    setModalOpen(true);
  }

  function openEdit(v: Vendor) {
    setEditingId(v.id);
    setForm({
      name: v.name ?? "",
      code: v.code ?? "",
      contact: v.contact ?? "",
      phone: v.phone ?? "",
      email: v.email ?? "",
      notes: v.notes ?? "",
      status: v.status === "Inactive" ? "Inactive" : "Active",
      order: typeof v.order === "number" ? v.order : 0,
    });
    setModalOpen(true);
  }

  async function toggleStatus(v: Vendor) {
    const status: Status = v.status === "Active" ? "Inactive" : "Active";
    setVendors((prev) => prev.map((x) => (x.id === v.id ? { ...x, status } : x)));
    try {
      await api.patch(`/api/vendors/${v.id}`, { status });
    } catch {
      setVendors((prev) => prev.map((x) => (x.id === v.id ? { ...x, status: v.status } : x)));
    }
  }

  async function save() {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        contact: form.contact.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        notes: form.notes.trim(),
        order: Number(form.order) || 0,
      };
      if (editingId) {
        const updated = await api.patch<Vendor>(`/api/vendors/${editingId}`, payload);
        setVendors((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
      } else {
        const created = await api.post<Vendor>("/api/vendors", {
          ...payload,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        setVendors((prev) => [...prev, created]);
      }
      setModalOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setVendors((prev) => prev.filter((v) => v.id !== id));
    await api.del(`/api/vendors/${id}`);
  }

  return (
    <PageShell section="Catalog" page="Vendors">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Vendor Master"
          description="Suppliers used by stock movements such as Vendor Replacement. The search-group bot offers Active vendors as buttons — no free-text vendor names."
        />
        <button type="button" onClick={openAdd} style={addBtnStyle}>
          ＋ New Vendor
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, code, contact…"
          style={{ ...inputStyle, maxWidth: 360 }}
        />
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
        <div style={{ padding: "15px 18px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>
          All vendors
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="Vendor" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Code" active={sortKey === "code"} dir={dir} onClick={() => toggleSort("code")} />
              <SortTh label="Contact" active={sortKey === "contact"} dir={dir} onClick={() => toggleSort("contact")} />
              <th style={thStyle()}>Phone</th>
              <SortTh label="Status" active={sortKey === "status"} dir={dir} onClick={() => toggleSort("status")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((v) => (
              <tr key={v.id}>
                <td style={tdStyle()}>
                  <div style={{ fontWeight: 600, color: "#1a2b4a" }}>{v.name}</div>
                  {v.email ? <div style={{ fontSize: 11.5, color: "#98a4bd" }}>{v.email}</div> : null}
                </td>
                <td style={{ ...tdStyle(), fontFamily: "var(--font-mono)", color: "#4a5878" }}>{v.code || "—"}</td>
                <td style={{ ...tdStyle(), color: "#67748e" }}>{v.contact || "—"}</td>
                <td style={{ ...tdStyle(), color: "#67748e" }}>{v.phone || "—"}</td>
                <td style={tdStyle()}>
                  <button type="button" onClick={() => toggleStatus(v)} style={statusChip(v.status)}>
                    {v.status}
                  </button>
                </td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() => openEdit(v)}
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
                      type="button"
                      onClick={() => remove(v.id)}
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
            ))}
          </tbody>
        </table>
        {loading ? <EmptyState text="Loading…" /> : null}
        {!loading && !sorted.length ? <EmptyState text="No vendors yet. Add one or run npm run seed:vendors." /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={520}>
          <ModalHeader title={editingId ? "Edit Vendor" : "New Vendor"} onClose={() => setModalOpen(false)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={labelStyle}>
                Vendor name <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. ABC Vendor" style={inputStyle} autoFocus />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>Code</label>
                <input value={form.code} onChange={(e) => setF("code", e.target.value)} placeholder="ABC" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Status</label>
                <select value={form.status} onChange={(e) => setF("status", e.target.value as Status)} style={{ ...inputStyle, background: "#fff" }}>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            </div>
            <div>
              <label style={labelStyle}>Contact person</label>
              <input value={form.contact} onChange={(e) => setF("contact", e.target.value)} placeholder="Name" style={inputStyle} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>Phone</label>
                <input value={form.phone} onChange={(e) => setF("phone", e.target.value)} placeholder="+91 …" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Email</label>
                <input value={form.email} onChange={(e) => setF("email", e.target.value)} placeholder="orders@…" style={inputStyle} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => setF("notes", e.target.value)}
                placeholder="Optional"
                style={{ ...inputStyle, minHeight: 72, resize: "vertical", fontFamily: "inherit" }}
              />
            </div>
          </div>
          <ModalFooter>
            <button type="button" onClick={() => setModalOpen(false)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button type="button" onClick={save} disabled={saving || !form.name.trim()} style={primaryBtnStyle}>
              {saving ? "Saving…" : "Save Vendor"}
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

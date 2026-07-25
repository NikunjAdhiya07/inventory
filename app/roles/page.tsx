"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, Modal, ModalHeader, ModalFooter, thStyle, tdStyle, labelStyle, inputStyle, secondaryBtnStyle, primaryBtnStyle, addBtnStyle, chipStyle, EmptyState, SortTh } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

const PERMS = ["Add Inventory", "Manage Masters", "Manage Workflows", "Approve Entries", "View Reports"];

type Role = { id: string; name: string; desc: string; color: string; users: number; status: "Active" | "Inactive"; perms: string[] };
type RoleForm = { name: string; desc: string; perms: string[]; status: "Active" | "Inactive" };

const EMPTY_FORM: RoleForm = { name: "", desc: "", perms: [], status: "Active" };

function cellStyle(on: boolean) {
  return {
    width: 26,
    height: 26,
    borderRadius: 7,
    border: `1.5px solid ${on ? "#1560f0" : "#dfe5ee"}`,
    background: on ? "#1560f0" : "#fff",
    color: "#fff",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  } as const;
}

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RoleForm>(EMPTY_FORM);
  const [delOpen, setDelOpen] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Role[]>("/api/roles")
      .then((data) => {
        if (!cancelled) setRoles(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setF<K extends keyof RoleForm>(k: K, v: RoleForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function toggleCell(roleId: string, perm: string) {
    let nextPerms: string[] = [];
    setRoles((prev) =>
      prev.map((r) => {
        if (r.id !== roleId) return r;
        const has = r.perms.includes(perm);
        nextPerms = has ? r.perms.filter((p) => p !== perm) : [...r.perms, perm];
        return { ...r, perms: nextPerms };
      })
    );
    await api.patch(`/api/roles/${roleId}`, { perms: nextPerms });
  }

  async function toggleStatus(r: Role) {
    const status = r.status === "Active" ? "Inactive" : "Active";
    setRoles((prev) => prev.map((x) => (x.id === r.id ? { ...x, status } : x)));
    await api.patch(`/api/roles/${r.id}`, { status });
  }

  async function save() {
    if (!form.name.trim()) return;
    if (editingId) {
      const updated = await api.patch<Role>(`/api/roles/${editingId}`, form);
      setRoles((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
    } else {
      const created = await api.post<Role>("/api/roles", { ...form, users: 0, color: "#1560f0" });
      setRoles((prev) => [...prev, created]);
    }
    setModalOpen(false);
  }

  const del = roles.find((r) => r.id === delId);
  const blocked = (del?.users || 0) > 0;
  const { sorted: sortedRoles, sortKey, dir, toggleSort } = useSort<Role, keyof Role>(roles);

  return (
    <PageShell section="Access" page="Roles & Permissions">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Roles & Permissions"
          description="Define what each role can do. Toggle a cell to grant or revoke a permission — changes apply the moment you save."
        />
        <button
          onClick={() => {
            setEditingId(null);
            setForm(EMPTY_FORM);
            setModalOpen(true);
          }}
          style={addBtnStyle}
        >
          ＋ New Role
        </button>
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)", marginBottom: 24 }}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid #f1f4f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Permission matrix</div>
          <div style={{ fontSize: 12, color: "#8a97b0" }}>Tap a cell to toggle</div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760 }}>
            <thead>
              <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
                <th style={{ padding: "12px 16px 12px 18px", fontWeight: 600, fontSize: 11.5, letterSpacing: ".3px", textTransform: "uppercase", position: "sticky", left: 0, background: "#fafbfd" }}>
                  Role
                </th>
                {PERMS.map((p) => (
                  <th key={p} style={{ padding: "12px 10px", fontWeight: 600, fontSize: 11, letterSpacing: ".2px", textTransform: "uppercase", textAlign: "center", color: "#7a8aa6" }}>
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id}>
                  <td style={{ padding: "12px 16px 12px 18px", borderTop: "1px solid #f1f4f8", position: "sticky", left: 0, background: "#fff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: r.color, flexShrink: 0 }} />
                      <div style={{ fontWeight: 700, color: "#1a2b4a" }}>{r.name}</div>
                    </div>
                  </td>
                  {PERMS.map((p) => {
                    const on = r.perms.includes(p);
                    return (
                      <td key={p} style={{ padding: "8px 10px", borderTop: "1px solid #f1f4f8", textAlign: "center" }}>
                        <button onClick={() => toggleCell(r.id, p)} style={cellStyle(on)}>
                          {on ? "✓" : ""}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Roles</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="Role" leftPad="18px" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Description" active={sortKey === "desc"} dir={dir} onClick={() => toggleSort("desc")} />
              <SortTh label="Users" align="center" active={sortKey === "users"} dir={dir} onClick={() => toggleSort("users")} />
              <SortTh label="Status" active={sortKey === "status"} dir={dir} onClick={() => toggleSort("status")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedRoles.map((r) => (
              <tr key={r.id}>
                <td style={tdStyle("18px")}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 9, fontWeight: 700, color: "#1a2b4a" }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: r.color, flexShrink: 0 }} />
                    {r.name}
                  </span>
                </td>
                <td style={{ ...tdStyle(), color: "#8a97b0" }}>{r.desc}</td>
                <td style={{ ...tdStyle(), textAlign: "center", color: "#4a5878", fontWeight: 600 }}>{r.users}</td>
                <td style={tdStyle()}>
                  <button onClick={() => toggleStatus(r)} style={chipStyle(r.status === "Active")}>
                    {r.status}
                  </button>
                </td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => {
                        setEditingId(r.id);
                        setForm({ name: r.name, desc: r.desc, perms: [...r.perms], status: r.status });
                        setModalOpen(true);
                      }}
                      style={{ padding: "6px 12px", border: "1px solid #dfe5ee", background: "#fff", color: "#3a4a68", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        setDelId(r.id);
                        setDelOpen(true);
                      }}
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
          <ModalHeader title={editingId ? "Edit Role" : "New Role"} onClose={() => setModalOpen(false)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>
                Role Name <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Inventory Manager" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Description</label>
              <input value={form.desc} onChange={(e) => setF("desc", e.target.value)} placeholder="What this role is for" style={inputStyle} />
            </div>
            <div>
              <label style={{ ...labelStyle, marginBottom: 8 }}>
                Permissions <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {PERMS.map((p) => {
                  const on = form.perms.includes(p);
                  return (
                    <button
                      key={p}
                      onClick={() => setF("perms", on ? form.perms.filter((x) => x !== p) : [...form.perms, p])}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 12px",
                        border: `1px solid ${on ? "#bcd4ff" : "#e9edf3"}`,
                        background: on ? "#f2f7ff" : "#fff",
                        borderRadius: 10,
                        fontSize: 13,
                        fontWeight: 500,
                        color: "#1a2b4a",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 6,
                          border: `1.5px solid ${on ? "#1560f0" : "#cfd8e6"}`,
                          background: on ? "#1560f0" : "#fff",
                          color: "#fff",
                          fontSize: 12,
                          fontWeight: 700,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {on ? "✓" : ""}
                      </span>
                      <span>{p}</span>
                    </button>
                  );
                })}
              </div>
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
              Save Role
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {delOpen ? (
        <Modal onClose={() => setDelOpen(false)} maxWidth={440} align="center">
          <div style={{ padding: 24 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 11,
                background: blocked ? "#fff4e5" : "#fdecec",
                color: blocked ? "#d98207" : "#d63a3a",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
                marginBottom: 14,
              }}
            >
              {blocked ? "⚠" : "🗑"}
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>
              {blocked ? `Can't delete "${del?.name}"` : `Delete "${del?.name}"?`}
            </h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
              {blocked
                ? `${del?.users} users are assigned to this role. Reassign them to another role first.`
                : "This role has no assigned users. The delete is recorded in the audit trail."}
            </p>
          </div>
          <ModalFooter>
            <button onClick={() => setDelOpen(false)} style={secondaryBtnStyle}>
              {blocked ? "Got it" : "Cancel"}
            </button>
            {!blocked ? (
              <button
                onClick={async () => {
                  setDelOpen(false);
                  const id = delId;
                  setRoles((prev) => prev.filter((r) => r.id !== id));
                  if (id) await api.del(`/api/roles/${id}`);
                }}
                style={{ ...primaryBtnStyle, background: "#d63a3a" }}
              >
                Delete
              </button>
            ) : null}
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

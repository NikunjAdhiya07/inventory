"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, SearchInput, EmptyState, Modal, ModalHeader, ModalFooter, thStyle, labelStyle, inputStyle, secondaryBtnStyle, primaryBtnStyle, addBtnStyle, chipStyle, SortTh } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

const ROLES = ["Admin", "Inventory Manager", "Workflow Designer", "Viewer"];
const ROLE_COLORS: Record<string, string> = { Admin: "#1560f0", "Inventory Manager": "#0d9488", "Workflow Designer": "#8b5cf6", Viewer: "#f59e0b" };
const AV = ["#1560f0", "#0d9488", "#f59e0b", "#8b5cf6", "#ec4899", "#6366f1", "#0ea5e9"];

type User = { id: string; username: string; handle: string; tgId: string; role: string; status: "Active" | "Inactive" };
type UserForm = { tgId: string; handle: string; username: string; role: string; status: "Active" | "Inactive" };

const EMPTY_FORM: UserForm = { tgId: "", handle: "", username: "", role: "Viewer", status: "Active" };

function initials(n: string) {
  return n.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export default function UserAssignmentsPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [error, setError] = useState("");
  const [delOpen, setDelOpen] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<User[]>("/api/users")
      .then((data) => {
        if (!cancelled) setUsers(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = users.filter(
    (u) => (!q || u.username.toLowerCase().includes(q) || u.handle.toLowerCase().includes(q) || u.tgId.includes(q)) && (!roleFilter || u.role === roleFilter)
  );
  const del = users.find((u) => u.id === delId);
  const { sorted: sortedUsers, sortKey, dir, toggleSort } = useSort<User, keyof User>(filtered);

  function setF<K extends keyof UserForm>(k: K, v: UserForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!form.tgId.trim() || !form.username.trim()) return;
    setError("");
    try {
      if (editingId) {
        const updated = await api.patch<User>(`/api/users/${editingId}`, form);
        setUsers((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
      } else {
        const created = await api.post<User>("/api/users", form);
        setUsers((prev) => [...prev, created]);
      }
      setModalOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  }

  async function toggleStatus(u: User) {
    const status = u.status === "Active" ? "Inactive" : "Active";
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, status } : x)));
    await api.patch(`/api/users/${u.id}`, { status });
  }

  return (
    <PageShell section="Access" page="User Assignments">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro title="User Assignments" description="Map Telegram users to roles. Set a user inactive to revoke bot access without deleting the record." />
        <button
          onClick={() => {
            setEditingId(null);
            setForm(EMPTY_FORM);
            setError("");
            setModalOpen(true);
          }}
          style={addBtnStyle}
        >
          ＋ Assign User
        </button>
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Assigned users</span>
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={{ padding: "7px 10px", border: "1px solid #dfe5ee", borderRadius: 8, fontSize: 12.5, background: "#fbfcfe", color: "#3a4a68" }}>
              <option value="">All roles</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, @username, ID…" width={250} />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="User" leftPad="18px" active={sortKey === "username"} dir={dir} onClick={() => toggleSort("username")} />
              <SortTh label="Telegram ID" active={sortKey === "tgId"} dir={dir} onClick={() => toggleSort("tgId")} />
              <SortTh label="Role" active={sortKey === "role"} dir={dir} onClick={() => toggleSort("role")} />
              <SortTh label="Status" active={sortKey === "status"} dir={dir} onClick={() => toggleSort("status")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((u) => (
              <tr key={u.id}>
                <td style={{ padding: "11px 14px 11px 18px", borderTop: "1px solid #f1f4f8" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: "50%",
                        background: AV[hashCode(u.id) % AV.length],
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {initials(u.username)}
                    </div>
                    <div style={{ lineHeight: 1.3 }}>
                      <div style={{ fontWeight: 600, color: "#1a2b4a" }}>{u.username}</div>
                      <div style={{ fontSize: 11.5, color: "#98a4bd" }}>{u.handle}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: "11px 14px", borderTop: "1px solid #f1f4f8", color: "#8a97b0", fontFamily: "var(--font-mono)" }}>{u.tgId}</td>
                <td style={{ padding: "11px 14px", borderTop: "1px solid #f1f4f8" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "4px 11px",
                      borderRadius: 20,
                      fontSize: 12,
                      fontWeight: 600,
                      background: `${ROLE_COLORS[u.role] || "#94a3b8"}14`,
                      color: ROLE_COLORS[u.role] || "#5a6a86",
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: ROLE_COLORS[u.role] || "#94a3b8" }} />
                    {u.role}
                  </span>
                </td>
                <td style={{ padding: "11px 14px", borderTop: "1px solid #f1f4f8" }}>
                  <button onClick={() => toggleStatus(u)} style={chipStyle(u.status === "Active")}>
                    {u.status}
                  </button>
                </td>
                <td style={{ padding: "11px 18px 11px 14px", borderTop: "1px solid #f1f4f8" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => {
                        setEditingId(u.id);
                        setForm({ tgId: u.tgId, handle: u.handle, username: u.username, role: u.role, status: u.status });
                        setError("");
                        setModalOpen(true);
                      }}
                      style={{ padding: "6px 12px", border: "1px solid #dfe5ee", background: "#fff", color: "#3a4a68", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        setDelId(u.id);
                        setDelOpen(true);
                      }}
                      style={{ padding: "6px 12px", border: "1px solid #f4d0d0", background: "#fff", color: "#d63a3a", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                    >
                      Revoke
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 ? <EmptyState text="No users match." /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)} maxWidth={520}>
          <ModalHeader title={editingId ? "Edit Assignment" : "Assign User"} onClose={() => setModalOpen(false)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            {error ? (
              <div style={{ background: "#fdecec", color: "#d63a3a", padding: "10px 12px", borderRadius: 9, fontSize: 12.5 }}>{error}</div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>
                  Telegram User ID <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input value={form.tgId} onChange={(e) => setF("tgId", e.target.value)} placeholder="e.g. 584920113" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
              </div>
              <div>
                <label style={labelStyle}>Username</label>
                <input value={form.handle} onChange={(e) => setF("handle", e.target.value)} placeholder="@vedant" style={inputStyle} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Display Name</label>
              <input value={form.username} onChange={(e) => setF("username", e.target.value)} placeholder="Full name" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>
                Assigned Role <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <select value={form.role} onChange={(e) => setF("role", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
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
              Save Assignment
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {delOpen ? (
        <Modal onClose={() => setDelOpen(false)} maxWidth={440} align="center">
          <div style={{ padding: 24 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
              ⛔
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Revoke access for {del?.username}?</h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
              This removes the user&apos;s role mapping and their bot access. The action is logged in the audit trail.
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
                setUsers((prev) => prev.filter((u) => u.id !== id));
                if (id) await api.del(`/api/users/${id}`);
              }}
              style={{ ...primaryBtnStyle, background: "#d63a3a" }}
            >
              Revoke
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

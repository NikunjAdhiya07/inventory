"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, Modal, ModalHeader, ModalFooter, thStyle, tdStyle, labelStyle, inputStyle, secondaryBtnStyle, primaryBtnStyle, addBtnStyle, chipStyle, EmptyState, SortTh, toggleStyle, toggleKnobStyle } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

const PERMS = ["Add Inventory", "Manage Masters", "Manage Workflows", "Approve Entries", "View Reports"];

// The permission the Telegram webhook actually gates messaging on
// (`app/api/telegram/webhook/route.ts`). A person can only talk to the bot when
// they are an Active user AND their role carries this — the Access section below
// reports exactly that pair, so what it shows is what the bot will do.
const MESSAGE_PERM = "Add Inventory";

type Role = { id: string; name: string; desc: string; color: string; users: number; status: "Active" | "Inactive"; perms: string[] };
type RoleForm = { name: string; desc: string; perms: string[]; status: "Active" | "Inactive" };
type User = { id: string; username: string; handle: string; tgId: string; role: string; status: "Active" | "Inactive" };
type GrantForm = { username: string; tgId: string; handle: string; role: string };

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
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RoleForm>(EMPTY_FORM);
  const [delOpen, setDelOpen] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);
  const [accessError, setAccessError] = useState("");
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantForm, setGrantForm] = useState<GrantForm>({ username: "", tgId: "", handle: "", role: "" });
  const [grantError, setGrantError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<Role[]>("/api/roles"), api.get<User[]>("/api/users")])
      .then(([roleData, userData]) => {
        if (cancelled) return;
        setRoles(roleData);
        setUsers(userData);
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

  // ---- Access section ----------------------------------------------------

  function roleCanMessage(roleName: string) {
    return roles.some((r) => r.name === roleName && r.perms.includes(MESSAGE_PERM));
  }

  function hasAccess(u: User) {
    return u.status === "Active" && roleCanMessage(u.role);
  }

  // Flipping the switch writes the user's status. The webhook reads the user
  // record uncached on every update, so an off here takes the person's access
  // away on their very next message rather than at the end of a cache TTL.
  async function toggleAccess(u: User) {
    const status = u.status === "Active" ? "Inactive" : "Active";
    setAccessError("");
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, status } : x)));
    try {
      await api.patch(`/api/users/${u.id}`, { status });
    } catch (e) {
      // An access control that silently fails to save is worse than one that
      // refuses — put the row back where it was and say so.
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, status: u.status } : x)));
      setAccessError(e instanceof Error ? e.message : "Couldn't update access. Try again.");
    }
  }

  // The switch alone can't grant messaging to someone whose role lacks the
  // permission, so the role is editable inline — that's the lever that fixes it.
  async function changeUserRole(u: User, role: string) {
    setAccessError("");
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role } : x)));
    try {
      await api.patch(`/api/users/${u.id}`, { role });
    } catch (e) {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role: u.role } : x)));
      setAccessError(e instanceof Error ? e.message : "Couldn't update role. Try again.");
    }
  }

  function openGrant() {
    setGrantForm({ username: "", tgId: "", handle: "", role: roles.find((r) => r.perms.includes(MESSAGE_PERM))?.name ?? roles[0]?.name ?? "" });
    setGrantError("");
    setGrantOpen(true);
  }

  async function saveGrant() {
    const username = grantForm.username.trim();
    const tgId = grantForm.tgId.trim();
    if (!username || !tgId) {
      setGrantError("Name and Telegram number are both required.");
      return;
    }
    setGrantError("");
    try {
      const created = await api.post<User>("/api/users", { ...grantForm, username, tgId, handle: grantForm.handle.trim(), status: "Active" });
      setUsers((prev) => [...prev, created]);
      setGrantOpen(false);
    } catch (e) {
      setGrantError(e instanceof Error ? e.message : "Failed to grant access.");
    }
  }

  const withAccess = users.filter(hasAccess);
  // People who can message float to the top — the question this section answers
  // most often is "who has access right now".
  const accessRows = [...users].sort((a, b) => Number(hasAccess(b)) - Number(hasAccess(a)) || a.username.localeCompare(b.username));

  const del = roles.find((r) => r.id === delId);
  const blocked = (del?.users || 0) > 0;
  const { sorted: sortedRoles, sortKey, dir, toggleSort } = useSort<Role, keyof Role>(roles);

  return (
    <PageShell section="Access" page="Roles & Permissions">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Roles & Permissions"
          description="Define what each role can do. Toggle a cell to grant or revoke a permission — changes apply the moment you save. The Access section at the bottom shows who can message the bot right now."
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

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)", marginTop: 24 }}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid #f1f4f8", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Access</div>
            <div style={{ fontSize: 12, color: "#8a97b0", marginTop: 2 }}>
              Who can message the bot. Switching someone off blocks them on their very next message.
            </div>
          </div>
          <button onClick={openGrant} style={addBtnStyle}>
            ＋ Give Access
          </button>
        </div>

        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f1f4f8", background: "#fafbfd" }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".3px", textTransform: "uppercase", color: "#8a97b0", marginBottom: 9 }}>
            Currently has access — {withAccess.length} {withAccess.length === 1 ? "person" : "people"}
          </div>
          {withAccess.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {withAccess.map((u) => (
                <span
                  key={u.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "5px 11px",
                    borderRadius: 20,
                    fontSize: 12.5,
                    fontWeight: 600,
                    background: "#eafaf1",
                    border: "1px solid #c7ecd8",
                    color: "#0f7a4f",
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#0f9d63" }} />
                  {u.username}
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, color: "#5aa886" }}>{u.tgId}</span>
                </span>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "#98a4bd" }}>No one can message the bot right now.</div>
          )}
        </div>

        {accessError ? (
          <div style={{ margin: "14px 18px 0", background: "#fdecec", color: "#d63a3a", padding: "10px 12px", borderRadius: 9, fontSize: 12.5 }}>{accessError}</div>
        ) : null}

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <th style={thStyle("18px")}>Name</th>
              <th style={thStyle()}>Telegram Number</th>
              <th style={thStyle()}>Role</th>
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Message Access</th>
            </tr>
          </thead>
          <tbody>
            {accessRows.map((u) => {
              const on = u.status === "Active";
              const granted = hasAccess(u);
              // Active but the role can't message: the switch is on and still
              // nothing works. Say which of the two is missing rather than
              // showing a green light the bot won't honour.
              const roleBlocks = on && !granted;
              return (
                <tr key={u.id}>
                  <td style={tdStyle("18px")}>
                    <div style={{ lineHeight: 1.3 }}>
                      <div style={{ fontWeight: 600, color: "#1a2b4a" }}>{u.username}</div>
                      {u.handle ? <div style={{ fontSize: 11.5, color: "#98a4bd" }}>{u.handle}</div> : null}
                    </div>
                  </td>
                  <td style={{ ...tdStyle(), color: "#8a97b0", fontFamily: "var(--font-mono)" }}>{u.tgId}</td>
                  <td style={tdStyle()}>
                    <select
                      value={u.role}
                      onChange={(e) => changeUserRole(u, e.target.value)}
                      style={{
                        padding: "6px 9px",
                        border: `1px solid ${roleBlocks ? "#f0d3a4" : "#dfe5ee"}`,
                        borderRadius: 8,
                        fontSize: 12.5,
                        background: roleBlocks ? "#fff8ec" : "#fbfcfe",
                        color: "#3a4a68",
                      }}
                    >
                      {roles.map((r) => (
                        <option key={r.id} value={r.name}>
                          {r.name}
                          {r.perms.includes(MESSAGE_PERM) ? "" : " — can't message"}
                        </option>
                      ))}
                      {roles.some((r) => r.name === u.role) ? null : <option value={u.role}>{u.role} — unknown role</option>}
                    </select>
                  </td>
                  <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 11, justifyContent: "flex-end" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: granted ? "#0f9d63" : roleBlocks ? "#c07d10" : "#98a4bd", textAlign: "right" }}>
                        {granted ? "Can message" : roleBlocks ? `${u.role} can't message` : "Off"}
                      </span>
                      <button onClick={() => toggleAccess(u)} style={toggleStyle(on)} aria-label={`Toggle bot access for ${u.username}`} aria-pressed={on}>
                        <span style={toggleKnobStyle(on)} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && users.length === 0 ? <EmptyState text="No one has been given access yet." /> : null}
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

      {grantOpen ? (
        <Modal onClose={() => setGrantOpen(false)} maxWidth={520}>
          <ModalHeader
            title="Give Access"
            subtitle="The person must have started a chat with the bot at least once."
            onClose={() => setGrantOpen(false)}
          />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            {grantError ? (
              <div style={{ background: "#fdecec", color: "#d63a3a", padding: "10px 12px", borderRadius: 9, fontSize: 12.5 }}>{grantError}</div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>
                  Name <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input
                  value={grantForm.username}
                  onChange={(e) => setGrantForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="Full name"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>
                  Telegram Number <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input
                  value={grantForm.tgId}
                  onChange={(e) => setGrantForm((f) => ({ ...f, tgId: e.target.value }))}
                  placeholder="e.g. 584920113"
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Username</label>
              <input
                value={grantForm.handle}
                onChange={(e) => setGrantForm((f) => ({ ...f, handle: e.target.value }))}
                placeholder="@vedant"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>
                Role <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <select
                value={grantForm.role}
                onChange={(e) => setGrantForm((f) => ({ ...f, role: e.target.value }))}
                style={{ ...inputStyle, background: "#fff" }}
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.name}>
                    {r.name}
                    {r.perms.includes(MESSAGE_PERM) ? "" : " — can't message"}
                  </option>
                ))}
              </select>
              {grantForm.role && !roleCanMessage(grantForm.role) ? (
                <div style={{ marginTop: 7, fontSize: 12, color: "#c07d10" }}>
                  “{grantForm.role}” doesn&apos;t have the “{MESSAGE_PERM}” permission, so this person still won&apos;t be able to message the bot. Pick another
                  role, or grant that permission in the matrix above.
                </div>
              ) : null}
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setGrantOpen(false)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={saveGrant} style={primaryBtnStyle}>
              Give Access
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

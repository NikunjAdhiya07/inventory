"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
  PageIntro,
  SearchInput,
  EmptyState,
  Modal,
  ModalHeader,
  ModalFooter,
  tdStyle,
  thStyle,
  labelStyle,
  inputStyle,
  secondaryBtnStyle,
  primaryBtnStyle,
  addBtnStyle,
  actionBtnStyle,
  chipStyle,
} from "@/components/dc-ui";

type Group = { id: string; chatId: string; title: string; status: "Active" | "Inactive" };
type GroupForm = { chatId: string; title: string; status: "Active" | "Inactive" };

const EMPTY: GroupForm = { chatId: "", title: "", status: "Active" };

export default function TelegramGroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<GroupForm>(EMPTY);
  const [delId, setDelId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Group[]>("/api/telegram-groups")
      .then((d) => !cancelled && setGroups(d))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = groups.filter((g) => !q || g.title.toLowerCase().includes(q) || g.chatId.includes(q));
  const del = groups.find((g) => g.id === delId);

  function setF<K extends keyof GroupForm>(k: K, v: GroupForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY);
    setModalOpen(true);
  }
  function openEdit(g: Group) {
    setEditingId(g.id);
    setForm({ chatId: g.chatId, title: g.title, status: g.status });
    setModalOpen(true);
  }

  async function save() {
    if (!form.title.trim() || !form.chatId.trim()) return;
    if (editingId) {
      const updated = await api.patch<Group>(`/api/telegram-groups/${editingId}`, form);
      setGroups((prev) => prev.map((x) => (x.id === editingId ? updated : x)));
    } else {
      const created = await api.post<Group>("/api/telegram-groups", form);
      setGroups((prev) => [...prev, created]);
    }
    setModalOpen(false);
  }

  async function doDelete() {
    const id = delId;
    setDelId(null);
    setGroups((prev) => prev.filter((g) => g.id !== id));
    if (id) await api.del(`/api/telegram-groups/${id}`);
  }

  return (
    <PageShell section="Automation" page="Telegram Groups">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro title="Telegram Groups" description="The chats the bot listens in. Assign workflows to a group so entries started there follow the right flow." />
        <button onClick={openAdd} style={addBtnStyle}>
          ＋ New Group
        </button>
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>All groups</div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search title or chat id…" width={240} />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <th style={thStyle("16px")}>Group</th>
              <th style={thStyle()}>Chat ID</th>
              <th style={thStyle()}>Status</th>
              <th style={{ ...thStyle(), textAlign: "right", padding: "11px 16px 11px 14px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((g) => (
              <tr key={g.id}>
                <td style={{ ...tdStyle("16px"), fontWeight: 600, color: "#1a2b4a" }}>{g.title}</td>
                <td style={{ ...tdStyle(), color: "#4a5878", fontFamily: "var(--font-mono)" }}>{g.chatId}</td>
                <td style={tdStyle()}>
                  <span style={chipStyle(g.status === "Active")}>{g.status}</span>
                </td>
                <td style={{ ...tdStyle(), padding: "12px 16px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button onClick={() => openEdit(g)} style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                      Edit
                    </button>
                    <button onClick={() => setDelId(g.id)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 ? <EmptyState text="No groups yet. Add one to assign a workflow to it." /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)}>
          <ModalHeader title={editingId ? "Edit Group" : "New Telegram Group"} subtitle="The chat id is the numeric Telegram group id (often negative)." onClose={() => setModalOpen(false)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>
                Group Title <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={form.title} onChange={(e) => setF("title", e.target.value)} placeholder="e.g. Main Inventory Group" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>
                Chat ID <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={form.chatId} onChange={(e) => setF("chatId", e.target.value)} placeholder="-1001234567890" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
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
              Save Group
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {delId ? (
        <Modal onClose={() => setDelId(null)} maxWidth={420} align="center">
          <div style={{ padding: 24 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
              🗑
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete &ldquo;{del?.title}&rdquo;?</h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>The group moves to the recycle bin. Any workflow assignments to it stop matching.</p>
          </div>
          <ModalFooter>
            <button onClick={() => setDelId(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={doDelete} style={{ ...primaryBtnStyle, background: "#d63a3a" }}>
              Delete
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

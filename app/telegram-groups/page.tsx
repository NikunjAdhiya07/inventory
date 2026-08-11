"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
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
  toggleStyle,
  toggleKnobStyle,
} from "@/components/dc-ui";

type BotHealth = "healthy" | "unhealthy" | "unknown";
// What a plain typed message means here. One bot token can only have one
// webhook, so both flows arrive at the same endpoint and this is what tells them
// apart:
//   entry   — the inventory-capture workflow (the original behaviour)
//   request — search → Record movement (ledger) or Request item (cart → Accept)
//
// Material issue/return is not listed because it is not a mode: `/issue` works
// in EVERY approved group regardless of this setting, so one group can run the
// entry workflow and the handover lifecycle together.
type GroupMode = "entry" | "request";
type Group = {
  id: string;
  chatId: string;
  title: string;
  status: "Active" | "Inactive";
  approved: boolean;
  manualInactive: boolean;
  mode: GroupMode;
  botHealth: BotHealth;
  lastSeenAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
};
type GroupForm = { chatId: string; title: string; manualInactive: boolean };
type TgLog = {
  id: string;
  ts: string;
  type: "health" | "command" | "update" | "error";
  level: "info" | "error";
  message: string;
};

const EMPTY: GroupForm = { chatId: "", title: "", manualInactive: false };
// Client-side poll cadence. Kept deliberately gentle and paused when the tab is
// hidden so backgrounded tabs never invoke serverless functions. There are no
// cron jobs or server-side timers — health pings only run on demand.
const REFRESH_MS = 30000;

// Mirrors lib/telegram-health.deriveStatus so an optimistic approve or manual
// toggle can recompute the badge instantly without waiting for a server round trip.
function effStatus(
  g: Pick<Group, "approved" | "manualInactive" | "botHealth" | "status">,
): "Active" | "Inactive" {
  if (g.approved === false) return "Inactive";
  if (g.manualInactive) return "Inactive";
  if (g.botHealth === "unhealthy") return "Inactive";
  if (g.botHealth === "healthy") return "Active";
  return g.status;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusChip(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 11px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    border: `1px solid ${active ? "#c7ecd8" : "#f4c9c9"}`,
    background: active ? "#eafaf1" : "#fdecec",
    color: active ? "#0f9d63" : "#d63a3a",
  };
}

// Which of the two flows a plain message here belongs to. Colour-coded rather
// than plain text because getting it wrong is consequential in one direction: a
// group set to entries treats every message as the start of an inventory entry.
const MODE_META: Record<
  GroupMode,
  { label: string; border: string; bg: string; fg: string; hint: string }
> = {
  entry: {
    label: "📥 Entries",
    border: "#d8d2f0",
    bg: "#f2effc",
    fg: "#6d5bd0",
    hint: "Switch to capturing inventory entries in this group",
  },
  request: {
    label: "🛒 Search",
    border: "#cdd9f7",
    bg: "#eef3fe",
    fg: "#1560f0",
    hint: "Switch to search: record stock movements or raise item requests",
  },
};

function nextMode(mode: GroupMode): GroupMode {
  return mode === "request" ? "entry" : "request";
}

function modeChip(mode: GroupMode): CSSProperties {
  const m = MODE_META[mode] ?? MODE_META.entry;
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 11px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    border: `1px solid ${m.border}`,
    background: m.bg,
    color: m.fg,
  };
}

const logTypeColor: Record<TgLog["type"], { bg: string; fg: string }> = {
  health: { bg: "#eaf1ff", fg: "#2b5fd0" },
  command: { bg: "#eef0fb", fg: "#5b57c9" },
  update: { bg: "#eef2f7", fg: "#5a6b86" },
  error: { bg: "#fdecec", fg: "#d63a3a" },
};

export default function TelegramGroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "Active" | "Inactive"
  >("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [checking, setChecking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<GroupForm>(EMPTY);
  const [delId, setDelId] = useState<string | null>(null);

  const [logsGroup, setLogsGroup] = useState<Group | null>(null);
  const [logs, setLogs] = useState<TgLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logLevel, setLogLevel] = useState<"all" | "error">("all");

  const load = useCallback(async () => {
    const d = await api.get<Group[]>("/api/telegram-groups");
    setGroups(d);
    setLastRefreshed(new Date());
  }, []);

  // Initial load only — a cheap DB-only read, no bot pings. Health checks are
  // on demand (the "Run health check" button) so opening the page costs one
  // Mongo query, not N Telegram calls.
  useEffect(() => {
    let cancelled = false;
    api
      .get<Group[]>("/api/telegram-groups")
      .then((d) => !cancelled && (setGroups(d), setLastRefreshed(new Date())))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-refresh: poll the cheap (DB-only) list endpoint, but only while the tab
  // is actually visible. A backgrounded tab does zero network work, so idle tabs
  // never rack up serverless invocations. Also refresh once on regaining focus.
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load().catch(() => {});
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [autoRefresh, load]);

  const q = search.trim().toLowerCase();
  const filtered = groups.filter((g) => {
    if (statusFilter !== "all" && g.status !== statusFilter) return false;
    return !q || g.title.toLowerCase().includes(q) || g.chatId.includes(q);
  });
  const del = groups.find((g) => g.id === delId);
  const activeCount = groups.filter((g) => g.status === "Active").length;

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
    setForm({
      chatId: g.chatId,
      title: g.title,
      manualInactive: g.manualInactive,
    });
    setModalOpen(true);
  }

  async function save() {
    if (!form.title.trim() || !form.chatId.trim()) return;
    if (editingId) {
      await api.patch<Group>(`/api/telegram-groups/${editingId}`, form);
    } else {
      // Entered by hand in the console, so it is approved by the act of adding
      // it. Only groups the bot discovers on its own start pending.
      await api.post<Group>("/api/telegram-groups", {
        ...form,
        status: "Active",
        approved: true,
        botHealth: "unknown",
      });
    }
    setModalOpen(false);
    await load().catch(() => {});
  }

  async function doDelete() {
    const id = delId;
    setDelId(null);
    setGroups((prev) => prev.filter((g) => g.id !== id));
    if (id) await api.del(`/api/telegram-groups/${id}`).catch(() => {});
  }

  async function runHealthAll() {
    setChecking(true);
    try {
      const d = await api.post<Group[]>("/api/telegram-groups/health");
      setGroups(d);
      setLastRefreshed(new Date());
    } catch {
      /* leave existing rows in place on failure */
    } finally {
      setChecking(false);
    }
  }

  async function checkOne(id: string) {
    setBusyId(id);
    try {
      const g = await api.post<Group>(`/api/telegram-groups/${id}/health`);
      setGroups((prev) => prev.map((x) => (x.id === id ? g : x)));
    } catch {
      /* ignore */
    } finally {
      setBusyId(null);
    }
  }

  // Let a discovered group start serving entries. Until this is done the bot
  // refuses every update from the chat, so this is the only way a group the bot
  // was added to becomes usable.
  async function setApproved(g: Group, next: boolean) {
    setGroups((prev) =>
      prev.map((x) =>
        x.id === g.id
          ? {
              ...x,
              approved: next,
              status: effStatus({ ...x, approved: next }),
            }
          : x,
      ),
    );
    await api
      .patch(`/api/telegram-groups/${g.id}`, { approved: next })
      .catch(() => load());
  }

  // Admin override — force a group inactive (or release it) even when healthy.
  async function toggleManual(g: Group) {
    const next = !g.manualInactive;
    setGroups((prev) =>
      prev.map((x) =>
        x.id === g.id
          ? {
              ...x,
              manualInactive: next,
              status: effStatus({ ...x, manualInactive: next }),
            }
          : x,
      ),
    );
    await api
      .patch(`/api/telegram-groups/${g.id}`, { manualInactive: next })
      .catch(() => load());
  }

  // Cycle a group through the flows. Deliberately a per-group setting rather
  // than one bot per flow: the same token serves all of them, so what a chat is
  // for has to be an admin's decision recorded here.
  async function toggleMode(g: Group) {
    const next = nextMode(g.mode);
    setGroups((prev) =>
      prev.map((x) => (x.id === g.id ? { ...x, mode: next } : x)),
    );
    await api
      .patch(`/api/telegram-groups/${g.id}`, { mode: next })
      .catch(() => load());
  }

  const openLogs = useCallback(
    async (g: Group, level: "all" | "error" = "all") => {
      setLogsGroup(g);
      setLogLevel(level);
      setLogsLoading(true);
      try {
        const d = await api.get<TgLog[]>(
          `/api/telegram-groups/${g.id}/logs${level === "error" ? "?level=error" : ""}`,
        );
        setLogs(d);
      } catch {
        setLogs([]);
      } finally {
        setLogsLoading(false);
      }
    },
    [],
  );

  return (
    <PageShell section="Automation" page="Telegram Groups">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 20,
          marginBottom: 22,
        }}>
        <div>
          <PageIntro
            title="Telegram Groups"
            description="The chats the bot listens in. Mode switches each group between Entries (inventory capture) and Search (type an item → Record movement or Request item)."
          />
          <Link
            href="/workflows"
            style={{
              display: "inline-block",
              marginTop: 8,
              fontSize: 12.5,
              fontWeight: 600,
              color: "#1560f0",
              textDecoration: "none",
            }}>
            See search-group bot preview on Workflows →
          </Link>
        </div>
        <button onClick={openAdd} style={addBtnStyle}>
          ＋ New Group
        </button>
      </div>

      {/* Monitoring toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 16,
        }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12.5,
            color: "#4a5878",
            fontWeight: 600,
          }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#0f9d63",
            }}
          />
          {activeCount} active
          <span style={{ color: "#c4ccda" }}>·</span>
          <span style={{ color: "#8a97b0" }}>
            {groups.length - activeCount} inactive
          </span>
        </div>
        <button
          onClick={runHealthAll}
          disabled={checking}
          style={{
            ...secondaryBtnStyle,
            padding: "8px 14px",
            opacity: checking ? 0.6 : 1,
            cursor: checking ? "default" : "pointer",
          }}>
          {checking ? "Pinging bots…" : "↻ Run health check"}
        </button>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12.5,
            color: "#4a5878",
            fontWeight: 600,
            cursor: "pointer",
          }}>
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            style={toggleStyle(autoRefresh)}
            aria-label="Toggle auto-refresh">
            <span style={toggleKnobStyle(autoRefresh)} />
          </button>
          Auto-refresh
        </label>
        <span
          style={{ fontSize: 12, color: "#98a4bd" }}
          title={lastRefreshed?.toLocaleString()}>
          Updated {ago(lastRefreshed ? lastRefreshed.toISOString() : null)}
        </span>
      </div>

      <section
        style={{
          background: "#fff",
          border: "1px solid #e9edf3",
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 1px 2px rgba(16,30,54,.04)",
        }}>
        <div
          style={{
            padding: "15px 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            borderBottom: "1px solid #f1f4f8",
            flexWrap: "wrap",
          }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>
            All groups
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as typeof statusFilter)
              }
              style={{
                padding: "9px 12px",
                border: "1px solid #dfe5ee",
                borderRadius: 9,
                fontSize: 13,
                background: "#fbfcfe",
                color: "#3a4a68",
                fontWeight: 600,
              }}>
              <option value="all">All statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search title or chat id…"
              width={240}
            />
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr
                style={{
                  background: "#fafbfd",
                  color: "#8a97b0",
                  textAlign: "left",
                }}>
                <th style={thStyle("16px")}>Group</th>
                <th style={thStyle()}>Chat ID</th>
                <th style={thStyle()}>Mode</th>
                <th style={thStyle()}>Status</th>
                <th style={thStyle()}>Last Seen</th>
                <th
                  style={{
                    ...thStyle(),
                    textAlign: "right",
                    padding: "11px 16px 11px 14px",
                  }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => {
                const active = g.status === "Active";
                return (
                  <tr key={g.id}>
                    <td
                      style={{
                        ...tdStyle("16px"),
                        fontWeight: 600,
                        color: "#1a2b4a",
                      }}>
                      {g.title}
                      {!g.approved ? (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 10.5,
                            fontWeight: 700,
                            color: "#b04a00",
                            background: "#fff1e6",
                            border: "1px solid #ffd2b0",
                            padding: "1px 7px",
                            borderRadius: 20,
                          }}>
                          PENDING APPROVAL
                        </span>
                      ) : null}
                      {g.manualInactive ? (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 10.5,
                            fontWeight: 700,
                            color: "#b06a00",
                            background: "#fff4e2",
                            border: "1px solid #ffe1b0",
                            padding: "1px 7px",
                            borderRadius: 20,
                          }}>
                          OVERRIDDEN
                        </span>
                      ) : null}
                    </td>
                    <td
                      style={{
                        ...tdStyle(),
                        color: "#4a5878",
                        fontFamily: "var(--font-mono)",
                      }}>
                      {g.chatId}
                    </td>
                    <td style={tdStyle()}>
                      <span style={modeChip(g.mode)}>
                        {(MODE_META[g.mode] ?? MODE_META.entry).label}
                      </span>
                      {/* Not a mode — an overlay that works in every approved
                          group. Shown here anyway because "where can I run
                          /issue" is the first thing an admin asks. */}
                      <span
                        style={{
                          ...modeChip("entry"),
                          border: "1px dashed #ffddb8",
                          background: "#fff6ea",
                          color: "#b06a00",
                          marginLeft: 6,
                        }}
                        title="Material issue/return (/issue) works in every approved group, whichever flow is selected">
                        + 📤 /issue
                      </span>
                      <div style={{ marginTop: 5 }}>
                        <button
                          onClick={() => toggleMode(g)}
                          style={{
                            border: "none",
                            background: "none",
                            padding: 0,
                            fontSize: 11,
                            fontWeight: 600,
                            color: "#8a97b0",
                            cursor: "pointer",
                            textDecoration: "underline",
                          }}
                          title={MODE_META[nextMode(g.mode)].hint}>
                          {`Use for ${MODE_META[nextMode(g.mode)].label.replace(/^\S+\s/, "").toLowerCase()}`}
                        </button>
                      </div>
                    </td>
                    <td style={tdStyle()}>
                      <span
                        style={statusChip(active)}
                        title={
                          !g.approved
                            ? "Waiting for approval — the bot refuses this chat"
                            : g.lastError ||
                              (active ? "Bot reachable" : "Bot unreachable")
                        }>
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: active ? "#0f9d63" : "#d63a3a",
                          }}
                        />
                        {g.status}
                      </span>
                      <div style={{ marginTop: 5 }}>
                        <button
                          onClick={() => toggleManual(g)}
                          style={{
                            border: "none",
                            background: "none",
                            padding: 0,
                            fontSize: 11,
                            fontWeight: 600,
                            color: "#8a97b0",
                            cursor: "pointer",
                            textDecoration: "underline",
                          }}>
                          {g.manualInactive
                            ? "Release override"
                            : "Force inactive"}
                        </button>
                      </div>
                    </td>
                    <td style={{ ...tdStyle(), color: "#67748e" }}>
                      {ago(g.lastSeenAt)}
                      {g.lastError ? (
                        <div
                          style={{
                            fontSize: 11,
                            color: "#d63a3a",
                            marginTop: 2,
                            maxWidth: 220,
                          }}>
                          {g.lastError}
                        </div>
                      ) : null}
                    </td>
                    <td
                      style={{ ...tdStyle(), padding: "12px 16px 12px 14px" }}>
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          justifyContent: "flex-end",
                          flexWrap: "wrap",
                        }}>
                        <button
                          onClick={() => setApproved(g, !g.approved)}
                          style={actionBtnStyle(
                            g.approved ? "#b04a00" : "#0f9d63",
                            g.approved ? "#ffd2b0" : "#c7ecd8",
                          )}>
                          {g.approved ? "Revoke" : "Approve"}
                        </button>
                        <button
                          onClick={() => checkOne(g.id)}
                          disabled={busyId === g.id}
                          style={actionBtnStyle("#2b5fd0", "#c8d8f5")}>
                          {busyId === g.id ? "…" : "Check"}
                        </button>
                        <button
                          onClick={() => openLogs(g)}
                          style={actionBtnStyle("#5b57c9", "#d8d6f0")}>
                          Logs
                        </button>
                        <button
                          onClick={() => openEdit(g)}
                          style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                          Edit
                        </button>
                        <button
                          onClick={() => setDelId(g.id)}
                          style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && filtered.length === 0 ? (
          <EmptyState
            text={
              groups.length
                ? "No groups match your filters."
                : "No groups yet. Add one to assign a workflow to it."
            }
          />
        ) : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {modalOpen ? (
        <Modal onClose={() => setModalOpen(false)}>
          <ModalHeader
            title={editingId ? "Edit Group" : "New Telegram Group"}
            subtitle="The chat id is the numeric Telegram group id (often negative)."
            onClose={() => setModalOpen(false)}
          />
          <div
            style={{
              padding: "22px 24px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}>
            <div>
              <label style={labelStyle}>
                Group Title <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input
                value={form.title}
                onChange={(e) => setF("title", e.target.value)}
                placeholder="e.g. Main Inventory Group"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>
                Chat ID <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input
                value={form.chatId}
                onChange={(e) => setF("chatId", e.target.value)}
                placeholder="-1001234567890"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                background: "#f8fafc",
                border: "1px solid #eef2f7",
                borderRadius: 10,
                padding: "12px 14px",
              }}>
              <button
                onClick={() => setF("manualInactive", !form.manualInactive)}
                style={toggleStyle(form.manualInactive)}
                aria-label="Toggle manual override">
                <span style={toggleKnobStyle(form.manualInactive)} />
              </button>
              <div>
                <div
                  style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4a68" }}>
                  Force inactive (manual override)
                </div>
                <div style={{ fontSize: 11.5, color: "#8a97b0", marginTop: 2 }}>
                  Keeps the group offline even when the bot health check passes.
                </div>
              </div>
            </div>
          </div>
          <ModalFooter>
            <button
              onClick={() => setModalOpen(false)}
              style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={save} style={primaryBtnStyle}>
              Save Group
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {logsGroup ? (
        <Modal onClose={() => setLogsGroup(null)} maxWidth={640}>
          <ModalHeader
            title={`Activity · ${logsGroup.title}`}
            subtitle="Inventory updates, commands, health checks and errors for this group."
            onClose={() => setLogsGroup(null)}
          />
          <div style={{ padding: "14px 24px 0", display: "flex", gap: 8 }}>
            {(["all", "error"] as const).map((lv) => (
              <button
                key={lv}
                onClick={() => openLogs(logsGroup, lv)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: `1px solid ${logLevel === lv ? "#1560f0" : "#dfe5ee"}`,
                  background: logLevel === lv ? "#eef4ff" : "#fff",
                  color: logLevel === lv ? "#1560f0" : "#67748e",
                }}>
                {lv === "all" ? "All activity" : "Errors only"}
              </button>
            ))}
          </div>
          <div
            style={{
              padding: "14px 24px 24px",
              maxHeight: 440,
              overflowY: "auto",
            }}>
            {logsLoading ? (
              <EmptyState text="Loading activity…" />
            ) : logs.length === 0 ? (
              <EmptyState
                text={
                  logLevel === "error"
                    ? "No errors logged for this group."
                    : "No activity logged yet."
                }
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {logs.map((l) => {
                  const c = logTypeColor[l.type] ?? logTypeColor.update;
                  return (
                    <div
                      key={l.id}
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "flex-start",
                        padding: "10px 12px",
                        border: "1px solid #f1f4f8",
                        borderRadius: 10,
                        background: l.level === "error" ? "#fffafa" : "#fff",
                      }}>
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: 10.5,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: ".3px",
                          padding: "3px 8px",
                          borderRadius: 6,
                          background: c.bg,
                          color: c.fg,
                        }}>
                        {l.type}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            color: l.level === "error" ? "#d63a3a" : "#2b3a55",
                            fontWeight: l.level === "error" ? 600 : 500,
                          }}>
                          {l.message}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#98a4bd",
                            marginTop: 2,
                          }}>
                          {new Date(l.ts).toLocaleString()} · {ago(l.ts)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Modal>
      ) : null}

      {delId ? (
        <Modal onClose={() => setDelId(null)} maxWidth={420} align="center">
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
              }}>
              🗑
            </div>
            <h3
              style={{
                margin: "0 0 6px",
                fontSize: 17,
                fontWeight: 800,
                color: "#0b1b45",
              }}>
              Delete &ldquo;{del?.title}&rdquo;?
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: 13.5,
                color: "#67748e",
                lineHeight: 1.55,
              }}>
              The group moves to the recycle bin. Any workflow assignments to it
              stop matching.
            </p>
          </div>
          <ModalFooter>
            <button onClick={() => setDelId(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button
              onClick={doDelete}
              style={{ ...primaryBtnStyle, background: "#d63a3a" }}>
              Delete
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

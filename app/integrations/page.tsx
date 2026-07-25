"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, thStyle, tdStyle, EmptyState, SortTh } from "@/components/dc-ui";
import { useSort } from "@/lib/use-sort";

const CARDS = [
  { name: "Telegram Bot", icon: "✈", bg: "#eaf2ff", fg: "#1560f0", status: "Connected", ok: true, desc: "@masterbase_inventory_bot reads all masters read-only. Story 3.", btn: "Manage" },
  { name: "Webhooks", icon: "🔗", bg: "#f0ecff", fg: "#7c4ddb", status: "2 active", ok: true, desc: "Fire an event when any master changes so subscribers stay in sync.", btn: "Configure" },
  { name: "Workflow Engine", icon: "⚙", bg: "#e9f7f4", fg: "#0d9488", status: "Connected", ok: true, desc: "Custom workflows (Story 2) consume categories, units and locations.", btn: "Manage" },
  { name: "ERP Sync", icon: "🏛", bg: "#fff2e5", fg: "#c9760a", status: "Not connected", ok: false, desc: "Push master data to an external ERP. Available on the roadmap.", btn: "Connect" },
  { name: "Google Sheets", icon: "▦", bg: "#e9f7f0", fg: "#0f9d63", status: "Not connected", ok: false, desc: "Mirror any master into a live spreadsheet for reporting.", btn: "Connect" },
  { name: "Slack Alerts", icon: "#", bg: "#fdecf4", fg: "#c026a8", status: "Not connected", ok: false, desc: "Post sync failures and approvals to a Slack channel.", btn: "Connect" },
];

type ApiKey = { id: string; name: string; masked: string; scope: string; lastUsed: string };

export default function IntegrationsPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ApiKey[]>("/api/api-keys")
      .then((data) => {
        if (!cancelled) setKeys(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { sorted: sortedKeys, sortKey, dir, toggleSort } = useSort<ApiKey, keyof ApiKey>(keys);

  function copy(id: string) {
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  }

  async function newKey() {
    const created = await api.post<ApiKey>("/api/api-keys");
    setKeys((prev) => [...prev, created]);
  }

  async function revoke(id: string) {
    setKeys((prev) => prev.filter((x) => x.id !== id));
    await api.del(`/api/api-keys/${id}`);
  }

  return (
    <PageShell section="System" page="Integrations">
      <div style={{ marginBottom: 22 }}>
        <PageIntro
          title="Integrations"
          description="The systems that consume this master data. The Telegram bot and workflows read it live; webhooks and API keys let other tools subscribe."
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 24 }}>
        {CARDS.map((c) => (
          <div key={c.name} style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: 20, boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ width: 40, height: 40, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, background: c.bg, color: c.fg }}>
                {c.icon}
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "3px 10px",
                  borderRadius: 20,
                  background: c.ok ? "#e9f7f0" : "#f1f4f9",
                  color: c.ok ? "#0f9d63" : "#8a97b0",
                }}
              >
                {c.status}
              </span>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0b1b45" }}>{c.name}</div>
            <div style={{ fontSize: 12.5, color: "#8a97b0", lineHeight: 1.5, marginTop: 4, minHeight: 38 }}>{c.desc}</div>
            <button
              style={{
                width: "100%",
                marginTop: 16,
                padding: 9,
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                border: `1px solid ${c.ok ? "#dfe5ee" : "#1560f0"}`,
                background: c.ok ? "#fff" : "#1560f0",
                color: c.ok ? "#3a4a68" : "#fff",
              }}
            >
              {c.btn}
            </button>
          </div>
        ))}
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #f1f4f8" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>API keys</div>
          <button onClick={newKey} style={{ padding: "8px 14px", border: "none", background: "#1560f0", color: "#fff", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
            ＋ Generate key
          </button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <SortTh label="Name" leftPad="18px" active={sortKey === "name"} dir={dir} onClick={() => toggleSort("name")} />
              <SortTh label="Key" active={sortKey === "masked"} dir={dir} onClick={() => toggleSort("masked")} />
              <SortTh label="Scope" active={sortKey === "scope"} dir={dir} onClick={() => toggleSort("scope")} />
              <SortTh label="Last used" active={sortKey === "lastUsed"} dir={dir} onClick={() => toggleSort("lastUsed")} />
              <th style={{ ...thStyle(), padding: "11px 18px 11px 14px", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedKeys.map((k) => (
              <tr key={k.id}>
                <td style={{ ...tdStyle("18px"), fontWeight: 600, color: "#1a2b4a" }}>{k.name}</td>
                <td style={{ ...tdStyle(), fontFamily: "var(--font-mono)", color: "#8a97b0" }}>{k.masked}</td>
                <td style={tdStyle()}>
                  <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: "#eef2f9", color: "#5a6a86" }}>{k.scope}</span>
                </td>
                <td style={{ ...tdStyle(), color: "#8a97b0" }}>{k.lastUsed}</td>
                <td style={{ ...tdStyle(), padding: "12px 18px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => copy(k.id)}
                      style={{ padding: "6px 12px", border: "1px solid #dfe5ee", background: "#fff", color: "#3a4a68", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                    >
                      {copiedId === k.id ? "Copied ✓" : "Copy"}
                    </button>
                    <button
                      onClick={() => revoke(k.id)}
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
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>
    </PageShell>
  );
}

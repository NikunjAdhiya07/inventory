"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, labelStyle, inputStyle, toggleStyle, toggleKnobStyle } from "@/components/dc-ui";

type Fields = { company: string; tz: string; dateFmt: string; currency: string; lang: string };
type Toggles = { softDelete: boolean; approval: boolean; duplicate: boolean; autoSync: boolean };
type SettingsDoc = Fields & { toggles: Toggles };

const TOGGLE_DEFS: [keyof Toggles, string, string][] = [
  ["softDelete", "Soft delete only (Recycle Bin)", "Records are never hard-deleted — they move to the Recycle Bin and can be restored."],
  ["approval", "Require approval for master changes", "New and edited masters enter the Approval Queue before they sync to the bot."],
  ["duplicate", "Block duplicate names", "Prevent two active records of the same type from sharing a name."],
  ["autoSync", "Auto-sync to Telegram", "Push every approved change to the bot immediately, with retry on failure."],
];

const DEFAULT_FIELDS: Fields = { company: "", tz: "Asia/Kolkata (GMT+5:30)", dateFmt: "DD MMM YYYY", currency: "INR — ₹", lang: "English" };
const DEFAULT_TOGGLES: Toggles = { softDelete: true, approval: true, duplicate: true, autoSync: true };

export default function GeneralSettingsPage() {
  const [f, setF] = useState<Fields>(DEFAULT_FIELDS);
  const [toggles, setToggles] = useState<Toggles>(DEFAULT_TOGGLES);
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get<SettingsDoc>("/api/settings").then((doc) => {
      const { toggles: t, ...rest } = doc;
      setF(rest);
      setToggles(t);
      setLoaded(true);
    });
  }, []);

  function setField<K extends keyof Fields>(k: K, v: Fields[K]) {
    setF((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  }

  async function persist(next: { f: Fields; toggles: Toggles }) {
    await api.put("/api/settings", { ...next.f, toggles: next.toggles });
  }

  async function save() {
    await persist({ f, toggles });
    setSaved(true);
  }

  async function flipToggle(key: keyof Toggles) {
    const next = { ...toggles, [key]: !toggles[key] };
    setToggles(next);
    setSaved(false);
    await persist({ f, toggles: next });
  }

  return (
    <PageShell section="Configuration" page="General Settings" maxWidth={920}>
      <div style={{ marginBottom: 22 }}>
        <PageIntro title="General Settings" description="Organization-wide defaults and the master-data lifecycle policy every screen inherits." />
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)", marginBottom: 18, opacity: loaded ? 1 : 0.6 }}>
        <div style={{ padding: "15px 20px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Organization</div>
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <div style={{ gridColumn: "1/-1" }}>
            <label style={labelStyle}>Company Name</label>
            <input value={f.company} onChange={(e) => setField("company", e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Timezone</label>
            <select value={f.tz} onChange={(e) => setField("tz", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
              <option>Asia/Kolkata (GMT+5:30)</option>
              <option>Asia/Dubai (GMT+4)</option>
              <option>UTC</option>
              <option>America/New_York (GMT-5)</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Date Format</label>
            <select value={f.dateFmt} onChange={(e) => setField("dateFmt", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
              <option>DD MMM YYYY</option>
              <option>DD/MM/YYYY</option>
              <option>MM/DD/YYYY</option>
              <option>YYYY-MM-DD</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Currency</label>
            <select value={f.currency} onChange={(e) => setField("currency", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
              <option>INR — ₹</option>
              <option>USD — $</option>
              <option>AED — د.إ</option>
              <option>EUR — €</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Language</label>
            <select value={f.lang} onChange={(e) => setField("lang", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
              <option>English</option>
              <option>Hindi</option>
              <option>Arabic</option>
            </select>
          </div>
        </div>
      </section>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)", marginBottom: 18 }}>
        <div style={{ padding: "15px 20px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Telegram Bot</div>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>Bot Token</label>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                value={reveal ? "7829143650:AAH9x2Lp-Qf3kZvN8rT1mWq..." : "•••••••••••••••••••••••••••••••••"}
                readOnly
                style={{ flex: 1, padding: "10px 12px", border: "1px solid #dfe5ee", borderRadius: 9, fontSize: 13, fontFamily: "var(--font-mono)", background: "#fbfcfe", color: "#5a6a86" }}
              />
              <button onClick={() => setReveal(!reveal)} style={{ padding: "10px 14px", border: "1px solid #dfe5ee", background: "#fff", color: "#3a4a68", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {reveal ? "Hide" : "Reveal"}
              </button>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#0f9d63", fontWeight: 600 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#0f9d63" }} />
            Connected to @masterbase_inventory_bot
          </div>
        </div>
      </section>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)", marginBottom: 18 }}>
        <div style={{ padding: "15px 20px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Master Data Lifecycle Policy</div>
        <div>
          {TOGGLE_DEFS.map(([key, title, desc]) => {
            const on = toggles[key];
            return (
              <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "15px 20px", borderTop: "1px solid #f6f8fb" }}>
                <div style={{ lineHeight: 1.4 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1a2b4a" }}>{title}</div>
                  <div style={{ fontSize: 12, color: "#8a97b0", maxWidth: 520 }}>{desc}</div>
                </div>
                <button onClick={() => flipToggle(key)} style={toggleStyle(on)}>
                  <span style={toggleKnobStyle(on)} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <div
        style={{
          position: "sticky",
          bottom: 0,
          background: "rgba(255,255,255,.9)",
          backdropFilter: "blur(8px)",
          borderTop: "1px solid #e9edf3",
          padding: "14px 0",
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          zIndex: 15,
        }}
      >
        <button style={{ padding: "10px 18px", border: "1px solid #dfe5ee", background: "#fff", color: "#3a4a68", borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>
          Discard
        </button>
        <button
          onClick={save}
          style={{ padding: "10px 22px", border: "none", background: "#1560f0", color: "#fff", borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}
        >
          {saved ? "✓ Saved" : "Save Changes"}
        </button>
      </div>
    </PageShell>
  );
}

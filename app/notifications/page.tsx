"use client";

import { useEffect, useRef, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import { PageIntro, labelStyle, inputStyle, toggleStyle, toggleKnobStyle } from "@/components/dc-ui";

const CH = ["Telegram", "Email", "In-app"];
const EVENTS: [string, string][] = [
  ["Sync failure", "A push to the bot failed and entered the retry queue"],
  ["Approval requested", "A master change is waiting for review"],
  ["Approval decision", "Your submitted change was approved or rejected"],
  ["Record deactivated", "A category, unit or location was set inactive"],
  ["Bulk import complete", "An Excel / CSV import finished processing"],
  ["New user assigned", "A Telegram user was mapped to a role"],
];

type NotifDoc = { email: string; tg: string; matrix: boolean[][] };

export default function NotificationsPage() {
  const [matrix, setMatrix] = useState<boolean[][]>(EVENTS.map(() => [false, false, false]));
  const [email, setEmail] = useState("");
  const [tg, setTg] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.get<NotifDoc>("/api/notifications").then((doc) => {
      setMatrix(doc.matrix);
      setEmail(doc.email);
      setTg(doc.tg);
    });
  }, []);

  // Debounce persistence so typing in the recipient fields doesn't fire a
  // network request (and a Mongo write) on every keystroke.
  function schedulePersist(next: Partial<NotifDoc>) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.put("/api/notifications", next);
    }, 500);
  }

  function toggle(ri: number, ci: number) {
    setMatrix((prev) => {
      const next = prev.map((row, r) => (r === ri ? row.map((v, c) => (c === ci ? !v : v)) : row));
      api.put("/api/notifications", { matrix: next });
      return next;
    });
  }

  return (
    <PageShell section="Configuration" page="Notifications" maxWidth={940}>
      <div style={{ marginBottom: 22 }}>
        <PageIntro
          title="Notifications"
          description="Choose which channel fires for each event. Sync failures and approval requests are the ones you'll want on."
        />
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)", marginBottom: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0" }}>
              <th style={{ textAlign: "left", padding: "14px 16px 14px 20px", fontWeight: 600, fontSize: 11.5, letterSpacing: ".3px", textTransform: "uppercase" }}>Event</th>
              {CH.map((c) => (
                <th key={c} style={{ textAlign: "center", padding: "14px 12px", fontWeight: 600, fontSize: 11.5, letterSpacing: ".3px", textTransform: "uppercase", width: 110 }}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {EVENTS.map(([title, desc], ri) => (
              <tr key={title}>
                <td style={{ padding: "14px 16px 14px 20px", borderTop: "1px solid #f1f4f8" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1a2b4a" }}>{title}</div>
                  <div style={{ fontSize: 12, color: "#8a97b0" }}>{desc}</div>
                </td>
                {CH.map((_, ci) => {
                  const on = matrix[ri]?.[ci] ?? false;
                  return (
                    <td key={ci} style={{ padding: "10px 12px", borderTop: "1px solid #f1f4f8", textAlign: "center" }}>
                      <button onClick={() => toggle(ri, ci)} style={toggleStyle(on, 42, 24)}>
                        <span style={toggleKnobStyle(on, 42)} />
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: 20, boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45", marginBottom: 16 }}>Recipients</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <div>
            <label style={labelStyle}>Admin email(s)</label>
            <input
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                schedulePersist({ email: e.target.value });
              }}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Telegram alert channel</label>
            <input
              value={tg}
              onChange={(e) => {
                setTg(e.target.value);
                schedulePersist({ tg: e.target.value });
              }}
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
            />
          </div>
        </div>
      </section>
    </PageShell>
  );
}

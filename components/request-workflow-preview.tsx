"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export const REQUEST_WORKFLOW_STEPS = [
  {
    id: "search",
    label: "Search",
    title: "Search stock",
    blurb: "Anyone with Request Items types what they need in the search group.",
    icon: "🔍",
  },
  {
    id: "cart",
    label: "Cart & submit",
    title: "Build cart & submit",
    blurb: "Pick location and quantity, then submit a numbered ticket.",
    icon: "🧺",
  },
  {
    id: "accept",
    label: "Manager Accept",
    title: "Inventory Manager Accept",
    blurb: "Managers are tagged. Accept is the only approval step.",
    icon: "✔",
  },
  {
    id: "done",
    label: "Stock out",
    title: "Stock decreased · closed",
    blurb: "Ledger issues the qty and the ticket closes immediately.",
    icon: "📉",
  },
] as const;

const INTERVAL_MS = 2200;

type Props = {
  /** panel = page section; modal = content inside Build-style dialog */
  variant?: "panel" | "modal";
};

export default function RequestWorkflowPreview({ variant = "panel" }: Props) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => (s + 1) % REQUEST_WORKFLOW_STEPS.length), INTERVAL_MS);
    return () => clearInterval(t);
  }, [playing]);

  const current = REQUEST_WORKFLOW_STEPS[step];
  const isModal = variant === "modal";

  const body = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isModal ? "240px 1fr minmax(240px, 280px)" : "minmax(0, 1fr) minmax(260px, 320px)",
        gap: 0,
        minHeight: isModal ? 420 : undefined,
      }}
      className="rq-preview-grid"
    >
      {isModal ? (
        <div style={{ borderRight: "1px solid #f1f4f8", padding: "16px 14px", background: "#fafbfd", maxHeight: 560, overflowY: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "#aab4c8", marginBottom: 10 }}>
            Request steps (fixed)
          </div>
          {REQUEST_WORKFLOW_STEPS.map((s, i) => {
            const active = i === step;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setStep(i);
                  setPlaying(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  width: "100%",
                  textAlign: "left",
                  padding: "9px 10px",
                  marginBottom: 6,
                  border: `1px solid ${active ? "#cdd9f7" : "#e9edf3"}`,
                  borderRadius: 9,
                  background: active ? "#eef3fe" : "#fff",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontSize: 15, width: 20, textAlign: "center" }}>{s.icon}</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "#1a2b4a" }}>{s.label}</span>
                <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: active ? "#1560f0" : "#98a4bd" }}>{i + 1}</span>
              </button>
            );
          })}
          <div style={{ marginTop: 14, padding: "10px 10px", borderRadius: 9, background: "#fff", border: "1px solid #e9edf3", fontSize: 11.5, color: "#67748e", lineHeight: 1.45 }}>
            These steps are not in the entry Step Library. Requests-mode Telegram groups run this flow automatically.
          </div>
        </div>
      ) : null}

      <div style={{ padding: isModal ? "16px 20px" : "20px 22px", borderRight: "1px solid #f1f4f8" }}>
        {!isModal ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
            {REQUEST_WORKFLOW_STEPS.map((s, i) => {
              const active = i === step;
              const done = i < step;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setStep(i);
                    setPlaying(false);
                  }}
                  style={{
                    flex: "1 1 100px",
                    minWidth: 100,
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: `1px solid ${active ? "#cdd9f7" : "#e9edf3"}`,
                    background: active ? "#eef3fe" : done ? "#f6f8fb" : "#fff",
                    cursor: "pointer",
                    transition: "border-color .2s, background .2s",
                  }}
                >
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: active ? "#1560f0" : "#98a4bd", marginBottom: 4 }}>
                    Step {i + 1}
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0b1b45" }}>{s.label}</div>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "#aab4c8", marginBottom: 12 }}>
            Conversation ({REQUEST_WORKFLOW_STEPS.length} steps)
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#0b1b45" }}>{current.title}</div>
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid #dfe5ee",
              background: "#fbfcfe",
              color: "#3a4a68",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {playing ? "Pause" : "Play"}
          </button>
        </div>
        <div style={{ fontSize: 13.5, color: "#4a5878", lineHeight: 1.5, marginBottom: 18 }}>{current.blurb}</div>

        {isModal ? (
          <ol style={{ margin: 0, padding: "0 0 0 18px", color: "#4a5878", fontSize: 13, lineHeight: 1.7 }}>
            {REQUEST_WORKFLOW_STEPS.map((s, i) => (
              <li key={s.id} style={{ fontWeight: i === step ? 700 : 500, color: i === step ? "#0b1b45" : "#67748e" }}>
                {s.title}
              </li>
            ))}
          </ol>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {REQUEST_WORKFLOW_STEPS.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Go to step ${i + 1}`}
                onClick={() => {
                  setStep(i);
                  setPlaying(false);
                }}
                style={{
                  width: i === step ? 18 : 8,
                  height: 8,
                  borderRadius: 8,
                  border: "none",
                  padding: 0,
                  background: i === step ? "#1560f0" : "#d5dce8",
                  cursor: "pointer",
                  transition: "width .25s, background .25s",
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          padding: isModal ? "16px 14px" : "22px 18px",
          background: "linear-gradient(165deg, #f4f7fb 0%, #e8eef7 55%, #eef3fe 100%)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <TelegramPhone step={step} />
      </div>
    </div>
  );

  return (
    <>
      {variant === "panel" ? (
        <section
          style={{
            background: "#fff",
            border: "1px solid #e9edf3",
            borderRadius: 14,
            overflow: "hidden",
            boxShadow: "0 1px 2px rgba(16,30,54,.04)",
            marginBottom: 22,
          }}
        >
          <div
            style={{
              padding: "15px 18px",
              borderBottom: "1px solid #f1f4f8",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Search / Request workflow</div>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    background: "#eef3fe",
                    color: "#1560f0",
                    borderRadius: 20,
                    padding: "2px 8px",
                  }}
                >
                  2ND BOT · FIXED
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: "#8a97b0", maxWidth: 520, lineHeight: 1.45 }}>
                Custom flow for Telegram groups in Requests mode — not built with the entry Step Library. Search →
                submit → manager Accept issues stock and closes the ticket.
              </div>
            </div>
          </div>
          {body}
        </section>
      ) : (
        body
      )}

      <style>{`
        @media (max-width: 900px) {
          .rq-preview-grid {
            grid-template-columns: 1fr !important;
          }
          .rq-preview-grid > div {
            border-right: none !important;
            border-bottom: 1px solid #f1f4f8;
          }
        }
        @keyframes rqFadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes rqPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(21, 96, 240, 0.35); }
          50% { box-shadow: 0 0 0 6px rgba(21, 96, 240, 0); }
        }
        @keyframes rqStockOut {
          from { opacity: 0; transform: scale(0.92); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </>
  );
}

function TelegramPhone({ step }: { step: number }) {
  return (
    <div
      style={{
        width: 248,
        borderRadius: 28,
        border: "2px solid #1a2b4a",
        background: "#0b1b45",
        padding: "10px 8px 14px",
        boxShadow: "0 16px 40px rgba(11, 27, 69, 0.22)",
      }}
    >
      <div style={{ width: 72, height: 5, borderRadius: 4, background: "#2a3d66", margin: "0 auto 10px" }} />
      <div
        style={{
          borderRadius: 18,
          background: "#17212b",
          overflow: "hidden",
          minHeight: 340,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "10px 12px",
            background: "#232e3c",
            borderBottom: "1px solid #2b3848",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #1560f0, #0d9488)",
              display: "grid",
              placeItems: "center",
              color: "#fff",
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            B
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#e8eef7" }}>Inventory Bot</div>
            <div style={{ fontSize: 10, color: "#8a97b0" }}>Search group</div>
          </div>
        </div>

        <div style={{ flex: 1, padding: "12px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div key={step} style={{ animation: "rqFadeUp .35s ease" }}>
            <PhoneScreen step={step} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneScreen({ step }: { step: number }) {
  if (step === 0) {
    return (
      <>
        <UserBubble>Type-C cable</UserBubble>
        <BotCard>
          <div style={cardTitle}>“Type-C cable” — 2 in stock</div>
          <div style={cardLine}>
            <b>1. USB-C Cable 1m</b>
          </div>
          <div style={cardMuted}>Cables › Store A — 12 pcs</div>
          <div style={cardLine}>
            <b>2. USB-C Cable 2m</b>
          </div>
          <div style={cardMuted}>Cables › Rack 3 — 4 pcs</div>
          <div style={{ ...btnRow, marginTop: 8 }}>
            <FakeBtn label="1. USB-C Cable 1m" primary />
            <FakeBtn label="2. USB-C Cable 2m" />
          </div>
        </BotCard>
      </>
    );
  }

  if (step === 1) {
    return (
      <BotCard>
        <div style={cardTitle}>Your request — 1 item</div>
        <div style={cardLine}>• USB-C Cable 1m × 2 pcs</div>
        <div style={cardMuted}>📍 Store A › Shelf 2</div>
        <div style={{ ...btnRow, marginTop: 10 }}>
          <FakeBtn label="Submit request" primary pulse />
          <FakeBtn label="Add more" />
        </div>
      </BotCard>
    );
  }

  if (step === 2) {
    return (
      <BotCard>
        <div style={cardTitle}>REQ-0042 — waiting for approval</div>
        <div style={cardMuted}>Requested by Alex</div>
        <div style={{ ...cardLine, marginTop: 6 }}>• USB-C Cable 1m × 2 pcs</div>
        <div style={{ ...cardMuted, marginTop: 8 }}>@inventory_mgr — please review</div>
        <div style={{ fontSize: 10, color: "#8ab4ff", marginTop: 6, fontStyle: "italic" }}>
          Accept issues the stock and closes this request.
        </div>
        <div style={{ ...btnRow, marginTop: 10 }}>
          <FakeBtn label="Accept — issue stock" primary pulse />
          <FakeBtn label="Reject" danger />
        </div>
      </BotCard>
    );
  }

  return (
    <BotCard>
      <div style={{ ...cardTitle, color: "#5ddea0" }}>REQ-0042 — completed — stock issued</div>
      <div style={cardLine}>• USB-C Cable 1m × 2 pcs</div>
      <div
        style={{
          marginTop: 10,
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(15, 157, 99, 0.18)",
          border: "1px solid rgba(15, 157, 99, 0.35)",
          animation: "rqStockOut .4s ease",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "#5ddea0" }}>Issued</div>
        <div style={{ fontSize: 12, color: "#e8eef7", marginTop: 2 }}>−2 pcs USB-C Cable 1m</div>
      </div>
      <div style={{ ...cardMuted, marginTop: 8 }}>• Manager — Accepted — stock issued and request closed.</div>
    </BotCard>
  );
}

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
      <div
        style={{
          background: "#1560f0",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
          padding: "7px 11px",
          borderRadius: "12px 12px 4px 12px",
          maxWidth: "85%",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function BotCard({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: "#232e3c",
        borderRadius: "4px 12px 12px 12px",
        padding: "10px 11px",
        border: "1px solid #2b3848",
      }}
    >
      {children}
    </div>
  );
}

function FakeBtn({
  label,
  primary,
  danger,
  pulse,
}: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  pulse?: boolean;
}) {
  const style: CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "center",
    padding: "6px 8px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 700,
    border: `1px solid ${danger ? "#7a3a3a" : primary ? "#3d6fd4" : "#3a4a68"}`,
    background: danger ? "#3a2424" : primary ? "#1e3a6e" : "#2a3545",
    color: danger ? "#f0a0a0" : primary ? "#cfe0ff" : "#c4ccda",
    animation: pulse ? "rqPulse 1.4s ease infinite" : undefined,
  };
  return <div style={style}>{label}</div>;
}

const cardTitle: CSSProperties = { fontSize: 12, fontWeight: 700, color: "#e8eef7", marginBottom: 4 };
const cardLine: CSSProperties = { fontSize: 11.5, color: "#d5dce8", lineHeight: 1.4 };
const cardMuted: CSSProperties = { fontSize: 10.5, color: "#8a97b0", lineHeight: 1.35 };
const btnRow: CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };

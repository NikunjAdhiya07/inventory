"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export type PreviewPath = "move" | "request";

export type PreviewStep = {
  id: string;
  label: string;
  title: string;
  blurb: string;
  icon: string;
};

/** Shared + movement path — used for step counts on the workflows list. */
export const MOVE_WORKFLOW_STEPS: PreviewStep[] = [
  {
    id: "search",
    label: "Search",
    title: "Type an item name",
    blurb: "In a Requests-mode Telegram group, anyone with Request Items types a product name. No slash command.",
    icon: "🔍",
  },
  {
    id: "intent",
    label: "Choose action",
    title: "Stock details · pick what to do",
    blurb: "Bot shows on-hand by location. Record movement updates the ledger now; Request item builds a cart for a manager.",
    icon: "⇄",
  },
  {
    id: "type",
    label: "Movement type",
    title: "Pick from Movement Master",
    blurb: "Active non-system types from Movement Types — Stock In, Stock Out, Transfer. Inactive types stay hidden.",
    icon: "📋",
  },
  {
    id: "fields",
    label: "Answer fields",
    title: "Only what that type needs",
    blurb: "Location (or from/to), quantity pad, then reference/remarks when the type requires them. Optional fields are skipped.",
    icon: "⌨️",
  },
  {
    id: "review",
    label: "Review",
    title: "Confirm the movement",
    blurb: "Summary of type, qty, and locations. Confirm runs the same validation as the console (oversell blocked unless allowed).",
    icon: "✅",
  },
  {
    id: "done",
    label: "Recorded",
    title: "Ledger updated",
    blurb: "Stock moves immediately. Confirmation shows new on-hand. Search again or close.",
    icon: "📈",
  },
];

export const REQUEST_PATH_STEPS: PreviewStep[] = [
  {
    id: "search",
    label: "Search",
    title: "Type an item name",
    blurb: "Same entry as movements — type a product name in the search group.",
    icon: "🔍",
  },
  {
    id: "intent",
    label: "Choose action",
    title: "Stock details · Request item",
    blurb: "After opening a product with stock, tap Request item to build a cart (hidden when on-hand is zero).",
    icon: "⇄",
  },
  {
    id: "cart",
    label: "Cart & submit",
    title: "Location · qty · submit",
    blurb: "Pick a shelf, enter quantity on the pad, add lines, then submit a numbered ticket.",
    icon: "🧺",
  },
  {
    id: "accept",
    label: "Manager Accept",
    title: "Inventory Manager decides",
    blurb: "Managers with Issue Inventory are tagged. Accept is the only approval step.",
    icon: "✔",
  },
  {
    id: "done",
    label: "Stock out",
    title: "Issued · ticket closed",
    blurb: "Accept writes issue movements to the ledger and closes the request.",
    icon: "📉",
  },
];

/** Combined length shown on the workflows table (shared search + both branches). */
export const REQUEST_WORKFLOW_STEPS = MOVE_WORKFLOW_STEPS;

const INTERVAL_MS = 2400;

type Props = {
  /** panel = page section; modal = content inside View dialog */
  variant?: "panel" | "modal";
};

export default function RequestWorkflowPreview({ variant = "panel" }: Props) {
  const [path, setPath] = useState<PreviewPath>("move");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);

  const steps = path === "move" ? MOVE_WORKFLOW_STEPS : REQUEST_PATH_STEPS;

  useEffect(() => {
    setStep(0);
  }, [path]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => (s + 1) % steps.length), INTERVAL_MS);
    return () => clearInterval(t);
  }, [playing, steps.length, path]);

  const current = steps[Math.min(step, steps.length - 1)];
  const isModal = variant === "modal";

  const pathToggle = (
    <div
      style={{
        display: "inline-flex",
        padding: 3,
        borderRadius: 10,
        background: "#f1f4f8",
        border: "1px solid #e3e8f0",
        gap: 2,
      }}
    >
      {(
        [
          { id: "move" as const, label: "Record movement", hint: "Ledger now" },
          { id: "request" as const, label: "Request item", hint: "Manager Accept" },
        ] as const
      ).map((p) => {
        const on = path === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setPath(p.id);
              setPlaying(true);
            }}
            style={{
              padding: "7px 12px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              background: on ? "#fff" : "transparent",
              boxShadow: on ? "0 1px 2px rgba(16,30,54,.08)" : "none",
              textAlign: "left",
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 700, color: on ? "#0b1b45" : "#67748e" }}>{p.label}</div>
            <div style={{ fontSize: 10.5, color: on ? "#1560f0" : "#98a4bd", fontWeight: 600 }}>{p.hint}</div>
          </button>
        );
      })}
    </div>
  );

  const body = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isModal ? "220px 1fr minmax(240px, 280px)" : "minmax(0, 1fr) minmax(260px, 300px)",
        gap: 0,
        minHeight: isModal ? 480 : undefined,
      }}
      className="rq-preview-grid"
    >
      {isModal ? (
        <div style={{ borderRight: "1px solid #f1f4f8", padding: "14px 12px", background: "#fafbfd", maxHeight: 580, overflowY: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "#aab4c8", marginBottom: 8 }}>
            {path === "move" ? "Movement path" : "Request path"}
          </div>
          {steps.map((s, i) => {
            const active = i === step;
            return (
              <button
                key={`${path}-${s.id}`}
                type="button"
                onClick={() => {
                  setStep(i);
                  setPlaying(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 9px",
                  marginBottom: 5,
                  border: `1px solid ${active ? (path === "move" ? "#bfe6e1" : "#cdd9f7") : "#e9edf3"}`,
                  borderRadius: 9,
                  background: active ? (path === "move" ? "#e9f7f4" : "#eef3fe") : "#fff",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontSize: 14, width: 18, textAlign: "center" }}>{s.icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1a2b4a" }}>{s.label}</span>
                <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: active ? (path === "move" ? "#0d9488" : "#1560f0") : "#98a4bd" }}>
                  {i + 1}
                </span>
              </button>
            );
          })}
          <div style={{ marginTop: 12, padding: "10px 10px", borderRadius: 9, background: "#fff", border: "1px solid #e9edf3", fontSize: 11.5, color: "#67748e", lineHeight: 1.45 }}>
            Switch path above the phone to see the other branch. Both start the same way: type an item name.
          </div>
        </div>
      ) : null}

      <div style={{ padding: isModal ? "16px 18px" : "18px 20px", borderRight: "1px solid #f1f4f8" }}>
        <div style={{ marginBottom: 14 }}>{pathToggle}</div>

        {!isModal ? (
          <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
            {steps.map((s, i) => {
              const active = i === step;
              const done = i < step;
              const accent = path === "move" ? "#0d9488" : "#1560f0";
              const border = path === "move" ? "#bfe6e1" : "#cdd9f7";
              const bg = path === "move" ? "#e9f7f4" : "#eef3fe";
              return (
                <button
                  key={`${path}-${s.id}`}
                  type="button"
                  onClick={() => {
                    setStep(i);
                    setPlaying(false);
                  }}
                  style={{
                    flex: "1 1 88px",
                    minWidth: 88,
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: `1px solid ${active ? border : "#e9edf3"}`,
                    background: active ? bg : done ? "#f6f8fb" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 10, fontWeight: 700, color: active ? accent : "#98a4bd", marginBottom: 3 }}>Step {i + 1}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#0b1b45" }}>{s.label}</div>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "#aab4c8", marginBottom: 10 }}>
            Conversation · {steps.length} steps
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
        <div style={{ fontSize: 13.5, color: "#4a5878", lineHeight: 1.5, marginBottom: 14 }}>{current.blurb}</div>

        {isModal ? (
          <ol style={{ margin: 0, padding: "0 0 0 18px", color: "#4a5878", fontSize: 13, lineHeight: 1.7 }}>
            {steps.map((s, i) => (
              <li key={s.id} style={{ fontWeight: i === step ? 700 : 500, color: i === step ? "#0b1b45" : "#67748e" }}>
                {s.title}
              </li>
            ))}
          </ol>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {steps.map((_, i) => (
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
                  background: i === step ? (path === "move" ? "#0d9488" : "#1560f0") : "#d5dce8",
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
          padding: isModal ? "16px 14px" : "20px 16px",
          background: path === "move" ? "linear-gradient(165deg, #f0faf7 0%, #e8f4f1 55%, #eef8f5 100%)" : "linear-gradient(165deg, #f4f7fb 0%, #e8eef7 55%, #eef3fe 100%)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <TelegramPhone path={path} step={step} />
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
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>How the search group bot works</div>
                <span style={badge("#eef3fe", "#1560f0")}>2ND BOT · FIXED</span>
                <span style={badge("#e9f7f4", "#0d9488")}>REQUESTS MODE</span>
              </div>
              <div style={{ fontSize: 12.5, color: "#8a97b0", maxWidth: 640, lineHeight: 1.45 }}>
                Type an item name → see stock → <b style={{ color: "#3a4a68", fontWeight: 600 }}>Record movement</b> (ledger) or{" "}
                <b style={{ color: "#3a4a68", fontWeight: 600 }}>Request item</b> (cart → manager Accept). Toggle the path below to preview each conversation.
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
        @keyframes rqPulseTeal {
          0%, 100% { box-shadow: 0 0 0 0 rgba(13, 148, 136, 0.35); }
          50% { box-shadow: 0 0 0 6px rgba(13, 148, 136, 0); }
        }
        @keyframes rqStockOut {
          from { opacity: 0; transform: scale(0.92); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </>
  );
}

function badge(bg: string, fg: string): CSSProperties {
  return {
    fontSize: 10.5,
    fontWeight: 700,
    background: bg,
    color: fg,
    borderRadius: 20,
    padding: "2px 8px",
  };
}

function TelegramPhone({ path, step }: { path: PreviewPath; step: number }) {
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
          minHeight: 360,
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
              background: path === "move" ? "linear-gradient(135deg, #0d9488, #1560f0)" : "linear-gradient(135deg, #1560f0, #0d9488)",
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
            <div style={{ fontSize: 10, color: "#8a97b0" }}>Search group · {path === "move" ? "movement" : "request"}</div>
          </div>
        </div>

        <div style={{ flex: 1, padding: "12px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div key={`${path}-${step}`} style={{ animation: "rqFadeUp .35s ease" }}>
            {path === "move" ? <MovePhoneScreen step={step} /> : <RequestPhoneScreen step={step} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function MovePhoneScreen({ step }: { step: number }) {
  if (step === 0) {
    return (
      <>
        <UserBubble>Type-C cable</UserBubble>
        <BotCard>
          <div style={cardTitle}>2 matches for “Type-C cable”</div>
          <div style={cardLine}>
            <b>1. USB-C Cable 1m</b> — 12 pcs
          </div>
          <div style={cardLine}>
            <b>2. USB-C Cable 2m</b> — 4 pcs
          </div>
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
        <div style={cardTitle}>USB-C Cable 1m — 12 pcs on hand</div>
        <div style={cardMuted}>📍 Store A › Shelf 2 — 12</div>
        <div style={{ ...cardMuted, marginTop: 8 }}>What do you want to do?</div>
        <div style={{ ...btnRow, marginTop: 10 }}>
          <FakeBtn label="⇄ Record movement" primary pulse teal />
          <FakeBtn label="Request item" />
        </div>
      </BotCard>
    );
  }

  if (step === 2) {
    return (
      <BotCard>
        <div style={cardTitle}>USB-C Cable 1m</div>
        <div style={cardMuted}>Pick a stock movement:</div>
        <div style={{ ...cardLine, marginTop: 6 }}>
          <b>Stock In</b>
        </div>
        <div style={cardMuted}>· Opening Stock · Return from Plant</div>
        <div style={{ ...cardLine, marginTop: 4 }}>
          <b>Stock Out</b>
        </div>
        <div style={cardMuted}>· Issue to Plant · Damaged/Lost</div>
        <div style={{ ...btnRow, marginTop: 10 }}>
          <FakeBtn label="Return from Plant" primary pulse teal />
          <FakeBtn label="Opening Stock" />
          <FakeBtn label="Issue to Plant" />
        </div>
      </BotCard>
    );
  }

  if (step === 3) {
    return (
      <BotCard>
        <div style={cardTitle}>Return from Plant</div>
        <div style={cardMuted}>Where to put stock?</div>
        <div style={{ ...btnRow, marginTop: 8 }}>
          <FakeBtn label="📁 Store A" />
          <FakeBtn label="📍 Shelf 2" primary pulse teal />
        </div>
        <div style={{ ...cardMuted, marginTop: 10 }}>Qty: <b style={{ color: "#e8eef7" }}>5</b> pcs</div>
        <div style={{ ...btnRow, marginTop: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
            {["1", "2", "3", "4", "5", "6"].map((d) => (
              <FakeBtn key={d} label={d} />
            ))}
          </div>
          <FakeBtn label="✔ Next" primary />
        </div>
      </BotCard>
    );
  }

  if (step === 4) {
    return (
      <BotCard>
        <div style={cardTitle}>Return from Plant</div>
        <div style={cardLine}>USB-C Cable 1m × <b>5</b> pcs</div>
        <div style={cardMuted}>At: Store A › Shelf 2</div>
        <div style={{ ...cardMuted, marginTop: 8 }}>Confirm to update inventory.</div>
        <div style={{ ...btnRow, marginTop: 10 }}>
          <FakeBtn label="✅ Confirm" primary pulse teal />
          <FakeBtn label="⬅ Back" />
        </div>
      </BotCard>
    );
  }

  return (
    <BotCard>
      <div style={{ ...cardTitle, color: "#5ddea0" }}>✅ Recorded — USB-C Cable 1m</div>
      <div style={cardLine}>Return from Plant · 5 pcs</div>
      <div
        style={{
          marginTop: 10,
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(13, 148, 136, 0.2)",
          border: "1px solid rgba(13, 148, 136, 0.4)",
          animation: "rqStockOut .4s ease",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "#5ddea0" }}>On hand now</div>
        <div style={{ fontSize: 12, color: "#e8eef7", marginTop: 2 }}>Store A › Shelf 2: 17</div>
      </div>
      <div style={{ ...btnRow, marginTop: 10 }}>
        <FakeBtn label="🔍 Search again" primary />
      </div>
    </BotCard>
  );
}

function RequestPhoneScreen({ step }: { step: number }) {
  if (step === 0) {
    return (
      <>
        <UserBubble>Type-C cable</UserBubble>
        <BotCard>
          <div style={cardTitle}>2 matches for “Type-C cable”</div>
          <div style={cardLine}>
            <b>1. USB-C Cable 1m</b> — 12 pcs
          </div>
          <div style={cardLine}>
            <b>2. USB-C Cable 2m</b> — 4 pcs
          </div>
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
        <div style={cardTitle}>USB-C Cable 1m — 12 pcs on hand</div>
        <div style={cardMuted}>📍 Store A › Shelf 2 — 12</div>
        <div style={{ ...cardMuted, marginTop: 8 }}>What do you want to do?</div>
        <div style={{ ...btnRow, marginTop: 10 }}>
          <FakeBtn label="⇄ Record movement" />
          <FakeBtn label="Request item" primary pulse />
        </div>
      </BotCard>
    );
  }

  if (step === 2) {
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

  if (step === 3) {
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
  teal,
}: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  pulse?: boolean;
  teal?: boolean;
}) {
  const style: CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "center",
    padding: "6px 8px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 700,
    border: `1px solid ${danger ? "#7a3a3a" : primary ? (teal ? "#2a9a8f" : "#3d6fd4") : "#3a4a68"}`,
    background: danger ? "#3a2424" : primary ? (teal ? "#1a4a45" : "#1e3a6e") : "#2a3545",
    color: danger ? "#f0a0a0" : primary ? (teal ? "#a8ebe3" : "#cfe0ff") : "#c4ccda",
    animation: pulse ? (teal ? "rqPulseTeal 1.4s ease infinite" : "rqPulse 1.4s ease infinite") : undefined,
  };
  return <div style={style}>{label}</div>;
}

const cardTitle: CSSProperties = { fontSize: 12, fontWeight: 700, color: "#e8eef7", marginBottom: 4 };
const cardLine: CSSProperties = { fontSize: 11.5, color: "#d5dce8", lineHeight: 1.4 };
const cardMuted: CSSProperties = { fontSize: 10.5, color: "#8a97b0", lineHeight: 1.35 };
const btnRow: CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };

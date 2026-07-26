import type { CSSProperties, ReactNode } from "react";

export function chipStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 11px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: `1px solid ${active ? "#c7ecd8" : "#e4e9f0"}`,
    background: active ? "#eafaf1" : "#f4f6f9",
    color: active ? "#0f9d63" : "#8a97b0",
  };
}

export function thStyle(leftPad?: string): CSSProperties {
  return {
    padding: `11px 14px 11px ${leftPad || "14px"}`,
    fontWeight: 600,
    fontSize: 11.5,
    letterSpacing: ".3px",
    textTransform: "uppercase",
  };
}

export function tdStyle(leftPad?: string): CSSProperties {
  return {
    padding: `12px 14px 12px ${leftPad || "14px"}`,
    borderTop: "1px solid #f1f4f8",
  };
}

// Clickable column header for client-side table sorting — pair with the
// useSort() hook. Shows a faint arrow when inactive, a solid one pointing in
// the active sort direction when this column is the active sort key.
export function SortTh({
  label,
  active,
  dir,
  onClick,
  align = "left",
  leftPad,
  rightPad,
}: {
  label: ReactNode;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "center" | "right";
  leftPad?: string;
  rightPad?: string;
}) {
  return (
    <th
      onClick={onClick}
      style={{
        ...thStyle(leftPad),
        ...(rightPad ? { padding: `11px ${rightPad} 11px ${leftPad || "14px"}` } : null),
        textAlign: align,
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start" }}>
        {label}
        <span style={{ fontSize: 9, color: active ? "#1560f0" : "#c4ccda" }}>{active && dir === "desc" ? "▼" : "▲"}</span>
      </span>
    </th>
  );
}

export function actionBtnStyle(color: string, border: string): CSSProperties {
  return {
    padding: "6px 12px",
    border: `1px solid ${border}`,
    background: "#fff",
    color,
    borderRadius: 7,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
  };
}

export const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12.5,
  fontWeight: 600,
  color: "#3a4a68",
  marginBottom: 6,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #dfe5ee",
  borderRadius: 9,
  fontSize: 13.5,
};

export const secondaryBtnStyle: CSSProperties = {
  padding: "10px 18px",
  border: "1px solid #dfe5ee",
  background: "#fff",
  color: "#3a4a68",
  borderRadius: 9,
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
};

export const primaryBtnStyle: CSSProperties = {
  padding: "10px 20px",
  border: "none",
  background: "#1560f0",
  color: "#fff",
  borderRadius: 9,
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
};

export const addBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  background: "#1560f0",
  color: "#fff",
  border: "none",
  padding: "11px 18px",
  borderRadius: 9,
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 1px 2px rgba(21,96,240,.35),0 2px 8px rgba(21,96,240,.18)",
  whiteSpace: "nowrap",
};

export function toggleStyle(on: boolean, width = 44, height = 26): CSSProperties {
  return {
    width,
    height,
    borderRadius: 20,
    border: "none",
    cursor: "pointer",
    position: "relative",
    flexShrink: 0,
    transition: "background .15s",
    background: on ? "#1560f0" : "#d3dae6",
  };
}

export function toggleKnobStyle(on: boolean, width = 44): CSSProperties {
  const size = width === 44 ? 20 : 18;
  const onLeft = width === 44 ? 21 : 21;
  return {
    position: "absolute",
    top: 3,
    left: on ? onLeft : 3,
    width: size,
    height: size,
    borderRadius: "50%",
    background: "#fff",
    transition: "left .15s",
    boxShadow: "0 1px 3px rgba(0,0,0,.2)",
  };
}

export function checkboxStyle(on: boolean, size = 22): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: 6,
    border: `1.5px solid ${on ? "#1560f0" : "#cfd8e6"}`,
    background: on ? "#1560f0" : "#fff",
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  };
}

export function Header({ section, page }: { section: string; page: string }) {
  return (
    <header
      style={{
        height: 62,
        background: "#fff",
        borderBottom: "1px solid #e9edf3",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 28px",
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      <div style={{ fontSize: 12.5, color: "#8a97b0", fontWeight: 500 }}>
        {section} <span style={{ color: "#c4ccda" }}>/</span>{" "}
        <span style={{ color: "#1a2b4a", fontWeight: 600 }}>{page}</span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px 5px 5px",
          background: "#f6f8fb",
          border: "1px solid #e9edf3",
          borderRadius: 24,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "linear-gradient(135deg,#0d9488,#0f766e)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          AS
        </div>
        <div style={{ lineHeight: 1.15 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Asha Sharma</div>
          <div style={{ fontSize: 10.5, color: "#98a4bd" }}>Inventory Admin</div>
        </div>
      </div>
    </header>
  );
}

export function PageIntro({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: "-.5px", color: "#0b1b45" }}>
        {title}
      </h1>
      <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "#67748e", maxWidth: 640 }}>{description}</p>
    </div>
  );
}

export function Modal({
  onClose,
  maxWidth = 540,
  children,
  align = "flex-start",
}: {
  onClose: () => void;
  maxWidth?: number;
  children: ReactNode;
  align?: "flex-start" | "center";
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(11,27,69,.42)",
        backdropFilter: "blur(2px)",
        zIndex: 50,
        display: "flex",
        alignItems: align,
        justifyContent: "center",
        padding: align === "center" ? 20 : "56px 20px",
        overflowY: "auto",
        animation: "om-fade .15s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width: "100%",
          maxWidth,
          borderRadius: 16,
          boxShadow: "0 24px 60px rgba(11,27,69,.28)",
          animation: "om-pop .2s cubic-bezier(.2,.9,.3,1)",
          overflow: align === "center" ? "hidden" : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <div
      style={{
        padding: "20px 24px",
        borderBottom: "1px solid #f1f4f8",
        display: "flex",
        alignItems: subtitle ? "flex-start" : "center",
        justifyContent: "space-between",
      }}
    >
      <div>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.3px" }}>
          {title}
        </h3>
        {subtitle ? <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "#8a97b0" }}>{subtitle}</p> : null}
      </div>
      <button
        onClick={onClose}
        style={{
          width: 32,
          height: 32,
          border: "none",
          background: "#f4f7fb",
          borderRadius: 8,
          color: "#67748e",
          fontSize: 17,
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}

export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "16px 24px",
        borderTop: "1px solid #f1f4f8",
        display: "flex",
        justifyContent: "flex-end",
        gap: 10,
      }}
    >
      {children}
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div style={{ padding: 44, textAlign: "center", color: "#98a4bd", fontSize: 13.5 }}>{text}</div>;
}

// Shown when a page's initial fetch rejects. Without it a failing API leaves the
// page rendering an empty table, which reads as "no records" rather than "broken".
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: "#fff4f4",
        border: "1px solid #f5c2c2",
        borderRadius: 12,
        padding: "12px 16px",
        marginBottom: 18,
        fontSize: 13,
        color: "#a11b1b",
      }}
    >
      <strong style={{ fontWeight: 700 }}>Couldn&apos;t load data.</strong> {message}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  width = 230,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  width?: number;
}) {
  return (
    <div style={{ position: "relative" }}>
      <span
        style={{
          position: "absolute",
          left: 12,
          top: "50%",
          transform: "translateY(-50%)",
          color: "#9aa6bd",
          fontSize: 13,
        }}
      >
        ⌕
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width,
          padding: "9px 12px 9px 30px",
          border: "1px solid #dfe5ee",
          borderRadius: 9,
          fontSize: 13,
          background: "#fbfcfe",
        }}
      />
    </div>
  );
}

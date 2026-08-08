"use client";

import type { ReactNode } from "react";
import Sidebar from "./sidebar";
import { Header } from "./dc-ui";

export default function PageShell({
  section,
  page,
  maxWidth = 1240,
  children,
}: {
  section: string;
  page: string;
  /** Pass `false` for full-bleed content (Workflows canvas, etc.). */
  maxWidth?: number | false;
  children: ReactNode;
}) {
  return (
    <div style={{ minHeight: "100vh" }}>
      <Sidebar />
      <div style={{ marginLeft: 238, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <Header section={section} page={page} />
        <main
          style={{
            flex: 1,
            padding: maxWidth === false ? "18px 16px 40px" : "26px 28px 60px",
            maxWidth: maxWidth === false ? "none" : maxWidth,
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: string;
  badge?: string;
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

const GROUPS: NavGroup[] = [
  {
    title: "Overview",
    items: [
      { key: "dashboard", label: "Dashboard", href: "/", icon: "▤" },
      { key: "tickets", label: "Tickets", href: "/tickets", icon: "🎫" },
    ],
  },
  {
    title: "Catalog",
    items: [
      { key: "item-master", label: "Item Master", href: "/item-master", icon: "▣" },
      { key: "products", label: "Product Master", href: "/products", icon: "❐" },
      { key: "product-attributes", label: "Product Attributes", href: "/product-attributes", icon: "≡" },
      { key: "categories", label: "Categories", href: "/categories", icon: "▦" },
      { key: "locations", label: "Storage Locations", href: "/locations", icon: "▧" },
      { key: "storage-map", label: "Storage Map", href: "/storage-map", icon: "▥" },
      { key: "vendors", label: "Vendors", href: "/vendors", icon: "◈" },
      { key: "plants", label: "Plants", href: "/plants", icon: "🏭" },
      { key: "departments", label: "Departments", href: "/departments", icon: "⌂" },
      { key: "units", label: "Units", href: "/units", icon: "⚖" },
    ],
  },
  {
    title: "Inventory",
    items: [
      { key: "stock-movements", label: "Stock Movements", href: "/stock-movements", icon: "⇄" },
      { key: "stock-unavailable", label: "Out of Stock", href: "/stock-unavailable", icon: "⚠" },
    ],
  },
  {
    title: "Configuration",
    items: [
      { key: "movement-types", label: "Movement Types", href: "/movement-types", icon: "⇅" },
      { key: "status", label: "Status Master", href: "/status", icon: "◑" },
      { key: "color", label: "Color Master", href: "/color", icon: "◆" },
      { key: "settings", label: "General Settings", href: "/settings", icon: "⚙" },
      { key: "notifications", label: "Notifications", href: "/notifications", icon: "◔" },
    ],
  },
  {
    title: "Automation",
    items: [
      { key: "workflows", label: "Workflows", href: "/workflows", icon: "⛓" },
      { key: "telegram-groups", label: "Telegram Groups", href: "/telegram-groups", icon: "✈" },
    ],
  },
  {
    title: "Access",
    items: [
      { key: "roles", label: "Roles & Permissions", href: "/roles", icon: "◐" },
      { key: "assignments", label: "User Assignments", href: "/assignments", icon: "◕" },
    ],
  },
  {
    title: "Data Operations",
    items: [
      { key: "import", label: "Import / Export", href: "/import", icon: "⇅" },
      { key: "recycle", label: "Recycle Bin", href: "/recycle", icon: "⌫" },
    ],
  },
  {
    title: "System",
    items: [
      { key: "audit", label: "Audit Log", href: "/audit", icon: "◷" },
      { key: "integrations", label: "Integrations", href: "/integrations", icon: "⧉" },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: 238,
        background: "#fff",
        borderRight: "1px solid #e9edf3",
        display: "flex",
        flexDirection: "column",
        zIndex: 30,
      }}
    >
      <div
        style={{
          padding: "20px 20px 16px",
          display: "flex",
          alignItems: "center",
          gap: 11,
          borderBottom: "1px solid #f1f4f8",
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: "linear-gradient(135deg,#3392ff,#1560f0)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: 800,
            fontSize: 16,
          }}
        >
          M
        </div>
        <div style={{ lineHeight: 1.2 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: "#0b1b45", letterSpacing: "-.3px" }}>
            Masterbase
          </div>
          <div style={{ fontSize: 11, color: "#8a97b0", fontWeight: 500 }}>Master Data Console</div>
        </div>
      </div>
      <nav style={{ flex: 1, overflowY: "auto", padding: "12px 12px 20px" }}>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: ".7px",
                textTransform: "uppercase",
                color: "#aab4c8",
                padding: "14px 12px 6px",
              }}
            >
              {g.title}
            </div>
            {g.items.map((it) => {
              const on = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
              return (
                <Link
                  key={it.key}
                  href={it.href}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 12px",
                    borderRadius: 8,
                    fontSize: 13.5,
                    fontWeight: on ? 600 : 500,
                    color: on ? "#1560f0" : "#4a5878",
                    background: on ? "#eaf2ff" : "transparent",
                    marginBottom: 2,
                    textDecoration: "none",
                  }}
                >
                  <span
                    style={{
                      width: 18,
                      textAlign: "center",
                      fontSize: 13,
                      color: on ? "#1560f0" : "#9aa6bd",
                      flexShrink: 0,
                    }}
                  >
                    {it.icon}
                  </span>
                  <span>{it.label}</span>
                  {it.badge ? (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10.5,
                        fontWeight: 700,
                        background: "#1560f0",
                        color: "#fff",
                        borderRadius: 20,
                        padding: "1px 7px",
                      }}
                    >
                      {it.badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div
        style={{
          padding: "13px 16px",
          borderTop: "1px solid #f1f4f8",
          fontSize: 11,
          color: "#98a4bd",
          lineHeight: 1.5,
        }}
      >
        Read-only source of truth for the Telegram Bot &amp; Workflows
      </div>
    </aside>
  );
}

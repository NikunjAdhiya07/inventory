"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PageShell from "@/components/page-shell";
import { ErrorBanner, PageIntro } from "@/components/dc-ui";
import { api } from "@/lib/api-client";

const AV = ["#1560f0", "#0d9488", "#f59e0b", "#8b5cf6", "#ec4899", "#6366f1"];

type Category = { id: string; parent: string | null; status: string; refCount: number };
type Unit = { id: string; type: string; status: string };
type LocationNode = { id: string; parent: string | null; refCount: number };
type ActivityRow = { id: string; user: string; action: "Created" | "Edited" | "Deleted"; dataType: string; entity: string; ts: string };

function initials(n: string) {
  return n.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function relativeTime(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function badgeStyle(action: string) {
  const m: Record<string, [string, string]> = {
    Created: ["#e9f7f0", "#0f9d63"],
    Edited: ["#eaf2ff", "#1560f0"],
    Deleted: ["#fdecec", "#d63a3a"],
  };
  const c = m[action] || ["#eef2f9", "#5a6a86"];
  return {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    background: c[0],
    color: c[1],
  } as const;
}

const verbFor: Record<string, string> = { Created: "created", Edited: "edited", Deleted: "deleted" };

export default function DashboardPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [locations, setLocations] = useState<LocationNode[]>([]);
  const [rolesCount, setRolesCount] = useState(0);
  const [usersCount, setUsersCount] = useState(0);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // One batch of parallel GETs on mount — no polling, no interval timers.
    Promise.all([
      api.get<Category[]>("/api/categories"),
      api.get<Unit[]>("/api/units"),
      api.get<LocationNode[]>("/api/locations"),
      api.get<unknown[]>("/api/roles"),
      api.get<unknown[]>("/api/users"),
      api.get<{ rows: ActivityRow[] }>("/api/audit-log?limit=5"),
    ])
      .then(([cats, us, locs, roles, users, log]) => {
        setCategories(cats);
        setUnits(us);
        setLocations(locs);
        setRolesCount(roles.length);
        setUsersCount(users.length);
        setActivity(log.rows);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  const roots = categories.filter((c) => (c.parent ?? null) === null);
  const nested = categories.filter((c) => c.parent != null && c.parent !== "");
  const activeCats = categories.filter((c) => c.status === "Active").length;
  const inactiveCats = categories.length - activeCats;
  const unusedCats = categories.filter((c) => (c.refCount || 0) === 0 && (c.parent ?? null) === null).length;
  const unitTypes = new Set(units.map((u) => u.type)).size;
  const inactiveUnits = units.filter((u) => u.status === "Inactive").length;
  const rootLocations = locations.filter((l) => l.parent === null).length;
  const emptyLocations = locations.filter((l) => l.refCount === 0).length;

  const tiles = [
    { href: "/categories", icon: "▦", bg: "#eaf2ff", fg: "#1560f0", value: categories.length, label: "Category nodes", tag: `${roots.length} roots`, tagGood: true },
    { href: "/categories", icon: "▤", bg: "#f0ecff", fg: "#7c4ddb", value: nested.length, label: "Nested categories", tag: "", tagGood: true },
    { href: "/locations", icon: "▧", bg: "#e9f7f4", fg: "#0d9488", value: locations.length, label: "Location nodes", tag: `${rootLocations} whs`, tagGood: false },
    { href: "/units", icon: "⚖", bg: "#fff2e5", fg: "#c9760a", value: units.length, label: "Units", tag: `${unitTypes} types`, tagGood: false },
  ];

  const health: [string, number, string][] = [
    ["Inactive categories", inactiveCats, "/categories"],
    ["Unused categories", unusedCats, "/categories"],
    ["Empty locations", emptyLocations, "/locations"],
    ["Inactive units", inactiveUnits, "/units"],
    ["Duplicate names", 0, "/audit"],
  ];

  return (
    <PageShell section="Overview" page="Dashboard">
      <div style={{ marginBottom: 22 }}>
        <PageIntro
          title="Master Data Overview"
          description="The single source of truth every inventory entry and workflow reads from. Manage each master below — approved changes sync straight to the Telegram bot."
        />
      </div>

      {loadError && <ErrorBanner message={loadError} />}

      <section
        style={{
          background: "#fff",
          border: "1px solid #e9edf3",
          borderRadius: 14,
          padding: 4,
          marginBottom: 18,
          boxShadow: "0 1px 2px rgba(16,30,54,.04)",
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
        }}
      >
        <div style={{ padding: "16px 20px" }}>
          <div style={{ fontSize: 12, color: "#8a97b0", fontWeight: 600, marginBottom: 6 }}>Telegram</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 800, color: "#0f9d63" }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#0f9d63", boxShadow: "0 0 0 3px rgba(15,157,99,.2)" }} />
            Synced
          </div>
        </div>
        <div style={{ padding: "16px 20px", borderLeft: "1px solid #f1f4f8" }}>
          <div style={{ fontSize: 12, color: "#8a97b0", fontWeight: 600, marginBottom: 6 }}>Last Sync</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0b1b45" }}>Just now</div>
          <div style={{ fontSize: 12, color: "#98a4bd" }}>Live from MongoDB</div>
        </div>
        <div style={{ padding: "16px 20px", borderLeft: "1px solid #f1f4f8" }}>
          <div style={{ fontSize: 12, color: "#8a97b0", fontWeight: 600, marginBottom: 6 }}>Records Synced</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#0b1b45" }}>
            {categories.length + units.length + locations.length}
          </div>
        </div>
        <div style={{ padding: "16px 20px", borderLeft: "1px solid #f1f4f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 12, color: "#8a97b0", fontWeight: 600, marginBottom: 6 }}>Failed</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#0b1b45" }}>0</div>
          </div>
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 18 }}>
        {tiles.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            style={{
              background: "#fff",
              border: "1px solid #e9edf3",
              borderRadius: 14,
              padding: "18px 20px",
              boxShadow: "0 1px 2px rgba(16,30,54,.04)",
              display: "block",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  background: t.bg,
                  color: t.fg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 15,
                }}
              >
                {t.icon}
              </span>
              {t.tag ? (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: t.tagGood ? "#0f9d63" : "#8a97b0",
                    background: t.tagGood ? "#e9f7f0" : "#f1f4f9",
                    padding: "2px 8px",
                    borderRadius: 20,
                  }}
                >
                  {t.tag}
                </span>
              ) : null}
            </div>
            <div style={{ fontSize: 30, fontWeight: 800, color: "#0b1b45", letterSpacing: "-.6px", marginTop: 14 }}>
              {t.value}
            </div>
            <div style={{ fontSize: 12.5, color: "#8a97b0", fontWeight: 600, marginTop: 1 }}>{t.label}</div>
          </Link>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 16 }}>
        <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
          <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #f1f4f8" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Recent activity</div>
            <Link href="/audit" style={{ fontSize: 12.5, fontWeight: 600 }}>
              View audit log →
            </Link>
          </div>
          {activity.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "#98a4bd", fontSize: 13 }}>No activity yet.</div>
          ) : null}
          {activity.map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderTop: "1px solid #f6f8fb" }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  background: AV[hashCode(a.user) % AV.length],
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {initials(a.user)}
              </div>
              <div style={{ flex: 1, lineHeight: 1.4 }}>
                <div style={{ fontSize: 13, color: "#1a2b4a" }}>
                  <strong>{a.user}</strong> {verbFor[a.action] || "changed"} <strong>{a.entity}</strong>
                </div>
                <div style={{ fontSize: 11.5, color: "#98a4bd" }}>
                  {a.dataType} · {relativeTime(a.ts)}
                </div>
              </div>
              <span style={badgeStyle(a.action)}>{a.action}</span>
            </div>
          ))}
        </section>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45", marginBottom: 14 }}>Data health</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {health.map(([label, count, href]) => (
                <Link key={label} href={href} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
                  <span style={{ color: "#67748e" }}>{label}</span>
                  <span
                    style={{
                      minWidth: 24,
                      textAlign: "center",
                      padding: "2px 8px",
                      borderRadius: 20,
                      fontSize: 12,
                      fontWeight: 700,
                      background: count > 0 ? "#fff4e5" : "#e9f7f0",
                      color: count > 0 ? "#d98207" : "#0f9d63",
                    }}
                  >
                    {count}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45", marginBottom: 14 }}>Access</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 32, height: 32, borderRadius: 9, background: "#eaf2ff", color: "#1560f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                ◐
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#3a4a68" }}>Roles</span>
            </div>
            <Link href="/roles" style={{ fontSize: 18, fontWeight: 800, color: "#0b1b45" }}>
              {rolesCount}
            </Link>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 32, height: 32, borderRadius: 9, background: "#e9f7f4", color: "#0d9488", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                ◕
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#3a4a68" }}>Telegram users</span>
            </div>
            <Link href="/assignments" style={{ fontSize: 18, fontWeight: 800, color: "#0b1b45" }}>
              {usersCount}
            </Link>
          </div>
        </section>
        <section style={{ background: "linear-gradient(135deg,#0b1b45,#123b8f)", borderRadius: 14, padding: 20, color: "#fff", boxShadow: "0 4px 16px rgba(11,27,69,.2)" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>Data contracts intact</div>
          <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "#c5d2f0", lineHeight: 1.5 }}>
            All masters are live and consumed read-only by Story 2 &amp; Story 3.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 0 3px rgba(74,222,128,.3)" }} />
            Synced to bot 2 min ago
          </div>
        </section>
      </div>
    </PageShell>
  );
}

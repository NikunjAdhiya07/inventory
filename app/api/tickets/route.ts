import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";

// Unified ticket feed for the console dashboard: inventory entries (INV-…),
// item requests / purchases (REQ-…, PUR-…) and material issues / returns
// (ISS-…, RET-…). Shaped like the maintenance TicketCard so the UI can render
// one card component for every series.

export type TicketKind = "entry" | "request" | "purchase" | "issue" | "return";

function openStatus(status: string): boolean {
  return ["draft", "pending_manager", "pending_approval", "procuring", "awaiting_collection"].includes(status);
}

function boardStatus(status: string): "PENDING" | "COMPLETED" | "REJECTED" | "CANCELLED" {
  if (status === "completed") return "COMPLETED";
  if (status === "rejected") return "REJECTED";
  if (status === "cancelled") return "CANCELLED";
  return "PENDING";
}

// The issue/return lifecycle has its own vocabulary, so it maps onto the board's
// four columns explicitly rather than by accident. An issue that is out with
// someone is PENDING right up until a return settles it — that is the whole
// point of the flow, and treating "acknowledged" as done would hide exactly the
// tickets a store head needs to chase.
function materialBoardStatus(kind: "issue" | "return", status: string): "PENDING" | "COMPLETED" | "REJECTED" | "CANCELLED" {
  if (status === "cancelled") return "CANCELLED";
  if (status === "rejected") return "REJECTED";
  if (kind === "issue") return status === "settled" ? "COMPLETED" : "PENDING";
  return status === "accepted" ? "COMPLETED" : "PENDING";
}

export async function GET(req: NextRequest) {
  const db = await getDb();
  const { searchParams } = new URL(req.url);
  const board = (searchParams.get("status") || "").toUpperCase(); // PENDING | COMPLETED | ""
  const kind = (searchParams.get("kind") || "").toLowerCase(); // entry | request | purchase | ""
  const limit = Math.min(Number(searchParams.get("limit")) || 200, 500);

  const tickets: Record<string, unknown>[] = [];

  if (!kind || kind === "entry") {
    const entries = await db
      .collection("inventoryEntries")
      .find({ ticketNumber: { $exists: true, $ne: "" } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    for (const e of entries) {
      const c = toClient(e);
      const fields = (c.fields ?? {}) as Record<string, unknown>;
      const itemName = String(fields.itemName || fields.productName || "Inventory entry");
      tickets.push({
        id: c.id,
        ticketId: c.ticketNumber,
        kind: "entry" as TicketKind,
        series: "INV",
        status: "COMPLETED",
        boardStatus: "COMPLETED",
        description: itemName,
        category: String(fields.category || "Entry"),
        subCategory: String(fields.subcategory || ""),
        location: String(fields.locationPath || "—"),
        quantity: fields.quantity ?? null,
        unit: String(fields.unit || ""),
        productNumber: String(fields.productNumber || ""),
        createdBy: String(c.submittedByName || "—"),
        completedBy: String((c.approval as { by?: string } | undefined)?.by || c.submittedByName || ""),
        createdAt: c.createdAt,
        completedAt: c.createdAt,
        closedAt: c.createdAt,
        lines: [],
        history: [],
        source: "telegram",
      });
    }
  }

  if (!kind || kind === "request" || kind === "purchase") {
    const filter: Record<string, unknown> = {
      ticketNumber: { $exists: true, $ne: "" },
      status: { $ne: "draft" },
    };
    if (kind === "request") filter.kind = "inventory";
    if (kind === "purchase") filter.kind = "purchase";

    const requests = await db.collection("requests").find(filter).sort({ updatedAt: -1 }).limit(limit).toArray();

    for (const r of requests) {
      const c = toClient(r);
      const lines = Array.isArray(c.lines) ? (c.lines as Record<string, unknown>[]) : [];
      const purchase = c.purchase as { name?: string; qty?: number; unit?: string } | undefined;
      const reqKind = c.kind === "purchase" ? "purchase" : "request";
      if (kind === "request" && reqKind !== "request") continue;
      if (kind === "purchase" && reqKind !== "purchase") continue;

      const desc =
        reqKind === "purchase"
          ? String(purchase?.name || "Purchase request")
          : lines.map((l) => `${l.productName} × ${l.qty} ${l.unit || ""}`.trim()).join(", ") || "Stock issue";

      const locations = [...new Set(lines.map((l) => String(l.locationPath || "")).filter(Boolean))];
      const categories = [...new Set(lines.map((l) => String(l.category || "")).filter(Boolean))];
      const decisions = Array.isArray(c.decisions) ? (c.decisions as { by?: string; decision?: string }[]) : [];
      const lastDecision = decisions[decisions.length - 1];
      const status = String(c.status);
      const bStatus = boardStatus(status);

      tickets.push({
        id: c.id,
        ticketId: c.ticketNumber,
        kind: reqKind as TicketKind,
        series: reqKind === "purchase" ? "PUR" : "REQ",
        status,
        boardStatus: bStatus,
        open: openStatus(status),
        description: desc,
        category: categories[0] || (reqKind === "purchase" ? "Purchase" : "Issue"),
        subCategory: String(lines[0]?.subcategory || ""),
        location: locations.join(" · ") || "—",
        quantity: reqKind === "purchase" ? purchase?.qty ?? null : lines.reduce((s, l) => s + Number(l.qty || 0), 0),
        unit: reqKind === "purchase" ? String(purchase?.unit || "") : String(lines[0]?.unit || ""),
        productNumber: String(lines[0]?.productNumber || ""),
        createdBy: String(c.requesterName || "—"),
        completedBy: String(lastDecision?.by || ""),
        createdAt: c.createdAt || c.submittedAt,
        completedAt: c.closedAt || null,
        closedAt: c.closedAt || null,
        submittedAt: c.submittedAt || null,
        lines: lines.map((l) => ({
          productName: l.productName,
          productNumber: l.productNumber,
          locationPath: l.locationPath,
          qty: l.qty,
          unit: l.unit,
          outcome: l.outcome,
        })),
        purchase: purchase || null,
        history: Array.isArray(c.history) ? c.history : [],
        decisions,
        source: "telegram",
      });
    }
  }

  if (!kind || kind === "issue" || kind === "return") {
    const filter: Record<string, unknown> = {
      ticketNumber: { $exists: true, $ne: "" },
      status: { $ne: "draft" },
    };
    if (kind === "issue" || kind === "return") filter.kind = kind;

    const materials = await db.collection("issueTickets").find(filter).sort({ updatedAt: -1 }).limit(limit).toArray();

    for (const m of materials) {
      const c = toClient(m);
      const mKind = c.kind === "return" ? "return" : "issue";
      const lines = Array.isArray(c.lines) ? (c.lines as Record<string, unknown>[]) : [];
      const recipient = c.recipient as { name?: string } | undefined;
      const status = String(c.status);

      // A return's lines carry the quantity coming BACK, so a line the recipient
      // left at zero would otherwise render as "Wire × 0" — the one number on the
      // card that is not what a reader wants. Show what was taken and let the
      // per-line detail carry the split.
      const desc =
        lines
          .map((l) => {
            const qty = mKind === "return" ? l.issuedQty ?? l.qty : l.qty;
            return `${l.productName} × ${qty} ${l.unit || ""}`.trim();
          })
          .join(", ") || (mKind === "return" ? "Material return" : "Material issue");

      const locations = [...new Set(lines.map((l) => String(l.locationPath || "")).filter(Boolean))];
      const categories = [...new Set(lines.map((l) => String(l.category || "")).filter(Boolean))];

      tickets.push({
        id: c.id,
        ticketId: c.ticketNumber,
        kind: mKind as TicketKind,
        series: mKind === "return" ? "RET" : "ISS",
        status,
        boardStatus: materialBoardStatus(mKind, status),
        open: !["settled", "accepted", "rejected", "cancelled"].includes(status),
        description: desc,
        category: categories[0] || (mKind === "return" ? "Return" : "Issue"),
        subCategory: String(lines[0]?.subcategory || ""),
        location: locations.join(" · ") || "—",
        quantity: lines.reduce(
          (s, l) => s + Number((mKind === "return" ? l.issuedQty ?? l.qty : l.qty) || 0),
          0
        ),
        unit: String(lines[0]?.unit || ""),
        productNumber: String(lines[0]?.productNumber || ""),
        createdBy: String(c.createdByName || "—"),
        // Who the materials are with. It is the single most useful thing on an
        // open issue card — "who do I chase" — so it takes the slot the other
        // series use for whoever closed the ticket.
        completedBy: String(recipient?.name || ""),
        createdAt: c.createdAt || c.submittedAt,
        completedAt: c.closedAt || null,
        closedAt: c.closedAt || null,
        submittedAt: c.submittedAt || null,
        issueTicketNumber: c.issueTicketNumber || null,
        lines: lines.map((l) => ({
          productName: l.productName,
          productNumber: l.productNumber,
          locationPath: l.locationPath,
          qty: mKind === "return" ? l.issuedQty ?? l.qty : l.qty,
          unit: l.unit,
          // The settlement split, which is the reason this flow exists. On an
          // issue it is filled in when a return closes it; on a return it is
          // what the recipient declared.
          returnedQty: mKind === "return" ? l.qty : l.returnedQty ?? null,
          consumedQty:
            mKind === "return" ? Number(l.issuedQty ?? 0) - Number(l.qty ?? 0) : l.consumedQty ?? null,
          outcome: l.outcome,
        })),
        history: Array.isArray(c.history) ? c.history : [],
        source: "telegram",
      });
    }
  }

  tickets.sort((a, b) => {
    const ta = new Date(String(a.createdAt || 0)).getTime();
    const tb = new Date(String(b.createdAt || 0)).getTime();
    return tb - ta;
  });

  let filtered = tickets;
  if (board === "PENDING") {
    filtered = tickets.filter((t) => t.boardStatus === "PENDING");
  } else if (board === "COMPLETED") {
    filtered = tickets.filter((t) => t.boardStatus !== "PENDING");
  }

  return NextResponse.json(filtered.slice(0, limit));
}

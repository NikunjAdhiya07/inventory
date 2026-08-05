import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { withErrors } from "@/lib/api-error";
import { logAudit, CURRENT_USER } from "@/lib/audit";
import { listMovements, recordStockMovement } from "@/lib/movements";

// Record a stock movement, and read the transaction history.
//
//   GET  /api/stock/movements?productId=&locationId=&type=&direction=&from=&to=
//   POST /api/stock/movements   { typeCode, productId, qty, ... }
//
// Every rule about what a movement may be lives in `lib/movements.ts`; this
// route is the transport and the audit trail around it.

async function history(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const db = await getDb();
  const rows = await listMovements(
    db,
    {
      productId: p.get("productId") || undefined,
      locationId: p.get("locationId") || undefined,
      typeCode: p.get("type") || undefined,
      direction: p.get("direction") || undefined,
      from: p.get("from") || undefined,
      to: p.get("to") || undefined,
    },
    Number(p.get("limit")) || 200
  );
  return NextResponse.json(rows);
}

async function record(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const db = await getDb();

  const result = await recordStockMovement(db, {
    typeCode: String(body.typeCode ?? ""),
    productId: String(body.productId ?? ""),
    qty: Number(body.qty),
    locationId: body.locationId ? String(body.locationId) : undefined,
    fromLocationId: body.fromLocationId ? String(body.fromLocationId) : undefined,
    toLocationId: body.toLocationId ? String(body.toLocationId) : undefined,
    remarks: body.remarks ? String(body.remarks) : undefined,
    reference: body.reference ? String(body.reference) : undefined,
    by: CURRENT_USER,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const where = result.balances.map((b) => `${b.locationPath}: ${b.qty}`).join(" · ");
  await logAudit({
    action: "Created",
    dataType: "Stock Movement",
    entity: `${result.productName} — ${result.type.name}`,
    field: result.type.name,
    before: "—",
    after: `${result.type.direction === "out" ? "-" : "+"}${result.qty}`,
    beforeFields: [["Item", result.productName]],
    afterFields: [
      ["Item", result.productName],
      ["Movement", result.type.name],
      ["Quantity", String(result.qty)],
      ["On hand after", where || "—"],
      ...(body.reference ? ([["Reference", String(body.reference)]] as [string, string][]) : []),
      ...(body.remarks ? ([["Remarks", String(body.remarks)]] as [string, string][]) : []),
    ],
  });

  // The confirmation carries the resulting balances, so the user sees the number
  // they can check against the shelf rather than a bare "saved" (AC-09).
  return NextResponse.json(
    {
      ok: true,
      movement: result.type.name,
      direction: result.type.direction,
      productName: result.productName,
      qty: result.qty,
      balances: result.balances,
    },
    { status: 201 }
  );
}

export const GET = withErrors(history);
export const POST = withErrors(record);

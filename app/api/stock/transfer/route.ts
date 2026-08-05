import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/mongodb";
import { withErrors } from "@/lib/api-error";
import { logAudit, CURRENT_USER } from "@/lib/audit";
import { locationPathById } from "@/lib/locations";
import { onHandLive, recordMovements } from "@/lib/stock";

// Carry goods from one box to another: "the wire is on Rack A Shelf 3, it's
// going to Rack B Shelf 5."
//
// Written as TWO movements sharing one transfer id — out of the source, into
// the destination — rather than by editing a location on existing rows. The
// difference matters: rewriting history would make the move invisible, while a
// matched pair leaves both boxes' balances derivable from their own movements
// and the move itself visible in the ledger forever. The pair also sums to
// zero, so a transfer can never change how much of something exists.

async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const read = (k: string) => String((body as Record<string, unknown> | null)?.[k] ?? "");
  const productId = read("productId");
  const fromLocationId = read("fromLocationId");
  const toLocationId = read("toLocationId");
  const qty = Number((body as { qty?: unknown } | null)?.qty);

  if (!ObjectId.isValid(productId)) return NextResponse.json({ error: "Pick a product first." }, { status: 400 });
  if (!ObjectId.isValid(fromLocationId)) return NextResponse.json({ error: "Missing the source box." }, { status: 400 });
  if (!ObjectId.isValid(toLocationId)) return NextResponse.json({ error: "Pick somewhere to move it to." }, { status: 400 });
  if (fromLocationId === toLocationId) {
    return NextResponse.json({ error: "Source and destination are the same place." }, { status: 400 });
  }
  if (!Number.isFinite(qty) || qty <= 0) return NextResponse.json({ error: "Quantity must be more than zero." }, { status: 400 });

  const db = await getDb();
  const [product, dest] = await Promise.all([
    db.collection("products").findOne({ _id: new ObjectId(productId) }),
    db.collection("locations").findOne({ _id: new ObjectId(toLocationId) }),
  ]);
  if (!product) return NextResponse.json({ error: "That product no longer exists." }, { status: 404 });
  if (!dest) return NextResponse.json({ error: "That destination no longer exists." }, { status: 404 });

  // Live, not the cached aggregation: this is the check that decides whether
  // goods may leave a box, and a five-second-old balance can approve a move of
  // stock that has already gone.
  const available = await onHandLive(db, productId, fromLocationId);
  const moving = Math.round(qty);
  if (moving > available) {
    return NextResponse.json(
      { error: `Only ${available} there — can't move ${moving}.` },
      { status: 409 }
    );
  }

  const [fromPath, toPath] = await Promise.all([locationPathById(db, fromLocationId), locationPathById(db, toLocationId)]);
  const transferId = randomUUID();
  const shared = {
    productId,
    productName: String(product.name ?? ""),
    productNumber: String(product.productNumber ?? ""),
    unit: String(product.unit ?? ""),
    reason: "transfer" as const,
    refType: "transfer" as const,
    refId: transferId,
    by: CURRENT_USER,
    createdAt: new Date().toISOString(),
  };

  await recordMovements(db, [
    { ...shared, movementKey: `transfer:${transferId}:out`, locationId: fromLocationId, locationPath: fromPath, qty: -moving },
    { ...shared, movementKey: `transfer:${transferId}:in`, locationId: toLocationId, locationPath: toPath, qty: moving },
  ]);

  await logAudit({
    action: "Edited",
    dataType: "Stock",
    entity: `${shared.productName} — ${moving} ${shared.unit}`,
    field: "Moved",
    before: fromPath,
    after: toPath,
    beforeFields: [
      ["Product", shared.productName],
      ["From", fromPath],
      ["Was on hand there", String(available)],
    ],
    afterFields: [
      ["Product", shared.productName],
      ["To", toPath],
      ["Moved", `${moving} ${shared.unit}`],
      ["Left behind", String(available - moving)],
    ],
  });

  return NextResponse.json({ ok: true, moved: moving, remaining: available - moving, fromPath, toPath });
}

const handler = withErrors(POST);
export { handler as POST };

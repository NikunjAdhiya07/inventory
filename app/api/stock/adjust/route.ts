import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/mongodb";
import { withErrors } from "@/lib/api-error";
import { logAudit, CURRENT_USER } from "@/lib/audit";
import { locationPathById } from "@/lib/locations";
import { onHandLive, recordMovement } from "@/lib/stock";

// Say what is physically in a box, from the console.
//
// The caller sends the COUNT ON THE SHELF, not a delta — "there are 12 of these
// in Box 04" is what a person standing in front of the box actually knows. The
// delta is derived here and written as one `adjustment` movement, so the ledger
// stays the only record of the balance and the correction keeps its own history.
// Setting a count that already matches writes nothing at all.
//
// Stock still normally arrives through the entry bot; this exists because the
// racks are being populated by hand from an existing room, which no ticket ever
// covered.

async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const locationId = String((body as { locationId?: unknown })?.locationId ?? "");
  const productId = String((body as { productId?: unknown })?.productId ?? "");
  const target = Number((body as { qty?: unknown })?.qty);

  if (!ObjectId.isValid(locationId)) return NextResponse.json({ error: "Pick a box first." }, { status: 400 });
  if (!ObjectId.isValid(productId)) return NextResponse.json({ error: "Pick a product first." }, { status: 400 });
  if (!Number.isFinite(target) || target < 0) {
    return NextResponse.json({ error: "Quantity must be zero or more." }, { status: 400 });
  }

  const db = await getDb();
  const [product, location] = await Promise.all([
    db.collection("products").findOne({ _id: new ObjectId(productId) }),
    db.collection("locations").findOne({ _id: new ObjectId(locationId) }),
  ]);
  if (!product) return NextResponse.json({ error: "That product no longer exists." }, { status: 404 });
  if (!location) return NextResponse.json({ error: "That box no longer exists." }, { status: 404 });

  // Live, not the 5s-cached aggregation: the delta is computed from this number
  // and a stale read would write the difference twice.
  const current = await onHandLive(db, productId, locationId);
  const delta = Math.round(target) - current;
  if (delta === 0) return NextResponse.json({ ok: true, qty: current, changed: false });

  const productName = String(product.name ?? "");
  const locationPath = (await locationPathById(db, locationId)) || String(location.name ?? "");

  await recordMovement(db, {
    // Two people setting the same box to the same count minutes apart are two
    // real corrections, not one retried event — so this key is unique per write
    // rather than derived from the count.
    movementKey: `adjust:${locationId}:${productId}:${randomUUID()}`,
    productId,
    productName,
    productNumber: String(product.productNumber ?? ""),
    locationId,
    locationPath,
    qty: delta,
    unit: String(product.unit ?? ""),
    reason: "adjustment",
    refType: "adjustment",
    refId: "console",
    by: CURRENT_USER,
    createdAt: new Date().toISOString(),
  });

  await logAudit({
    action: "Edited",
    dataType: "Stock",
    entity: `${productName} @ ${locationPath}`,
    field: "On hand",
    before: String(current),
    after: String(Math.round(target)),
    beforeFields: [
      ["Product", productName],
      ["Location", locationPath],
      ["On hand", String(current)],
    ],
    afterFields: [
      ["Product", productName],
      ["Location", locationPath],
      ["On hand", String(Math.round(target))],
      ["Movement", `${delta > 0 ? "+" : ""}${delta}`],
    ],
  });

  return NextResponse.json({ ok: true, qty: Math.round(target), delta, changed: true });
}

const handler = withErrors(POST);
export { handler as POST };

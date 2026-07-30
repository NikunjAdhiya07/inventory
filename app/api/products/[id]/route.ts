import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb, isDuplicateKeyError } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { softDelete } from "@/lib/recycle";
import { withErrors } from "@/lib/api-error";
import { buildProductDoc, duplicateProductNumber, productFieldPairs } from "@/lib/product-store";
import { productLabel } from "@/lib/products";

function objectId(id: string): ObjectId | null {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

async function update(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const _id = objectId(id);
  if (!_id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const db = await getDb();
  const before = await db.collection("products").findOne({ _id });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const built = buildProductDoc(body, before);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status });

  if (built.doc.productNumberKey) {
    const clash = await duplicateProductNumber(db, String(built.doc.productNumberKey), id);
    if (clash) {
      return NextResponse.json(
        { error: `Product Number "${built.doc.productNumber}" is already used by ${productLabel(clash)}.` },
        { status: 409 }
      );
    }
  }

  try {
    await db.collection("products").updateOne({ _id }, { $set: built.doc });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return NextResponse.json({ error: `Product Number "${built.doc.productNumber}" is already used.` }, { status: 409 });
    }
    throw err;
  }

  invalidateCollection("products");
  const after = { ...before, ...built.doc };
  const changed = Object.keys(built.doc).find((k) => k !== "updatedAt") ?? "Updated";
  await logAudit({
    action: "Edited",
    dataType: "Product",
    entity: productLabel(after),
    field: changed,
    before: String(before[changed] ?? "—"),
    after: String(built.doc[changed] ?? "—"),
    beforeFields: productFieldPairs(before),
    afterFields: productFieldPairs(after),
  });
  return NextResponse.json(toClient(after));
}

async function remove(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const _id = objectId(id);
  if (!_id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = await getDb();
  const doc = await db.collection("products").findOne({ _id });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const name = productLabel(doc);
  await softDelete("products", "Product", doc, name, String(doc.category || "Uncategorised"));
  invalidateCollection("products");
  await logAudit({
    action: "Deleted",
    dataType: "Product",
    entity: name,
    field: "Record removed",
    before: name,
    after: "—",
    beforeFields: productFieldPairs(doc),
    afterFields: [["Record", "Deleted → Recycle Bin"]],
  });
  return NextResponse.json({ ok: true });
}

export const PATCH = withErrors(update);
export const DELETE = withErrors(remove);

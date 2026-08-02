import { NextRequest, NextResponse } from "next/server";
import { getDb, isDuplicateKeyError } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { withErrors } from "@/lib/api-error";
import { buildProductDoc, duplicateProductNumber, productFieldPairs } from "@/lib/product-store";
import { productLabel } from "@/lib/products";

// The Product Master. Hand-written rather than built on `createCrudHandlers`
// because products carry two things the generic masters don't: a uniqueness
// rule on the product number, and a nested attribute list that has to be
// normalised on the way in and flattened for the audit trail.

async function list() {
  const db = await getDb();
  const docs = await db.collection("products").find({}).sort({ name: 1, productNumber: 1 }).toArray();
  return NextResponse.json(toClientList(docs));
}

async function create(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const built = buildProductDoc(body);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status });

  const db = await getDb();
  const clash = await duplicateProductNumber(db, String(built.doc.productNumberKey));
  if (clash) {
    return NextResponse.json(
      { error: `Product Number "${built.doc.productNumber}" is already used by ${productLabel(clash)}.` },
      { status: 409 }
    );
  }

  let insertedId;
  try {
    ({ insertedId } = await db.collection("products").insertOne(built.doc));
  } catch (err) {
    // Lost the race against another tab between the check above and the insert.
    if (isDuplicateKeyError(err)) {
      return NextResponse.json({ error: `Product Number "${built.doc.productNumber}" is already used.` }, { status: 409 });
    }
    throw err;
  }

  invalidateCollection("products");
  const doc = { _id: insertedId, ...built.doc };
  await logAudit({
    action: "Created",
    dataType: "Product",
    entity: productLabel(doc),
    field: "New record",
    before: "—",
    after: productLabel(doc),
    beforeFields: [["Product", "—"]],
    afterFields: productFieldPairs(doc),
  });
  return NextResponse.json(toClient(doc), { status: 201 });
}

export const GET = withErrors(list);
export const POST = withErrors(create);

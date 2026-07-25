import { NextRequest, NextResponse } from "next/server";
import { ObjectId, type Document } from "mongodb";
import { getDb } from "./mongodb";
import { toClientList, toClient } from "./serialize";
import { logAudit } from "./audit";
import { softDelete } from "./recycle";

function fieldPairs(doc: Document): [string, string][] {
  return Object.entries(doc)
    .filter(([k]) => k !== "_id")
    .map(([k, v]) => [k, v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)]);
}

type CrudOptions = {
  collection: string;
  dataType: string;
  entityName: (doc: Document) => string;
  recycleDetail?: (doc: Document) => string;
  recycleType?: string;
  sort?: Document;
};

// Generic list+create / update+delete handlers shared by the simple masters
// (units, categories, subcategories, roles, statuses, colors, users, apiKeys).
// Keeping this in one place means one Mongo round trip per request and one
// consistent audit-log write path instead of copy-pasted logic per resource.
export function createCrudHandlers(opts: CrudOptions) {
  async function GET() {
    const db = await getDb();
    const docs = await db
      .collection(opts.collection)
      .find({})
      .sort(opts.sort || { _id: 1 })
      .toArray();
    return NextResponse.json(toClientList(docs));
  }

  async function POST(req: NextRequest) {
    const body = await req.json();
    const db = await getDb();
    const result = await db.collection(opts.collection).insertOne(body);
    const doc = { _id: result.insertedId, ...body };
    await logAudit({
      action: "Created",
      dataType: opts.dataType,
      entity: opts.entityName(doc),
      field: "New record",
      before: "—",
      after: opts.entityName(doc),
      beforeFields: [["Name", "—"]],
      afterFields: fieldPairs(doc),
    });
    return NextResponse.json(toClient(doc), { status: 201 });
  }

  return { GET, POST };
}

export function createItemHandlers(opts: CrudOptions) {
  async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const patch = await req.json();
    const db = await getDb();
    const before = await db.collection(opts.collection).findOne({ _id: new ObjectId(id) });
    if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await db.collection(opts.collection).updateOne({ _id: new ObjectId(id) }, { $set: patch });
    const after = { ...before, ...patch };
    await logAudit({
      action: "Edited",
      dataType: opts.dataType,
      entity: opts.entityName(after),
      field: Object.keys(patch)[0] || "Updated",
      before: String(Object.values(before).find((_v, i) => Object.keys(before)[i] === Object.keys(patch)[0]) ?? "—"),
      after: String(Object.values(patch)[0] ?? "—"),
      beforeFields: fieldPairs(before),
      afterFields: fieldPairs(after),
    });
    return NextResponse.json(toClient(after as Document & { _id: ObjectId }));
  }

  async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const db = await getDb();
    const doc = await db.collection(opts.collection).findOne({ _id: new ObjectId(id) });
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const name = opts.entityName(doc);
    await softDelete(opts.collection, opts.recycleType || opts.dataType, doc, name, opts.recycleDetail ? opts.recycleDetail(doc) : "");
    await logAudit({
      action: "Deleted",
      dataType: opts.dataType,
      entity: name,
      field: "Record removed",
      before: name,
      after: "—",
      beforeFields: fieldPairs(doc),
      afterFields: [["Record", "Deleted → Recycle Bin"]],
    });
    return NextResponse.json({ ok: true });
  }

  return { PATCH, DELETE };
}

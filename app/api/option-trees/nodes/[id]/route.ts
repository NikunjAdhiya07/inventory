import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { softDelete } from "@/lib/recycle";
import { withErrors } from "@/lib/api-error";
import { sameNameFilter } from "@/lib/option-trees";

async function update(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const db = await getDb();
  const before = await db.collection("optionNodes").findOne({ _id: new ObjectId(id) });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = String(body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "An option needs a name." }, { status: 400 });
    const clash = await db
      .collection("optionNodes")
      .findOne({ treeId: before.treeId, parent: before.parent ?? null, name: sameNameFilter(name), _id: { $ne: new ObjectId(id) } });
    if (clash) return NextResponse.json({ error: `“${name}” is already an option here.` }, { status: 409 });
    patch.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, "order")) patch.order = Number(body.order) || 0;
  if (Object.prototype.hasOwnProperty.call(body, "status")) patch.status = body.status === "Inactive" ? "Inactive" : "Active";

  await db.collection("optionNodes").updateOne({ _id: new ObjectId(id) }, { $set: patch });
  invalidateCollection("optionNodes");
  const after = { ...before, ...patch };
  await logAudit({
    action: "Edited",
    dataType: "Nested Option",
    entity: String(after.name ?? ""),
    field: Object.keys(patch)[0] || "Updated",
    before: String(before.name ?? ""),
    after: String(after.name ?? ""),
    beforeFields: [["Name", String(before.name ?? "")], ["Status", String(before.status ?? "")]],
    afterFields: [["Name", String(after.name ?? "")], ["Status", String(after.status ?? "")]],
  });
  return NextResponse.json(toClient(after as never));
}

async function remove(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const doc = await db.collection("optionNodes").findOne({ _id: new ObjectId(id) });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Deleting a node with children would strand the whole branch — the options
  // below it would stay in the collection unreachable by any walk.
  const children = await db.collection("optionNodes").countDocuments({ parent: id });
  if (children > 0) {
    return NextResponse.json(
      { error: `“${doc.name}” has ${children} option${children === 1 ? "" : "s"} under it. Remove those first.` },
      { status: 409 }
    );
  }

  const name = String(doc.name ?? "");
  await softDelete("optionNodes", "Nested Option", doc, name, `Option in tree ${doc.treeId}`);
  invalidateCollection("optionNodes");
  await logAudit({
    action: "Deleted",
    dataType: "Nested Option",
    entity: name,
    field: "Record removed",
    before: name,
    after: "—",
    beforeFields: [["Name", name]],
    afterFields: [["Record", "Deleted → Recycle Bin"]],
  });
  return NextResponse.json({ ok: true });
}

export const PATCH = withErrors(update);
export const DELETE = withErrors(remove);

import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { softDelete } from "@/lib/recycle";
import { withErrors } from "@/lib/api-error";
import { normalizeTreeInput, sameNameFilter } from "@/lib/option-trees";

async function update(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const db = await getDb();
  const before = await db.collection("optionTrees").findOne({ _id: new ObjectId(id) });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A status flip from the list is a one-field patch; the editor sends the whole
  // tree. Normalising only what was sent keeps both honest.
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  const full = normalizeTreeInput({ ...before, ...body });
  for (const key of ["name", "desc", "matches", "levels", "status"] as const) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = full[key];
  }
  if (patch.name === "") return NextResponse.json({ error: "A tree needs a name." }, { status: 400 });
  if (typeof patch.name === "string" && patch.name !== before.name) {
    const clash = await db.collection("optionTrees").findOne({ name: sameNameFilter(patch.name), _id: { $ne: new ObjectId(id) } });
    if (clash) return NextResponse.json({ error: `A tree named “${patch.name}” already exists.` }, { status: 409 });
  }

  await db.collection("optionTrees").updateOne({ _id: new ObjectId(id) }, { $set: patch });
  invalidateCollection("optionTrees");
  const after = { ...before, ...patch };
  await logAudit({
    action: "Edited",
    dataType: "Nested Category",
    entity: String(after.name ?? ""),
    field: Object.keys(patch).find((k) => k !== "updatedAt") || "Updated",
    before: String(before.name ?? ""),
    after: String(after.name ?? ""),
    beforeFields: [
      ["Levels", (before.levels ?? []).map((l: { label?: string }) => l.label).join(" → ") || "—"],
      ["Status", String(before.status ?? "")],
    ],
    afterFields: [
      ["Levels", (after.levels ?? []).map((l: { label?: string }) => l.label).join(" → ") || "—"],
      ["Status", String(after.status ?? "")],
    ],
  });
  return NextResponse.json(toClient(after as never));
}

async function remove(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const doc = await db.collection("optionTrees").findOne({ _id: new ObjectId(id) });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Options belong to their tree — a tree in the recycle bin whose options
  // stayed behind would restore as an empty shell, so they travel with it and
  // come back with it.
  const nodes = await db.collection("optionNodes").find({ treeId: id }).toArray();
  const name = String(doc.name ?? "");
  await softDelete("optionTrees", "Nested Category", doc, name, `${nodes.length} option${nodes.length === 1 ? "" : "s"}`, {
    collection: "optionNodes",
    parentField: "treeId",
    docs: nodes,
  });
  invalidateCollection("optionTrees");
  invalidateCollection("optionNodes");

  await logAudit({
    action: "Deleted",
    dataType: "Nested Category",
    entity: name,
    field: "Record removed",
    before: name,
    after: "—",
    beforeFields: [["Name", name], ["Options", String(nodes.length)]],
    afterFields: [["Record", "Deleted → Recycle Bin"]],
  });
  return NextResponse.json({ ok: true });
}

export const PATCH = withErrors(update);
export const DELETE = withErrors(remove);

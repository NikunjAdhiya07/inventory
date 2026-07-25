import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { softDelete } from "@/lib/recycle";

// Editing a workflow updates the editable "head" in place (name/desc/steps).
// Versions are NOT created here — they are captured only when the workflow is
// published via the activate route. This means edits to an Active workflow are
// staged on the head and only reach the bot on the next Activate, while
// in-progress entries keep running their pinned snapshot. This satisfies the
// "in-progress entries continue on their version; new entries use the updated
// version" requirement without spawning a version on every keystroke/drag.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const patch = await req.json();
  const db = await getDb();
  const before = await db.collection("workflows").findOne({ _id: new ObjectId(id) });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const set = { ...patch, updatedAt: new Date().toISOString() };
  await db.collection("workflows").updateOne({ _id: new ObjectId(id) }, { $set: set });
  const after = { ...before, ...set };
  await logAudit({
    action: "Edited",
    dataType: "Workflow",
    entity: String(after.name ?? ""),
    field: Object.prototype.hasOwnProperty.call(patch, "steps") ? "Steps" : Object.keys(patch)[0] || "Updated",
    before: "—",
    after: String(Object.values(patch)[0] ?? "—"),
    beforeFields: [["Version", String(before.version ?? 0)]],
    afterFields: [["Version", String(after.version ?? 0)], ["Status", String(after.status ?? "")]],
  });
  return NextResponse.json(toClient(after as never));
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const doc = await db.collection("workflows").findOne({ _id: new ObjectId(id) });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const name = String(doc.name ?? "");
  await softDelete("workflows", "Workflow", doc, name, `Version ${doc.version ?? 0}`);
  // Assignments referencing this workflow are no longer meaningful.
  await db.collection("workflowAssignments").deleteMany({ workflowId: id });
  await logAudit({
    action: "Deleted",
    dataType: "Workflow",
    entity: name,
    field: "Record removed",
    before: name,
    after: "—",
    beforeFields: [["Name", name]],
    afterFields: [["Record", "Deleted → Recycle Bin"]],
  });
  return NextResponse.json({ ok: true });
}

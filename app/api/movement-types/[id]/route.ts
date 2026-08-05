import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { softDelete } from "@/lib/recycle";
import { withErrors } from "@/lib/api-error";
import { normalizeMovementTypeInput } from "@/lib/movements";

async function update(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const db = await getDb();
  const before = await db.collection("movementTypes").findOne({ _id: new ObjectId(id) });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const full = normalizeMovementTypeInput({ ...before, ...body });
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const key of ["name", "desc", "direction", "requireRemarks", "requireReference", "allowNegative", "order", "status"] as const) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = full[key];
  }
  if (patch.name === "") return NextResponse.json({ error: "A movement type needs a name." }, { status: 400 });

  // The code is the ledger's reference to this type. Renaming the label is
  // always fine; changing the code would orphan every movement already recorded
  // under it, so it is fixed once created.
  if (body.code && String(body.code) !== String(before.code)) {
    return NextResponse.json({ error: "A type's code can't change — movements already reference it." }, { status: 400 });
  }
  // Direction decides the sign of the rows a type writes. Flipping it on a type
  // with history would make past movements read as the opposite of what they
  // did, so it is only editable while the type is unused.
  if (patch.direction && patch.direction !== before.direction) {
    const used = await db.collection("stockMovements").countDocuments({ reason: String(before.code) }, { limit: 1 });
    if (used) {
      return NextResponse.json(
        { error: "This type has movements recorded against it — its direction can't change. Deactivate it and add a new one." },
        { status: 409 }
      );
    }
  }

  await db.collection("movementTypes").updateOne({ _id: new ObjectId(id) }, { $set: patch });
  invalidateCollection("movementTypes");
  const after = { ...before, ...patch };
  await logAudit({
    action: "Edited",
    dataType: "Movement Type",
    entity: String(after.name ?? ""),
    field: Object.keys(patch).find((k) => k !== "updatedAt") || "Updated",
    before: String(before.name ?? ""),
    after: String(after.name ?? ""),
    beforeFields: [
      ["Name", String(before.name ?? "")],
      ["Direction", String(before.direction ?? "")],
      ["Status", String(before.status ?? "")],
    ],
    afterFields: [
      ["Name", String(after.name ?? "")],
      ["Direction", String(after.direction ?? "")],
      ["Status", String(after.status ?? "")],
    ],
  });
  return NextResponse.json(toClient(after as never));
}

async function remove(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const doc = await db.collection("movementTypes").findOne({ _id: new ObjectId(id) });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A system type is what the entry bot, the request bot and the storage map
  // write their movements as. Removing one would leave those flows recording
  // against a type that no longer exists.
  if (doc.isSystem) {
    return NextResponse.json({ error: `“${doc.name}” is written by the system and can't be deleted. Deactivate it instead.` }, { status: 409 });
  }
  // History is the point of the ledger. A type with movements behind it is
  // retired by deactivating it, which takes it off the form while every past
  // movement keeps its name.
  const used = await db.collection("stockMovements").countDocuments({ reason: String(doc.code) }, { limit: 1 });
  if (used) {
    return NextResponse.json(
      { error: `“${doc.name}” has movements recorded against it. Set it Inactive to retire it instead.` },
      { status: 409 }
    );
  }

  const name = String(doc.name ?? "");
  await softDelete("movementTypes", "Movement Type", doc, name, `${doc.direction} · ${doc.code}`);
  invalidateCollection("movementTypes");
  await logAudit({
    action: "Deleted",
    dataType: "Movement Type",
    entity: name,
    field: "Record removed",
    before: name,
    after: "—",
    beforeFields: [["Name", name], ["Code", String(doc.code ?? "")]],
    afterFields: [["Record", "Deleted → Recycle Bin"]],
  });
  return NextResponse.json({ ok: true });
}

export const PATCH = withErrors(update);
export const DELETE = withErrors(remove);

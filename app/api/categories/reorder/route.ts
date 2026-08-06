import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { invalidateCollection } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { withErrors } from "@/lib/api-error";
import { categorySubtreeIds } from "@/lib/categories";

// Reposition category nodes. Body: { parent, ids } — same contract as locations.
// Covers sibling reorder and reparenting in one write.

async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const ids = Array.isArray((body as { ids?: unknown })?.ids)
    ? ((body as { ids: unknown[] }).ids as unknown[]).map(String)
    : [];

  if (!ids.length) return NextResponse.json({ error: "Nothing to reposition." }, { status: 400 });
  if (ids.some((id) => !ObjectId.isValid(id))) return NextResponse.json({ error: "Bad node id." }, { status: 400 });

  const db = await getDb();
  const hasParentKey = Boolean(body) && typeof body === "object" && "parent" in body;

  // Legacy: a bare id list without parent still means "set global order on roots".
  if (!hasParentKey) {
    await Promise.all(
      ids.map((id, i) => db.collection("categories").updateOne({ _id: new ObjectId(id) }, { $set: { order: i + 1 } }))
    );
    invalidateCollection("categories");
    return NextResponse.json({ ok: true });
  }

  const parent = (body as { parent?: unknown }).parent;
  const parentId = parent == null || parent === "" ? null : String(parent);

  if (parentId !== null && !ObjectId.isValid(parentId)) {
    return NextResponse.json({ error: "Bad destination id." }, { status: 400 });
  }
  if (parentId !== null && ids.includes(parentId)) {
    return NextResponse.json({ error: "A node can't be moved into itself." }, { status: 400 });
  }

  if (parentId !== null) {
    const dest = await db.collection("categories").findOne({ _id: new ObjectId(parentId) });
    if (!dest) return NextResponse.json({ error: "That destination no longer exists." }, { status: 404 });

    for (const id of ids) {
      const subtree = await categorySubtreeIds(db, id);
      if (subtree.has(parentId)) {
        return NextResponse.json(
          { error: "That destination sits inside the node you're moving. Pick a destination outside it." },
          { status: 400 }
        );
      }
    }
  }

  const before = await db
    .collection("categories")
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { name: 1, parent: 1 } })
    .toArray();
  if (before.length !== ids.length) return NextResponse.json({ error: "One of those nodes no longer exists." }, { status: 404 });

  await db.collection("categories").bulkWrite(
    ids.map((id, i) => ({
      updateOne: { filter: { _id: new ObjectId(id) }, update: { $set: { parent: parentId, order: i + 1 } } },
    }))
  );
  invalidateCollection("categories");

  const nameById = new Map(before.map((b) => [b._id.toString(), String(b.name)]));
  const moved = before.filter((b) => (b.parent ? String(b.parent) : null) !== parentId);
  await logAudit({
    action: "Edited",
    dataType: "Category",
    entity: ids.length === 1 ? nameById.get(ids[0]) || "" : `${ids.length} nodes`,
    field: moved.length ? "Moved" : "Reordered",
    before: moved.length ? `${moved.length} under a different parent` : "previous order",
    after: ids.map((id) => nameById.get(id) || id).join(", "),
    beforeFields: [["Nodes", before.map((b) => String(b.name)).join(", ")]],
    afterFields: [
      ["Order", ids.map((id, i) => `${i + 1}. ${nameById.get(id) || id}`).join(", ")],
      ["Moved", moved.length ? moved.map((m) => String(m.name)).join(", ") : "—"],
    ],
  });

  return NextResponse.json({ ok: true, moved: moved.length, ordered: ids.length });
}

const handler = withErrors(POST);
export { handler as POST };

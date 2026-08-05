import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { invalidateCollection } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { withErrors } from "@/lib/api-error";
import { locationSubtreeIds } from "@/lib/locations";

// Reposition nodes. The body is a statement about one parent: "these are your
// children, in this order."
//
// That one shape covers every move the map offers — nudging Box 04 up a place,
// dragging a box from Shelf 3 to Shelf 5, moving a whole shelf to another rack —
// because reordering within a parent and moving between parents differ only in
// whether the ids were already there. One route, one audit entry, one write per
// node, and no way to end up reordered-but-not-moved.

async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parent = (body as { parent?: unknown })?.parent;
  const parentId = parent == null || parent === "" ? null : String(parent);
  const ids = Array.isArray((body as { ids?: unknown })?.ids) ? ((body as { ids: unknown[] }).ids as unknown[]).map(String) : [];

  if (!ids.length) return NextResponse.json({ error: "Nothing to reposition." }, { status: 400 });
  if (ids.some((id) => !ObjectId.isValid(id))) return NextResponse.json({ error: "Bad node id." }, { status: 400 });
  if (parentId !== null && !ObjectId.isValid(parentId)) {
    return NextResponse.json({ error: "Bad destination id." }, { status: 400 });
  }
  if (parentId !== null && ids.includes(parentId)) {
    return NextResponse.json({ error: "A node can't be moved into itself." }, { status: 400 });
  }

  const db = await getDb();

  if (parentId !== null) {
    const dest = await db.collection("locations").findOne({ _id: new ObjectId(parentId) });
    if (!dest) return NextResponse.json({ error: "That destination no longer exists." }, { status: 404 });

    // Moving a rack into one of its own shelves would cut the branch loose from
    // the tree: it would still hold stock, and nothing would be able to name it.
    for (const id of ids) {
      const subtree = await locationSubtreeIds(db, id);
      if (subtree.has(parentId)) {
        return NextResponse.json(
          { error: "That destination sits inside the node you're moving. Pick a destination outside it." },
          { status: 400 }
        );
      }
    }
  }

  const before = await db
    .collection("locations")
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { name: 1, parent: 1 } })
    .toArray();
  if (before.length !== ids.length) return NextResponse.json({ error: "One of those nodes no longer exists." }, { status: 404 });

  await db.collection("locations").bulkWrite(
    ids.map((id, i) => ({
      updateOne: { filter: { _id: new ObjectId(id) }, update: { $set: { parent: parentId, order: i + 1 } } },
    }))
  );
  invalidateCollection("locations");

  // A node that changed hands is a different event from one that just shifted
  // place, and the trail should say which happened.
  const nameById = new Map(before.map((b) => [b._id.toString(), String(b.name)]));
  const moved = before.filter((b) => (b.parent ? String(b.parent) : null) !== parentId);
  await logAudit({
    action: "Edited",
    dataType: "Storage Location",
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

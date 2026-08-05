import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { withErrors } from "@/lib/api-error";
import { normalizeMovementTypeInput } from "@/lib/movements";

// The stock movement vocabulary. Adding a type here is all it takes to make a
// new kind of movement recordable — the form, the ledger and the history are
// all driven by these rows (AC-02).

async function list() {
  const db = await getDb();
  const [types, used] = await Promise.all([
    db.collection("movementTypes").find({}).sort({ order: 1, name: 1 }).toArray(),
    // How often each type has actually been used. It is what makes deleting one
    // a decision rather than a guess.
    db.collection("stockMovements").aggregate([{ $group: { _id: "$reason", n: { $sum: 1 } } }]).toArray(),
  ]);
  const counts = new Map(used.map((u) => [String(u._id), Number(u.n)]));
  return NextResponse.json(toClientList(types).map((t) => ({ ...t, usedCount: counts.get(String(t.code)) ?? 0 })));
}

async function create(req: NextRequest) {
  const body = await req.json();
  const doc = normalizeMovementTypeInput(body);
  if (!doc.name) return NextResponse.json({ error: "A movement type needs a name." }, { status: 400 });
  if (!doc.code) return NextResponse.json({ error: "A movement type needs a code." }, { status: 400 });

  const db = await getDb();
  // The code is what every ledger row stores, so two types may not share one —
  // history could not tell them apart afterwards.
  const clash = await db.collection("movementTypes").findOne({ code: doc.code });
  if (clash) return NextResponse.json({ error: `The code “${doc.code}” is already in use.` }, { status: 409 });

  const now = new Date().toISOString();
  // Types added in the console are never system types: `isSystem` marks the ones
  // the software writes itself, and granting it here would hide the new type
  // from the very form it was created for.
  const result = await db.collection("movementTypes").insertOne({ ...doc, isSystem: false, createdAt: now, updatedAt: now });
  invalidateCollection("movementTypes");
  await logAudit({
    action: "Created",
    dataType: "Movement Type",
    entity: doc.name,
    field: "New movement type",
    before: "—",
    after: doc.name,
    beforeFields: [["Name", "—"]],
    afterFields: [
      ["Name", doc.name],
      ["Code", doc.code],
      ["Direction", doc.direction],
      ["Status", doc.status],
    ],
  });
  return NextResponse.json(toClient({ _id: result.insertedId, ...doc, isSystem: false, usedCount: 0 }), { status: 201 });
}

export const GET = withErrors(list);
export const POST = withErrors(create);

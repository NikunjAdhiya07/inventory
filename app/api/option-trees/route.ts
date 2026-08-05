import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { withErrors } from "@/lib/api-error";
import { normalizeTreeInput, sameNameFilter } from "@/lib/option-trees";

// Nested category trees — the master behind the bot's nested_select step.
// A tree IS its levels (the questions, in order); the options that answer the
// node levels live in `optionNodes` and are managed under ./nodes.

async function list() {
  const db = await getDb();
  const [trees, counts] = await Promise.all([
    db.collection("optionTrees").find({}).sort({ name: 1 }).toArray(),
    // One grouped count instead of a query per tree — the list shows how much is
    // authored under each one.
    db.collection("optionNodes").aggregate([{ $group: { _id: "$treeId", n: { $sum: 1 } } }]).toArray(),
  ]);
  const byTree = new Map(counts.map((c) => [String(c._id), Number(c.n)]));
  return NextResponse.json(toClientList(trees).map((t) => ({ ...t, nodeCount: byTree.get(String(t.id)) ?? 0 })));
}

async function create(req: NextRequest) {
  const body = await req.json();
  const doc = normalizeTreeInput(body);
  if (!doc.name) return NextResponse.json({ error: "A tree needs a name." }, { status: 400 });

  const db = await getDb();
  // The name is how both a workflow step and an item name find a tree, and both
  // find it case-insensitively — so two trees may not share one in any casing.
  const clash = await db.collection("optionTrees").findOne({ name: sameNameFilter(doc.name) });
  if (clash) return NextResponse.json({ error: `A tree named “${doc.name}” already exists.` }, { status: 409 });

  const now = new Date().toISOString();
  const result = await db.collection("optionTrees").insertOne({ ...doc, createdAt: now, updatedAt: now });
  invalidateCollection("optionTrees");
  await logAudit({
    action: "Created",
    dataType: "Nested Category",
    entity: doc.name,
    field: "New tree",
    before: "—",
    after: doc.name,
    beforeFields: [["Name", "—"]],
    afterFields: [
      ["Name", doc.name],
      ["Levels", doc.levels.map((l) => l.label).join(" → ") || "—"],
      ["Status", doc.status],
    ],
  });
  return NextResponse.json(toClient({ _id: result.insertedId, ...doc, nodeCount: 0 }), { status: 201 });
}

export const GET = withErrors(list);
export const POST = withErrors(create);

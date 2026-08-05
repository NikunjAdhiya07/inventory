import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { withErrors } from "@/lib/api-error";
import { sameNameFilter } from "@/lib/option-trees";

// The options that answer a tree's node levels: a parent/child forest, one
// document per option, scoped to a tree. `parent: null` is a root option — the
// answer to the first node level of its tree.

async function list(req: NextRequest) {
  const treeId = req.nextUrl.searchParams.get("treeId");
  const db = await getDb();
  const docs = await db
    .collection("optionNodes")
    .find(treeId ? { treeId } : {})
    .sort({ order: 1, name: 1 })
    .toArray();
  return NextResponse.json(toClientList(docs));
}

async function create(req: NextRequest) {
  const body = await req.json();
  const treeId = String(body.treeId ?? "").trim();
  const name = String(body.name ?? "").trim();
  if (!treeId) return NextResponse.json({ error: "An option belongs to a tree." }, { status: 400 });
  if (!name) return NextResponse.json({ error: "An option needs a name." }, { status: 400 });

  const doc = {
    treeId,
    parent: body.parent ? String(body.parent) : null,
    name,
    order: Number(body.order) || 0,
    status: body.status === "Inactive" ? "Inactive" : "Active",
  };
  const db = await getDb();
  // Siblings are what the user picks between, so two of them may not read the
  // same — and "Copper" beside "copper" is two identical buttons as far as
  // anyone tapping one is concerned. Different branches reusing a name is
  // normal and stays allowed.
  const clash = await db.collection("optionNodes").findOne({ treeId, parent: doc.parent, name: sameNameFilter(name) });
  if (clash) return NextResponse.json({ error: `“${name}” is already an option here.` }, { status: 409 });

  const result = await db.collection("optionNodes").insertOne(doc);
  invalidateCollection("optionNodes");
  await logAudit({
    action: "Created",
    dataType: "Nested Option",
    entity: name,
    field: "New option",
    before: "—",
    after: name,
    beforeFields: [["Name", "—"]],
    afterFields: [["Name", name], ["Parent", doc.parent ? "Child option" : "Top level"], ["Status", doc.status]],
  });
  return NextResponse.json(toClient({ _id: result.insertedId, ...doc }), { status: 201 });
}

export const GET = withErrors(list);
export const POST = withErrors(create);

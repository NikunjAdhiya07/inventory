import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";

// Workflows list, newest-edited first.
export async function GET() {
  const db = await getDb();
  const docs = await db.collection("workflows").find({}).sort({ updatedAt: -1 }).toArray();
  return NextResponse.json(toClientList(docs));
}

// A new workflow always starts as a Draft on version 0 with no steps. It only
// gets a version number + snapshot when it is activated (see activate route).
export async function POST(req: NextRequest) {
  const body = await req.json();
  const now = new Date().toISOString();
  const doc = {
    name: String(body.name ?? "Untitled workflow"),
    desc: String(body.desc ?? ""),
    status: "Draft" as const,
    version: 0,
    isDefault: false,
    steps: Array.isArray(body.steps) ? body.steps : [],
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  const result = await db.collection("workflows").insertOne(doc);
  const full = { _id: result.insertedId, ...doc };
  await logAudit({
    action: "Created",
    dataType: "Workflow",
    entity: doc.name,
    field: "New workflow",
    before: "—",
    after: doc.name,
    beforeFields: [["Name", "—"]],
    afterFields: [["Name", doc.name], ["Status", "Draft"]],
  });
  return NextResponse.json(toClient(full), { status: 201 });
}

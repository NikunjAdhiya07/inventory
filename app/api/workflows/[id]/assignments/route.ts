import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";

// Assignment edges for a workflow: which Telegram groups and/or categories it
// applies to. GET lists them; POST creates one; DELETE (?assignmentId=) removes.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const docs = await db.collection("workflowAssignments").find({ workflowId: id }).toArray();
  return NextResponse.json(toClientList(docs));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const scope = body.scope === "category" ? "category" : "group";
  const doc = {
    workflowId: id,
    scope,
    chatId: scope === "group" ? String(body.chatId ?? "") : undefined,
    category: scope === "category" ? String(body.category ?? "") : undefined,
    priority: Number(body.priority) || 0,
    status: "Active" as const,
    createdAt: new Date().toISOString(),
  };
  const db = await getDb();
  const result = await db.collection("workflowAssignments").insertOne(doc);
  return NextResponse.json(toClient({ _id: result.insertedId, ...doc }), { status: 201 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const assignmentId = new URL(req.url).searchParams.get("assignmentId");
  if (!assignmentId) return NextResponse.json({ error: "assignmentId required" }, { status: 400 });
  const db = await getDb();
  await db.collection("workflowAssignments").deleteOne({ _id: new ObjectId(assignmentId), workflowId: id });
  return NextResponse.json({ ok: true });
}

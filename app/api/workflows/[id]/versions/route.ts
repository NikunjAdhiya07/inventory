import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";

// Immutable version history for a workflow, newest first.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const docs = await db.collection("workflowVersions").find({ workflowId: id }).sort({ version: -1 }).toArray();
  return NextResponse.json(toClientList(docs));
}

import { NextRequest, NextResponse } from "next/server";
import { ObjectId, type Document } from "mongodb";
import { getDb } from "@/lib/mongodb";

// Persists a drag-and-drop reorder of a workflow's steps in one round trip:
// body is the list of step instanceIds in their new order. Reorders the
// embedded steps array on the head and rewrites each step's `order`. Mirrors the
// categories reorder route; edits the head only (no new version — see PATCH).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { instanceIds }: { instanceIds: string[] } = await req.json();
  const db = await getDb();
  const wf = await db.collection("workflows").findOne({ _id: new ObjectId(id) });
  if (!wf) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const byId = new Map((wf.steps as Document[]).map((s) => [s.instanceId, s]));
  const reordered = instanceIds
    .map((iid, i) => {
      const step = byId.get(iid);
      return step ? { ...step, order: i + 1 } : null;
    })
    .filter(Boolean);

  await db
    .collection("workflows")
    .updateOne({ _id: new ObjectId(id) }, { $set: { steps: reordered, updatedAt: new Date().toISOString() } });
  return NextResponse.json({ ok: true });
}

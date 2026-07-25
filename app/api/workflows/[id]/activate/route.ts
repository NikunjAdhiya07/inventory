import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { writeSnapshot } from "@/lib/workflow-versions";

// Activate a workflow (or re-activate after edits). Bumps the version, writes an
// immutable snapshot, and — if this workflow is marked default — clears the
// default flag on every other workflow so exactly one fallback exists.
// Body may include { setDefault: boolean }.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const db = await getDb();
  const wf = await db.collection("workflows").findOne({ _id: new ObjectId(id) });
  if (!wf) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  if (steps.length === 0) {
    return NextResponse.json({ error: "Add at least one step before activating." }, { status: 400 });
  }

  const nextVersion = (wf.version || 0) + 1;
  const setDefault = body.setDefault === true || wf.isDefault === true;

  if (setDefault) {
    // Enforce a single default fallback.
    await db.collection("workflows").updateMany({ _id: { $ne: new ObjectId(id) } }, { $set: { isDefault: false } });
  }

  await writeSnapshot(db, id, nextVersion, String(wf.name ?? ""), steps);
  await db.collection("workflows").updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: "Active", version: nextVersion, isDefault: setDefault, updatedAt: new Date().toISOString() } }
  );

  await logAudit({
    action: "Edited",
    dataType: "Workflow",
    entity: String(wf.name ?? ""),
    field: "Activated",
    before: `${wf.status} v${wf.version ?? 0}`,
    after: `Active v${nextVersion}`,
    beforeFields: [["Status", String(wf.status ?? "")], ["Version", String(wf.version ?? 0)]],
    afterFields: [["Status", "Active"], ["Version", String(nextVersion)], ["Default", setDefault ? "Yes" : "No"]],
  });

  const after = { ...wf, status: "Active", version: nextVersion, isDefault: setDefault };
  return NextResponse.json(toClient(after as never));
}

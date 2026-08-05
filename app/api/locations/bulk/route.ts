import { NextRequest, NextResponse } from "next/server";
import type { Document } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";
import { invalidateCollection } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { withErrors } from "@/lib/api-error";
import { buildBulkNodes, type BulkSpec } from "@/lib/location-bulk";

// Create a run of sibling nodes in one write — a rack's worth of boxes, or a
// section's worth of racks. The single-node POST on /api/locations stays as it
// is; this is the same collection, entered at the rate a warehouse is actually
// laid out.

async function POST(req: NextRequest) {
  const spec = (await req.json()) as BulkSpec;

  let docs;
  try {
    docs = buildBulkNodes(spec);
  } catch (err) {
    // A bad range is the user mistyping a form, not a server fault — 400 so the
    // client shows the reason instead of "Request failed (500)".
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  if (!docs.length) return NextResponse.json({ error: "Nothing to create." }, { status: 400 });

  const db = await getDb();

  // Refuse to duplicate names already sitting under this parent. Re-running a
  // batch after adding two more boxes should add the two, not a second "Box 01".
  const siblings = await db
    .collection("locations")
    .find({ parent: spec.parent ?? null }, { projection: { name: 1 } })
    .toArray();
  const taken = new Set(siblings.map((s) => String(s.name).toLowerCase()));
  const fresh = docs.filter((d) => !taken.has(String(d.name).toLowerCase()));
  if (!fresh.length) {
    return NextResponse.json({ error: "Every node in that range already exists here." }, { status: 409 });
  }

  const result = await db.collection("locations").insertMany(fresh);
  invalidateCollection("locations");

  const created: Document[] = fresh.map((d, i) => ({ ...d, _id: result.insertedIds[i] }));
  const first = String(created[0].name);
  const last = String(created[created.length - 1].name);
  await logAudit({
    action: "Created",
    dataType: "Storage Location",
    entity: created.length === 1 ? first : `${first} … ${last}`,
    field: "Bulk create",
    before: "—",
    after: `${created.length} × ${spec.level}`,
    beforeFields: [["Nodes", "—"]],
    afterFields: [
      ["Level", String(spec.level)],
      ["Count", String(created.length)],
      ["Names", created.map((c) => c.name).join(", ")],
    ],
  });

  return NextResponse.json(
    { created: toClientList(created as never), skipped: docs.length - fresh.length },
    { status: 201 }
  );
}

const handler = withErrors(POST);
export { handler as POST };

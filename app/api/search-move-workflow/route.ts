import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { withErrors } from "@/lib/api-error";
import { logAudit } from "@/lib/audit";
import {
  getSearchMoveWorkflow,
  normalizeWorkflow,
  saveSearchMoveWorkflow,
  type SearchMoveWorkflow,
} from "@/lib/search-move-workflow";

async function get() {
  const db = await getDb();
  const workflow = await getSearchMoveWorkflow(db);
  return NextResponse.json(workflow);
}

async function put(req: NextRequest) {
  const body = (await req.json()) as SearchMoveWorkflow;
  const db = await getDb();
  const before = await getSearchMoveWorkflow(db);
  const saved = await saveSearchMoveWorkflow(db, normalizeWorkflow(body));
  await logAudit({
    action: "Edited",
    dataType: "Search Move Workflow",
    entity: saved.name,
    field: "Tree",
    before: `${Object.keys(before.nodes).length} nodes`,
    after: `${Object.keys(saved.nodes).length} nodes`,
    beforeFields: [["Nodes", String(Object.keys(before.nodes).length)]],
    afterFields: [["Nodes", String(Object.keys(saved.nodes).length)]],
  });
  return NextResponse.json(saved);
}

export const GET = withErrors(get);
export const PUT = withErrors(put);

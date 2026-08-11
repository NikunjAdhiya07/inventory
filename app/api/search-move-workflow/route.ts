import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { withErrors } from "@/lib/api-error";
import { logAudit } from "@/lib/audit";
import {
  getSearchMoveWorkflow,
  normalizeWorkflow,
  saveSearchMoveWorkflow,
  type SearchMoveWorkflow,
  type WorkflowGroupMode,
} from "@/lib/search-move-workflow";
import { groupMode } from "@/lib/telegram-health";

async function get(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("chatId")?.trim() || "";
  if (!chatId) {
    return NextResponse.json({ error: "chatId is required — pick a Telegram group on Workflows." }, { status: 400 });
  }
  const db = await getDb();
  const group = await db.collection("telegramGroups").findOne({ chatId });
  if (!group) {
    return NextResponse.json({ error: "Telegram group not found." }, { status: 404 });
  }
  const mode = groupMode(group as { mode?: string }) as WorkflowGroupMode;
  const workflow = await getSearchMoveWorkflow(db, chatId, { mode });
  return NextResponse.json({ ...workflow, groupMode: mode, groupTitle: String(group.title ?? chatId) });
}

async function put(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("chatId")?.trim() || "";
  if (!chatId) {
    return NextResponse.json({ error: "chatId is required." }, { status: 400 });
  }
  const body = (await req.json()) as SearchMoveWorkflow;
  const db = await getDb();
  const group = await db.collection("telegramGroups").findOne({ chatId });
  if (!group) {
    return NextResponse.json({ error: "Telegram group not found." }, { status: 404 });
  }
  const mode = groupMode(group as { mode?: string }) as WorkflowGroupMode;
  const before = await getSearchMoveWorkflow(db, chatId, { mode });
  const saved = await saveSearchMoveWorkflow(db, normalizeWorkflow(body), chatId);
  await logAudit({
    action: "Edited",
    dataType: "Search Move Workflow",
    entity: `${saved.name} · ${group.title ?? chatId}`,
    field: "Tree",
    before: `${Object.keys(before.nodes).length} nodes`,
    after: `${Object.keys(saved.nodes).length} nodes`,
    beforeFields: [
      ["Group", String(group.title ?? chatId)],
      ["Nodes", String(Object.keys(before.nodes).length)],
    ],
    afterFields: [
      ["Group", String(group.title ?? chatId)],
      ["Nodes", String(Object.keys(saved.nodes).length)],
      ["Mode", mode],
    ],
  });
  return NextResponse.json({ ...saved, groupMode: mode, groupTitle: String(group.title ?? chatId) });
}

export const GET = withErrors(get);
export const PUT = withErrors(put);

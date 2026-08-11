import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";
import { logAudit } from "@/lib/audit";
import { invalidateCollection } from "@/lib/cache";
import { writeSnapshot } from "@/lib/workflow-versions";
import {
  ADD_TO_STOCK_WORKFLOW_DESC,
  ADD_TO_STOCK_WORKFLOW_NAME,
  buildAddToStockSteps,
} from "@/lib/entry-workflow-template";
import { groupMode } from "@/lib/telegram-health";

/**
 * Create the Add-to-Stock entry workflow from template, activate it, and assign
 * it to a Telegram Entries-mode group in one shot.
 *
 * Body: { chatId: string, name?: string, setDefault?: boolean }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const chatId = String(body.chatId ?? "").trim();
  if (!chatId) {
    return NextResponse.json({ error: "Select a Telegram group (chatId required)." }, { status: 400 });
  }

  const db = await getDb();
  const group = await db.collection("telegramGroups").findOne({ chatId });
  if (!group) {
    return NextResponse.json({ error: "Telegram group not found." }, { status: 404 });
  }
  if (groupMode(group as { mode?: string }) !== "entry") {
    return NextResponse.json(
      {
        error:
          "That group is in Requests mode. Switch it to Entries on Telegram Groups, then try again.",
      },
      { status: 400 }
    );
  }

  const name = String(body.name ?? "").trim() || ADD_TO_STOCK_WORKFLOW_NAME;
  const steps = buildAddToStockSteps();
  const now = new Date().toISOString();

  const defaultCount = await db.collection("workflows").countDocuments({ isDefault: true, status: "Active" });
  const setDefault = body.setDefault === true || defaultCount === 0;

  if (setDefault) {
    await db.collection("workflows").updateMany({}, { $set: { isDefault: false } });
  }

  const insert = await db.collection("workflows").insertOne({
    name,
    desc: ADD_TO_STOCK_WORKFLOW_DESC,
    status: "Active",
    version: 1,
    isDefault: setDefault,
    steps,
    createdAt: now,
    updatedAt: now,
  });
  const workflowId = insert.insertedId.toString();

  await writeSnapshot(db, workflowId, 1, name, steps, "console:from-template");

  // Keep builder palette in sync for installs that seeded before flatSelect existed.
  await db.collection("stepLibrary").updateOne(
    { type: "location_tree" },
    {
      $set: {
        name: "Storage Location",
        desc: "Pick a storage location — flat one-tap list, or drill Warehouse → Floor → Rack.",
        configSchema: [
          {
            key: "dataSource",
            label: "Location source",
            type: "dataSource",
            default: "locations",
            appliesToDataSource: "locations",
          },
          { key: "flatSelect", label: "Flat list (no drill-down)", type: "toggle", default: false },
          { key: "defaultLocation", label: "Open inside location (drill mode)", type: "text", default: "" },
        ],
      },
    }
  );
  await db.collection("stepLibrary").updateOne(
    { type: "review_confirm" },
    {
      $set: {
        name: "Review & Add to Cart",
        desc: "Shows a summary; the user taps Add to Cart to save (no extra confirmation).",
      },
    }
  );

  await db.collection("workflowAssignments").insertOne({
    workflowId,
    scope: "group",
    chatId,
    priority: 10,
    status: "Active",
    createdAt: now,
  });

  invalidateCollection("workflows");
  invalidateCollection("workflowAssignments");

  const groupTitle = String(group.title ?? chatId);
  await logAudit({
    action: "Created",
    dataType: "Workflow",
    entity: name,
    field: "Add-to-Stock template",
    before: "—",
    after: `Active v1 → ${groupTitle}`,
    beforeFields: [["Name", "—"]],
    afterFields: [
      ["Name", name],
      ["Status", "Active"],
      ["Version", "1"],
      ["Group", groupTitle],
      ["Default", setDefault ? "Yes" : "No"],
    ],
  });

  return NextResponse.json(
    toClient({
      _id: insert.insertedId,
      name,
      desc: ADD_TO_STOCK_WORKFLOW_DESC,
      status: "Active",
      version: 1,
      isDefault: setDefault,
      steps,
      createdAt: now,
      updatedAt: now,
      assignedChatId: chatId,
      assignedGroupTitle: groupTitle,
    }),
    { status: 201 }
  );
}

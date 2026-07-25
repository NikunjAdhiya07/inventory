import { NextResponse } from "next/server";
import { createCrudHandlers } from "@/lib/crud";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";
import { deriveGroup } from "@/lib/telegram-health";

const handlers = createCrudHandlers({
  collection: "telegramGroups",
  dataType: "Telegram Group",
  entityName: (d) => String(d.title ?? ""),
  recycleDetail: (d) => `Chat id: ${d.chatId ?? ""}`,
  sort: { title: 1 },
});

// Cheap poll endpoint used by the console's auto-refresh: derives the effective
// status (health + manual override) from stored fields without touching the
// Telegram network. Health pings live behind the /health routes instead.
export async function GET() {
  const db = await getDb();
  const docs = await db.collection("telegramGroups").find({}).sort({ title: 1 }).toArray();
  return NextResponse.json(toClientList(docs).map(deriveGroup));
}

export const { POST } = handlers;

import type { Db, Document, ObjectId } from "mongodb";
import { getChat } from "./telegram";

// ------------------------------------------------------------------
// Telegram group monitoring: health checks, effective-status derivation
// and an append-only activity log used by the Telegram Groups console.
// ------------------------------------------------------------------

export type BotHealth = "healthy" | "unhealthy" | "unknown";
export type LogType = "health" | "command" | "update" | "error";
export type LogLevel = "info" | "error";

// The status the console displays. A manual override always wins so an admin can
// force a group offline even when the bot is perfectly healthy; otherwise the
// last health-check result decides, falling back to any stored status until the
// first probe has run.
export function deriveStatus(g: {
  manualInactive?: boolean;
  botHealth?: BotHealth;
  status?: string;
}): "Active" | "Inactive" {
  if (g.manualInactive) return "Inactive";
  if (g.botHealth === "unhealthy") return "Inactive";
  if (g.botHealth === "healthy") return "Active";
  return g.status === "Inactive" ? "Inactive" : "Active";
}

// Shape returned to the client — the stored doc plus the computed status so the
// UI never has to re-implement the precedence rules above.
export function deriveGroup<T extends Document & { id: string }>(g: T) {
  return {
    ...g,
    manualInactive: Boolean(g.manualInactive),
    botHealth: (g.botHealth as BotHealth) ?? "unknown",
    lastSeenAt: (g.lastSeenAt as string | null) ?? null,
    lastCheckedAt: (g.lastCheckedAt as string | null) ?? null,
    lastError: (g.lastError as string | null) ?? null,
    status: deriveStatus(g as { manualInactive?: boolean; botHealth?: BotHealth; status?: string }),
  };
}

// Append one entry to the per-group activity log. Failures here must never break
// the caller (a webhook update, a health check), so callers treat it as
// fire-and-forget.
export async function logTelegram(
  db: Db,
  e: {
    groupId?: string | null;
    chatId?: string | null;
    title?: string | null;
    type: LogType;
    level?: LogLevel;
    message: string;
  }
) {
  await db.collection("telegramLogs").insertOne({
    ts: new Date().toISOString(),
    groupId: e.groupId ?? null,
    chatId: e.chatId ?? null,
    title: e.title ?? null,
    type: e.type,
    level: e.level ?? "info",
    message: e.message,
  });
}

// Ping one group's bot and persist the outcome (health, last-seen, last-error)
// plus a log entry. Returns the health so a caller can short-circuit.
export async function runHealthCheck(
  db: Db,
  group: { _id: ObjectId; chatId: string; title?: string }
): Promise<BotHealth> {
  const now = new Date().toISOString();
  let healthy = false;
  let detail = "";
  try {
    const chat = await getChat(group.chatId);
    healthy = !!chat;
    if (!healthy) detail = "Bot did not respond (getChat returned no result).";
  } catch (err) {
    healthy = false;
    detail = err instanceof Error ? err.message : "Unknown error contacting Telegram.";
  }

  await db.collection("telegramGroups").updateOne(
    { _id: group._id },
    {
      $set: {
        botHealth: healthy ? "healthy" : "unhealthy",
        lastCheckedAt: now,
        lastError: healthy ? null : detail,
        ...(healthy ? { lastSeenAt: now } : {}),
      },
    }
  );

  await logTelegram(db, {
    groupId: group._id.toString(),
    chatId: group.chatId,
    title: group.title ?? null,
    type: "health",
    level: healthy ? "info" : "error",
    message: healthy ? "Health check OK — bot reachable." : `Health check failed — ${detail}`,
  }).catch(() => {});

  return healthy ? "healthy" : "unhealthy";
}

// Called from the webhook on every authorized update. Marks the group as seen
// (which also flips a previously-unhealthy group back to healthy) and records a
// command/update log line. Best-effort: never throws into the webhook path.
export async function recordGroupActivity(
  db: Db,
  chatId: string,
  info: { isCommand: boolean; text?: string; actor: string }
) {
  try {
    const now = new Date().toISOString();
    const group = await db.collection("telegramGroups").findOne({ chatId });
    if (group) {
      await db.collection("telegramGroups").updateOne(
        { _id: group._id },
        { $set: { lastSeenAt: now, botHealth: "healthy", lastError: null } }
      );
    }
    await logTelegram(db, {
      groupId: group?._id?.toString() ?? null,
      chatId,
      title: (group?.title as string) ?? null,
      type: info.isCommand ? "command" : "update",
      level: "info",
      message: info.isCommand
        ? `${info.actor} ran ${(info.text || "").split(/\s+/)[0]}`
        : `${info.actor} sent an inventory update.`,
    });
  } catch {
    // monitoring must not affect bot delivery
  }
}

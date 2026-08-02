import type { Db, Document, ObjectId } from "mongodb";
import { getChat } from "./telegram";
import { cached } from "./cache";

// ------------------------------------------------------------------
// Telegram group monitoring: health checks, effective-status derivation
// and an append-only activity log used by the Telegram Groups console.
// ------------------------------------------------------------------

export type BotHealth = "healthy" | "unhealthy" | "unknown";
export type LogType = "health" | "command" | "update" | "error";
export type LogLevel = "info" | "error";

// What the bot does in a given group. One bot token can only ever have one
// webhook, so both flows arrive at the same endpoint and the group decides which
// one it is: `entry` runs the inventory-capture workflow, `request` runs the
// search-and-request flow.
//
// Defaulting to `entry` is what keeps every group that existed before this
// field behaving exactly as it did.
export type GroupMode = "entry" | "request";

export function groupMode(g: { mode?: string }): GroupMode {
  return g.mode === "request" ? "request" : "entry";
}

// The status the console displays. Approval and a manual override both win over
// health so an admin can hold a group offline even when the bot is perfectly
// reachable; otherwise the last health-check result decides, falling back to any
// stored status until the first probe has run.
export function deriveStatus(g: {
  approved?: boolean;
  manualInactive?: boolean;
  botHealth?: BotHealth;
  status?: string;
}): "Active" | "Inactive" {
  if (isApproved(g) === false) return "Inactive";
  if (g.manualInactive) return "Inactive";
  if (g.botHealth === "unhealthy") return "Inactive";
  if (g.botHealth === "healthy") return "Active";
  return g.status === "Inactive" ? "Inactive" : "Active";
}

// A group with no `approved` field predates the approval gate — it could only
// have got into the collection through the console, so it stays approved. Only
// an explicit `false`, which is what a self-registering group is inserted with,
// means "waiting for an admin".
export function isApproved(g: { approved?: boolean }): boolean {
  return g.approved !== false;
}

// Shape returned to the client — the stored doc plus the computed status so the
// UI never has to re-implement the precedence rules above.
export function deriveGroup<T extends Document & { id: string }>(g: T) {
  return {
    ...g,
    approved: isApproved(g as { approved?: boolean }),
    manualInactive: Boolean(g.manualInactive),
    mode: groupMode(g as { mode?: string }),
    botHealth: (g.botHealth as BotHealth) ?? "unknown",
    lastSeenAt: (g.lastSeenAt as string | null) ?? null,
    lastCheckedAt: (g.lastCheckedAt as string | null) ?? null,
    lastError: (g.lastError as string | null) ?? null,
    status: deriveStatus(g as { approved?: boolean; manualInactive?: boolean; botHealth?: BotHealth; status?: string }),
  };
}

// Fields a group is created with when the bot discovers it rather than an admin
// entering it. `approved: false` is the whole point: the bot can be added to any
// chat by anyone, so a chat it has never been authorized for starts blocked.
function discoveredGroupDefaults(chatId: string, title: string | undefined, now: string) {
  return {
    chatId,
    title: title || `Chat ${chatId}`,
    status: "Active",
    manualInactive: false,
    approved: false,
    // A discovered group captures inventory until an admin says otherwise. It is
    // the older and more destructive of the two flows, so making it the default
    // is a deliberate choice to fail towards the behaviour an admin already
    // knows rather than towards a silent new one.
    mode: "entry" as GroupMode,
    source: "telegram",
    createdAt: now,
  };
}

// May this chat drive the bot, and which flow does it run? Checked before
// anything else the webhook does for a group, so an unapproved chat never enrols
// anyone, opens an entry or raises a request.
//
// Both answers come from one document, so they are read together — the mode
// costs nothing on top of the gate that was already here.
//
// Cached like the other read-mostly admin data: it is read on every single
// update and only changes when someone approves, force-inactivates, re-modes or
// deletes a group — all of which run through the console's write path and
// invalidate it.
export async function groupConfig(db: Db, chatId: string): Promise<{ allowed: boolean; mode: GroupMode }> {
  return cached(`telegramGroups:config:${chatId}`, async () => {
    const g = await db
      .collection("telegramGroups")
      .findOne({ chatId }, { projection: { approved: 1, manualInactive: 1, status: 1, mode: 1 } });
    // Never seen before: not approved, by definition.
    if (!g) return { allowed: false, mode: "entry" as GroupMode };
    // Health is deliberately not consulted here. An update arriving IS the bot
    // being reachable, so a stale "unhealthy" probe must not lock a live group
    // out of its own entries.
    const allowed = isApproved(g as { approved?: boolean }) && !g.manualInactive && g.status !== "Inactive";
    return { allowed, mode: groupMode(g as { mode?: string }) };
  });
}

// How long a blocked group waits between "an admin has to approve this" replies.
// Without it every message in an unapproved chat would draw one.
const BLOCKED_NOTICE_MS = 60 * 60 * 1000;

// Record an update from a group the bot is not allowed to serve. The group is
// upserted so it shows up in the console as pending — an admin cannot approve a
// chat they cannot see — and the caller is told whether to say so in the chat.
export async function noteBlockedGroup(db: Db, chatId: string, title?: string): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const before = await db.collection("telegramGroups").findOneAndUpdate(
      { chatId },
      {
        $set: { lastSeenAt: now, blockedNoticeAt: now },
        $setOnInsert: { ...discoveredGroupDefaults(chatId, title, now), botHealth: "unknown" },
      },
      { returnDocument: "before", upsert: true, projection: { _id: 1, title: 1, blockedNoticeAt: 1 } }
    );
    const last = before?.blockedNoticeAt ? Date.parse(String(before.blockedNoticeAt)) : 0;
    const notify = !before || Date.now() - last > BLOCKED_NOTICE_MS;
    if (notify) {
      await logTelegram(db, {
        groupId: before?._id?.toString() ?? null,
        chatId,
        title: (before?.title as string) ?? title ?? null,
        type: "error",
        level: "error",
        message: before
          ? "Update refused — this group is not approved for the bot."
          : "New group discovered. Blocked until an admin approves it.",
      }).catch(() => {});
    }
    return notify;
  } catch {
    // Monitoring must never decide whether an update is served. The gate has
    // already said no; failing to write the log does not change that.
    return false;
  }
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

// Register a group the bot is in but the console has never seen. Called when the
// bot is added to a chat and on the first update from any unregistered one, so a
// group that is live in Telegram is never invisible in the console. Only fills
// in what is missing — an admin's approval, title edit or manual override is
// left alone.
export async function registerGroup(db: Db, chatId: string, title?: string) {
  const now = new Date().toISOString();
  await db.collection("telegramGroups").updateOne(
    { chatId },
    {
      $set: { lastSeenAt: now, botHealth: "healthy", lastError: null },
      $setOnInsert: discoveredGroupDefaults(chatId, title, now),
    },
    { upsert: true }
  );
}

// Called from the webhook on every authorized update. Marks the group as seen
// (which also flips a previously-unhealthy group back to healthy) and records a
// command/update log line. Best-effort: never throws into the webhook path.
export async function recordGroupActivity(
  db: Db,
  chatId: string,
  info: { isCommand: boolean; text?: string; actor: string; title?: string }
) {
  try {
    const now = new Date().toISOString();
    // One round trip instead of a read followed by a write. `returnDocument:
    // "before"` still gives us the title/id needed for the log line.
    //
    // Upserted rather than updated: with anyone in an approved group able to
    // make an entry, the first sign of a group is usually someone using it, and
    // a group nobody registered by hand would otherwise log activity against
    // nothing and never appear in the console. Reaching here means the gate
    // already allowed the chat, so the insert branch is only for a group whose
    // row was deleted out from under a live approval.
    const group = await db.collection("telegramGroups").findOneAndUpdate(
      { chatId },
      {
        $set: { lastSeenAt: now, botHealth: "healthy", lastError: null },
        $setOnInsert: discoveredGroupDefaults(chatId, info.title, now),
      },
      { returnDocument: "before", upsert: true, projection: { _id: 1, title: 1 } }
    );
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

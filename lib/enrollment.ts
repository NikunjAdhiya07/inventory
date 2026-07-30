import type { Db, Document } from "mongodb";
import { invalidateCollection } from "./cache";
import { defer } from "./defer";
import { logAudit } from "./audit";
import { isDuplicateKeyError } from "./mongodb";
import { logTelegram } from "./telegram-health";

// Self-enrolment for Telegram group members.
//
// The bot used to answer anyone without a `users` row with "⛔ You are not
// authorized to add inventory", which meant every new person in the group had to
// be added by hand in the console — with their numeric Telegram id — before they
// could log anything. Being in the group is now the credential: the first time
// someone speaks, they get a user record with the member role and their message
// is handled in the same update, so there is no "try again now" step.
//
// Three limits keep that from being a way in for strangers:
//   * groups only — a private chat with the bot enrols nobody, so finding the
//     bot's username is not enough to write into the inventory;
//   * least privilege — the member role grants "Add Inventory" and nothing else;
//   * deactivation still wins — a user an admin set to Inactive stays blocked,
//     because that row already exists and is never re-created.

export const MEMBER_ROLE = process.env.TELEGRAM_MEMBER_ROLE || "Group Member";

// Set TELEGRAM_AUTO_ENROLL=off to go back to admin-only access.
export const AUTO_ENROLL_ENABLED = (process.env.TELEGRAM_AUTO_ENROLL || "on").toLowerCase() !== "off";

export type TelegramUser = {
  id: number | string;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export function isGroupChat(chatType?: string): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export function displayName(from: TelegramUser): string {
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return full || from.username || `Telegram ${from.id}`;
}

// Create the member role if it is missing. `$setOnInsert` so an admin who edits
// its permissions later keeps their edit — this only ever fills in a gap.
async function ensureMemberRole(db: Db) {
  const res = await db.collection("roles").updateOne(
    { name: MEMBER_ROLE },
    {
      $setOnInsert: {
        name: MEMBER_ROLE,
        desc: "Anyone who joins a connected Telegram group. Can add inventory, nothing else.",
        color: "#0ea5e9",
        perms: ["Add Inventory"],
        status: "Active",
      },
    },
    { upsert: true }
  );
  // A lookup that ran before the role existed cached an empty permission list
  // under this name; the very next update would then reject the person we just
  // enrolled.
  if (res.upsertedCount) invalidateCollection("roles");
}

// Enrol one Telegram user and return their user document — the same shape the
// webhook's authorize step works with. Returns null for bots and for anyone who
// cannot be enrolled.
export async function enrollTelegramUser(db: Db, from: TelegramUser, chatId: string): Promise<Document | null> {
  if (from.is_bot) return null;
  const tgId = String(from.id);
  const name = displayName(from);
  const now = new Date().toISOString();

  await ensureMemberRole(db);

  const doc = {
    username: name,
    handle: from.username ? `@${from.username}` : "",
    tgId,
    role: MEMBER_ROLE,
    status: "Active" as const,
    // Distinguishes a self-enrolled member from one an admin added, both in the
    // console and for anyone auditing who can write to the inventory.
    source: "telegram-group",
    enrolledAt: now,
    enrolledFromChatId: chatId,
  };

  try {
    const res = await db.collection("users").insertOne(doc);
    defer(async () => {
      await logAudit(
        {
          action: "Created",
          dataType: "User",
          entity: name,
          field: "Auto-enrolled from Telegram",
          before: "—",
          after: `${name} (${MEMBER_ROLE})`,
          beforeFields: [["User", "—"]],
          afterFields: [
            ["User", name],
            ["Telegram ID", tgId],
            ["Role", MEMBER_ROLE],
            ["Enrolled from chat", chatId],
          ],
        },
        name
      );
      await logTelegram(db, {
        chatId,
        type: "update",
        message: `${name} joined the bot — enrolled as ${MEMBER_ROLE}.`,
      });
    });
    return { _id: res.insertedId, ...doc };
  } catch (err) {
    // Two messages from the same new person at once, or a member who was
    // enrolled by the join event a moment earlier: the unique index on tgId
    // decides, and the row it kept is the right one to use.
    if (isDuplicateKeyError(err)) return db.collection("users").findOne({ tgId });
    throw err;
  }
}

import { getDb } from "./mongodb";

const CURRENT_USER = "Asha Sharma";

export type AuditAction = "Created" | "Edited" | "Deleted";

export async function logAudit(
  entry: {
    action: AuditAction;
    dataType: string;
    entity: string;
    field: string;
    before: string;
    after: string;
    beforeFields: [string, string][];
    afterFields: [string, string][];
  },
  // Bot-originated writes pass the resolved Telegram user so the audit trail
  // attributes them correctly; console writes omit it and keep the default.
  actorName?: string
) {
  const db = await getDb();
  await db.collection("auditLog").insertOne({
    ts: new Date().toISOString(),
    user: actorName || CURRENT_USER,
    ip: actorName ? "telegram" : "10.2.14.7",
    device: actorName ? "Telegram Bot" : "Chrome · Windows",
    session: actorName ? "s_bot" : "s_local",
    ...entry,
  });
}

export { CURRENT_USER };

// Grant the request-flow permissions to the roles that need them.
//
// `npm run seed` cannot do this: it skips any collection that already has
// documents, so on a live installation it never touches `roles` and the three
// new permissions would silently never arrive.
//
// Purely additive and idempotent — it only ever adds permissions and creates
// missing roles. It never removes a permission, never edits one an admin has
// changed, and re-running it is a no-op.
//
//   node scripts/migrate-request-roles.mjs          # report what would change
//   node scripts/migrate-request-roles.mjs --write  # apply it

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";

// .env.local is Next's convention and is not loaded by dotenv/config.
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env.local — rely on the ambient environment
}

const WRITE = process.argv.includes("--write");

// Which existing roles gain which permissions.
//
// The split is deliberate: asking for an item, handing one over, and approving
// money are three different jobs. Admin gets all three because an Admin who
// cannot unblock a stuck ticket is not an administrator.
const GRANTS = {
  Admin: ["Request Items", "Issue Inventory", "Approve Purchase"],
  "Inventory Manager": ["Request Items", "Issue Inventory"],
  Viewer: [],
  "Workflow Designer": [],
};

// Roles the flow needs that may not exist yet.
const NEW_ROLES = [
  {
    name: "Purchase Officer",
    desc: "Approves purchase requests for items not held in stock",
    color: "#db2777",
    perms: ["Approve Purchase", "View Reports", "Request Items"],
    status: "Active",
    users: 0,
  },
  {
    // The bot creates this itself on first enrolment (lib/enrollment.ts), but
    // creating it here means an admin can see and edit it in the console before
    // the first person ever speaks in the group.
    name: process.env.TELEGRAM_MEMBER_ROLE || "Group Member",
    desc: "Anyone who joins a connected Telegram group. Can add inventory and raise requests, nothing else.",
    color: "#0ea5e9",
    perms: ["Add Inventory", "Request Items"],
    status: "Active",
    users: 0,
  },
];

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGODB_DB || "inventory");
const roles = db.collection("roles");

let changes = 0;

for (const [name, perms] of Object.entries(GRANTS)) {
  if (!perms.length) continue;
  const role = await roles.findOne({ name });
  if (!role) {
    console.log(`–  ${name}: not present, skipped`);
    continue;
  }
  const missing = perms.filter((p) => !(role.perms ?? []).includes(p));
  if (!missing.length) {
    console.log(`✔  ${name}: already has ${perms.join(", ")}`);
    continue;
  }
  console.log(`${WRITE ? "+ " : "→ "} ${name}: add ${missing.join(", ")}`);
  changes++;
  // $addToSet, not $set: an admin may have added or removed other permissions
  // since, and this migration has no business overwriting that.
  if (WRITE) await roles.updateOne({ _id: role._id }, { $addToSet: { perms: { $each: missing } } });
}

for (const role of NEW_ROLES) {
  const existing = await roles.findOne({ name: role.name });
  if (existing) {
    const missing = role.perms.filter((p) => !(existing.perms ?? []).includes(p));
    if (!missing.length) {
      console.log(`✔  ${role.name}: already present`);
      continue;
    }
    console.log(`${WRITE ? "+ " : "→ "} ${role.name}: add ${missing.join(", ")}`);
    changes++;
    if (WRITE) await roles.updateOne({ _id: existing._id }, { $addToSet: { perms: { $each: missing } } });
    continue;
  }
  console.log(`${WRITE ? "+ " : "→ "} ${role.name}: create with ${role.perms.join(", ")}`);
  changes++;
  if (WRITE) await roles.insertOne(role);
}

console.log(`\n${changes} change(s) ${WRITE ? "applied" : "pending"}.`);
if (!WRITE && changes) console.log("Re-run with --write to apply.");

if (WRITE) {
  console.log("\nRoles now:");
  for (const r of await roles.find({}).sort({ name: 1 }).toArray()) {
    console.log(`  ${r.name.padEnd(20)} ${(r.perms ?? []).join(", ")}`);
  }
  console.log(
    "\nNote: the running app caches roles for ~30s (lib/cache.ts), so a permission\n" +
      "granted here takes effect on the bot within half a minute."
  );
}

await client.close();

// Seeds the two masters the search bot's Borrow flow reads, plus the Borrow
// row in Movement Master.
//
//   • maintenanceUsers — whose account a borrowing sits under
//   • workers          — offered when a maintenance user picks "Other"
//
// The app seeds these itself the first time it finds either collection empty,
// so this script is for topping up an install where somebody emptied one, or
// for putting the rows in before anyone opens the bot.
//
// Synced by `code` with $setOnInsert, so a rename or a row set to Inactive in
// the console survives a re-run — only missing people are added.
//
//   node scripts/seed-borrow-masters.mjs   (or: npm run seed:borrow-masters)
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

const maintenanceUsers = [
  { code: "vijay", name: "Vijay", order: 10 },
  { code: "nilesh-chauhan", name: "Nilesh Chauhan", order: 20 },
  { code: "devang", name: "Devang", order: 30 },
  { code: "vishal", name: "Vishal", order: 40 },
];

// "Nilesh" is a worker and "Nilesh Chauhan" is a maintenance user — two rows,
// two people. Do not merge them.
const workers = [
  { code: "babu", name: "Babu", order: 10 },
  { code: "hardip", name: "Hardip", order: 20 },
  { code: "aakash", name: "Aakash", order: 30 },
  { code: "mahesh-chauhan", name: "Mahesh Chauhan", order: 40 },
  { code: "nilesh", name: "Nilesh", order: 50 },
  { code: "rahul", name: "Rahul", order: 60 },
  { code: "jayesh", name: "Jayesh", order: 70 },
  { code: "mahesh-madhar", name: "Mahesh Madhar", order: 80 },
];

async function syncMaster(db, collection, rows) {
  let added = 0;
  for (const r of rows) {
    const now = new Date().toISOString();
    const res = await db.collection(collection).updateOne(
      { code: r.code },
      {
        $setOnInsert: { code: r.code, name: r.name, order: r.order, status: "Active", createdAt: now },
        $set: { updatedAt: now },
      },
      { upsert: true }
    );
    if (res.upsertedCount) added++;
  }
  const total = await db.collection(collection).countDocuments();
  console.log(`${collection}: ${rows.length} synced (${added} new), ${total} in total`);
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  await syncMaster(db, "maintenanceUsers", maintenanceUsers);
  await syncMaster(db, "workers", workers);

  const now = new Date().toISOString();
  const res = await db.collection("movementTypes").updateOne(
    { code: "borrow" },
    {
      $setOnInsert: {
        code: "borrow",
        name: "Borrow",
        direction: "out",
        desc: "Material borrowed by a maintenance user (for themselves or for one of their workers). Stock is deducted the moment the borrowing is confirmed.",
        requireRemarks: false,
        requireReference: false,
        allowNegative: false,
        questions: [],
        order: 39,
        status: "Active",
        createdAt: now,
        updatedAt: now,
      },
      $set: { isSystem: false },
    },
    { upsert: true }
  );
  console.log(`movementTypes: borrow ${res.upsertedCount ? "added" : "already present"}`);

  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

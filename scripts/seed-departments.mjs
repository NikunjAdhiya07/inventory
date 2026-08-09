// Seeds demo Department Master rows for Department Return / Issue.
//
//   node scripts/seed-departments.mjs   (or: npm run seed:departments)
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

const departments = [
  { code: "PROD", name: "Production", contact: "Floor Supervisor", order: 10 },
  { code: "MAINT", name: "Maintenance", contact: "Maintenance Lead", order: 20 },
  { code: "ELEC", name: "Electrical", contact: "Electrical Lead", order: 30 },
  { code: "QA", name: "Quality", contact: "QA Manager", order: 40 },
  { code: "STORE", name: "Stores", contact: "Store Keeper", order: 50 },
  { code: "PACK", name: "Packaging", contact: "Packaging Lead", order: 60 },
];

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  let added = 0;
  for (const d of departments) {
    const now = new Date().toISOString();
    const doc = {
      code: d.code,
      name: d.name,
      contact: d.contact,
      phone: "",
      email: "",
      notes: "",
      order: d.order,
      status: "Active",
    };
    const res = await db.collection("departments").updateOne(
      { code: d.code },
      {
        $setOnInsert: { ...doc, createdAt: now },
        $set: { updatedAt: now },
      },
      { upsert: true }
    );
    if (res.upsertedCount) added++;
  }

  const total = await db.collection("departments").countDocuments();
  console.log(`departments: ${departments.length} synced (${added} new), ${total} in total`);
  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

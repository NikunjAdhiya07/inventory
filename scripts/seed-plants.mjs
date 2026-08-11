// Seeds demo Plant Master rows for Return from Plant / Issue to Plant.
//
//   node scripts/seed-plants.mjs   (or: npm run seed:plants)
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

const plants = [
  { code: "AP-PLT", name: "Asian Paints Plant", contact: "Plant Store", order: 10 },
  { code: "AMD-PLT", name: "Ahmedabad Plant", contact: "Plant Store", order: 20 },
  { code: "MUM-PLT", name: "Mumbai Plant", contact: "Plant Store", order: 30 },
];

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  let added = 0;
  for (const p of plants) {
    const now = new Date().toISOString();
    const res = await db.collection("plants").updateOne(
      { code: p.code },
      {
        $setOnInsert: {
          code: p.code,
          name: p.name,
          phone: "",
          email: "",
          notes: "",
          createdAt: now,
        },
        $set: {
          updatedAt: now,
          contact: p.contact,
          order: p.order,
          status: "Active",
        },
      },
      { upsert: true }
    );
    if (res.upsertedCount) added++;
  }

  const total = await db.collection("plants").countDocuments();
  console.log(`plants: ${plants.length} synced (${added} new), ${total} in total`);
  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

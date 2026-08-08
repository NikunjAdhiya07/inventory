// Seeds demo Vendor Master rows for search-group Vendor Replacement.
//
//   node scripts/seed-vendors.mjs   (or: npm run seed:vendors)
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

const vendors = [
  {
    code: "ABC",
    name: "ABC Vendor",
    contact: "Ravi Mehta",
    phone: "+91 98765 43210",
    email: "sales@abc-vendor.example",
    notes: "Primary PVC / UPVC supplier",
    order: 10,
  },
  {
    code: "PPL",
    name: "Precision Pipes Ltd",
    contact: "Anita Shah",
    phone: "+91 98200 11122",
    email: "orders@precisionpipes.example",
    notes: "MS and GI pipe manufacturer",
    order: 20,
  },
  {
    code: "MPS",
    name: "Metro Plumbing Supply",
    contact: "Imran Khan",
    phone: "+91 99887 76655",
    email: "desk@metroplumbing.example",
    notes: "Local wholesale plumbing",
    order: 30,
  },
  {
    code: "SFT",
    name: "SafeFit Industrial",
    contact: "Priya Nair",
    phone: "+91 97654 32100",
    email: "support@safefit.example",
    notes: "Fittings and valves",
    order: 40,
  },
  {
    code: "ORC",
    name: "Orbit Conduit Co",
    contact: "Suresh Patil",
    phone: "+91 90123 45678",
    email: "hello@orbitconduit.example",
    notes: "Electrical conduit",
    order: 50,
  },
  {
    code: "H2O",
    name: "HydroFlow Traders",
    contact: "Meena Joshi",
    phone: "+91 88990 11223",
    email: "trade@hydroflow.example",
    notes: "Pressure pipe & accessories",
    order: 60,
  },
];

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  let added = 0;
  for (const v of vendors) {
    const now = new Date().toISOString();
    const doc = {
      code: v.code,
      name: v.name,
      contact: v.contact,
      phone: v.phone,
      email: v.email,
      notes: v.notes,
      order: v.order,
      status: "Active",
    };
    const res = await db.collection("vendors").updateOne(
      { code: v.code },
      {
        $setOnInsert: { ...doc, createdAt: now },
        $set: { updatedAt: now },
      },
      { upsert: true }
    );
    if (res.upsertedCount) added++;
  }

  const total = await db.collection("vendors").countDocuments();
  console.log(`vendors: ${vendors.length} synced (${added} new), ${total} in total`);
  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

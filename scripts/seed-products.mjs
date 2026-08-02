// Seeds the Product Master:
//   productAttributes — the reusable attribute definitions (Size, Grade, …)
//   products          — a few representative products, deliberately uneven:
//                       one with Grade + Size, one with Colour + Finish, one
//                       with no attributes at all, because that is the shape
//                       real product data has.
//
// Idempotent: only seeds a collection if it is currently empty. Safe to re-run.
// Run with: node scripts/seed-products.mjs   (or: npm run seed:products)
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";
const now = new Date().toISOString();

const productAttributes = [
  { name: "Size", inputType: "text", options: [], unit: "mm", desc: "Nominal size or dimension.", order: 1, status: "Active" },
  { name: "Grade", inputType: "select", options: ["A", "B", "C", "IS 2062", "SS 304", "SS 316"], unit: "", desc: "Material grade or specification.", order: 2, status: "Active" },
  { name: "Colour", inputType: "text", options: [], unit: "", desc: "Finish colour, where it identifies the product.", order: 3, status: "Active" },
  { name: "Material", inputType: "select", options: ["Mild Steel", "Stainless Steel", "Aluminium", "PVC", "Brass"], unit: "", desc: "What the product is made of.", order: 4, status: "Active" },
  { name: "Thickness", inputType: "number", options: [], unit: "mm", desc: "Wall or sheet thickness.", order: 5, status: "Active" },
  { name: "Finish", inputType: "select", options: ["Matte", "Glossy", "Galvanised", "Powder Coated"], unit: "", desc: "Surface finish.", order: 6, status: "Active" },
  { name: "Brand", inputType: "text", options: [], unit: "", desc: "Manufacturer or brand name.", order: 7, status: "Active" },
];

// `productNumberKey` mirrors lib/products.ts — it is what the unique index is
// built on, so the seed has to set it the same way the API does.
function product(name, productNumber, extra) {
  return {
    name,
    productNumber,
    productNumberKey: productNumber.replace(/\s+/g, "").toUpperCase(),
    category: "",
    subcategory: "",
    unit: "",
    desc: "",
    attributes: [],
    status: "Active",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

const products = [
  product("MS Round Pipe", "MSP-1024", {
    unit: "Meter",
    attributes: [
      { name: "Size", value: "50 mm" },
      { name: "Grade", value: "IS 2062" },
      { name: "Thickness", value: "3.2" },
    ],
  }),
  product("Enamel Paint", "PNT-2210", {
    unit: "Litre",
    attributes: [
      { name: "Colour", value: "Signal Red" },
      { name: "Finish", value: "Glossy" },
      { name: "Brand", value: "Asian Paints" },
    ],
  }),
  product("SS Hex Bolt", "SSB-4408", {
    unit: "Piece",
    attributes: [
      { name: "Size", value: "M12 x 50" },
      { name: "Grade", value: "SS 304" },
      { name: "Material", value: "Stainless Steel" },
    ],
  }),
  // Deliberately attribute-free: not every product needs them.
  product("Cotton Waste Cloth", "CWC-0091", { unit: "Kilogram" }),
];

async function seedEmpty(db, collection, docs) {
  const count = await db.collection(collection).countDocuments();
  if (count > 0) {
    console.log(`skip ${collection} (already has ${count} docs)`);
    return;
  }
  if (docs.length) await db.collection(collection).insertMany(docs);
  console.log(`seeded ${collection}: ${docs.length} docs`);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

await seedEmpty(db, "productAttributes", productAttributes);
await seedEmpty(db, "products", products);

await client.close();
console.log("done");

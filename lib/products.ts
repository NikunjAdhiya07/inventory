// Shared shapes + normalisation for the Product Master.
//
// Products are deliberately half-fixed, half-open. The fields every product has
// regardless of what it is (name, number, category, default unit) are columns;
// everything that varies by product type — Size, Grade, Colour, Thickness, or a
// one-off attribute that applies to exactly one product — lives in `attributes`
// as name/value pairs. A steel pipe carries Grade and Size, a paint tin carries
// Colour and Finish, a consumable carries neither, and none of them need a
// schema change or a column full of blanks.
//
// `productAttributes` is the companion master: it defines the reusable
// attributes (their input type and allowed values) so that "Grade" means the
// same thing on every product and the bot can offer real choices instead of
// free text. A product may still carry an ad-hoc attribute that exists in no
// definition — the definitions guide data entry, they don't gate it.

export type ProductAttributeType = "text" | "number" | "select";

// One reusable attribute definition (the `productAttributes` collection).
export type ProductAttributeDef = {
  id: string;
  name: string;
  inputType: ProductAttributeType;
  options: string[]; // allowed values, `select` only
  unit: string; // display suffix, e.g. "mm" — never part of the stored value
  desc: string;
  order: number;
  status: "Active" | "Inactive";
};

// One attribute as carried BY a product. Values are stored as text: they are
// descriptive facts shown to a user, not quantities to compute with, and keeping
// one type means the bot, the console table and the audit trail all render the
// same string.
export type ProductAttribute = { name: string; value: string };

// One answered identity level of a nested drill-down, in the order it was asked.
// "Type of Wire: Copper", then "Subcategory: Flexible (FR)", then "Size: 2.5 sq
// mm" — the labels come from the tree's levels, so they stay meaningful next to
// a value that would be ambiguous alone.
export type VariantPathSegment = { label: string; value: string };

export type Product = {
  id: string;
  name: string;
  productNumber: string;
  category: string;
  subcategory: string;
  unit: string;
  desc: string;
  attributes: ProductAttribute[];
  status: "Active" | "Inactive";
  // Set only on a product that a nested drill-down resolved to. A product typed
  // straight into the console carries none of these and is unaffected by any of
  // it — variants are an additional way to arrive at a product row, not a
  // different kind of row. See `lib/variants.ts`.
  //
  // `pathKey` is the normalised join of `treePath`'s values and is what the
  // unique index is built on, exactly as `productNumberKey` is for the visible
  // number: it must never be set independently of the path it summarises.
  treeId?: string;
  treeName?: string;
  treePath?: VariantPathSegment[];
  pathKey?: string;
  createdAt: string;
  updatedAt: string;
};

// A product with 25 attributes is a data-modelling mistake, not a product, and
// the bot has to be able to render them inside one Telegram message.
export const MAX_ATTRIBUTES = 25;
const MAX_ATTR_NAME = 40;
const MAX_ATTR_VALUE = 120;

export function trimmed(v: unknown, max = 200): string {
  return typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, max) : "";
}

// Case- and spacing-insensitive form of a product number, stored alongside it as
// `productNumberKey`. "pn 1024" and "PN-1024" differ only in how someone typed
// them, so the unique index is built on this rather than on the raw value.
export function productNumberKey(productNumber: string): string {
  return productNumber.replace(/\s+/g, "").toUpperCase();
}

// Coerce whatever the client sent into a clean attribute list: drop entries with
// no name or no value (that is how the UI represents "this product doesn't have
// this attribute"), collapse duplicate names keeping the first, and cap the
// length. Never throws — a bad shape yields an empty list rather than a 500.
export function normalizeAttributes(input: unknown): ProductAttribute[] {
  if (!Array.isArray(input)) return [];
  const out: ProductAttribute[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const { name, value } = raw as Record<string, unknown>;
    const n = trimmed(name, MAX_ATTR_NAME);
    const v = trimmed(value, MAX_ATTR_VALUE);
    if (!n || !v) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: n, value: v });
    if (out.length >= MAX_ATTRIBUTES) break;
  }
  return out;
}

// "12 mm · Grade A" — the attribute values only, for a compact secondary line
// under a product name in a list or an inline button.
export function attributeValues(attributes: ProductAttribute[], limit = 3): string {
  return attributes.slice(0, limit).map((a) => a.value).join(" · ");
}

// "Size: 12 mm\nGrade: A" — the full labelled list, for the bot's confirmation
// and the entry summary.
export function attributeLines(attributes: ProductAttribute[]): string {
  return attributes.map((a) => `${a.name}: ${a.value}`).join("\n");
}

// How a product is named everywhere it is referred to as a whole: in the bot's
// summary, in the audit trail, on a generated ticket.
export function productLabel(p: Record<string, unknown>): string {
  const name = trimmed(p.name);
  const number = trimmed(p.productNumber);
  if (name && number) return `${name} (${number})`;
  return name || number || "(unnamed product)";
}

// Free-text match used by both the console search box and the bot's product
// search: name, number and every attribute value are all searchable, because
// "12mm" is how a user thinks of the product they want.
export function productMatches(
  p: {
    name?: unknown;
    productNumber?: unknown;
    category?: unknown;
    attributes?: ProductAttribute[];
    treePath?: VariantPathSegment[];
  },
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    trimmed(p.name),
    trimmed(p.productNumber),
    trimmed(p.category),
    ...(Array.isArray(p.attributes) ? p.attributes.map((a) => `${a.name} ${a.value}`) : []),
    // A variant is most naturally searched by the answers that define it —
    // "copper 2.5" has to find the wire it names.
    ...(Array.isArray(p.treePath) ? p.treePath.map((s) => `${s.label} ${s.value}`) : []),
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

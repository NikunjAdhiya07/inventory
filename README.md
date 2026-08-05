This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Product Master

Products are half-fixed, half-open. Name, product number, category, subcategory
and default unit are columns; everything that varies by product type — Size,
Grade, Colour, Thickness, or something one product alone needs — lives in
`attributes` as name/value pairs. A product with no attributes at all is normal
and valid.

- **`productAttributes`** (`/product-attributes`) defines the reusable attributes:
  input type, allowed values, display unit. It guides data entry; it does not
  gate it, so a product can still carry an ad-hoc attribute defined nowhere.
- **`products`** (`/products`) holds the products. The product number is unique
  case- and space-insensitively — the unique index is built on `productNumberKey`
  (`lib/products.ts`), which the API maintains in lockstep with the visible
  number. Never write one without the other.
- **In the bot**, the `product_select` step lists the catalogue, pages through it,
  and takes a typed message as a search over name, number and attribute values.
  Choosing a product copies a **snapshot** of it onto the entry, so editing a
  product later never rewrites the tickets already raised against it. A product
  also fills in the category, subcategory and unit that the workflow never
  asked for.
- Seed both with `npm run seed:products`. New step types reach an existing
  install via `npm run seed:workflows`, which syncs `stepLibrary` by `type`
  rather than only seeding an empty collection.

## Stock movements

On-hand is never stored as a number (see the ledger note in `lib/stock.ts`): it
is summed from movement rows, so **every balance is explained by its own
history**. What the movement module adds is the other half of that — a way to
record any movement by hand, and a configurable vocabulary of what a movement
can be.

**Stock Movements** (`/stock-movements`) is the screen: find the item, see what
is on hand and where, pick what happened, enter a quantity, add a reference or
remarks, submit. The confirmation quotes the resulting balance rather than just
saying "saved", because the number is the thing the storekeeper can check
against the shelf. Movement history sits under the form, filterable to the item
in hand or the whole ledger.

**Movement Types** (`/movement-types`) is the vocabulary. A movement's `reason`
is the *code* of a row in `movementTypes`, so an organisation adds "Scrap to
Vendor" in the console and it is immediately recordable, reportable and
history-visible — no deploy. Each type carries the rules its own capture needs:

- **`direction`** decides the sign and what the form asks for. `in` adds at one
  location, `out` removes from one, `transfer` writes a matched pair that sums
  to zero — so a transfer can never change how much of something exists.
- **`requireRemarks` / `requireReference`** are the per-type mandatory fields.
  Damaged/Lost is meaningless without a note; a purchase is meaningless without
  an invoice number.
- **`allowNegative`** is the explicit permission to take out more than is on
  hand. Off by default: stock-out is refused against a *live* balance, never the
  5-second-cached one, because that check decides whether goods may leave.

Twenty types ship seeded across Stock In, Stock Out and Stock Transfer
(`npm run seed:movement-types`, synced by code so an existing install picks up
new ones without losing local edits). Alongside them are the **system types** —
`receipt`, `issue`, `return`, `transfer`, `adjustment` — which are what the entry
bot, the request bot and the storage map already write. Seeding them means old
rows are named like any other movement; marking them `isSystem` keeps them off
the manual form, because recording one by hand would claim a ticket happened
that didn't.

Two rules protect history: a type's **code never changes** (every recorded
movement references it), and a type with movements behind it is **retired by
deactivating**, not deleted. Direction is likewise fixed once a type has been
used — flipping it would make past movements read as the opposite of what they
did.

`scripts/verify-stock-movements.mjs` drives the whole module over HTTP and
re-derives every balance from the ledger; it covers each acceptance criterion
and each row of the story's test-case table.

*Not built yet:* per-type approval workflows, notifications and business rules.
The type document is where they attach when that lands — the workflow builder
and its approval step already exist for the bot side.

## Nested categories

Some items are not described by one answer. "Wire" is a type, a subcategory, a
colour and a size before it is a quantity — and asking for all of that in one
message gets one line of free text nobody can report on. A **nested category
tree** (`/option-trees`) turns it into one short question at a time:

```
Item: Wire
  Type of Wire            → Copper · Aluminium · Fibre Optic
  Subcategory of the Wire → Flexible (FR) · House Wire · Armoured   (under Copper)
  Colour                  → Red · Black · Blue · …
  Size                    → 1.0 · 1.5 · 2.5 sq mm   (under Flexible (FR))
Quantity: 25
Where it will be used: Block B second floor rewiring
```

The structure is configuration, not code, so the same machinery serves pipe,
cement or anything else. Two things define a tree, and they are deliberately
separate:

- **Levels are the questions**, in the order they are asked. A level reads its
  options from the tree (`nodes`), offers a **fixed list**, or takes **typed
  text** or a **number** on the keypad. Only `nodes` levels drill deeper, which
  is why Colour can be one list instead of being repeated under every
  subcategory — and why the Size level below it still finds the sizes belonging
  to the subcategory the user picked. `Allow a typed answer too` accepts the
  value nobody thought to add, without letting it fork the tree.
- **Options are the answers** to the node levels: a parent/child forest in
  `optionNodes`, exactly like storage locations. Copper → Flexible (FR) → 2.5 sq
  mm is three rows, not a row per combination.

**In a workflow**, add the *Nested Category Drill-down* step. Leave its tree
blank and it resolves the tree from the item the user already named — matching
the tree's name or any of its alternate spellings, best match wins — so **one
workflow serves every item**: wire gets the wire questions, cement gets its own,
and an item with no tree behind it walks straight past the step. `When no tree
matches` decides whether an unmatched item is skipped or asked about; a step
with nothing to ask is stepped over in both directions, so Back never parks the
user on it. Naming a tree explicitly instead pins the step to that one drill-down.

Each level lands on the ticket as **its own field** — `Colour: Red`, not one
opaque `Copper › Flexible (FR) › Red › 2.5 sq mm` — so the answers stay
reportable. Back inside the step undoes one level at a time before it leaves.

Seed a worked example (the Wire and Pipe trees plus a *Wire Entry (Nested)*
workflow) with `npm run seed:option-trees`; new step types reach an existing
install through `npm run seed:workflows`. `scripts/verify-nested-bot.mjs` drives
the whole drill-down against a running server the way Telegram would — see the
header of `scripts/verify-bot.mjs` for the throwaway-database setup both share.

## Who can use the bot

Being in an **approved** group is the credential. Someone the console has never
seen is enrolled the first time they speak there, and that same message starts
their entry — there is no "ask an admin to add your Telegram id" step
(`lib/enrollment.ts`).

Four things bound that:

- **Approved groups only.** Anyone can add the bot to a chat, so which chats it
  serves is an admin's decision. A group the bot is added to appears in Telegram
  Groups marked *Pending approval* and every update from it is refused — nobody
  enrolled, no entry started, no workflow resolved — until someone hits Approve.
  Groups that predate this gate stay approved; only ones the bot discovers itself
  start pending. *Force inactive* on an approved group has the same effect.
- **Groups only.** A private chat with the bot enrols nobody, so knowing the
  bot's username is not a way into the inventory.
- **Least privilege.** Enrolled members get the `Group Member` role, which grants
  `Add Inventory` and nothing else. Edit that role in Roles & Permissions to
  change what every member can do; the bot creates it if it is missing but never
  overwrites your edits.
- **Deactivation wins.** Setting a user to Inactive in User Assignments blocks
  them for good — enrolment only ever creates a record that does not exist yet.

Set `TELEGRAM_AUTO_ENROLL=off` for admin-only access, or `TELEGRAM_MEMBER_ROLE`
to enrol into a different role. Self-enrolled users are marked
`source: "telegram-group"` and each enrolment is in the audit log.

Joins, leaves, pins and title changes are chat events, not entries: a join
enrols the people who arrived, everything else is dropped. Groups the console has
never seen register themselves on first activity — pending, so they are visible
to approve without being usable.

### The one setting that is not in this repo

Telegram's **privacy mode** decides whether a bot receives ordinary group
messages at all. With it ON (the default) the bot only sees commands, replies to
itself and @mentions — plain `MS Pipe` messages never arrive and the bot looks
broken while being perfectly healthy. It cannot be changed over the API:

> BotFather → `/setprivacy` → **Disable**, then remove and re-add the bot to each
> group so the change takes effect.

`node scripts/set-webhook.mjs info` reports the current state in plain English.

## Ticket numbers

Every completed entry gets one: `INV-202607-0042` — prefix, period, then a
sequence that restarts monthly (`lib/ticket.ts`, visible at `/tickets`).

- The sequence comes from an atomic `$inc` on a `counters` document, so
  concurrent instances cannot be issued the same number. Do not replace it with
  a count of existing entries.
- `TICKET_PREFIX` changes the prefix. `TICKET_UTC_OFFSET_MINUTES` (330 for IST)
  aligns the monthly boundary with the working day; unset means UTC.
- **One entry per session, enforced by Mongo.** Entries carry `sessionId` under a
  unique index and the session is claimed with a conditional update before the
  write, so a double-tapped Confirm or a redelivered Telegram update produces one
  ticket and shows it twice rather than two tickets. Both indexes come from
  `npm run ensure-indexes` — run it before relying on this.

## Bot response time

The Telegram webhook (`app/api/telegram/webhook/route.ts`) is the latency-critical
path — every millisecond there is time a user spends staring at a spinner. Things
to keep in mind when changing it:

- **Master data is cached** (`lib/cache.ts`, 30s TTL, override with `CACHE_TTL_MS`).
  Categories, subcategories, units, locations, products, role permissions and the
  resolved workflow are read once and reused. Console writes call `invalidateCollection()`
  so edits show up immediately on that instance; other instances converge within
  the TTL. **If you add a new write path for any of those collections, invalidate
  it too.**
- **Bookkeeping goes through `defer()`** (`lib/defer.ts`), which runs work after
  the response via Next's `after()`. Audit rows, the group activity log and index
  creation must never sit in front of the bot's reply.
- **Deployment region matters most.** The Atlas cluster is in Mumbai
  (`ap-south-1`), so `vercel.json` pins functions to `bom1`. Vercel otherwise
  defaults to US East, which adds ~200ms to *every* database round trip.
  If the cluster moves, change the region to match it.
- **Indexes are created by `npm run ensure-indexes`**, not lazily per request.
  Run it after a deploy that adds one.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

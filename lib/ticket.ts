import type { Db } from "mongodb";

// Ticket numbers for completed inventory entries, item requests and purchases.
//
// Format: INV-202607-0042 — series, period, then a sequence that restarts each
// month. The number is what a user quotes when they ask about an entry, so it
// has to be short, sortable, and above all unique: two entries sharing a number
// is worse than no number at all.
//
// Each series counts independently, so INV, REQ and PUR each run their own
// 0001-upwards sequence within a month and a busy request month never pushes the
// inventory numbers along with it.
//
// Uniqueness comes from Mongo, not from application logic. `findOneAndUpdate`
// with `$inc` is atomic on a single document, so concurrent bot instances each
// get a distinct sequence value without a lock, a read-then-write, or a
// count-the-existing-entries scan (which is what makes numbering go wrong under
// load — two entries counted at the same moment both come out as #41).

const PREFIX = process.env.TICKET_PREFIX || "INV";

// The series a ticket numbers itself from. `INVENTORY` stays configurable
// because deployments already set TICKET_PREFIX; the rest are fixed so a ticket
// number always says which flow raised it.
//
// ISS and RET are a pair: an issue records materials leaving with a named
// person, and a return settles it. They are numbered separately because they are
// raised days apart by different people, and each is quoted on its own.
export const TicketSeries = {
  INVENTORY: PREFIX,
  REQUEST: "REQ",
  PURCHASE: "PUR",
  ISSUE: "ISS",
  RETURN: "RET",
} as const;

export type TicketSeriesName = (typeof TicketSeries)[keyof typeof TicketSeries];

// The counter document backing one series+period.
//
// The inventory series deliberately keeps the original un-namespaced id. Its
// counter is already sitting at whatever this month reached, and moving it to a
// new key would restart the sequence at 1 — straight into a duplicate-key
// failure against the ticket numbers already in `inventoryEntries`.
function counterId(series: string, period: string): string {
  return series === PREFIX ? `ticket:${period}` : `ticket:${series}:${period}`;
}

// The rest of the app timestamps in UTC. A ticket, though, is read by people in
// one place, and a month boundary that lands mid-evening local time looks like a
// numbering bug. Set TICKET_UTC_OFFSET_MINUTES (330 for IST) to align the period
// with the working day; leaving it unset keeps the UTC behaviour.
const OFFSET_MINUTES = Number(process.env.TICKET_UTC_OFFSET_MINUTES) || 0;

export function ticketPeriod(when: Date): string {
  const shifted = new Date(when.getTime() + OFFSET_MINUTES * 60_000);
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

type Counter = { _id: string; seq: number };

export async function nextTicketNumber(
  db: Db,
  when = new Date(),
  series: string = TicketSeries.INVENTORY
): Promise<string> {
  const period = ticketPeriod(when);
  try {
    const counter = await db
      .collection<Counter>("counters")
      .findOneAndUpdate(
        { _id: counterId(series, period) },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" }
      );
    const seq = Number(counter?.seq);
    if (!Number.isFinite(seq) || seq < 1) throw new Error(`counter returned ${counter?.seq}`);
    return `${series}-${period}-${String(seq).padStart(4, "0")}`;
  } catch (err) {
    // The entry itself matters more than the shape of its number: an entry the
    // user watched themselves complete must not be lost because the counter
    // document was briefly unavailable. The fallback is still unique (a
    // millisecond timestamp) and visibly irregular, so it can be found later.
    console.error("[ticket] counter unavailable, falling back to a timestamp number:", err);
    return `${series}-${period}-X${Date.now().toString(36).toUpperCase()}`;
  }
}

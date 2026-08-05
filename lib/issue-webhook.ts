import type { Db, ObjectId } from "mongodb";
import { applyDraftCallback, applyMessage, renderTicket, type RenderResult } from "./issue-engine";
import {
  acceptReturn,
  acknowledgeIssue,
  cancelIssue,
  cancelReturn,
  disputeIssue,
  findByAnchor,
  findById,
  findDraft,
  newIssueDraft,
  newReturnDraft,
  outstandingLines,
  rejectReturn,
  saveTicket,
  submitIssue,
  submitReturn,
  type TransitionResult,
} from "./issues";
import { isTerminal, PERM_ISSUE, STORE_ROLE, type MaterialTicket } from "./issue-types";
import { answerCallbackQuery, editMessageText, sendMessage } from "./telegram";

// Material issue / return: the handover lifecycle.
//
// Two tickets, one conversation:
//
//   store head sends /issue wire → cart → picks Vijay → Issue  ISS-…  (stock out)
//   Vijay taps Acknowledge                                     ISS-…  acknowledged
//   Vijay taps Return unused → sets 2 of 5 → Submit            RET-…  (nothing moves)
//   store head taps Accept return                              RET-…  (stock in)
//                                                              ISS-…  settled: 2 back, 3 consumed
//
// This flow is an OVERLAY, not a group mode. It runs in every approved group
// alongside whatever that group's plain messages already mean, so a site can
// keep one Telegram group for everything: someone types a product name and gets
// the original inventory-entry workflow, and someone types `/issue` in the same
// chat and gets a handover ticket. Nothing about the entry flow changes.
//
// Making that safe comes down to never guessing. The overlay claims an update
// only on evidence that is impossible to produce by accident:
//
//   * a callback whose data starts `is:` — its buttons and nobody else's;
//   * an explicit `/issue` command;
//   * a plain message from someone who has an issue or return DRAFT open, which
//     they can only have because they typed `/issue` themselves.
//
// Everything else falls straight through to the group's own flow. See
// `claimUpdate` below, which is what the webhook route asks.

export type IssueContext = {
  chatId: string;
  updateId: number;
  userId: string;
  name: string;
  handle: string;
  dbUserId: string;
  perms: string[];
  message?: { text?: string };
  callback?: { id: string; data: string; messageId?: number };
  // The open draft `claimUpdate` already found, handed on so the message path
  // does not look it up a second time.
  draft?: MaterialTicket | null;
};

// What made this update ours. `command` and `draft` only ever apply to messages.
export type IssueClaim = { how: "callback" | "command" | "draft"; draft?: MaterialTicket | null };

// The command that opens a handover. Deliberately explicit: in an entry group a
// plain message is already the start of an inventory entry, and quietly stealing
// some of those would break the workflow this bot was built for.
const ISSUE_COMMAND = /^\/(issue|handover|giveout)\b/i;

// Does this update belong to the issue overlay?
//
// Asked by the webhook route BEFORE it dispatches to the group's own flow, and
// before the permission gate — a maintenance worker acknowledging a ticket needs
// no inventory permission at all, and must not be turned away by a gate meant
// for people adding stock.
//
// The draft lookup is one indexed findOne on the `{chatId, createdByUserId, …}`
// prefix, and it runs only for plain messages: a callback is decided by its
// prefix alone, and a command by its text.
export async function claimUpdate(
  db: Db,
  args: { chatId: string; userId: string; callbackData?: string; text?: string }
): Promise<IssueClaim | null> {
  if (args.callbackData) {
    return args.callbackData.startsWith("is:") ? { how: "callback" } : null;
  }

  const text = (args.text ?? "").trim();
  if (ISSUE_COMMAND.test(text)) return { how: "command" };

  const draft = (await db.collection("issueTickets").findOne({
    chatId: args.chatId,
    createdByUserId: args.userId,
    status: "draft",
  })) as MaterialTicket | null;
  if (!draft) return null;

  // `/cancel` belongs to whichever draft is open, of either kind, so a ticket
  // can always be cleared by the person who opened it.
  if (/^\/cancel\b/i.test(text)) return { how: "draft", draft };

  // An ISSUE draft can only exist because this person ran `/issue`, and it is
  // driven by typing — a product name is a search, a person's name filters the
  // recipient list. Treating their next message as part of it follows their
  // stated intent rather than guessing at it; without this, typing a product
  // name to fill the cart would open an inventory entry instead.
  //
  // A RETURN draft is the opposite: every field on it is a button, so it has
  // nothing to do with a typed message. Claiming those would swallow the
  // recipient's ordinary use of the group — someone with a return open could no
  // longer log an inventory entry — for no gain at all.
  return draft.kind === "issue" ? { how: "draft", draft } : null;
}

// Taps that only shape a draft. Everything else is a status transition and
// carries its own permission check next to it.
const DRAFT_PREFIXES = [
  "is:cart",
  "is:back",
  "is:who",
  "is:u:",
  "is:upg:",
  "is:pg:",
  "is:s:",
  "is:l:",
  "is:q:",
  "is:rm:",
  "is:rl:",
  "is:rq:",
];

function isDraftCallback(data: string): boolean {
  return DRAFT_PREFIXES.some((p) => data.startsWith(p));
}

// Draw into the ticket's anchor message, sending a fresh one if the edit fails
// (message deleted, or past Telegram's 48h edit window) so a ticket can never
// dead-end mid-flow.
async function render(ticket: MaterialTicket, result: RenderResult): Promise<void> {
  if (ticket.anchorMessageId) {
    const res = await editMessageText(ticket.chatId, ticket.anchorMessageId, result.text, result.keyboard);
    if (res.ok || res.notModified) return;
  }
  const sent = await sendMessage(ticket.chatId, result.text, result.keyboard);
  if (sent?.message_id) ticket.anchorMessageId = sent.message_id;
}

export async function handleIssueUpdate(db: Db, ctx: IssueContext): Promise<void> {
  if (ctx.callback) return handleCallback(db, ctx, ctx.callback);
  return handleMessage(db, ctx);
}

// ---------------------------------------------------------------------------
// Typed messages
// ---------------------------------------------------------------------------

async function handleMessage(db: Db, ctx: IssueContext): Promise<void> {
  const text = (ctx.message?.text ?? "").trim();
  if (!text) return;

  const isCommand = ISSUE_COMMAND.test(text);
  // `claimUpdate` already found this, except on the command path where it does
  // not need to look.
  const draft =
    ctx.draft !== undefined ? ctx.draft : await findDraft(db, ctx.chatId, ctx.userId, "issue");

  // `/cancel` drops whichever draft this person has open. Handled before the
  // permission check so someone whose access was just removed can still clear
  // their own half-built ticket out of the group — and before anything else, so
  // a stuck draft can never trap someone out of the entry workflow.
  if (/^\/cancel\b/i.test(text)) {
    if (!draft) return;
    const res = draft.kind === "return" ? await cancelReturn(db, draft, ctx.name) : await cancelIssue(db, draft, ctx.name);
    if (res.ok) {
      res.ticket.anchorMessageId = draft.anchorMessageId;
      await render(res.ticket, await renderTicket(db, res.ticket));
    }
    return;
  }

  if (!ctx.perms.includes(PERM_ISSUE)) {
    // Only an explicit command earns a refusal. Someone with a draft open who is
    // typing has already passed this check to get one, and answering stray lines
    // in a shared group is how it becomes unreadable.
    if (isCommand) {
      await sendMessage(
        ctx.chatId,
        `⛔ Your role can't issue materials. Ask an admin to grant it the "${PERM_ISSUE}" permission.`
      );
    }
    return;
  }

  if (draft?.processedUpdateIds?.includes(ctx.updateId)) return;

  // `/issue wire` searches for wire; a bare `/issue` opens an empty ticket and
  // its prompt rather than searching for the empty string.
  const query = isCommand ? text.replace(/^\/\w+\s*/, "").trim() : text;

  if (!draft) {
    // Only a command gets here — a plain message with no draft was never claimed
    // by `claimUpdate` and is still the group's own flow to handle.
    if (!isCommand) return;
    const fresh = newIssueDraft(ctx.chatId, ctx.userId, ctx.dbUserId, ctx.name, ctx.handle);
    if (query) {
      fresh.ui.query = query.slice(0, 60);
      fresh.ui.page = 0;
    }
    fresh.processedUpdateIds = [ctx.updateId];
    await render(fresh, await renderTicket(db, fresh));
    await saveTicket(db, fresh);
    return;
  }

  // A second `/issue` while a draft is already open re-opens that draft rather
  // than starting a rival one — there can only be a single cart per person per
  // chat, and silently discarding a half-built one would lose real work.
  const result = await applyMessage(db, draft, query);
  draft.processedUpdateIds = [...(draft.processedUpdateIds ?? []), ctx.updateId].slice(-20);
  if (result.render) await render(draft, result.render);
  else if (result.notice) await sendMessage(ctx.chatId, result.notice);
  await saveTicket(db, draft);
}

// ---------------------------------------------------------------------------
// Button taps
// ---------------------------------------------------------------------------

async function handleCallback(
  db: Db,
  ctx: IssueContext,
  callback: { id: string; data: string; messageId?: number }
): Promise<void> {
  const ticket =
    typeof callback.messageId === "number" ? await findByAnchor(db, ctx.chatId, callback.messageId) : null;

  if (!ticket) {
    await answerCallbackQuery(callback.id, "This ticket is no longer open. Send a material name to start a new one.");
    return;
  }

  if (ticket.processedUpdateIds?.includes(ctx.updateId)) {
    await answerCallbackQuery(callback.id);
    return;
  }
  ticket.processedUpdateIds = [...(ticket.processedUpdateIds ?? []), ctx.updateId].slice(-20);

  const outcome = await routeCallback(db, ctx, ticket, callback.data);

  // A refusal leaves the ticket exactly as it was, so there is nothing to
  // redraw — the toast is the whole response.
  if (outcome.notice && !outcome.render) {
    await Promise.all([answerCallbackQuery(callback.id, outcome.notice), persist(db, ticket)]);
    return;
  }

  const target = outcome.ticket ?? ticket;
  await Promise.all([
    answerCallbackQuery(callback.id, outcome.notice),
    (async () => {
      if (outcome.render) await render(target, outcome.render);
    })(),
    // A settled issue is a second message in the group that is now out of date.
    // Redrawing it here is what keeps "2 returned, 3 consumed" visible on the
    // ticket people actually scroll back to.
    (async () => {
      if (outcome.alsoRedraw) await render(outcome.alsoRedraw, await renderTicket(db, outcome.alsoRedraw));
    })(),
  ]);

  await persist(db, target);
  if (outcome.alsoRedraw) await persistAnchor(db, outcome.alsoRedraw);
}

// Persist the replay guard, anchor and ui scratch without clobbering fields a
// transition wrote straight to the database.
//
// A transition returns the document as it stood AFTER its own conditional
// update, so writing the whole thing back would be safe — but a draft that has
// only ever existed in memory has to be saved whole. The two cases are told
// apart by whether the ticket has a number yet.
async function persist(db: Db, ticket: MaterialTicket): Promise<void> {
  if (!ticket.ticketNumber) {
    await saveTicket(db, ticket);
    return;
  }
  await db.collection("issueTickets").updateOne(
    { _id: ticket._id as ObjectId },
    {
      $set: {
        processedUpdateIds: ticket.processedUpdateIds,
        anchorMessageId: ticket.anchorMessageId,
        ui: ticket.ui,
        updatedAt: new Date().toISOString(),
      },
    }
  );
}

// Only the anchor: used for the parent issue after a return settles it, where
// everything else was already written by the transition.
async function persistAnchor(db: Db, ticket: MaterialTicket): Promise<void> {
  await db
    .collection("issueTickets")
    .updateOne({ _id: ticket._id as ObjectId }, { $set: { anchorMessageId: ticket.anchorMessageId } });
}

type Outcome = {
  render?: RenderResult;
  notice?: string;
  ticket?: MaterialTicket;
  // A second ticket whose message needs redrawing — the parent issue when a
  // return settles it.
  alsoRedraw?: MaterialTicket;
};

async function routeCallback(db: Db, ctx: IssueContext, ticket: MaterialTicket, data: string): Promise<Outcome> {
  const isAuthor = ticket.createdByUserId === ctx.userId;
  const isRecipient = ticket.recipient?.userId === ctx.userId;
  const isStore = ctx.perms.includes(PERM_ISSUE);

  if (isTerminal(ticket.status)) return { notice: "This ticket is already closed." };

  // ---- draft stage ----
  if (isDraftCallback(data)) {
    if (ticket.status !== "draft") return { notice: "This ticket has already been submitted." };
    if (!isAuthor) return { notice: "Only the person who opened this ticket can change it." };
    // The store side of a draft issue needs the permission; a return draft is
    // the recipient answering for their own materials and needs nothing.
    if (ticket.kind === "issue" && !isStore) return { notice: "Your role can't issue materials." };
    const res = await applyDraftCallback(db, ticket, data);
    return { render: res.render, notice: res.notice };
  }

  if (data === "is:cancel") {
    // The author withdraws their own; the store can clear one that is stuck.
    if (!isAuthor && !isStore) return { notice: "Only the author or the store can cancel this." };
    const res = ticket.kind === "return" ? await cancelReturn(db, ticket, ctx.name) : await cancelIssue(db, ticket, ctx.name);
    return transition(db, ticket, res);
  }

  // ---- issue tickets ----
  if (data === "is:sub") {
    if (!isAuthor) return { notice: "Only the person who opened this ticket can issue it." };
    if (!isStore) return { notice: `Your role can't issue materials. Ask an admin for the "${PERM_ISSUE}" permission.` };
    return transition(db, ticket, await submitIssue(db, ticket));
  }

  if (data === "is:ack" || data === "is:nack") {
    // Deliberately the recipient alone, and not the store. The whole value of
    // this step is that it is a signature from the person who took the
    // materials; letting the store tick it off on their behalf would make it a
    // formality that records nothing.
    if (!isRecipient) return { notice: "Only the person these materials went to can answer for them." };
    const res = data === "is:ack" ? await acknowledgeIssue(db, ticket, ctx.name) : await disputeIssue(db, ticket, ctx.name);
    return transition(db, ticket, res);
  }

  if (data === "is:ret") {
    if (!isRecipient) return { notice: "Only the person holding these materials can return them." };
    if (ticket.status !== "acknowledged") {
      return { notice: "Acknowledge the materials first, then you can return what is left over." };
    }
    return openReturn(db, ctx, ticket);
  }

  // ---- return tickets ----
  if (data === "is:rsub") {
    if (!isAuthor) return { notice: "Only the person who opened this return can submit it." };
    const issue = ticket.issueTicketId ? await findById(db, ticket.issueTicketId) : null;
    return transition(db, ticket, await submitReturn(db, ticket, issue));
  }

  if (data === "is:racc" || data === "is:rrej") {
    if (!isStore) return { notice: `Only the ${STORE_ROLE} can action a return.` };
    if (data === "is:rrej") return transition(db, ticket, await rejectReturn(db, ticket, ctx.name));

    const res = await acceptReturn(db, ticket, ctx.name);
    if (!res.ok) return { notice: res.reason };
    const out = await transition(db, ticket, res);
    // The settled parent carries its own stored anchor (the transition read it
    // back from Mongo), so redrawing it edits the message the group is already
    // looking at rather than posting a duplicate.
    if (res.issue) out.alsoRedraw = res.issue;
    return out;
  }

  return { notice: "Use the buttons above." };
}

// Open a return against an acknowledged issue.
//
// A return is its own document with its own anchor message, so this SENDS rather
// than edits: the issue ticket stays on screen unchanged (it is still the record
// of what went out) and the return appears below it as a new thing to fill in.
async function openReturn(db: Db, ctx: IssueContext, issue: MaterialTicket): Promise<Outcome> {
  const existing = await db.collection("issueTickets").findOne({
    chatId: issue.chatId,
    kind: "return",
    issueTicketId: String(issue._id),
    status: { $in: ["draft", "pending_store"] },
  });
  if (existing) {
    return { notice: "There is already a return open against this issue — scroll up to it." };
  }

  if (!outstandingLines(issue).length) {
    return { notice: "Nothing on this ticket was actually issued, so there is nothing to return." };
  }

  const draft = newReturnDraft(issue, ctx.userId, ctx.dbUserId, ctx.name, ctx.handle);
  const view = await renderTicket(db, draft);
  const sent = await sendMessage(draft.chatId, view.text, view.keyboard);
  if (sent?.message_id) draft.anchorMessageId = sent.message_id;
  await saveTicket(db, draft);

  // The issue itself did not change, so its own message is left exactly as it
  // is. The toast tells the recipient where to look.
  return { notice: "Return opened below — set how much is coming back." };
}

// Turn a transition result into a redraw or a toast.
async function transition(db: Db, fallback: MaterialTicket, res: TransitionResult): Promise<Outcome> {
  if (!res.ok) return { notice: res.reason };
  // The transition already wrote the status; carry the in-memory replay guard
  // and anchor across so `persist` does not lose them.
  res.ticket.processedUpdateIds = fallback.processedUpdateIds;
  res.ticket.anchorMessageId = fallback.anchorMessageId;
  return { render: await renderTicket(db, res.ticket), ticket: res.ticket };
}

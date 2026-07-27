import { after } from "next/server";

// Run best-effort work (audit rows, monitoring, log lines) AFTER the response has
// been sent, so it never sits in front of the bot's reply.
//
// A bare unawaited promise is not good enough on a serverless platform: once the
// handler returns, the instance can be frozen or reclaimed and the write is lost
// halfway. `after` keeps the invocation alive until the work settles.
//
// Falls back to a detached promise when called outside a request scope (scripts,
// tests), where `after` throws.
export function defer(work: () => Promise<unknown>) {
  const run = () => work().catch((err) => console.error("[defer] task failed:", err));
  try {
    after(run);
  } catch {
    void run();
  }
}

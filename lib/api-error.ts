import { NextResponse } from "next/server";

// Route handlers let driver/network failures propagate. Next turns an uncaught
// throw into an empty 500, so `lib/api-client.ts` can only report the generic
// "Request failed (500)" — which looks identical whether the cause is a missing
// MONGODB_URI, a blocked Atlas IP, or a genuine bug. Wrapping the handler puts
// the real reason in the response body and in the platform logs.
export function apiError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api] request failed:", err);
  return NextResponse.json({ error: message }, { status: 500 });
}

export function withErrors<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return apiError(err);
    }
  };
}

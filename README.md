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

## Bot response time

The Telegram webhook (`app/api/telegram/webhook/route.ts`) is the latency-critical
path — every millisecond there is time a user spends staring at a spinner. Things
to keep in mind when changing it:

- **Master data is cached** (`lib/cache.ts`, 30s TTL, override with `CACHE_TTL_MS`).
  Categories, subcategories, units, locations, role permissions and the resolved
  workflow are read once and reused. Console writes call `invalidateCollection()`
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

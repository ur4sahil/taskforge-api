# TaskForge — Email-to-list (Cloudflare path)

Receives inbound email at `*@inbound.sigmahousingllc.com` and turns each one into a TaskForge task in the list whose address matches the recipient.

## Prerequisites

- You own `sigmahousingllc.com` on Cloudflare (you already do).
- The TaskForge API is reachable at `https://taskforge-api.sigmahousingllc.com` (via the existing cloudflared tunnel).
- API env vars set on the VPS (already done in this session):
  - `INBOUND_EMAIL_DOMAIN=inbound.sigmahousingllc.com`
  - `INBOUND_WEBHOOK_SECRET=<the value generated in this session — also pasted into Cloudflare below>`

## One-time setup

### 1. Cloudflare dashboard — Email Routing

1. Log in to https://dash.cloudflare.com → pick `sigmahousingllc.com`.
2. Left sidebar → **Email** → **Email Routing** → **Get started**.
3. Cloudflare proposes MX records. Approve them — Cloudflare adds them to the zone automatically. The MX targets look like `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`, `route3.mx.cloudflare.net`.

   ⚠ This affects the **root domain**'s mail flow. If you currently receive any mail at `*@sigmahousingllc.com`, those MX records will be replaced. If you need to keep them, do the routing on a subdomain instead (skip to step 1b below).

   **1b. Subdomain-only path (recommended for you):** in DNS, add MX records for `inbound` host pointing to the three `routeN.mx.cloudflare.net` targets with priority 50. Then in Email Routing → **Destinations** → **Edit zone** → use `inbound.sigmahousingllc.com` as the routing target. This keeps your existing root-domain email untouched.

4. **Custom Addresses** → **Catch-all** → action: **Send to a Worker** → leave it pointing at "no worker yet" for now.

### 2. Deploy the worker

```bash
cd /Users/aggar/taskforge/deploy/cloudflare-email-worker
npm install
npx wrangler login                              # opens browser, authorizes
npx wrangler secret put TASKFORGE_SECRET        # paste the value of INBOUND_WEBHOOK_SECRET (from the VPS .env)
npm run deploy
```

You should see "Published taskforge-email-router" with a workers.dev URL (the URL is irrelevant — Cloudflare invokes the worker via its email binding, not HTTP).

### 3. Bind the worker to inbound mail

1. Cloudflare dashboard → **Email** → **Email Routing** → **Routes**.
2. Under **Catch-all**, click **Edit** → action: **Send to a Worker** → choose `taskforge-email-router` → save.
3. Email Routing now forwards every inbound mail on `inbound.sigmahousingllc.com` to the worker, which parses and POSTs to TaskForge.

### 4. Test

1. In TaskForge, open any list. The header now shows an address like `<uuid>@inbound.sigmahousingllc.com` with a copy button.
2. Send a plain-text email **from any of the seeded accounts' email addresses** (e.g. `sarah@acme.test`) — wait, those aren't real mailboxes. Use a real email you control as the sender.
3. Subject becomes the task title; body becomes the description. Refresh the list — the task should appear within a few seconds.
4. To watch deliveries live: `cd deploy/cloudflare-email-worker && npm run tail`.

## What happens if it breaks

- **Sender bounce** = something failed. The worker rejects mail with a clear reason if TaskForge returns non-2xx.
- **No task appears, no bounce** = mail isn't reaching the worker. Re-check the catch-all route in Cloudflare dashboard.
- **API logs** on the VPS: `pm2 logs taskforge-api | grep -i email`. Look for `Email task ... created` (success) or `Unknown or disabled inbound address` (the To: didn't match a list).

## Notes / known gaps

- Attachments are NOT carried through to the task yet. Adding them requires writing each one to R2 from the worker and calling the attachments endpoint. Easy to add when needed.
- Sender attribution only works if the sender's email matches a workspace member's user email exactly. External senders fall back to "task creator = list creator".
- The webhook secret check rejects requests without `X-Inbound-Secret` — there's no way to test by curl without the secret, which is intentional.

/**
 * TaskForge — Cloudflare Email Worker
 *
 * Receives raw inbound email for inbound.sigmahousingllc.com and POSTs a
 * normalized JSON payload to TaskForge's /api/v1/webhooks/inbound-email.
 *
 * Bindings required (set in Cloudflare dashboard → Worker → Settings → Variables):
 *   TASKFORGE_WEBHOOK_URL   plain text   e.g. https://taskforge-api.sigmahousingllc.com/api/v1/webhooks/inbound-email
 *   TASKFORGE_SECRET        secret       value of INBOUND_WEBHOOK_SECRET on the API
 *
 * Dependencies: postal-mime (bundled by wrangler).
 */

import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    // Parse the raw MIME stream into a usable object.
    const parsed = await PostalMime.parse(message.raw);

    const payload = {
      to: (parsed.to || []).map(a => a.address).filter(Boolean),
      from: parsed.from?.address || '',
      cc: (parsed.cc || []).map(a => a.address).filter(Boolean),
      subject: parsed.subject || '',
      // Prefer plain text; fall back to a stripped HTML if text is missing.
      text: parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, '').trim() : ''),
    };

    const res = await fetch(env.TASKFORGE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inbound-Secret': env.TASKFORGE_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('TaskForge webhook rejected delivery', res.status, body);
      // Tell Cloudflare to reject + bounce so the sender gets a clear failure
      // instead of silent loss.
      message.setReject(`TaskForge rejected this email (${res.status})`);
      return;
    }

    console.log('Delivered to TaskForge:', message.headers.get('message-id'));
  },
};

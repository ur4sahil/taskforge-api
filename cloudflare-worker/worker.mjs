// Cloudflare Email Worker — TaskForge inbound email gateway
//
// Receives email sent to *@tasks.housify365.com via Cloudflare Email Routing,
// normalizes it to InboundEmailPayload, and POSTs to the TaskForge API webhook.
//
// Bindings expected (set via Worker secret/env):
//   WEBHOOK_URL    — full URL of the inbound-email webhook (https://taskforge-api.sigmahousingllc.com/api/v1/webhooks/inbound-email)
//   WEBHOOK_SECRET — value of INBOUND_WEBHOOK_SECRET on the API
//
// Lightweight, no external deps. Handles the common cases:
//   - text/plain bodies (with optional quoted-printable / base64 transfer encoding)
//   - multipart/alternative — picks the first text/plain part
//   - multipart/mixed — finds the first text/plain part anywhere
//   - encoded-word subjects (`=?UTF-8?B?...?=`)

const decoder = new TextDecoder('utf-8');

function decodeQuotedPrintable(s) {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeBase64(s) {
  try { return decoder.decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0))); }
  catch { return ''; }
}

// Decode RFC 2047 encoded-word subjects: =?charset?B?...?= or =?charset?Q?...?=
function decodeHeader(s) {
  if (!s) return '';
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, enc, data) => {
    if (enc.toUpperCase() === 'B') return decodeBase64(data);
    return decodeQuotedPrintable(data.replace(/_/g, ' '));
  });
}

// Parse headers + body out of an RFC822 chunk. Returns { headers: Map, body: string }.
function splitHeadersBody(text) {
  const sep = text.search(/\r?\n\r?\n/);
  if (sep === -1) return { headers: new Map(), body: text };
  const head = text.slice(0, sep);
  const body = text.slice(sep).replace(/^\r?\n\r?\n/, '');
  const headers = new Map();
  let current = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, headers.get(current) + ' ' + line.trim());
    } else {
      const m = line.match(/^([^:]+):\s?(.*)$/);
      if (m) { current = m[1].toLowerCase(); headers.set(current, m[2]); }
    }
  }
  return { headers, body };
}

function paramValue(headerValue, key) {
  const m = (headerValue || '').match(new RegExp(`${key}\\s*=\\s*"?([^";]+)"?`, 'i'));
  return m ? m[1] : null;
}

function decodeBody(headers, body) {
  const cte = (headers.get('content-transfer-encoding') || '7bit').toLowerCase();
  if (cte === 'quoted-printable') return decodeQuotedPrintable(body);
  if (cte === 'base64') return decodeBase64(body);
  return body;
}

// Walk a (possibly multipart) MIME tree and return the first text/plain payload.
function findTextPlain(headers, body) {
  const ct = headers.get('content-type') || 'text/plain';
  if (/^text\/plain/i.test(ct)) return decodeBody(headers, body).trim();
  if (/^multipart\//i.test(ct)) {
    const boundary = paramValue(ct, 'boundary');
    if (!boundary) return '';
    // Non-capturing group around the (--)? trailer keeps split() from
    // emitting `undefined` slots between parts (which used to crash the
    // .replace() below for any real multipart email).
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      const trimmed = part.replace(/^\r?\n/, '');
      if (!trimmed || trimmed === '--') continue;
      const sub = splitHeadersBody(trimmed);
      const text = findTextPlain(sub.headers, sub.body);
      if (text) return text;
    }
  }
  return '';
}

async function streamToString(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > 5 * 1024 * 1024) break; // hard cap 5MB to keep workers fast
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return decoder.decode(merged);
}

export default {
  async email(message, env, ctx) {
    try {
      // Only handle the inbound-task subdomain. Anything else hitting this catch-all
      // (random mail to @housify365.com that didn't match a literal rule) is rejected
      // so it mirrors the prior "no rule matches" behavior.
      const toAddr = (message.to || '').toLowerCase();
      const inboundDomain = (env.INBOUND_DOMAIN || 'tasks.housify365.com').toLowerCase();
      if (!toAddr.endsWith('@' + inboundDomain)) {
        message.setReject('Address not handled');
        return;
      }

      const raw = await streamToString(message.raw);
      const { headers, body } = splitHeadersBody(raw);
      const subject = decodeHeader(headers.get('subject') || '');
      const text = findTextPlain(headers, body);
      const ccRaw = headers.get('cc') || '';
      const cc = ccRaw ? ccRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      const payload = {
        to: message.to,
        from: message.from,
        cc,
        subject,
        text,
      };

      const res = await fetch(env.WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-inbound-secret': env.WEBHOOK_SECRET,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`Webhook ${res.status}: ${errBody.slice(0, 500)}`);
        message.setReject(`TaskForge webhook returned ${res.status}`);
      }
    } catch (err) {
      console.error('Worker error', err && err.stack || err);
      message.setReject('Internal email-worker error');
    }
  },
};

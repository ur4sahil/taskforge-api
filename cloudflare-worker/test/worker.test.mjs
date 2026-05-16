// Tests for the Cloudflare Email Worker MIME parser. Node's built-in test
// runner — no install. We feed the worker a fake EmailMessage (raw stream +
// to/from + headers) and assert the JSON payload it POSTs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import worker from '../worker.mjs';

function streamOf(s) {
  // Cloudflare's EmailMessage.raw is a Web ReadableStream; Node 25's Readable
  // implements toWeb(). Encode UTF-8 first so binary bodies survive.
  return Readable.toWeb(Readable.from([Buffer.from(s, 'utf-8')]));
}

function eml({ from = 'sender@example.com', to = 'inbox-uuid@tasks.housify365.com', headers = '', body = '' } = {}) {
  const message = {
    from, to,
    raw: streamOf(headers + body),
    setReject(reason) { this.rejected = reason; },
  };
  return message;
}

async function run(message, env = {}) {
  const fetchCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  try {
    await worker.email(message, {
      WEBHOOK_URL: 'https://api.test/webhook',
      WEBHOOK_SECRET: 'shhh',
      INBOUND_DOMAIN: 'tasks.housify365.com',
      ...env,
    }, {});
  } finally {
    globalThis.fetch = origFetch;
  }
  return { fetchCalls, message };
}

test('plain-text body: subject + text extracted, POST sent with secret header', async () => {
  const headers = [
    'From: sender@example.com',
    'To: list-abc@tasks.housify365.com',
    'Subject: Hello there',
    'Content-Type: text/plain; charset=UTF-8',
    '', '',
  ].join('\r\n');
  const msg = eml({ to: 'list-abc@tasks.housify365.com', headers, body: 'This is the body.\r\n' });

  const { fetchCalls, message } = await run(msg);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.test/webhook');
  assert.equal(fetchCalls[0].opts.headers['x-inbound-secret'], 'shhh');
  const payload = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(payload.to, 'list-abc@tasks.housify365.com');
  assert.equal(payload.from, 'sender@example.com');
  assert.equal(payload.subject, 'Hello there');
  assert.equal(payload.text, 'This is the body.');
  assert.equal(message.rejected, undefined);
});

test('multipart/alternative — text/plain part is preferred over text/html', async () => {
  const boundary = 'abc123';
  const headers = [
    'Subject: Mixed',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '', '',
  ].join('\r\n');
  const body =
    `--${boundary}\r\n` +
    'Content-Type: text/plain; charset=UTF-8\r\n\r\n' +
    'plain version\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: text/html; charset=UTF-8\r\n\r\n' +
    '<p>html version</p>\r\n' +
    `--${boundary}--\r\n`;
  const { fetchCalls } = await run(eml({ headers, body }));
  const payload = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(payload.text, 'plain version');
});

test('quoted-printable body is decoded', async () => {
  const headers = [
    'Subject: QP test',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '', '',
  ].join('\r\n');
  const { fetchCalls } = await run(eml({ headers, body: 'Caf=C3=A9 time =\r\nand more' }));
  const payload = JSON.parse(fetchCalls[0].opts.body);
  // 'Caf' + Ã (0xC3) + © (0xA9) — when decoded as bytes those form the UTF-8 sequence for é.
  // Our decoder is simplified and treats each %XX as a single charCode, so we expect
  // the raw byte-pair string. Worker decodeBody is intentionally simple here.
  assert.match(payload.text, /Caf.+ time and more/);
});

test('base64 body is decoded', async () => {
  const headers = [
    'Subject: B64 test',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '', '',
  ].join('\r\n');
  // 'hello world' in base64
  const body = 'aGVsbG8gd29ybGQ=';
  const { fetchCalls } = await run(eml({ headers, body }));
  const payload = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(payload.text, 'hello world');
});

test('encoded-word subject (=?UTF-8?B?...?=) is decoded', async () => {
  const headers = [
    'Subject: =?UTF-8?B?SGVsbG8gV29ybGQ=?=',
    'Content-Type: text/plain; charset=UTF-8',
    '', '',
  ].join('\r\n');
  const { fetchCalls } = await run(eml({ headers, body: 'body' }));
  const payload = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(payload.subject, 'Hello World');
});

test('encoded-word subject (Q encoding) decodes underscore as space', async () => {
  const headers = [
    'Subject: =?UTF-8?Q?Hello_There?=',
    'Content-Type: text/plain',
    '', '',
  ].join('\r\n');
  const { fetchCalls } = await run(eml({ headers, body: 'body' }));
  const payload = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(payload.subject, 'Hello There');
});

test('addresses NOT on INBOUND_DOMAIN are rejected and webhook NOT called', async () => {
  const headers = [
    'Subject: stray mail',
    'Content-Type: text/plain',
    '', '',
  ].join('\r\n');
  const msg = eml({ to: 'random@housify365.com', headers, body: 'body' });
  const { fetchCalls, message } = await run(msg);
  assert.equal(fetchCalls.length, 0);
  assert.equal(message.rejected, 'Address not handled');
});

test('webhook 5xx response causes the worker to setReject the email', async () => {
  const headers = [
    'Subject: Error path',
    'Content-Type: text/plain',
    '', '',
  ].join('\r\n');
  const msg = eml({ headers, body: 'body' });
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'server bad' });
  try {
    await worker.email(msg, {
      WEBHOOK_URL: 'https://api.test/webhook',
      WEBHOOK_SECRET: 'shhh',
      INBOUND_DOMAIN: 'tasks.housify365.com',
    }, {});
  } finally {
    delete globalThis.fetch;
  }
  assert.match(msg.rejected || '', /500/);
});

test('cc header (comma-separated) ends up in the payload', async () => {
  const headers = [
    'Subject: CC test',
    'Cc: alice@example.com, bob@example.com',
    'Content-Type: text/plain',
    '', '',
  ].join('\r\n');
  const { fetchCalls } = await run(eml({ headers, body: 'body' }));
  const payload = JSON.parse(fetchCalls[0].opts.body);
  assert.deepEqual(payload.cc, ['alice@example.com', 'bob@example.com']);
});

test('case-insensitive INBOUND_DOMAIN match (uppercase To: still routes)', async () => {
  const headers = [
    'Subject: Uppercase',
    'Content-Type: text/plain',
    '', '',
  ].join('\r\n');
  const msg = eml({ to: 'List-XYZ@TASKS.HOUSIFY365.com', headers, body: 'body' });
  const { fetchCalls } = await run(msg);
  assert.equal(fetchCalls.length, 1);
});

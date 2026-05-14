/**
 * OpenGraph unfurl with SSRF protection. Fetches the first URL in a message body,
 * parses <meta property="og:..."> tags, returns a preview object.
 *
 * Safety:
 *  - Only http/https schemes
 *  - Reject hostnames that resolve to private/loopback IPs (basic regex check)
 *  - 5 second timeout
 *  - 2 MB max body
 *  - Stops after first matching URL per message
 */

import { Logger } from '@nestjs/common';
const log = new Logger('Unfurl');

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;

const BLOCKED_HOSTS = [
  'localhost',
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^::1$/, /^fc/, /^fe80/,
];

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return BLOCKED_HOSTS.some(p => typeof p === 'string' ? h === p : p.test(h));
}

export function extractFirstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  if (!m) return null;
  let url = m[0].replace(/[.,!?)\]]+$/, '');
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateHost(u.hostname)) return null;
    return u.toString();
  } catch { return null; }
}

export async function fetchLinkPreview(rawUrl: string, timeoutMs = 5000): Promise<LinkPreview | null> {
  const url = extractFirstUrl(rawUrl);
  if (!url) return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'TaskForgeBot/1.0 (+https://taskforge.app)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    // Cap the body we read at 2 MB so we don't blow memory on huge pages.
    const reader = res.body?.getReader();
    if (!reader) return null;
    let received = 0;
    const chunks: Uint8Array[] = [];
    const MAX = 2 * 1024 * 1024;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      chunks.push(value);
      if (received > MAX) { reader.cancel(); break; }
      // We only need the <head>. Bail early once we've passed </head>.
      const sofar = new TextDecoder().decode(chunks[chunks.length - 1]);
      if (sofar.includes('</head>')) break;
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks));
    return parseOpenGraph(html, url);
  } catch (err: any) {
    if (err.name !== 'AbortError') log.warn(`unfurl failed for ${url}: ${err?.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.byteLength; }
  return out;
}

function meta(html: string, attr: string, value: string): string | undefined {
  // Tolerant attribute extractor: order-independent, single OR double-quoted.
  const re = new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]*content=["']([^"']+)["']`, 'i');
  const m1 = html.match(re);
  if (m1) return m1[1];
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${value}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? m2[1] : undefined;
}

function parseOpenGraph(html: string, url: string): LinkPreview {
  const title = meta(html, 'property', 'og:title') || meta(html, 'name', 'twitter:title') || (html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim());
  const description = meta(html, 'property', 'og:description') || meta(html, 'name', 'twitter:description') || meta(html, 'name', 'description');
  const image = meta(html, 'property', 'og:image') || meta(html, 'name', 'twitter:image');
  const siteName = meta(html, 'property', 'og:site_name');
  return {
    url,
    title: title?.slice(0, 200),
    description: description?.slice(0, 300),
    image,
    siteName: siteName?.slice(0, 100),
  };
}

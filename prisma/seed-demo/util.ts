// Small, dependency-free helpers for the demo seed: a seeded PRNG, deterministic
// UUIDs, calendar/instant helpers in the workspace timezone, tiny PNG/WAV
// encoders for real uploads, and an R2 client that mirrors R2StorageService.
import { deflateSync } from 'zlib';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  addDays, keyToDayNumber, dayNumberToKey, weekday, localDateTimeToUtc, todayKeyIn, DayKey,
} from '../../src/common/utils/recurrence';
import { dateKeyToDb } from '../../src/common/utils/dates';

export { addDays, weekday, keyToDayNumber, dayNumberToKey, dateKeyToDb, todayKeyIn };
export type { DayKey };

export const TZ = 'America/New_York';
export const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────── PRNG

/** mulberry32 — tiny deterministic PRNG. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [a, b] inclusive. */
  int(a: number, b: number): number { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** Pick `n` distinct items (n clamped to arr.length). */
  sample<T>(arr: readonly T[], n: number): T[] {
    const copy = arr.slice();
    this.shuffle(copy);
    return copy.slice(0, Math.min(n, copy.length));
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  weighted<T>(items: readonly [T, number][]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of items) { r -= w; if (r <= 0) return v; }
    return items[items.length - 1][0];
  }
  /** RFC-4122 v4 formatted UUID from PRNG bytes (deterministic for a seed). */
  uuid(): string {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = Math.floor(this.next() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  hex(bytes: number): string {
    let s = '';
    for (let i = 0; i < bytes; i++) s += Math.floor(this.next() * 256).toString(16).padStart(2, '0');
    return s;
  }
}

// ─────────────────────────────────────────────────────────────── dates

/** UTC instant of wall-clock `HH:MM` on `day` in the workspace timezone. */
export function at(day: DayKey, hhmm: string): Date { return localDateTimeToUtc(day, hhmm, TZ); }

export function hhmm(h: number, m: number): string { return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }

const SEED_NOW = new Date();

/** Never produce an instant in the future: anything past "now" becomes a few minutes to ~3 hours ago. */
export function clampPast(rng: Rng, d: Date): Date {
  if (d.getTime() <= SEED_NOW.getTime() - 120_000) return d;
  return new Date(SEED_NOW.getTime() - (2 + rng.next() * 170) * 60_000);
}

/** A random instant during the working day (08:00–18:30, weighted toward mid-day). */
export function workInstant(rng: Rng, day: DayKey): Date {
  const h = rng.weighted<number>([[8, 2], [9, 5], [10, 6], [11, 6], [12, 3], [13, 5], [14, 6], [15, 6], [16, 5], [17, 3], [18, 1]]);
  return clampPast(rng, at(day, hhmm(h, rng.int(0, 59))));
}

/** A random instant in the evening (people answer chats late too). */
export function anyInstant(rng: Rng, day: DayKey): Date {
  const h = rng.weighted<number>([[7, 1], [8, 3], [9, 5], [10, 5], [11, 5], [12, 4], [13, 5], [14, 5], [15, 5], [16, 5], [17, 4], [18, 3], [19, 2], [20, 1], [21, 1]]);
  return clampPast(rng, at(day, hhmm(h, rng.int(0, 59))));
}

export function plusMin(d: Date, minutes: number): Date { return new Date(d.getTime() + minutes * 60_000); }
export function plusDays(d: Date, days: number): Date { return new Date(d.getTime() + days * DAY_MS); }
export function dayOf(d: Date): DayKey { return todayKeyIn(TZ, d); }
export function minDate(a: Date, b: Date): Date { return a.getTime() <= b.getTime() ? a : b; }
export function maxDate(a: Date, b: Date): Date { return a.getTime() >= b.getTime() ? a : b; }
export function cmpKey(a: DayKey, b: DayKey): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Next 03:00 UTC strictly after `d` — when the auto-archive worker runs. */
export function nextArchiveTick(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 0, 0));
  return t.getTime() > d.getTime() ? t : new Date(t.getTime() + DAY_MS);
}

/** Top of the hour strictly after `d` — when the recurring-tasks worker ticks. */
export function nextHourTick(d: Date): Date {
  const t = new Date(d.getTime());
  t.setUTCMinutes(0, 0, 0);
  return new Date(t.getTime() + 3_600_000);
}

/**
 * Weighted day picker over [from, to]: weekdays heavy, the last two weeks
 * busiest, recent months busier than the distant past.
 */
export class DayPicker {
  private days: DayKey[] = [];
  private cum: number[] = [];
  constructor(from: DayKey, to: DayKey, private today: DayKey) {
    let acc = 0;
    for (let n = keyToDayNumber(from); n <= keyToDayNumber(to); n++) {
      const k = dayNumberToKey(n);
      const wd = weekday(k);
      const dayW = wd === 0 ? 0.08 : wd === 6 ? 0.22 : 1;
      const age = keyToDayNumber(today) - n; // days before today (negative = future)
      const recency = age < 0 ? 1 : age <= 14 ? 3.2 : age <= 60 ? 1.8 : age <= 180 ? 1.3 : 1;
      acc += dayW * recency;
      this.days.push(k);
      this.cum.push(acc);
    }
  }
  pick(rng: Rng): DayKey {
    const r = rng.next() * this.cum[this.cum.length - 1];
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < r) lo = mid + 1; else hi = mid; }
    return this.days[lo];
  }
}

/** A weekday-biased day in [from, to] (inclusive), uniform otherwise. */
export function businessDayBetween(rng: Rng, from: DayKey, to: DayKey): DayKey {
  const a = keyToDayNumber(from), b = keyToDayNumber(to);
  if (b <= a) return from;
  for (let i = 0; i < 8; i++) {
    const k = dayNumberToKey(rng.int(a, b));
    const wd = weekday(k);
    if (wd >= 1 && wd <= 5) return k;
    if (rng.chance(0.2)) return k;
  }
  return dayNumberToKey(rng.int(a, b));
}

// ─────────────────────────────────────────────────────────────── files

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** Minimal valid 8-bit RGB PNG: a solid colour with a darker diagonal stripe so it is visibly an image. */
export function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const stripe = Math.abs(x - y) < 6;
      row[1 + x * 3] = stripe ? rgb[0] >> 1 : rgb[0];
      row[2 + x * 3] = stripe ? rgb[1] >> 1 : rgb[1];
      row[3 + x * 3] = stripe ? rgb[2] >> 1 : rgb[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 16-bit mono PCM WAV: a short decaying tone (a plausible "voice note"). */
export function makeWav(seconds = 1.4, sampleRate = 8000, freq = 330): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-2.2 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    const v = Math.sin(2 * Math.PI * freq * t) * 0.6 + Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.25;
    data.writeInt16LE(Math.round(v * env * 32767 * 0.8), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ─────────────────────────────────────────────────────────────── R2

/** Same wiring as R2StorageService (storage config → S3 client, optional key prefix). */
export class DemoStorage {
  private client: S3Client | null = null;
  private bucket = process.env.R2_BUCKET_NAME || 'taskforge-files';
  private keyPrefix = (process.env.R2_KEY_PREFIX || '').replace(/^\/+|\/+$/g, '');
  constructor() {
    if (this.keyPrefix) this.keyPrefix += '/';
    const accountId = process.env.R2_ACCOUNT_ID, keyId = process.env.R2_ACCESS_KEY_ID, secret = process.env.R2_SECRET_ACCESS_KEY;
    if (accountId && keyId && secret) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: keyId, secretAccessKey: secret },
      });
    }
  }
  isConfigured() { return !!this.client; }
  private prefixed(key: string) { return this.keyPrefix + key.replace(/^\/+/, ''); }
  async upload(key: string, body: Buffer, mimeType: string) {
    if (!this.client) throw new Error('Storage not configured');
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.prefixed(key), Body: body, ContentType: mimeType }));
  }
  async delete(key: string) {
    if (!this.client) return;
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefixed(key) })); } catch { /* best effort */ }
  }
}

// ─────────────────────────────────────────────────────────────── misc

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Fill `{slot}` placeholders from a map. Unknown slots are left as-is. */
export function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{([\w:]+)\}/g, (m, k) => (k in slots ? slots[k] : m));
}

export function truncate(s: string, n = 140): string { return s.length > n ? s.slice(0, n - 3) + '…' : s; }

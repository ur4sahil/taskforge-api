// Unit tests for the URL extraction + OpenGraph parsing logic in unfurl.ts.
// fetchLinkPreview() is NOT tested here because it does network I/O — covered
// indirectly via the messages integration spec when relevant.
import { extractFirstUrl } from '../../src/common/utils/unfurl';

describe('extractFirstUrl', () => {
  it('returns null for plain text without a URL', () => {
    expect(extractFirstUrl('hello world')).toBeNull();
  });

  it('extracts a bare https URL', () => {
    expect(extractFirstUrl('check https://example.com it rules')).toBe('https://example.com/');
  });

  it('extracts an http URL too', () => {
    expect(extractFirstUrl('http://example.org/path?q=1')).toBe('http://example.org/path?q=1');
  });

  it('strips trailing punctuation', () => {
    expect(extractFirstUrl('see https://example.com.')).toBe('https://example.com/');
    expect(extractFirstUrl('(https://example.com)')).toBe('https://example.com/');
    expect(extractFirstUrl('https://example.com?')).toBe('https://example.com/');
  });

  it('returns null for non-http(s) schemes', () => {
    expect(extractFirstUrl('javascript:alert(1)')).toBeNull();
    expect(extractFirstUrl('ftp://files.example.com')).toBeNull();
  });

  it('rejects localhost', () => {
    expect(extractFirstUrl('hit http://localhost/admin')).toBeNull();
  });

  it('rejects loopback IPv4', () => {
    expect(extractFirstUrl('http://127.0.0.1:3000')).toBeNull();
  });

  it('rejects RFC1918 private ranges', () => {
    expect(extractFirstUrl('http://10.0.0.1')).toBeNull();
    expect(extractFirstUrl('http://192.168.1.5')).toBeNull();
    expect(extractFirstUrl('http://172.16.0.1')).toBeNull();
    expect(extractFirstUrl('http://172.31.99.99')).toBeNull();
  });

  it('allows 172.32.x.x (outside RFC1918)', () => {
    expect(extractFirstUrl('http://172.32.0.1')).toBe('http://172.32.0.1/');
  });

  it('rejects IPv6 loopback / link-local', () => {
    expect(extractFirstUrl('http://[::1]')).toBeNull();
  });

  it('only extracts the FIRST URL when many are present', () => {
    const out = extractFirstUrl('https://a.com https://b.com');
    expect(out).toBe('https://a.com/');
  });

  it('returns null for malformed-looking input that can\'t be parsed', () => {
    expect(extractFirstUrl('https://')).toBeNull();
  });
});

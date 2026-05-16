// Tests for the OpenGraph extraction logic in unfurl.ts. parseOpenGraph isn't
// exported, so we exercise it via fetchLinkPreview with a stubbed global.fetch
// that returns canned HTML — this is also the real production code path.
import { fetchLinkPreview, extractFirstUrl } from '../../src/common/utils/unfurl';

function stubFetch(html: string, contentType = 'text/html; charset=utf-8') {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (k: string) => k.toLowerCase() === 'content-type' ? contentType : null },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(html) };
          },
          cancel: async () => {},
        };
      },
    },
  }) as any;
}

afterEach(() => { delete (globalThis as any).fetch; });

describe('fetchLinkPreview (parseOpenGraph)', () => {
  it('returns null for invalid URLs (does not call fetch)', async () => {
    globalThis.fetch = jest.fn() as any;
    const out = await fetchLinkPreview('not-a-url');
    expect(out).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns null when fetch responds non-OK', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    expect(await fetchLinkPreview('https://example.com')).toBeNull();
  });

  it('returns null when response is not text/html', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
    }) as any;
    expect(await fetchLinkPreview('https://example.com')).toBeNull();
  });

  it('extracts og:title + og:description + og:image + og:site_name', async () => {
    stubFetch(`<html><head>
      <meta property="og:title" content="Hello world">
      <meta property="og:description" content="A friendly greeting">
      <meta property="og:image" content="https://example.com/cover.png">
      <meta property="og:site_name" content="Example">
    </head></html>`);
    const out = await fetchLinkPreview('https://example.com');
    expect(out).toMatchObject({
      url: 'https://example.com/',
      title: 'Hello world',
      description: 'A friendly greeting',
      image: 'https://example.com/cover.png',
      siteName: 'Example',
    });
  });

  it('falls back to twitter: tags when og: is absent', async () => {
    stubFetch(`<html><head>
      <meta name="twitter:title" content="Tweet title">
      <meta name="twitter:description" content="Tweet desc">
      <meta name="twitter:image" content="https://twimg.example/x.jpg">
    </head></html>`);
    const out = await fetchLinkPreview('https://example.com');
    expect(out!.title).toBe('Tweet title');
    expect(out!.description).toBe('Tweet desc');
    expect(out!.image).toBe('https://twimg.example/x.jpg');
  });

  it('falls back to <title> when neither og: nor twitter: title is present', async () => {
    stubFetch(`<html><head><title>  Plain title  </title></head></html>`);
    const out = await fetchLinkPreview('https://example.com');
    expect(out!.title).toBe('Plain title');
  });

  it('falls back to meta name="description" when og + twitter description absent', async () => {
    stubFetch(`<html><head><meta name="description" content="Plain description"></head></html>`);
    const out = await fetchLinkPreview('https://example.com');
    expect(out!.description).toBe('Plain description');
  });

  it('handles meta tags with single quotes', async () => {
    stubFetch(`<html><head><meta property='og:title' content='Single-quoted'></head></html>`);
    const out = await fetchLinkPreview('https://example.com');
    expect(out!.title).toBe('Single-quoted');
  });

  it('handles attribute order with content= before name/property=', async () => {
    stubFetch(`<html><head><meta content="Reversed order" property="og:title"></head></html>`);
    const out = await fetchLinkPreview('https://example.com');
    expect(out!.title).toBe('Reversed order');
  });

  it('truncates very long title/description/siteName', async () => {
    const longTitle = 'A'.repeat(300);
    const longDesc = 'B'.repeat(500);
    const longSite = 'C'.repeat(200);
    stubFetch(`<html><head>
      <meta property="og:title" content="${longTitle}">
      <meta property="og:description" content="${longDesc}">
      <meta property="og:site_name" content="${longSite}">
    </head></html>`);
    const out = await fetchLinkPreview('https://example.com');
    expect(out!.title!.length).toBe(200);
    expect(out!.description!.length).toBe(300);
    expect(out!.siteName!.length).toBe(100);
  });

  it('refuses to fetch private/loopback hosts (extractFirstUrl gate)', async () => {
    globalThis.fetch = jest.fn() as any;
    expect(await fetchLinkPreview('http://127.0.0.1/secret')).toBeNull();
    expect(await fetchLinkPreview('http://10.0.0.1')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('extractFirstUrl + fetchLinkPreview cooperate — message body input works', async () => {
    stubFetch(`<html><head><title>Forge</title></head></html>`);
    // fetchLinkPreview also routes via extractFirstUrl internally.
    const out = await fetchLinkPreview('see https://example.com for more.');
    expect(out!.title).toBe('Forge');
    expect(extractFirstUrl('see https://example.com for more.')).toBe('https://example.com/');
  });
});

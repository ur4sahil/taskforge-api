import { generateSlug, generateInboundEmail } from '../../src/common/utils/slug';

describe('generateSlug', () => {
  it('produces a lowercased, dash-separated slug from a multi-word name', () => {
    const slug = generateSlug('My Awesome Workspace');
    expect(slug.startsWith('my-awesome-workspace-')).toBe(true);
  });

  it('strips special characters and emoji-like punctuation', () => {
    const slug = generateSlug('Hello, World! @#$%^&*()');
    // strict mode strips non-alphanumeric chars; result should only contain a-z, 0-9, dashes
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith('hello-world-')).toBe(true);
  });

  it('returns just the uuid suffix (prefixed by a dash) for an empty name', () => {
    const slug = generateSlug('');
    // slugify('') is '', so result is '-<6 hex chars>'
    expect(slug).toMatch(/^-[a-f0-9]{6}$/);
  });

  it('appends a 6-character lowercase hex/uuid suffix after a single dash', () => {
    const slug = generateSlug('Test');
    const parts = slug.split('-');
    const suffix = parts[parts.length - 1];
    expect(suffix).toHaveLength(6);
    // uuid v4 segments are hex chars 0-9a-f
    expect(suffix).toMatch(/^[a-f0-9]{6}$/);
  });

  it('produces unique slugs across many invocations with the same input', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 500; i++) {
      slugs.add(generateSlug('Same Name'));
    }
    // overwhelmingly unique — collisions across 500 random 24-bit suffixes are extremely rare
    expect(slugs.size).toBeGreaterThanOrEqual(499);
  });

  it('handles unicode input by stripping or transliterating to ascii', () => {
    const slug = generateSlug('Café Über Naïve');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    // suffix is still appended
    expect(slug.split('-').pop()).toMatch(/^[a-f0-9]{6}$/);
  });
});

describe('generateInboundEmail', () => {
  it('returns a full uuid (8-4-4-4-12) at the given domain', () => {
    const email = generateInboundEmail('inbound.test.local');
    expect(email).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}@inbound\.test\.local$/,
    );
  });

  it('produces unique addresses across many invocations', () => {
    const emails = new Set<string>();
    for (let i = 0; i < 200; i++) {
      emails.add(generateInboundEmail('example.com'));
    }
    expect(emails.size).toBe(200);
  });
});

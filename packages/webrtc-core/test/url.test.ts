import { describe, it, expect } from 'vitest';
import { rewriteWsScheme, stripTrailingSlashes, toWsUrl } from '../src/url';
import { buildBrowserWsUrl } from '../src/ws-ticket';

describe('stripTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(stripTrailingSlashes('http://h/')).toBe('http://h');
    expect(stripTrailingSlashes('http://h///')).toBe('http://h');
    expect(stripTrailingSlashes('http://h/a/')).toBe('http://h/a');
    expect(stripTrailingSlashes('http://h')).toBe('http://h');
  });
});

describe('toWsUrl', () => {
  it('rewrites http→ws and https→wss', () => {
    expect(toWsUrl('http://h:8787/x')).toBe('ws://h:8787/x');
    expect(toWsUrl('https://h/x')).toBe('wss://h/x');
  });

  it('passes ws/wss through', () => {
    expect(toWsUrl('ws://h/p')).toBe('ws://h/p');
    expect(toWsUrl('wss://h/p')).toBe('wss://h/p');
  });

  it('trims trailing slashes', () => {
    expect(toWsUrl('http://h/')).toBe('ws://h');
    expect(toWsUrl('ws://h/')).toBe('ws://h');
  });

  it('throws on any other scheme', () => {
    expect(() => toWsUrl('ftp://h/p')).toThrow();
    expect(() => toWsUrl('')).toThrow();
    expect(() => toWsUrl('localhost:8787')).toThrow();
  });
});

describe('buildBrowserWsUrl', () => {
  it('keeps the historical output for every accepted scheme', () => {
    expect(buildBrowserWsUrl('http://h', 't1')).toBe(
      'ws://h/api/ws/browser?ticket=t1',
    );
    expect(buildBrowserWsUrl('https://h', 't1')).toBe(
      'wss://h/api/ws/browser?ticket=t1',
    );
    expect(buildBrowserWsUrl('ws://h', 't1')).toBe(
      'ws://h/api/ws/browser?ticket=t1',
    );
    expect(buildBrowserWsUrl('wss://h', 't1')).toBe(
      'wss://h/api/ws/browser?ticket=t1',
    );
  });

  it('URL-encodes the ticket', () => {
    expect(buildBrowserWsUrl('http://h', 'a b')).toBe(
      'ws://h/api/ws/browser?ticket=a%20b',
    );
  });
});

describe('rewriteWsScheme', () => {
  it('rewrites http to ws', () => {
    expect(rewriteWsScheme('http://localhost:8787/api/ws/agent')).toBe(
      'ws://localhost:8787/api/ws/agent',
    );
  });

  it('rewrites https to wss', () => {
    expect(rewriteWsScheme('https://signal.example.com/x')).toBe(
      'wss://signal.example.com/x',
    );
  });

  it('passes ws and wss through unchanged', () => {
    expect(rewriteWsScheme('ws://h/p')).toBe('ws://h/p');
    expect(rewriteWsScheme('wss://h/p')).toBe('wss://h/p');
  });

  it('trims a trailing path slash', () => {
    expect(rewriteWsScheme('http://h/p/')).toBe('ws://h/p');
    expect(rewriteWsScheme('ws://h/')).toBe('ws://h');
  });

  it('does not append a path of its own', () => {
    expect(
      rewriteWsScheme('http://h:8787/api/ws/agent').match(/\/api\/ws\/agent/g),
    ).toHaveLength(1);
  });

  it('preserves a query value that ends in a slash', () => {
    // The regression the split-before-trim ordering exists for: a whole-string
    // trim would drop this slash and change what the server receives.
    expect(rewriteWsScheme('wss://signal.example/api/ws/agent?next=/')).toBe(
      'wss://signal.example/api/ws/agent?next=/',
    );
  });

  it('preserves a query value through an https rewrite', () => {
    expect(rewriteWsScheme('https://signal.example/api/ws/agent?scope=/')).toBe(
      'wss://signal.example/api/ws/agent?scope=/',
    );
  });

  it('trims the path slash before the query without altering the query', () => {
    expect(rewriteWsScheme('http://h/p/?q=1/')).toBe('ws://h/p?q=1/');
  });

  it('preserves a fragment byte for byte', () => {
    expect(rewriteWsScheme('http://h/p/#frag')).toBe('ws://h/p#frag');
  });

  it('rejects an unknown scheme and the empty string', () => {
    expect(() => rewriteWsScheme('ftp://h/p')).toThrow(
      /unsupported URL scheme/,
    );
    expect(() => rewriteWsScheme('')).toThrow(/unsupported URL scheme/);
  });

  it('leaves the agent CLI default URL unchanged', () => {
    expect(rewriteWsScheme('ws://localhost:8787/api/ws/agent')).toBe(
      'ws://localhost:8787/api/ws/agent',
    );
  });

  it('differs from toWsUrl exactly where a query or fragment is present', () => {
    // This pins why the two functions coexist. If someone later "simplifies"
    // one into the other, this case fails.
    expect(toWsUrl('http://h/a/?next=/')).toBe('ws://h/a/?next=');
    expect(rewriteWsScheme('http://h/a/?next=/')).toBe('ws://h/a?next=/');
  });
});

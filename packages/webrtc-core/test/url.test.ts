import { describe, it, expect } from 'vitest';
import { stripTrailingSlashes, toWsUrl } from '../src/url';
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

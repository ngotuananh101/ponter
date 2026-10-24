import { describe, expect, it } from 'vitest';
import { buildUpgradeHeaders } from '../../src/signalling/upgrade.js';

describe('buildUpgradeHeaders', () => {
  it('sets a bearer Authorization header', () => {
    expect(buildUpgradeHeaders('ag_secret')).toEqual({
      Authorization: 'Bearer ag_secret',
    });
  });

  it('rejects a credential carrying a control character', () => {
    expect(() => buildUpgradeHeaders('bad\nvalue')).toThrow(
      /not a valid header value/,
    );
  });

  it('rejects a credential carrying a space', () => {
    expect(() => buildUpgradeHeaders('bad value')).toThrow(
      /not a valid header value/,
    );
  });

  it('never puts the credential in a query string', () => {
    const headers = buildUpgradeHeaders('ag_secret');
    expect(Object.keys(headers)).toEqual(['Authorization']);
    expect(JSON.stringify(headers)).not.toMatch(/\?/);
  });
});

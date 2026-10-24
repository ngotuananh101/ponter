import { describe, expect, it } from 'vitest';
import { classifyClose } from '../../src/signalling/close.js';

describe('classifyClose', () => {
  it('treats 4409 (replaced) as terminal', () => {
    expect(classifyClose(4409)).toEqual({ kind: 'terminal', code: 4409 });
  });

  it('treats 4401 (unauthorized) as terminal', () => {
    expect(classifyClose(4401)).toEqual({ kind: 'terminal', code: 4401 });
  });

  it('treats a normal close as transient', () => {
    expect(classifyClose(1000)).toEqual({ kind: 'transient' });
    expect(classifyClose(1001)).toEqual({ kind: 'transient' });
  });

  it('treats a missing close frame as transient', () => {
    // A socket that dies without a close frame is exactly the case reconnect
    // exists for.
    expect(classifyClose(null)).toEqual({ kind: 'transient' });
  });

  it('treats an unmapped application code as transient', () => {
    expect(classifyClose(4400)).toEqual({ kind: 'transient' });
    expect(classifyClose(1013)).toEqual({ kind: 'transient' });
  });
});

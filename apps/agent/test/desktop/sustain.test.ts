// apps/agent/test/desktop/sustain.test.ts
import { describe, expect, it } from 'vitest';
import { SUSTAIN_FRAMES, SustainLadder } from '../../src/desktop/sustain.js';

describe('the ladder', () => {
  it('downgrades 1080p60 to 720p60 after 30 over-budget frames', () => {
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES - 1; i += 1)
      expect(ladder.noteFrame(40)).toBeNull();
    expect(ladder.noteFrame(40)).toBe('720p60');
  });

  it('needs a STRICTLY greater encode time', () => {
    // Exactly on budget is on budget. A `>=` here would downgrade a stream that
    // is meeting its target every frame.
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES * 2; i += 1)
      expect(ladder.noteFrame(16.7)).toBeNull();
  });

  it('resets the counter on any single on-budget frame', () => {
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < 29; i += 1) ladder.noteFrame(40);
    expect(ladder.consecutive()).toBe(29);
    expect(ladder.noteFrame(10)).toBeNull();
    expect(ladder.consecutive()).toBe(0);
  });

  it('walks the whole ladder down to the floor and stops', () => {
    const steps: string[] = [];
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let rung = 0; rung < 4; rung += 1) {
      for (let i = 0; i < SUSTAIN_FRAMES; i += 1) {
        const next = ladder.noteFrame(40);
        if (next) steps.push(next);
      }
    }
    expect(steps).toEqual(['720p60', '720p30']);
    expect(ladder.current()).toBe('720p30');
  });

  it('has 720p30 as the floor, so its successor is null', () => {
    const ladder = new SustainLadder('720p30', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p30');
    expect(ladder.consecutive()).toBe(0);
  });

  it('sends 1080p30 to 720p30 in one step', () => {
    const ladder = new SustainLadder('1080p30', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES - 1; i += 1) ladder.noteFrame(40);
    expect(ladder.noteFrame(40)).toBe('720p30');
  });
});

describe('noteBitrateChange', () => {
  it('re-opens the latch above the floor so the stream can climb back', () => {
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p60');
    ladder.noteBitrateChange(8_000_000);
    for (let i = 0; i < SUSTAIN_FRAMES - 1; i += 1) ladder.noteFrame(40);
    expect(ladder.noteFrame(40)).toBe('720p30');
  });

  it('does nothing at the floor', () => {
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES * 4; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p30');
    ladder.noteBitrateChange(8_000_000);
    for (let i = 0; i < SUSTAIN_FRAMES; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p30');
  });

  it('resets a partial streak when a retarget re-arms it above the floor', () => {
    // The trip itself zeroes the counter, so `re-opens the latch above the
    // floor` calls `noteBitrateChange` when it is already zero and cannot see
    // the reset. A partial streak makes it observable.
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < 10; i += 1) ladder.noteFrame(40);
    expect(ladder.consecutive()).toBe(10);
    ladder.noteBitrateChange(8_000_000);
    expect(ladder.consecutive()).toBe(0);
  });

  it('leaves a partial streak alone at the floor', () => {
    // ADR-24: with no lower rung, a retarget is not a fresh evaluation request,
    // so it must not re-arm the streak. This port carries no separate `latched`
    // flag — the trip zeroes the counter and the floor returns `null` forever —
    // so the counter is the only surface the floor guard has.
    const ladder = new SustainLadder('720p30', 16.7);
    for (let i = 0; i < 10; i += 1) ladder.noteFrame(40);
    expect(ladder.consecutive()).toBe(10);
    ladder.noteBitrateChange(8_000_000);
    expect(ladder.consecutive()).toBe(10);
  });

  it('updates neither the budget nor the next rung', () => {
    // A bitrate change re-opens the latch and nothing else. Recomputing the
    // budget from the new bitrate would make the ladder's threshold depend on
    // the client's bandwidth, which is the opposite of what it measures.
    const ladder = new SustainLadder('1080p60', 16.7);
    ladder.noteBitrateChange(20_000_000);
    for (let i = 0; i < SUSTAIN_FRAMES; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p60');
  });
});

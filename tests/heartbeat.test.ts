import { expect, test } from 'bun:test';
import { heartbeatAction } from '../src/lib/signaling/client';

test('a late tick after an answered ping pings again instead of timing out', () => {
  // Ping at 0, pong at 100 ms, next tick a minute late (throttled hidden tab).
  expect(heartbeatAction(60_000, 0, 100)).toBe('ping');
  // Nothing sent yet since the socket opened.
  expect(heartbeatAction(60_000, 0, 0)).toBe('ping');
});

test('an unanswered ping times out only after its own deadline', () => {
  expect(heartbeatAction(12_000, 1_000, 500)).toBe('wait');
  expect(heartbeatAction(21_000, 1_000, 500)).toBe('wait');
  expect(heartbeatAction(21_001, 1_000, 500)).toBe('timeout');
});

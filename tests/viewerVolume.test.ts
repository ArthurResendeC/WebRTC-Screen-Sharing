import { beforeEach, expect, test } from 'bun:test';
import {
  recallViewerVolume,
  rememberViewerVolume,
} from '../src/client/viewerVolume';

const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: key => values.get(key) ?? null,
  key: index => [...values.keys()][index] ?? null,
  removeItem: key => void values.delete(key),
  setItem: (key, value) => void values.set(key, value),
};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

beforeEach(() => storage.clear());

test('viewer volume defaults to full volume', () => {
  expect(recallViewerVolume()).toBe(1);
});

test('viewer volume round-trips through storage', () => {
  rememberViewerVolume(0.35);
  expect(recallViewerVolume()).toBe(0.35);
});

test('viewer volume is clamped to the media element range', () => {
  rememberViewerVolume(1.8);
  expect(recallViewerVolume()).toBe(1);
  rememberViewerVolume(-0.2);
  expect(recallViewerVolume()).toBe(0);
});

test('corrupt stored viewer volume falls back to full volume', () => {
  storage.setItem('screen-share:viewer-volume', 'loud');
  expect(recallViewerVolume()).toBe(1);
  storage.setItem('screen-share:viewer-volume', '');
  expect(recallViewerVolume()).toBe(1);
});

test('blocked storage keeps the default volume usable', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  try {
    expect(() => rememberViewerVolume(0.5)).not.toThrow();
    expect(recallViewerVolume()).toBe(1);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
  }
});

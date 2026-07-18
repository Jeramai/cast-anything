/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import {
  CONVERT_QUALITY_TUNING,
  DEFAULT_CONVERT_QUALITY,
  toConvertQuality,
  type ConvertQuality,
} from './quality';

describe('convert quality presets', () => {
  test('best keeps source fps, full bitrate, 1080p', () => {
    expect(CONVERT_QUALITY_TUNING.best).toEqual({ maxFps: 0, bitRateMbps: 8, maxHeight: 1080, maxWidth: 1920 });
  });

  test('balanced caps fps but keeps bitrate + 1080p', () => {
    expect(CONVERT_QUALITY_TUNING.balanced).toEqual({ maxFps: 30, bitRateMbps: 8, maxHeight: 1080, maxWidth: 1920 });
  });

  test('fastest caps fps, lowers bitrate, drops to 720p', () => {
    expect(CONVERT_QUALITY_TUNING.fastest).toEqual({ maxFps: 30, bitRateMbps: 6, maxHeight: 720, maxWidth: 1280 });
  });

  test('default favors speed', () => {
    expect(DEFAULT_CONVERT_QUALITY).toBe('fastest');
  });

  test('speed ordering: fastest ≤ balanced ≤ best on every lever', () => {
    const order: ConvertQuality[] = ['fastest', 'balanced', 'best'];
    for (let i = 1; i < order.length; i++) {
      const prev = CONVERT_QUALITY_TUNING[order[i - 1]];
      const cur = CONVERT_QUALITY_TUNING[order[i]];
      // Higher quality never encodes fewer frames, fewer bits, or fewer pixels.
      const prevFps = prev.maxFps === 0 ? Infinity : prev.maxFps;
      const curFps = cur.maxFps === 0 ? Infinity : cur.maxFps;
      expect(curFps).toBeGreaterThanOrEqual(prevFps);
      expect(cur.bitRateMbps).toBeGreaterThanOrEqual(prev.bitRateMbps);
      expect(cur.maxHeight).toBeGreaterThanOrEqual(prev.maxHeight);
      expect(cur.maxWidth).toBeGreaterThanOrEqual(prev.maxWidth);
    }
  });
});

describe('toConvertQuality', () => {
  test('passes through valid values', () => {
    expect(toConvertQuality('best')).toBe('best');
    expect(toConvertQuality('balanced')).toBe('balanced');
    expect(toConvertQuality('fastest')).toBe('fastest');
  });

  test('falls back to the default for junk / undefined', () => {
    expect(toConvertQuality('720p')).toBe(DEFAULT_CONVERT_QUALITY);
    expect(toConvertQuality(undefined)).toBe(DEFAULT_CONVERT_QUALITY);
    expect(toConvertQuality(null)).toBe(DEFAULT_CONVERT_QUALITY);
    expect(toConvertQuality(42)).toBe(DEFAULT_CONVERT_QUALITY);
  });
});

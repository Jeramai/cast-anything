/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { formatTime } from './formatTime';

describe('formatTime', () => {
  test('formats sub-hour durations as m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9)).toBe('0:09');
    expect(formatTime(59)).toBe('0:59');
    expect(formatTime(60)).toBe('1:00');
    expect(formatTime(84)).toBe('1:24');
    expect(formatTime(600)).toBe('10:00');
  });

  test('shows hours once past an hour as h:mm:ss', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3661)).toBe('1:01:01');
    expect(formatTime(37230)).toBe('10:20:30');
  });

  test('floors fractional seconds', () => {
    expect(formatTime(90.7)).toBe('1:30');
    expect(formatTime(3600.99)).toBe('1:00:00');
  });

  test('clamps negatives to zero', () => {
    expect(formatTime(-5)).toBe('0:00');
    expect(formatTime(-3600)).toBe('0:00');
  });
});

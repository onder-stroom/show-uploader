import { describe, expect, it } from 'vitest';
import { formatShortcut } from '../../src/upload/shortcuts';

describe('formatShortcut', () => {
  it('writes modifiers as symbols on a Mac', () => {
    expect(formatShortcut('mod+z', true)).toBe('⌘Z');
    expect(formatShortcut('mod+shift+z', true)).toBe('⌘⇧Z');
    expect(formatShortcut('shift+i', true)).toBe('⇧I');
  });

  it('writes them as words elsewhere', () => {
    expect(formatShortcut('mod+z', false)).toBe('ctrl+Z');
    expect(formatShortcut('mod+shift+z', false)).toBe('ctrl+shift+Z');
  });

  it('names the keys that have no letter', () => {
    expect(formatShortcut('space', true)).toBe('space');
    expect(formatShortcut('up', false)).toBe('↑');
    expect(formatShortcut('shift+slash', false)).toBe('shift+/');
  });
});

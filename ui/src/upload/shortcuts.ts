const isMac = () => typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '');

const NAMES: Record<string, string> = { space: 'space', up: '↑', down: '↓', left: '←', right: '→', slash: '/', enter: '↵', escape: 'esc' };

/** A react-hotkeys-hook key combo as the operator reads it: "mod+shift+z" is "⌘⇧Z" on a Mac. */
export function formatShortcut(combo: string, mac = isMac()): string {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  const mods = parts.map((m) => {
    if (m === 'mod') return mac ? '⌘' : 'ctrl';
    if (m === 'shift') return mac ? '⇧' : 'shift';
    if (m === 'alt') return mac ? '⌥' : 'alt';
    return m;
  });
  const name = NAMES[key] ?? key.toUpperCase();
  return mac ? [...mods, name].join('') : [...mods, name].join('+');
}

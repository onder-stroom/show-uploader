/**
 * J/K/L shuttle, as in Premiere. A rate is signed: positive plays forward, negative plays
 * backwards, 0 is paused. Pressing the same direction again adds half a step.
 */
export const MAX_RATE = 8;
const STEP = 0.5;

export type ShuttleKey = 'j' | 'k' | 'l' | 'space';

export function nextShuttleRate(rate: number, key: ShuttleKey): number {
  switch (key) {
    case 'k': return 0;
    case 'space': return rate === 0 ? 1 : 0;
    case 'l': return rate > 0 ? Math.min(MAX_RATE, rate + STEP) : 1;
    case 'j': return rate < 0 ? Math.max(-MAX_RATE, rate - STEP) : -1;
  }
}

export function shuttleLabel(rate: number): string {
  if (rate === 0) return 'paused';
  return `${rate > 0 ? '▶' : '◀'} ${Math.abs(rate)}×`;
}

/**
 * Browsers cannot play a video backwards, so reverse steps the playhead back by hand.
 * `done` is true once it reaches the start.
 */
export function reverseStep(timeS: number, dtS: number, rate: number): { time: number; done: boolean } {
  const time = Math.max(0, timeS + rate * dtS);
  return { time, done: time <= 0 };
}

/**
 * Where a key belongs to the control, not to the editor: text entry, a menu or a dialog. Like the
 * Clipper, buttons and range sliders are not on the list: after a click or a drag they keep
 * focus, and the shortcuts must keep working.
 */
const CONTROL_SELECTOR =
  'textarea, select, input:not([type="range"]), [contenteditable=""], [contenteditable="true"], ' +
  '[role="combobox"], [role="option"], [role="listbox"], [role="menuitem"], [role="dialog"]';

export function isControlTarget(el: { closest(selector: string): unknown } | null): boolean {
  return !!el && el.closest(CONTROL_SELECTOR) !== null;
}

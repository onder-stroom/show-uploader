import { useHotkeys } from 'react-hotkeys-hook';
import { isControlTarget, type ShuttleKey } from './shuttle';

export type EditorKeys = {
  shuttle(key: ShuttleKey): void;
  markIn(): void;
  markOut(): void;
  goToIn(): void;
  goToOut(): void;
  undo(): void;
  redo(): void;
  toggleSheet(): void;
};

/**
 * Every editor shortcut, registered once. The descriptions are what the cheat sheet lists, read
 * back from react-hotkeys-hook, so a key is never documented in two places. I, O and Space are the
 * Coming Soon Clipper's keys; the rest are Premiere's.
 */
export function useEditorHotkeys(a: EditorKeys) {
  const base = {
    preventDefault: true,
    // Our own check says where a key belongs to a control (see isControlTarget); the library's
    // blanket rule for form tags would also swallow keys after a trim handle was dragged.
    enableOnFormTags: true,
    ignoreEventWhen: (e: KeyboardEvent) => isControlTarget(e.target as Element | null),
  };
  useHotkeys('space', () => a.shuttle('space'), { ...base, description: 'play / pause' });
  useHotkeys('k', () => a.shuttle('k'), { ...base, description: 'pause' });
  useHotkeys('l', () => a.shuttle('l'), { ...base, description: 'play forward, half a speed faster per press (max 8×)' });
  useHotkeys('j', () => a.shuttle('j'), { ...base, description: 'play backwards, half a speed faster per press (max 8×)' });
  useHotkeys('i', a.markIn, { ...base, description: 'IN: set the in point at the playhead' });
  useHotkeys('o', a.markOut, { ...base, description: 'OUT: set the out point at the playhead' });
  useHotkeys('shift+i', a.goToIn, { ...base, description: 'move the playhead to the in point' });
  useHotkeys('shift+o', a.goToOut, { ...base, description: 'move the playhead to the out point' });
  useHotkeys('mod+z', a.undo, { ...base, description: 'undo' });
  useHotkeys(['mod+shift+z', 'mod+y'], a.redo, { ...base, description: 'redo' });
  useHotkeys('shift+slash', a.toggleSheet, { ...base, description: 'show or hide this list' });
}

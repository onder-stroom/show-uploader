import { useCallback, useRef } from 'react';
import useUndo from 'use-undo';
import type { Draft } from './segments';

/** Edits to one segment this close together (a drag fires one per pixel) are a single undo step. */
export const MERGE_MS = 500;

/**
 * The editor's segments with undo/redo. The stack is use-undo's; this only decides which edits
 * start a new step: one with a different key, or after a pause, does; a burst under one key does not.
 */
export function useSegmentHistory(initial: Draft[]) {
  const [state, actions] = useUndo<Draft[]>(initial, { useCheckpoints: true });
  const last = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  // Several edits can land before the next render; each must build on the one before.
  const present = useRef(state.present);
  present.current = state.present;

  const commit = useCallback(
    (next: Draft[] | ((prev: Draft[]) => Draft[]), key: string | null = null) => {
      const value = typeof next === 'function' ? next(present.current) : next;
      const now = Date.now();
      const merge = key !== null && last.current.key === key && now - last.current.at < MERGE_MS;
      last.current = { key, at: now };
      present.current = value;
      actions.set(value, !merge);
    },
    [actions.set]
  );

  const undo = useCallback(() => {
    last.current = { key: null, at: 0 };
    actions.undo();
  }, [actions.undo]);
  const redo = useCallback(() => {
    last.current = { key: null, at: 0 };
    actions.redo();
  }, [actions.redo]);

  return { segments: state.present, commit, undo, redo, canUndo: actions.canUndo, canRedo: actions.canRedo };
}

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { nextShuttleRate, reverseStep, type ShuttleKey } from './shuttle';

/**
 * J/K/L shuttle on a <video>. Forward is the element's own playbackRate. Browsers cannot play
 * backwards, so reverse pauses the video and steps its currentTime back every animation frame.
 * Spread `videoProps` onto the element so its own controls keep the state honest.
 */
export function useShuttle(video: RefObject<HTMLVideoElement | null>, seek: (seconds: number) => void) {
  const [rate, setRate] = useState(0);
  const rateRef = useRef(0);
  const frame = useRef<number | null>(null);
  // Set while reverse owns the (paused) video, so its pause event is not read as the operator's.
  const reversing = useRef(false);

  const stopReverse = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    reversing.current = false;
  }, []);

  const apply = useCallback(
    (next: number) => {
      rateRef.current = next;
      setRate(next);
      stopReverse();
      const el = video.current;
      if (!el) return;
      if (next > 0) {
        el.playbackRate = next;
        el.play().catch(() => {
          rateRef.current = 0;
          setRate(0);
        });
      } else if (next === 0) {
        el.pause();
      } else {
        reversing.current = true;
        el.pause();
        let last = performance.now();
        const tick = (now: number) => {
          const { time, done } = reverseStep(el.currentTime, (now - last) / 1000, rateRef.current);
          last = now;
          seek(time);
          if (done) {
            stopReverse();
            rateRef.current = 0;
            setRate(0);
            return;
          }
          frame.current = requestAnimationFrame(tick);
        };
        frame.current = requestAnimationFrame(tick);
      }
    },
    [video, seek, stopReverse]
  );

  const press = useCallback((key: ShuttleKey) => apply(nextShuttleRate(rateRef.current, key)), [apply]);
  useEffect(() => stopReverse, [stopReverse]);

  const videoProps = {
    // The video's own play button: play at 1x.
    onPlay: () => {
      if (reversing.current || rateRef.current > 0) return;
      rateRef.current = 1;
      setRate(1);
    },
    onPause: () => {
      if (reversing.current || rateRef.current === 0) return;
      rateRef.current = 0;
      setRate(0);
    },
    onEnded: () => {
      rateRef.current = 0;
      setRate(0);
    },
  };

  return { rate, press, videoProps };
}

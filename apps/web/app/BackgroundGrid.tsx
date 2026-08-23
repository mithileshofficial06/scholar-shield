'use client';

import { useEffect, useRef } from 'react';

/**
 * Two independent background layers, deliberately driven by different things.
 *
 *   .bg-drift   a fine grid crawling steadily upward. Pure CSS animation, runs
 *               whether or not anyone touches the page. This is the "live" layer.
 *
 *   .bg-react   a coarse grid driven only by scroll position, and moved on
 *               different axes than the drift — it sweeps sideways, pushes
 *               downward against the drift's upward crawl, and tilts slightly.
 *
 * The separation is the point: the idle motion and the scroll response never
 * share an axis, so scrolling reads as acting on the page rather than as merely
 * speeding up the animation already playing.
 *
 * Scroll work is confined to a rAF-batched custom-property write — no React state
 * per frame, no re-render, and the listener is passive so it never blocks scroll.
 */
export function BackgroundGrid() {
  const reactiveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = reactiveRef.current;
    if (!el) return;

    // Honour the OS setting: no scroll-linked movement for people who asked for
    // less motion. The CSS handles the drift layer separately.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;

    let frame = 0;

    const apply = () => {
      frame = 0;
      const y = window.scrollY;

      // Sideways sweep — an axis the drift layer never uses.
      el.style.setProperty('--scroll-x', `${(y * 0.28).toFixed(1)}px`);
      // Downward push, against the drift's upward crawl.
      el.style.setProperty('--scroll-y', `${(y * 0.16).toFixed(1)}px`);
      // Small tilt, capped so the grid skews rather than spins.
      el.style.setProperty('--scroll-tilt', `${Math.min(y / 260, 3.5).toFixed(2)}deg`);
    };

    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="bg-field" aria-hidden="true">
      <div className="bg-drift" />
      <div className="bg-react" ref={reactiveRef} />
      <div className="bg-vignette" />
    </div>
  );
}

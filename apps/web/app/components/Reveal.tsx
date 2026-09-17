'use client';

import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from 'react';

interface RevealProps {
  children: ReactNode;
  /** Position in a staggered group; each step adds a short delay. */
  index?: number;
  as?: ElementType;
  className?: string;
}

/**
 * Fades and lifts its content into place the first time it scrolls into view.
 *
 * Content is only hidden once the `js` class is on <html> (set by an inline
 * script in the layout), so a page that never hydrates still shows everything.
 * Revealing once, rather than on every entry, keeps the page calm when someone
 * scrolls back up to re-read a section.
 */
export function Reveal({ children, index = 0, as: Tag = 'div', className = '' }: RevealProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={`reveal ${className}`.trim()}
      style={{ '--i': index } as CSSProperties}
    >
      {children}
    </Tag>
  );
}

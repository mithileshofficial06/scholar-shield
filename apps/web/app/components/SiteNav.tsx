'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/apply', label: 'Apply' },
  { href: '/dashboard', label: 'Reviewer queue' },
];

/** Primary navigation. A client component only so it can mark the current page. */
export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="nav" aria-label="Primary">
      {NAV.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-link${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const PUBLIC = [
  { href: '/', label: 'Overview' },
  { href: '/apply', label: 'Apply' },
];

const STAFF = [{ href: '/dashboard', label: 'Queue' }];
const ADMIN = [{ href: '/admin', label: 'Admin' }];

/**
 * Primary navigation.
 *
 * Staff links appear only for a staff session. That is a courtesy, not a
 * control: every one of those routes checks the session itself, and hiding a
 * link has never stopped anyone from typing a URL.
 */
export function SiteNav({ role }: { role?: string | null }) {
  const pathname = usePathname();
  const isStaff = role === 'reviewer' || role === 'admin';

  const items = [
    ...PUBLIC,
    // Signed out, an applicant's way back in is a new emailed link, not the
    // staff sign-in button beside this nav — so it gets its own entry.
    ...(role === 'applicant'
      ? [{ href: '/status', label: 'My application' }]
      : !role
        ? [{ href: '/status', label: 'Check my application' }]
        : []),
    ...(isStaff ? STAFF : []),
    ...(role === 'admin' ? ADMIN : []),
  ];

  return (
    <nav className="nav" aria-label="Primary">
      {items.map((item) => {
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

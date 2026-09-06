'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export type NavItem = { href: string; label: string };

function isActive(pathname: string, href: string): boolean {
  // '/admin' is a prefix of every admin route, so it only matches exactly.
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Primary navigation for both roles.
 *
 * Desktop renders a horizontal tab bar; below `md` it collapses into a
 * disclosure that names the current section, closes on Escape, and closes when
 * the route changes.
 */
export function PrimaryNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);

  // Close the disclosure when the route changes. This is React's documented
  // "adjusting state when a prop changes" pattern — the previous value is held
  // in state, and React re-renders immediately without committing the stale UI.
  // A synchronous setState inside an effect would render twice instead.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const current = items.find((item) => isActive(pathname, item.href));

  return (
    <>
      <nav aria-label="Primary" className="mx-auto hidden max-w-7xl px-2 md:block">
        <ul className="flex flex-wrap gap-0.5">
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={clsx(
                    'inline-block border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors',
                    active
                      ? 'border-brand-500 text-white'
                      : 'border-transparent text-ink-300 hover:border-ink-600 hover:text-white',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-white/10 md:hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav-panel"
          data-testid="mobile-nav-toggle"
          className="flex w-full items-center justify-between px-4 py-2.5 text-[13px] font-medium text-white"
        >
          <span>{current?.label ?? 'Menu'}</span>
          <span aria-hidden="true" className="text-ink-300">
            {open ? '▲' : '▼'}
          </span>
        </button>
        <div id="mobile-nav-panel" hidden={!open} className="border-t border-white/10 pb-2">
          <nav aria-label="Primary, mobile">
            <ul>
              {items.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={clsx(
                        'block px-4 py-2.5 text-[13px]',
                        active ? 'bg-white/10 font-semibold text-white' : 'text-ink-300',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </div>
    </>
  );
}

'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '../utils';

// A NAV GROUP IN THE TOP BAR: a button that discloses a panel of links.
//
// Not Dropdown. That one is an ACTION menu (role="menu", buttons that run a
// callback) behind a div that cannot take focus, which is right for a row's
// kebab and wrong for navigation. This is the disclosure-navigation pattern:
// a real <button> with aria-expanded, and plain links in the panel, so a screen
// reader reads them as the links they are and middle-click still opens a tab.
//
// The panel borrows Dropdown's portal and fixed positioning, for the same
// reason: the bar scrolls horizontally on a narrow window and clips anything
// absolutely positioned inside it.
//
// No next/* import: packages/ui is shared, so the caller supplies the link
// element through renderLink.

const PANEL_WIDTH = 208;
// How long the pointer may be outside both the trigger and the panel before a
// hover-opened menu shuts: long enough to cross the 4px gap between them, or to
// clip a corner on the way down, without the menu flickering.
const HOVER_CLOSE_MS = 150;

// Only one menu is ever open. Each menu keeps its own state, so without this a
// pointer sliding from one trigger to the next opened the second at once while
// the first sat out its HOVER_CLOSE_MS, and the two panels overlapped; a
// click-opened menu never closed on hover at all. Opening a menu now shuts
// every other one immediately.
const openMenus = new Map<string, () => void>();

function claimOpen(id: string) {
  for (const [otherId, shut] of openMenus) if (otherId !== id) shut();
}

// By whole segment, as in nav-groups' isRouteActive.
function isUnder(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface NavMenuItem {
  href: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  current: boolean;
  /** Rows folded under this one. The row still links to its own page; a chevron beside it opens them. */
  children?: NavMenuItem[];
  /** Label of the first row inside the fold, which opens this row's own page. */
  selfLabel?: string;
}

export interface NavMenuLinkProps {
  className?: string;
  'aria-current'?: 'page';
  onClick: () => void;
  children: React.ReactNode;
}

interface NavMenuProps {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  active: boolean;
  pathname: string;
  items: NavMenuItem[];
  renderLink: (item: NavMenuItem, props: NavMenuLinkProps) => React.ReactNode;
  triggerClassName?: string;
  panelClassName?: string;
  linkClassName?: string;
  /** The chevron beside a row that has children. */
  toggleClassName?: string;
  /** Added to the rows inside a fold. */
  childIndentClassName?: string;
}

export function NavMenu({
  id,
  label,
  icon: Icon,
  active,
  pathname,
  items,
  renderLink,
  triggerClassName,
  panelClassName,
  linkClassName,
  toggleClassName,
  childIndentClassName,
}: NavMenuProps) {
  const [open, setOpen] = React.useState(false);
  // Only the folds somebody has toggled. One they have not is open when the
  // current page is inside it, so the reader starts where they are.
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Set when the menu was opened from the keyboard. Consumed once the panel has
  // actually rendered, which is not until the position below is known.
  const focusFirstRef = React.useRef(false);
  // A MOUSE opens the menu on hover. A menu opened that way also closes when the
  // pointer leaves; one opened by click, tap or keyboard stays until dismissed.
  // Touch never hovers (pointerType is checked), so phones keep tap-to-open.
  const openedByHoverRef = React.useRef(false);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = `nav-menu-${id}`;

  // The fold toggles too, so the arrow keys and the Tab-out below reach them.
  const focusables = () =>
    Array.from(panelRef.current?.querySelectorAll<HTMLElement>('a[href], button[data-nav-toggle]') ?? []);

  const close = React.useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // A navigation closes the menu. Keyed on pathname only, so a parent that
  // re-renders on a timer does not shut a menu somebody is reading.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const cancelHoverClose = React.useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // However it closed, the next open starts from scratch.
  React.useEffect(() => {
    if (!open) {
      openedByHoverRef.current = false;
      cancelHoverClose();
      setExpanded({});
    }
  }, [open, cancelHoverClose]);

  React.useEffect(() => cancelHoverClose, [cancelHoverClose]);

  React.useEffect(() => {
    if (!open) return;
    claimOpen(id);
    openMenus.set(id, () => setOpen(false));
    return () => {
      openMenus.delete(id);
    };
  }, [open, id]);

  function handlePointerEnter(event: React.PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    cancelHoverClose();
    if (!open) {
      openedByHoverRef.current = true;
      setOpen(true);
    }
  }

  function handlePointerLeave(event: React.PointerEvent) {
    if (event.pointerType !== 'mouse' || !openedByHoverRef.current) return;
    cancelHoverClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  }

  React.useEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePos = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      // Left-aligned under the trigger; clamped to the viewport.
      const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open || !pos || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    focusables()[0]?.focus();
  }, [open, pos]);

  React.useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: PointerEvent) {
      const t = event.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') close(true);
    }
    // pointerdown, not mousedown: a tap on a phone at the door must close it too.
    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, close]);

  // Only a focus move to somewhere ELSE closes it. A null relatedTarget is left
  // alone on purpose: Safari does not focus a clicked link, so a click inside
  // the panel reports focus going nowhere, and closing on that would unmount
  // the link before its click lands. Mouse dismissal is the handler above.
  function handleBlur(event: React.FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next) return;
    if (triggerRef.current?.contains(next)) return;
    if (panelRef.current?.contains(next)) return;
    setOpen(false);
  }

  function handleTriggerClick(event: React.MouseEvent) {
    // detail is 0 when Enter or Space activated the button, so a keyboard user
    // lands on the first link and a mouse user does not get a focus ring.
    if (!open && event.detail === 0) focusFirstRef.current = true;
    // Hover already opened it, so the click that follows must not shut it again.
    if (open && openedByHoverRef.current && event.detail !== 0) return;
    setOpen((v) => !v);
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (open) focusables()[0]?.focus();
      else {
        focusFirstRef.current = true;
        setOpen(true);
      }
    } else if (event.key === 'Tab' && !event.shiftKey && open) {
      // The panel sits at the end of <body>, so the browser's own Tab order
      // would skip it. Step into it instead.
      event.preventDefault();
      focusables()[0]?.focus();
    }
  }

  function handlePanelKeyDown(event: React.KeyboardEvent) {
    const all = focusables();
    const index = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      all[(index + step + all.length) % all.length]?.focus();
    } else if (event.key === 'Tab') {
      // Out of the panel either way goes back to the trigger, where the page's
      // own Tab order resumes.
      if ((event.shiftKey && index === 0) || (!event.shiftKey && index === all.length - 1)) {
        event.preventDefault();
        close(true);
      }
    }
  }

  function renderItem(item: NavMenuItem, key: string, className: string | undefined) {
    const ItemIcon = item.icon;
    return (
      <React.Fragment key={key}>
        {renderLink(item, {
          className,
          'aria-current': item.current ? 'page' : undefined,
          onClick: () => setOpen(false),
          children: (
            <>
              {ItemIcon && <ItemIcon className="w-4 h-4" />}
              <span>{item.label}</span>
            </>
          ),
        })}
      </React.Fragment>
    );
  }

  const panel =
    open && pos && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={panelRef}
            id={panelId}
            onKeyDown={handlePanelKeyDown}
            onBlur={handleBlur}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH, zIndex: 100 }}
            className={panelClassName}
          >
            {items.map((item) => {
              if (!item.children?.length) return renderItem(item, item.href, linkClassName);
              const isOpen = expanded[item.href] ?? isUnder(pathname, item.href);
              const subId = `${panelId}-${item.href.replace(/\W/g, '-')}`;
              return (
                <React.Fragment key={item.href}>
                  <div className="flex items-stretch">
                    {/* Marked current only while folded: open, the self row
                        inside carries the mark, so one row lights up, not two. */}
                    {renderItem(
                      { ...item, current: item.current && !isOpen },
                      `${item.href}#row`,
                      cn(linkClassName, 'flex-1 min-w-0'),
                    )}
                    <button
                      type="button"
                      data-nav-toggle
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? subId : undefined}
                      aria-label={`${isOpen ? 'Hide' : 'Show'} ${item.label} pages`}
                      onClick={() => setExpanded((prev) => ({ ...prev, [item.href]: !isOpen }))}
                      className={toggleClassName}
                    >
                      <ChevronDown
                        aria-hidden
                        className={cn('w-3.5 h-3.5 transition-transform', isOpen && 'rotate-180')}
                      />
                    </button>
                  </div>
                  {/* Mounted only while open, never `hidden`: a hidden link
                      would still be in focusables() and the arrow keys would
                      stall on it. */}
                  {isOpen && (
                    <div id={subId} role="group" aria-label={item.label}>
                      {renderItem(
                        { ...item, label: item.selfLabel ?? item.label, current: pathname === item.href, children: undefined },
                        `${item.href}#self`,
                        cn(linkClassName, childIndentClassName),
                      )}
                      {item.children.map((child) =>
                        renderItem(child, child.href, cn(linkClassName, childIndentClassName)),
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="true"
        data-active={active || undefined}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        onBlur={handleBlur}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        className={triggerClassName}
      >
        {Icon && <Icon className="w-4 h-4" />}
        <span>{label}</span>
        <ChevronDown
          aria-hidden
          className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')}
        />
      </button>
      {panel}
    </>
  );
}

'use client';

import { useEffect } from 'react';

// An old /fees?tab=expenses link is redirected here with #expenses, but a
// server redirect lands at the top of the page: the browser keeps the hash and
// never scrolls to it. This scrolls once the sections are on the page.
export function ScrollToSection() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);
  return null;
}

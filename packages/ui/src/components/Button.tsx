'use client';

import React from 'react';
import { cn } from '../utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 font-bold uppercase tracking-[0.16em] rounded-md transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--red)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:opacity-50 disabled:cursor-not-allowed border whitespace-nowrap';
  const variants = {
    primary:
      'bg-[var(--red)] text-white border-transparent hover:bg-[var(--red-ink)]',
    secondary:
      'bg-[var(--surface-2)] text-[var(--ink)] border-[var(--line)] hover:bg-[var(--line)]',
    danger:
      'bg-[var(--loss)] text-white border-transparent hover:brightness-110',
    ghost:
      'bg-transparent text-[var(--ink-2)] border-[var(--line)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]',
    success:
      'bg-[var(--win)] text-white border-transparent hover:brightness-110',
  };
  const sizes = {
    sm: 'px-3 min-h-[32px] text-[11px]',
    md: 'px-4 min-h-[40px] text-[11px]',
    lg: 'px-6 min-h-[48px] text-sm',
  };

  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && (
        <svg className="animate-spin -ml-1 h-4 w-4" viewBox="0 0 24 24" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  );
}

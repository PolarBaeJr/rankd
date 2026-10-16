'use client';

import React from 'react';
import { cn } from '../utils';

interface TabsProps {
  tabs: { id: string; label: string; count?: number }[];
  activeTab: string;
  onChange: (id: string) => void;
  /** 'subtle' is a 36px segmented strip that sits in a row of other h-9 controls. */
  variant?: 'solid' | 'subtle';
}

export function Tabs({ tabs, activeTab, onChange, variant = 'solid' }: TabsProps) {
  const subtle = variant === 'subtle';
  return (
    <div
      className={
        subtle
          ? 'flex h-9 gap-0.5 overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5'
          : 'flex gap-1 bg-[var(--bg-elevated)] p-1 rounded-lg overflow-x-auto'
      }
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            subtle
              ? 'px-3 text-xs rounded-[6px] whitespace-nowrap transition-colors flex items-center gap-1.5'
              : 'px-4 min-h-[44px] text-sm rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5',
            subtle
              ? activeTab === tab.id
                ? 'bg-[color-mix(in_oklab,var(--color-accent)_14%,transparent)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-accent)_40%,transparent)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              : activeTab === tab.id
                ? 'bg-[var(--color-accent)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)]'
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={cn(
              'text-xs px-1.5 py-0.5 rounded-full',
              activeTab === tab.id && !subtle ? 'bg-white/20' : 'bg-[var(--border-hover)]'
            )}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

'use client';

import { useToast } from '@/components/toast-provider';

/**
 * Copy the text a notice carries (00333: the results lines for the Marketing
 * holders). Rendered BESIDE the row, never inside it: the row is a link, and a
 * button inside a link is invalid markup.
 */
export function CopyTextButton({ text, label = 'Copy text' }: { text: string; label?: string }) {
  const { toast } = useToast();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('Could not copy', 'error');
    }
  }

  return (
    <div className="notif-copy">
      <button type="button" className="notif-cta press" onClick={handleCopy} data-copy-text={text}>
        {label}
      </button>
    </div>
  );
}

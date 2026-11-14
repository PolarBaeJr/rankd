'use client';

import { Button } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';

/** Copy a caption or the results lines (00333). The text is also shown, selectable. */
export function CopyText({ text, label = 'Copy caption' }: { text: string; label?: string }) {
  const { toast } = useToast();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('The browser refused the clipboard. Select the text and copy it by hand.', 'error');
    }
  }

  return (
    <Button size="sm" variant="secondary" onClick={handleCopy}>
      {label}
    </Button>
  );
}

'use client';

import { Printer } from 'lucide-react';
import { Button } from '@badminton/ui';

export function PrintButton() {
  return (
    <Button onClick={() => window.print()}>
      <Printer className="mr-2 h-4 w-4" />
      Print
    </Button>
  );
}

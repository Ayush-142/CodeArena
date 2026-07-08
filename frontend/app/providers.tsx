'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '@/components/AuthProvider';
import { SocketProvider } from '@/components/SocketProvider';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <SocketProvider>{children}</SocketProvider>
    </AuthProvider>
  );
}

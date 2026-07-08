'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { createSocket, type ClientToServerEvents, type ServerToClientEvents } from '@/lib/socket';
import { useAuth } from './AuthProvider';

const SocketContext = createContext<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  // Lazy initializer: exactly one Socket instance for this provider's lifetime, created
  // disconnected (autoConnect:false in lib/socket.ts) — connect/disconnect is driven purely
  // by auth status below, never per-page.
  const [socketInstance] = useState(() => createSocket());
  const [connectedSocket, setConnectedSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(
    null,
  );

  useEffect(() => {
    if (status === 'authenticated') {
      socketInstance.connect();
      setConnectedSocket(socketInstance);
    } else {
      socketInstance.disconnect();
      setConnectedSocket(null);
    }
  }, [status, socketInstance]);

  useEffect(() => {
    return () => {
      socketInstance.disconnect();
    };
  }, [socketInstance]);

  return <SocketContext.Provider value={connectedSocket}>{children}</SocketContext.Provider>;
}

// Returns null whenever there's no live, authenticated connection — pages must treat that
// as "nothing to subscribe to" rather than connecting their own socket.
export function useSocket(): Socket<ServerToClientEvents, ClientToServerEvents> | null {
  return useContext(SocketContext);
}

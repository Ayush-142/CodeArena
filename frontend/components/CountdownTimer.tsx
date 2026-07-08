'use client';

import { useEffect, useRef, useState } from 'react';

function formatDuration(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}

// serverTime comes from the response that fetched targetTime (contest startAt/endAt) —
// see Phase 5 plan decision #8.
export function CountdownTimer({ targetTime, serverTime }: { targetTime: string | number; serverTime: number }) {
  // Computed once per serverTime received (i.e. once per fetch), NOT recomputed every tick.
  // Re-deriving offset as `serverTime - Date.now()` on every tick would cancel out to the
  // constant `serverTime` and freeze the countdown — the offset must be captured once and
  // reused, only Date.now() should advance between ticks.
  const offsetRef = useRef(serverTime - Date.now());
  useEffect(() => {
    offsetRef.current = serverTime - Date.now();
  }, [serverTime]);

  const [now, setNow] = useState(() => Date.now() + offsetRef.current);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now() + offsetRef.current), 1000);
    return () => clearInterval(interval);
  }, []);

  const target = new Date(targetTime).getTime();
  return <span>{formatDuration(target - now)}</span>;
}

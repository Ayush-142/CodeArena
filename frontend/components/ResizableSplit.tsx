'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_PANE_PX = 320;
const NUDGE_PERCENT = 2;
// Matches Tailwind's default `md:` breakpoint — below this the split collapses to a
// stacked column and dragging is disabled entirely.
const DESKTOP_QUERY = '(min-width: 768px)';

function usePersistedRatio(storageKey: string, defaultRatio: number) {
  // First paint always uses defaultRatio (matches server-rendered markup, avoiding a
  // hydration mismatch); the persisted value, if any, is applied a tick after mount
  // once localStorage is actually reachable.
  const [ratio, setRatioState] = useState(defaultRatio);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      const parsed = stored === null ? NaN : Number(stored);
      if (Number.isFinite(parsed)) setRatioState(parsed);
    } catch {
      // localStorage unavailable (private mode, etc.) — default ratio stands.
    }
  }, [storageKey]);

  const setRatio = useCallback(
    (next: number) => {
      setRatioState(next);
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        // Non-fatal — the ratio just won't survive a reload this session.
      }
    },
    [storageKey],
  );

  return [ratio, setRatio] as const;
}

export function ResizableSplit({
  left,
  right,
  storageKey,
  defaultRatio = 50,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  storageKey: string;
  defaultRatio?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = usePersistedRatio(storageKey, defaultRatio);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const clampToContainer = useCallback((pct: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return pct;
    const minPct = (MIN_PANE_PX / rect.width) * 100;
    return Math.min(100 - minPct, Math.max(minPct, pct));
  }, []);

  function handlePointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const maybeRect = containerRef.current?.getBoundingClientRect();
    if (!maybeRect) return;
    const rect = maybeRect;
    document.body.classList.add('select-none');

    function handleMove(ev: PointerEvent) {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setRatio(clampToContainer(pct));
    }
    function handleUp() {
      document.body.classList.remove('select-none');
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setRatio(clampToContainer(ratio - NUDGE_PERCENT));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setRatio(clampToContainer(ratio + NUDGE_PERCENT));
    }
  }

  return (
    <div ref={containerRef} className="flex flex-1 flex-col md:flex-row">
      <div
        className="min-w-0"
        style={isDesktop ? { width: `${ratio}%`, minWidth: MIN_PANE_PX, flexShrink: 0 } : undefined}
      >
        {left}
      </div>
      {isDesktop ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          aria-valuenow={Math.round(ratio)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
          onDoubleClick={() => setRatio(defaultRatio)}
          className="mx-1 flex shrink-0 cursor-col-resize items-stretch justify-center bg-line hover:bg-accent focus:bg-accent focus:outline-none"
          style={{ width: 6 }}
        >
          <span className="my-auto h-8 w-0.5 bg-ink/30" aria-hidden="true" />
        </div>
      ) : null}
      <div className="min-w-0 flex-1" style={isDesktop ? { minWidth: MIN_PANE_PX } : undefined}>
        {right}
      </div>
    </div>
  );
}

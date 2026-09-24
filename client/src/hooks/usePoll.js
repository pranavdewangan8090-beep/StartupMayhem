import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Polls GET /api/player/state every `intervalMs`. The server returns 204
 * (no body) when nothing changed since our last known version, so most ticks
 * cost nothing to render. Any screen can also call `refreshNow()` right after
 * it does something itself (e.g. just played a card) to update sooner than
 * the next tick.
 */
export function useGameState(intervalMs = 4000) {
  const [state, setState] = useState(null);
  const versionRef = useRef(0);

  async function tick() {
    try {
      const result = await api.get(`/player/state?v=${versionRef.current}`);
      if (result) {
        versionRef.current = result.version;
        setState(result);
      }
    } catch {
      // transient network hiccup — next tick will retry
    }
  }

  useEffect(() => {
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return { state, refreshNow: tick };
}

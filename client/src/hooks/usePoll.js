import { useEffect, useState } from 'react';
import { supabase, call } from '../lib/supabase.js';

/**
 * Polls fn_player_state() every `intervalMs`. Any screen can also call
 * `refreshNow()` right after it does something itself (e.g. just played a
 * card) to update sooner than the next tick.
 */
export function useGameState(intervalMs = 4000) {
  const [state, setState] = useState(null);

  async function tick() {
    try {
      const rows = await call(supabase.rpc('fn_player_state'));
      if (rows?.[0]) setState(rows[0]);
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

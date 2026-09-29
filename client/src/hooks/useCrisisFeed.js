import { useEffect, useRef, useState } from 'react';
import { supabase, call } from '../lib/supabase.js';
import { readSeenCrises, markCrisisSeen } from '../lib/mayhemSeen.js';

/**
 * Polls fn_crisis_public() on the same cadence as the rest of the live
 * game state and surfaces the first triggered crisis this team hasn't
 * been shown the full-screen Mayhem reveal for yet. "Seen" is persisted
 * per team in localStorage, same pattern as revealedCards.js, so a
 * reload or tab switch never re-shows a crisis the player already
 * dismissed — but a genuinely new one triggered by Super Admin always
 * pushes through on the next poll.
 */
export function useCrisisFeed(teamId, intervalMs = 4000) {
  const [crises, setCrises] = useState([]);
  const [pendingReveal, setPendingReveal] = useState(null);
  const seenRef = useRef(readSeenCrises(teamId));

  useEffect(() => {
    seenRef.current = readSeenCrises(teamId);
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const rows = await call(supabase.rpc('fn_crisis_public'));
        if (cancelled) return;
        setCrises(rows || []);
        const unseen = (rows || []).find((c) => !seenRef.current.has(c.crisis_id));
        if (unseen) setPendingReveal((prev) => prev ?? unseen);
      } catch {
        // transient network hiccup — next tick retries
      }
    }

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [teamId, intervalMs]);

  function dismiss() {
    if (!pendingReveal) return;
    seenRef.current = markCrisisSeen(teamId, pendingReveal.crisis_id, seenRef.current);
    setPendingReveal(null);
  }

  return { crises, pendingReveal, dismiss };
}

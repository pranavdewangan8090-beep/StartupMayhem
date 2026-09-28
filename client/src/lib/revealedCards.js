import { useCallback, useEffect, useState } from 'react';

export const CARD_CATEGORIES = ['market', 'customer', 'mission', 'resources'];

function storageKey(teamId) {
  return `sm_revealed_cards_${teamId ?? 'unknown'}`;
}

function readRevealed(teamId) {
  try {
    const raw = localStorage.getItem(storageKey(teamId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function areAllCardsRevealed(revealed) {
  return CARD_CATEGORIES.every((c) => revealed.has(c));
}

/**
 * Tracks which of the 4 starting-card categories a team has flipped face-up
 * at least once, persisted in localStorage so it survives switching tabs or
 * reloading the page — a card that's already been revealed never asks the
 * player to flip it again. Resets only if they log in fresh in a new browser.
 */
export function useRevealedCards(teamId) {
  const [revealed, setRevealed] = useState(() => readRevealed(teamId));

  useEffect(() => {
    setRevealed(readRevealed(teamId));
  }, [teamId]);

  const reveal = useCallback((category) => {
    setRevealed((prev) => {
      if (prev.has(category)) return prev;
      const next = new Set(prev);
      next.add(category);
      try {
        localStorage.setItem(storageKey(teamId), JSON.stringify([...next]));
      } catch {
        // storage unavailable — reveal still works for this session
      }
      return next;
    });
  }, [teamId]);

  return { revealed, reveal };
}

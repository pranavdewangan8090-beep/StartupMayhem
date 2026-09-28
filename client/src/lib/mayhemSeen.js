function storageKey(teamId) {
  return `sm_seen_crises_${teamId ?? 'unknown'}`;
}

export function readSeenCrises(teamId) {
  try {
    const raw = localStorage.getItem(storageKey(teamId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function markCrisisSeen(teamId, crisisId, seen) {
  const next = new Set(seen);
  next.add(crisisId);
  try {
    localStorage.setItem(storageKey(teamId), JSON.stringify([...next]));
  } catch {
    // storage unavailable — reveal will just reappear next poll, harmless
  }
  return next;
}

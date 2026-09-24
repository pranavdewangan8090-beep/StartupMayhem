// Thin fetch wrapper: always sends the httpOnly auth cookie, always parses
// JSON, and throws a rich error object every screen can render consistently.
const BASE = '/api';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || 'Request failed');
    this.status = status;
    this.code = body?.error;
    this.details = body?.details;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }

  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
};

/** A fresh v4 uuid, used as the idempotency key (`requestId`) on every mutation. */
export function newRequestId() {
  return crypto.randomUUID();
}

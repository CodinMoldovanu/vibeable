export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(!["GET", "HEAD"].includes(init.method ?? "GET") ? { "x-vibeable-csrf": "1" } : {}),
      ...init.headers
    }
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status);
  return payload as T;
}

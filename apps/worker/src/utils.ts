export const nowIso = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `lgw_live_${raw}`;
}

export function estimateTokens(payload: unknown): number {
  const text = JSON.stringify(payload);
  return Math.max(1, Math.ceil(text.length / 3));
}

export function calculateCredit(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  inputRate: number,
  outputRate: number,
  cachedRate: number,
  markupBps: number,
): number {
  const raw =
    (Math.max(0, inputTokens - cachedInputTokens) * inputRate) / 1_000_000 +
    (cachedInputTokens * cachedRate) / 1_000_000 +
    (outputTokens * outputRate) / 1_000_000;
  return Math.max(1, Math.ceil(raw * (1 + markupBps / 10_000)));
}

export function errorBody(message: string, code: string, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code } };
}

export function dateKey(timeZone = 'Asia/Jakarta'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function monthStartIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

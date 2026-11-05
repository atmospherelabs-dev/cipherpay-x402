const MAX_RESPONSE_BYTES = 1_048_576;

export function facilitatorBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid CipherPay facilitator URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('CipherPay requires HTTPS (HTTP is allowed only on loopback), without URL credentials, query or fragment');
  }
  return url.href.replace(/\/$/, '');
}

export function merchantKey(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error('A valid merchant API key is required');
  }
  return value;
}

export function invalidResponse(): never { throw new Error('CipherPay returned an invalid response'); }
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value as Record<string, any>;
}
export function text(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
export function integer(value: unknown, positive = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0) && value <= 2_100_000_000_000_000;
}

/** Errors deliberately exclude response bodies, credentials and request data. */
export async function request(base: string, path: string, timeoutMs: number, options: {
  apiKey?: string; body?: unknown; headers?: Record<string, string>; allowConflict?: boolean;
} = {}): Promise<{ data: unknown; headers: Headers; status: number }> {
  const url = facilitatorBase(base) + path;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (options.apiKey !== undefined) headers.Authorization = `Bearer ${merchantKey(options.apiKey)}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal, redirect: 'error',
    });
    if (response.status === 409 && options.allowConflict) {
      await response.body?.cancel();
      return { data: undefined, headers: response.headers, status: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`CipherPay request failed (HTTP ${response.status})`);
    }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) invalidResponse();
    if (!response.body) invalidResponse();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) invalidResponse();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { invalidResponse(); }
    return { data, headers: response.headers, status: response.status };
  } catch (error) {
    if (error instanceof Error && /^(CipherPay request failed \(HTTP \d{3}\)|CipherPay returned an invalid response|A valid merchant API key is required)$/.test(error.message)) throw error;
    throw new Error('CipherPay request unavailable or timed out');
  } finally { clearTimeout(timeout); controller.abort(); }
}

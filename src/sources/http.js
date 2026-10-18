// Small wrapper around fetch with a timeout and a clear error message.
export async function getJson(url, { timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Relay/0.1 (recruitment lead feed)', accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs / 1000}s: ${new URL(url).host}`);
    if (err.message === 'fetch failed') {
      throw new Error(`Couldn't reach ${new URL(url).host} (${err.cause?.code || err.cause?.message || 'network error'})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

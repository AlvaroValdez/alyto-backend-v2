/**
 * boundedCache.js — LRU-ish cache con TTL y tamaño máximo.
 *
 * Mitigación de memory leaks para Maps globales que crecen por clave dinámica
 * (quoteId, userId, etc.). Eviction:
 *   1) Al alcanzar maxSize, intenta eliminar una entrada expirada.
 *   2) Si no hay expiradas, elimina la más antigua (FIFO por orden de inserción).
 *   3) Al leer, si la entrada está expirada, la elimina y devuelve undefined.
 */

export class BoundedCache {
  constructor(maxSize = 1000, ttlMs = 5 * 60 * 1000) {
    this.map = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  set(key, value) {
    if (this.map.size >= this.maxSize) {
      const now = Date.now();
      let evicted = false;
      for (const [k, v] of this.map) {
        if (now > v.expiresAt) { this.map.delete(k); evicted = true; break; }
      }
      if (!evicted) {
        const oldestKey = this.map.keys().next().value;
        if (oldestKey !== undefined) this.map.delete(oldestKey);
      }
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key) { this.map.delete(key); }
  has(key)    { return this.get(key) !== undefined; }
  clear()     { this.map.clear(); }
  get size()  { return this.map.size; }
}

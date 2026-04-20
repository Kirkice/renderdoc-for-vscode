/**
 * Minimal size-bounded LRU cache.
 *
 * Kept deliberately tiny — just enough to prevent unbounded growth in the
 * Inspector's per-event shader / pipeline / texture caches on very large
 * captures. Behaviour:
 *   - `get(k)` marks the key as recently used
 *   - `set(k, v)` inserts / updates; if size exceeds the capacity, the
 *     least-recently-used entry is evicted
 *
 * Uses the fact that `Map` iteration order reflects insertion order: to mark
 * a key as MRU we delete + re-insert it.
 */
export class LruCache<K, V> {
    private readonly map = new Map<K, V>();

    constructor(private readonly capacity: number) {
        if (capacity <= 0) {
            throw new Error(`LruCache capacity must be > 0 (got ${capacity})`);
        }
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    get(key: K): V | undefined {
        if (!this.map.has(key)) { return undefined; }
        const v = this.map.get(key)!;
        // Promote to MRU by re-inserting.
        this.map.delete(key);
        this.map.set(key, v);
        return v;
    }

    set(key: K, value: V): void {
        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.capacity) {
            // Evict the LRU entry (oldest in insertion order).
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) {
                this.map.delete(oldest);
            }
        }
        this.map.set(key, value);
    }

    clear(): void {
        this.map.clear();
    }

    get size(): number {
        return this.map.size;
    }
}

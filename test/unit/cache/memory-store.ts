import type { Store } from '../../../src/cache/store.js';

// An in-memory bucket.
export function memoryStore() {
  const objects = new Map<string, Buffer>();
  const store: Store = {
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) throw new Error(`GET ${key}: 404`);
      return new Response(new Uint8Array(o));
    },
    async put(key, body) {
      objects.set(key, Buffer.from(await body.arrayBuffer()));
    },
  };
  return { store, objects };
}

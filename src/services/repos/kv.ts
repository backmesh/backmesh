
export default {
  async create<T>(kv: KVNamespace, key: string, value: T) {
    const curr = await kv.get(key);
    if (curr !== null) {
      throw new TypeError(`New ${key}, but it already exists`);
    }
    const jsonValue = JSON.stringify(value);
    await kv.put(key, jsonValue);
  },

  async edit<T>(
    kv: KVNamespace,
    key: string,
    value: T,
    immutableFields: Array<string>,
  ) {
    const curr = await kv.get(key);
    if (curr === null) throw new TypeError(`No value to edit for key: ${key}`);
    const currVal = JSON.parse(curr);
    const newValue = value as any;
    for (const field of immutableFields) {
      if (currVal[field] !== newValue[field]) {
        throw new TypeError(`Field '${field}' is immutable and cannot be changed`);
      }
    }
    // Use current value if the new value is empty
    // needed to preserve private api key on updates
    for (const field in currVal) {
      if (newValue[field] === undefined || newValue[field] === '') {
        newValue[field] = currVal[field];
      }
    }
    const jsonValue = JSON.stringify(value);
    await kv.put(key, jsonValue);
  },

  async get<T>(kv: KVNamespace, key: string): Promise<T> {
    const value = await kv.get(key);
    if (value === null) throw new TypeError(`No value for key: ${key}`);
    return JSON.parse(value) as T;
  },

  async del(kv: KVNamespace, key: string) {
    const curr = await kv.get(key);
    if (curr === null) throw new TypeError(`No value to delete for key: ${key}`);
    await kv.delete(key);
  },

  async listKeys(kv: KVNamespace, prefix: string) {
    const keysList = [];
    let cursor: string | undefined = undefined;

    do {
      const res: KVNamespaceListResult<unknown> = await kv.list({
        prefix,
        cursor,
      });

      keysList.push(...res.keys);

      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
    return keysList;
  },

  generateId(length: number = 20): string {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(array, (byte) => chars[byte % chars.length]).join('');
  },
};

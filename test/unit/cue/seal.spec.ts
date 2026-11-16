import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  coalesceHash,
  CueFormatError,
  generateKey,
  type CueFields,
  type CueFormat,
  keyId,
  openCue,
  sealCue,
} from '../../../src/cue/seal.js';

const fields = {
  repo: 'acme/app',
  branch: 'main',
  user: 'alice',
  kind: 'push' as const,
  pr: '?' as 'y' | 'n' | '?',
  lead_s: 90,
};

describe('cue sealing', () => {
  it("opens the previous release's format and its own, and names any other", async () => {
    const { pair, key } = await generateKey();
    // rc.5 and rc.6 sealed format 1 with `pr`: it still opens, at the
    // same length as format 2.
    const previous = await sealCue(11, key, fields, 1000, 1);
    expect(await openCue(pair, 11, previous)).toMatchObject({
      ...fields,
      v: 1,
    });
    const current = await sealCue(11, key, fields, 1000);
    expect(current.ct).toHaveLength(previous.ct.length);
    // rc.4's format 1 had no `pr` and a null lead: a format error, not a
    // cue that doesn't open.
    const rc4 = {
      ...fields,
      pr: undefined,
      lead_s: null,
    } as unknown as CueFields;
    const old = await openCue(
      pair,
      11,
      await sealCue(11, key, rc4, 1000, 1),
    ).catch((e: unknown) => e);
    expect(old).toBeInstanceOf(CueFormatError);
    expect(old).toMatchObject({ v: 1, pr: false });
    // A newer format than this build reads.
    const next = await openCue(
      pair,
      11,
      await sealCue(11, key, fields, 1000, 3 as CueFormat),
    ).catch((e: unknown) => e);
    expect(next).toMatchObject({ v: 3, pr: true });
    // A format this build reads, but malformed, doesn't open: no format error.
    const bad = { ...fields, lead_s: 'x' } as unknown as CueFields;
    const malformed = await openCue(
      pair,
      11,
      await sealCue(11, key, bad, 1000),
    ).catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(Error);
    expect(malformed).not.toBeInstanceOf(CueFormatError);
  });

  it('opens only for the org and key it was sealed to', async () => {
    const { pair, key } = await generateKey();
    const sealed = await sealCue(11, key, fields, 1000);
    expect(sealed.enc).toHaveLength(43);
    expect(await openCue(pair, 11, sealed)).toMatchObject({
      ...fields,
      v: 2,
      org_id: 11,
      ts: 1000,
    });
    await expect(openCue(pair, 12, sealed)).rejects.toThrow();
    await expect(openCue(pair, 11, { ...sealed, kid: 'x' })).rejects.toThrow();
    const other = await generateKey();
    await expect(openCue(other.pair, 11, sealed)).rejects.toThrow();
    const ct = Buffer.from(sealed.ct, 'base64url');
    ct[0]! ^= 1;
    await expect(
      openCue(pair, 11, { ...sealed, ct: ct.toString('base64url') }),
    ).rejects.toThrow();
    // Each seal is fresh: a new encapsulation and nonce.
    const again = await sealCue(11, key, fields);
    expect(again.enc).not.toBe(sealed.enc);
    expect((await openCue(pair, 11, again)).nonce).not.toBe(
      (await openCue(pair, 11, sealed)).nonce,
    );
  });

  it('refuses a cue whose fields a listener must not act on', async () => {
    const { pair, key } = await generateKey();
    for (const bad of [
      { ...fields, repo: 'acme/..' },
      { ...fields, repo: 'acme' },
      { ...fields, branch: 'a b' },
      { ...fields, lead_s: 601 },
      { ...fields, lead_s: 29 },
      { ...fields, kind: 'stop' as 'drop' },
      { ...fields, pr: 'yes' as 'y' },
      { ...fields, lead_s: null as unknown as number },
    ]) {
      await expect(
        openCue(pair, 11, await sealCue(11, key, bad)),
      ).rejects.toThrow();
    }
  });

  it('derives the key ID the relay checks', async () => {
    const { key } = await generateKey();
    const raw = Buffer.from(key.pub, 'base64url');
    expect(raw).toHaveLength(32);
    expect(key.kid).toBe(
      createHash('sha256').update(raw).digest('base64url').slice(0, 16),
    );
    expect(keyId(raw)).toBe(key.kid);
  });

  it("coalesces by the push's salt and time, which the relay can't read", () => {
    const salt = 'a'.repeat(32);
    expect(coalesceHash(salt, '100')).toBe(coalesceHash(salt, '100'));
    for (const [other, eta] of [
      ['b'.repeat(32), '100'],
      [salt, '101'],
      [salt, 'in 101'],
      [salt, 'drop'],
    ]) {
      expect(coalesceHash(other!, eta!)).not.toBe(coalesceHash(salt, '100'));
    }
    expect(coalesceHash(salt, 'drop')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('seals a cancel and a cue of any lead to one length', async () => {
    const { pair, key } = await generateKey();
    const seal = (over: Partial<Parameters<typeof sealCue>[2]>) =>
      sealCue(11, key, { ...fields, ...over }, 1000);
    const drop = await seal({ kind: 'drop', lead_s: 600 });
    for (const [lead_s, pr] of [
      [90, 'y'],
      [99, 'n'],
      [100, '?'],
      [600, 'y'],
    ] as const) {
      const cue = await seal({ lead_s, pr });
      expect(cue.ct).toHaveLength(drop.ct.length);
      expect(await openCue(pair, 11, cue)).toMatchObject({ lead_s });
    }
    expect(await openCue(pair, 11, drop)).toMatchObject({ kind: 'drop' });
  });
});

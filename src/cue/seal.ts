// A cue's sealing, shared by `backmesh cue` and the listener.
// HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and
// AES-128-GCM, from @hpke/core on WebCrypto, so Node 22 and the Bun binary
// run the same code. The relay (worker/src/relay.ts) sees only the org, the
// key ID, the push's tag, the coalescing hash and the ciphertext.
import { createHash, randomBytes } from 'node:crypto';

import {
  Aes128Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from '@hpke/core';
import { z } from 'zod';

// The HPKE suite.
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});
const INFO = new TextEncoder().encode('backmesh cue v1');
// The org and key ID are bound in, so the relay can't move a cue to another
// org or key without the open failing.
const aad = (orgId: number, kid: string) =>
  new TextEncoder().encode(`bm-cue|${orgId}|${kid}`);

// A GitHub repo (`owner/name`) and a branch git would accept, so a cue
// can't steer the listener's GitHub calls.
const REPO = /^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[^\s~^:?*[\\]{1,255}$/;
// The lead a cue must name: from 30 s (owner, 2026-11-09), as runners
// started at once are still up before a cold start would be, to the longest
// the listener holds a scheduled start.
export const MIN_LEAD_S = 30;
export const MAX_LEAD_S = 600;

// The cue formats this build opens, and the one it seals. Format 2 is format
// 1 with its number raised: rc.4's cues also said 1 but had no `pr` and could
// carry a null lead, so the number told a listener nothing. From format 2 on,
// a change of the sealed fields raises it. The listener opens the previous
// release's format (1 with `pr`, rc.5 and rc.6) for one more release, and
// advertises what it opens with its key (`formats`), so a CLI seals one it
// reads or says to update. Format 1 goes in the release after
// rc.7's public version.
export const CUE_FORMATS = [1, 2] as const;
export type CueFormat = (typeof CUE_FORMATS)[number];
export const CUE_FORMAT: CueFormat = 2;

const cueSchema = z.object({
  v: z.literal(CUE_FORMATS),
  org_id: z.number().int(),
  repo: z.string().regex(REPO),
  branch: z.string().regex(BRANCH),
  // The GitHub login, which must equal the relay's signed-in user.
  user: z.string().min(1).max(39),
  // `push` warns of a push; `drop` (`--cancel`) drops the branch's cue. The
  // same length, and a cancel carries a lead the listener ignores, so its
  // ciphertext is the length of a cue's.
  kind: z.enum(['push', 'drop']),
  // Whether the branch has a PR, as the CLI read it from git: `y`, `n`, or
  // `?` when it couldn't tell (or for a cancel). One character, so every
  // value seals to one length.
  pr: z.enum(['y', 'n', '?']),
  // How soon the push is expected.
  lead_s: z.number().int().min(MIN_LEAD_S).max(MAX_LEAD_S),
  ts: z.number(), // ms since the epoch, when sealed
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
});
export type Cue = z.infer<typeof cueSchema>;
export type CueFields = Pick<
  Cue,
  'repo' | 'branch' | 'user' | 'kind' | 'pr' | 'lead_s'
>;

export interface Sealed {
  kid: string;
  enc: string; // base64url
  ct: string; // base64url
}
// A listener's published key: raw X25519, base64url, and the cue formats
// it opens (none from a listener before formats).
export interface PublicKey {
  kid: string;
  pub: string;
  formats?: number[];
}

// A cue that opened but isn't a format this build reads: an older or newer
// CLI's, not a bad key. `v` and whether it had a `pr`, for the log.
export class CueFormatError extends Error {
  constructor(
    readonly v: unknown,
    readonly pr: boolean,
  ) {
    super(`format ${String(v)}${pr ? '' : ' without pr'}`);
  }
}

export const validRepo = (repo: string) => REPO.test(repo);
export const validBranch = (branch: string) => BRANCH.test(branch);

// The first 16 characters of the base64url SHA-256 of the raw key, as the
// relay checks it.
export const keyId = (pub: Uint8Array) =>
  createHash('sha256').update(pub).digest('base64url').slice(0, 16);

// A listener's key pair, made at start and held only in memory.
export async function generateKey() {
  const pair = await suite.kem.generateKeyPair();
  const raw = new Uint8Array(
    await suite.kem.serializePublicKey(pair.publicKey),
  );
  const key: PublicKey = {
    kid: keyId(raw),
    pub: Buffer.from(raw).toString('base64url'),
  };
  return { pair, key };
}

export type KeyPair = Awaited<ReturnType<typeof generateKey>>['pair'];

// Equal for repeats of a push's cue: the same `eta` under the push's
// `salt`, which only the CLI holds, so the relay coalesces them without
// learning the time. `eta` is the push's expected time rounded to 30 s,
// or `drop` for a cancel, so a rescheduled cue isn't a repeat.
export const coalesceHash = (salt: string, eta: string) =>
  createHash('sha256')
    .update(['bm-cue-coalesce-v2', salt, eta].join('\0'))
    .digest('hex');

export async function sealCue(
  orgId: number,
  key: PublicKey,
  fields: CueFields,
  now = Date.now(),
  format: CueFormat = CUE_FORMAT,
): Promise<Sealed> {
  const cue: Cue = {
    v: format,
    org_id: orgId,
    ...fields,
    ts: now,
    nonce: randomBytes(16).toString('hex'),
  };
  // Padded so a 2-digit lead seals to the length of a 3-digit one or a
  // cancel's; JSON allows the trailing space.
  const json = JSON.stringify(cue);
  const plain = json.padEnd(json.length + 3 - String(cue.lead_s).length);
  const recipientPublicKey = await suite.kem.deserializePublicKey(
    Buffer.from(key.pub, 'base64url'),
  );
  const { enc, ct } = await suite.seal(
    { recipientPublicKey, info: INFO },
    new TextEncoder().encode(plain),
    aad(orgId, key.kid),
  );
  return {
    kid: key.kid,
    enc: Buffer.from(enc).toString('base64url'),
    ct: Buffer.from(ct).toString('base64url'),
  };
}

// The cue, or a throw when it doesn't open for this org and key or isn't a
// cue.
export async function openCue(
  pair: KeyPair,
  orgId: number,
  sealed: Sealed,
): Promise<Cue> {
  const plain = await suite.open(
    {
      recipientKey: pair,
      enc: Buffer.from(sealed.enc, 'base64url'),
      info: INFO,
    },
    Buffer.from(sealed.ct, 'base64url'),
    aad(orgId, sealed.kid),
  );
  const raw: unknown = JSON.parse(new TextDecoder().decode(plain));
  const parsed = cueSchema.safeParse(raw);
  if (!parsed.success) {
    const { v, pr } = (raw ?? {}) as { v?: unknown; pr?: unknown };
    // A format this build reads, but malformed: not a format refusal. Only
    // rc.4's format 1, without `pr`, is one.
    const rc4 = v === 1 && pr === undefined;
    if ((CUE_FORMATS as readonly unknown[]).includes(v) && !rc4)
      throw parsed.error;
    throw new CueFormatError(v, pr !== undefined);
  }
  const cue = parsed.data;
  if (cue.org_id !== orgId) throw new Error('cue for another org');
  return cue;
}

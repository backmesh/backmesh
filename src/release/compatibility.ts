// The compatibility matrix each backmesh release carries: the one anycloud
// version it pins and its two image digests. The release workflow writes it as
// `compatibility.json` and each release binary embeds it
// (scripts/build-binaries.sh); `install` and `upgrade` read it.
import { z } from 'zod';

import { ANYCLOUD_VERSION } from '../anycloud/contract.generated.js';

const VERSION = /^\d+\.\d+\.\d+$/;

// By digest, since GHCR tags can be overwritten.
const image = (name: string) =>
  z
    .string()
    .regex(
      new RegExp(`^ghcr\\.io/backmesh/backmesh-${name}@sha256:[0-9a-f]{64}$`),
    );

export const compatibilitySchema = z.strictObject({
  backmesh: z.string().regex(VERSION),
  anycloud: z.string().regex(VERSION),
  runnerImage: image('runner'),
  listenerImage: image('listener'),
});

export type Compatibility = z.infer<typeof compatibilitySchema>;

/** The matrix for a release of this checkout, which pins its generated client's anycloud. */
export const releaseMatrix = (
  fields: Omit<Compatibility, 'anycloud'>,
): Compatibility =>
  compatibilitySchema.parse({ ...fields, anycloud: ANYCLOUD_VERSION });

// `bun build --define` replaces this name with compatibility.json's text.
declare const BACKMESH_COMPATIBILITY: string | undefined;
const EMBEDDED =
  typeof BACKMESH_COMPATIBILITY === 'string'
    ? BACKMESH_COMPATIBILITY
    : undefined;

/** This release's matrix; it must pin the generated client's anycloud. */
export function readCompatibility(text = EMBEDDED): Compatibility {
  if (text === undefined) {
    throw new Error(
      'This backmesh build has no compatibility.json, so it names no images. Install a released backmesh.',
    );
  }
  const result = compatibilitySchema
    .extend({ anycloud: z.literal(ANYCLOUD_VERSION) })
    .safeParse(JSON.parse(text));
  if (!result.success) {
    throw new Error(
      `compatibility.json doesn't match this build's anycloud ${ANYCLOUD_VERSION}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

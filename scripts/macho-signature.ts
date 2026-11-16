// Checks and prepares the embedded code signature of the thin 64-bit Mach-O
// executables `bun build --compile` cross-compiles for macOS. Copied from
// anycloud's scripts/macho-signature.ts, where its tests are.
//
//   bun scripts/macho-signature.ts verify <binary>...
//   bun scripts/macho-signature.ts fit <binary>...
//
// `verify` checks the signature the way macOS does at launch: every
// CodeDirectory page hash, every special-slot hash for a blob the signature
// carries, and a signature that ends the file. Apple Silicon SIGKILLs an
// executable that fails these checks.
//
// `fit` shrinks a code signature load command that runs past the end of the
// file to the bytes that are there, so a signer can parse and replace it. Bun
// 1.3.3 leaves the darwin-x64 template's signature in place under such a size.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MH_MAGIC_64 = 0xfeedfacf;
const LC_CODE_SIGNATURE = 0x1d;
const SUPERBLOB_MAGIC = 0xfade0cc0;
const CODEDIRECTORY_MAGIC = 0xfade0c02;
const HASH_ALGORITHMS: Record<number, { name: string; size: number }> = {
  1: { name: 'sha1', size: 20 },
  2: { name: 'sha256', size: 32 },
};
// Alternate CodeDirectories (0x1000-0x1004) are not checked, so a signature
// carrying one is refused rather than passed half-verified.
const ALTERNATE_CODEDIRECTORY_TYPES = [0x1000, 0x1001, 0x1002, 0x1003, 0x1004];
// Special slots macOS checks against a blob in the same SuperBlob:
// requirements, entitlements, and DER entitlements.
const CHECKED_SPECIAL_SLOTS = [2, 5, 7];

function codeSignatureCommand(binary: Buffer): {
  command: number;
  offset: number;
  size: number;
} {
  if (binary.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error('not a thin 64-bit little-endian Mach-O');
  }
  for (let i = 0, command = 32; i < binary.readUInt32LE(16); i++) {
    if (binary.readUInt32LE(command) === LC_CODE_SIGNATURE) {
      return {
        command,
        offset: binary.readUInt32LE(command + 8),
        size: binary.readUInt32LE(command + 12),
      };
    }
    command += binary.readUInt32LE(command + 4);
  }
  throw new Error('no LC_CODE_SIGNATURE load command');
}

export function verifyMachOSignature(binary: Buffer): {
  identifier: string;
  pages: number;
} {
  const signature = codeSignatureCommand(binary);
  if (signature.offset + signature.size !== binary.length) {
    throw new Error(
      `signature ends at ${signature.offset + signature.size} but the file is ${binary.length} bytes`,
    );
  }

  const superBlob = binary.subarray(signature.offset);
  if (superBlob.readUInt32BE(0) !== SUPERBLOB_MAGIC)
    throw new Error('signature is not a SuperBlob');
  const blobs = new Map<number, Buffer>();
  for (let i = 0; i < superBlob.readUInt32BE(8); i++) {
    const type = superBlob.readUInt32BE(12 + i * 8);
    const blobOffset = superBlob.readUInt32BE(16 + i * 8);
    blobs.set(
      type,
      superBlob.subarray(
        blobOffset,
        blobOffset + superBlob.readUInt32BE(blobOffset + 4),
      ),
    );
  }

  const codeDirectory = blobs.get(0);
  if (codeDirectory?.readUInt32BE(0) !== CODEDIRECTORY_MAGIC) {
    throw new Error('SuperBlob has no CodeDirectory');
  }
  const hashOffset = codeDirectory.readUInt32BE(16);
  const identOffset = codeDirectory.readUInt32BE(20);
  const nSpecialSlots = codeDirectory.readUInt32BE(24);
  const nCodeSlots = codeDirectory.readUInt32BE(28);
  const codeLimit = codeDirectory.readUInt32BE(32);
  const hashSize = codeDirectory.readUInt8(36);
  const algorithm = HASH_ALGORITHMS[codeDirectory.readUInt8(37)];
  const pageSize = 2 ** codeDirectory.readUInt8(39);
  if (!algorithm)
    throw new Error(
      `unsupported CodeDirectory hash type ${codeDirectory.readUInt8(37)}`,
    );
  if (hashSize !== algorithm.size) {
    throw new Error(
      `CodeDirectory hash size ${hashSize} is not ${algorithm.size} for ${algorithm.name}`,
    );
  }
  const alternate = ALTERNATE_CODEDIRECTORY_TYPES.find((type) =>
    blobs.has(type),
  );
  if (alternate !== undefined) {
    throw new Error(
      `alternate CodeDirectory ${alternate.toString(16)} is not verified`,
    );
  }
  if (codeLimit !== signature.offset) {
    throw new Error(
      `CodeDirectory covers ${codeLimit} bytes but the signature starts at ${signature.offset}`,
    );
  }
  if (nCodeSlots !== Math.ceil(codeLimit / pageSize)) {
    throw new Error(
      `CodeDirectory has ${nCodeSlots} page hashes for ${codeLimit} bytes`,
    );
  }

  const digest = (data: Buffer) =>
    createHash(algorithm.name).update(data).digest();
  const slot = (index: number) =>
    codeDirectory.subarray(
      hashOffset + index * hashSize,
      hashOffset + (index + 1) * hashSize,
    );
  for (let page = 0; page < nCodeSlots; page++) {
    // The last page is hashed at its real length, not padded to pageSize.
    const data = binary.subarray(
      page * pageSize,
      Math.min((page + 1) * pageSize, codeLimit),
    );
    if (!digest(data).equals(slot(page)))
      throw new Error(`page ${page} hash does not match`);
  }
  for (const type of CHECKED_SPECIAL_SLOTS) {
    const blob = blobs.get(type);
    if (blob && (type > nSpecialSlots || !digest(blob).equals(slot(-type)))) {
      throw new Error(`special slot ${type} hash does not match its blob`);
    }
  }

  const identifier = codeDirectory
    .subarray(identOffset, codeDirectory.indexOf(0, identOffset))
    .toString();
  return { identifier, pages: nCodeSlots };
}

export function fitMachOSignature(binary: Buffer): boolean {
  const signature = codeSignatureCommand(binary);
  if (signature.offset + signature.size <= binary.length) return false;
  binary.writeUInt32LE(
    binary.length - signature.offset,
    signature.command + 12,
  );
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...paths] = process.argv.slice(2);
  if (command !== 'verify' && command !== 'fit') {
    throw new Error('usage: macho-signature.ts verify|fit <binary>...');
  }
  for (const path of paths) {
    const binary = readFileSync(path);
    if (command === 'fit') {
      if (fitMachOSignature(binary)) writeFileSync(path, binary);
      continue;
    }
    try {
      const { identifier, pages } = verifyMachOSignature(binary);
      console.log(
        `${path}: valid code signature (${identifier}, ${pages} pages)`,
      );
    } catch (error) {
      console.error(
        `${path}: invalid code signature: ${(error as Error).message}`,
      );
      process.exitCode = 1;
    }
  }
}

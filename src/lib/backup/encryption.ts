import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

/**
 * Encrypting a dump at rest.
 *
 * A dump of this database is every customer's phone number, every home address
 * with its landmark, and every order they have placed — in one file that is
 * designed to be copied somewhere else. That file ends up on a laptop, in
 * object storage, in a message to a contractor. Left in plaintext it makes the
 * backup the least protected copy of the most sensitive data the business
 * holds, and the Data Privacy Act does not care that it was only meant to be
 * temporary.
 *
 * So: AES-256-GCM when `BACKUP_ENCRYPTION_KEY` is set, and a loud warning when
 * it is not. Optional rather than mandatory for one reason — an encrypted
 * backup whose key is lost is not a backup, and forcing a key on somebody
 * setting this up for the first time trades a privacy risk for a total-loss
 * risk.
 *
 * GCM rather than CBC because it authenticates: a dump that has been altered
 * or truncated fails to decrypt rather than restoring a plausible-looking
 * database. `node:crypto` is used freely here because nothing in this file is
 * ever bundled — it is reached only from `scripts/`, never from the app.
 */

/** Six bytes, so a file can be identified without trying to decrypt it. */
const MAGIC = Buffer.from('TARABK', 'ascii');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** magic | salt | iv. The authentication tag is appended after the body. */
export const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + IV_LENGTH;

export class BackupKeyMissingError extends Error {
  constructor() {
    super(
      'This dump is encrypted and BACKUP_ENCRYPTION_KEY is not set. Without ' +
        'the key the file cannot be read — which is the point, and also why ' +
        'the key belongs somewhere that survives the loss of this machine.',
    );
    this.name = 'BackupKeyMissingError';
  }
}

export class BackupFormatError extends Error {
  constructor(reason: string) {
    super(`This dump cannot be read: ${reason}`);
    this.name = 'BackupFormatError';
  }
}

/**
 * Stretches the passphrase into a key.
 *
 * scrypt with a per-file salt, so two dumps taken with the same passphrase do
 * not share a key, and so a weak passphrase costs an attacker real time per
 * guess rather than one hash.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
}

export function isEncryptionConfigured(
  key: string | undefined = process.env.BACKUP_ENCRYPTION_KEY,
): boolean {
  return typeof key === 'string' && key.length > 0;
}

/**
 * Streams `input` into `output`, encrypted, returning the size and checksum of
 * the file as written.
 *
 * Chunk by chunk on purpose: a database large enough to be worth backing up is
 * one too large to hold in memory, and the checksum is taken over the bytes
 * that actually land on disk so a later restore can prove it read the same
 * file.
 */
export async function encryptStream(
  input: Readable,
  output: Writable,
  passphrase: string,
): Promise<{ bytes: number; checksum: string }> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);

  const digest = createHash('sha256');
  let bytes = 0;

  const write = async (chunk: Buffer): Promise<void> => {
    digest.update(chunk);
    bytes += chunk.length;
    // Respect backpressure: a fast dump into a slow disk must not buffer the
    // whole database in memory.
    if (!output.write(chunk)) await once(output, 'drain');
  };

  await write(Buffer.concat([MAGIC, salt, iv]));

  input.pipe(cipher);
  for await (const chunk of cipher) {
    await write(chunk as Buffer);
  }

  await write(cipher.getAuthTag());

  return { bytes, checksum: digest.digest('hex') };
}

/**
 * Decrypts a file that `encryptStream` wrote.
 *
 * Takes the whole ciphertext as a buffer rather than streaming it, because the
 * only caller is the restore drill — which has already had to put the dump on
 * disk for `pg_restore` to read.
 */
export function decryptBuffer(file: Buffer, passphrase: string): Buffer {
  if (file.length < HEADER_LENGTH + TAG_LENGTH) {
    throw new BackupFormatError('it is too short to contain a header and a tag');
  }
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupFormatError('the header does not match');
  }

  const salt = file.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH);
  const iv = file.subarray(MAGIC.length + SALT_LENGTH, HEADER_LENGTH);
  const tag = file.subarray(file.length - TAG_LENGTH);
  const body = file.subarray(HEADER_LENGTH, file.length - TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  try {
    // Throws if the tag does not verify, which is the property that makes a
    // truncated or tampered dump fail loudly instead of restoring something
    // that looks fine.
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Node's own message here is "Unsupported state or unable to authenticate
    // data", which is accurate and tells the person nothing they can act on.
    // The two causes are the wrong key and a damaged file, and it is not
    // possible to tell which — so say both.
    throw new BackupFormatError(
      'either BACKUP_ENCRYPTION_KEY is not the key this dump was written ' +
        'with, or the file has been altered or truncated since. Both are ' +
        'indistinguishable from here, and both mean it cannot be restored',
    );
  }
}

/** Whether a file on disk is one of ours, without needing the key. */
export function looksEncrypted(head: Buffer): boolean {
  return head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC);
}

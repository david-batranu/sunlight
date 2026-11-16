/**
 * Atomic file writes: temp file in the destination directory, fsync, rename.
 *
 * Rename within one directory is atomic on POSIX and on NTFS, so readers either
 * see the previous file or the complete new one, never a partial write.
 */

import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

let counter = 0;

export async function atomicWriteFile(filePath: string, data: Buffer | string, mode = 0o644): Promise<void> {
  const directory = path.dirname(filePath);
  const tempName = `.${path.basename(filePath)}.tmp-${process.pid}-${counter++}-${randomBytes(4).toString('hex')}`;
  const tempPath = path.join(directory, tempName);
  const handle = await open(tempPath, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Removes a file, ignoring "not found" (used by cache cleanup). */
export async function safeUnlink(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

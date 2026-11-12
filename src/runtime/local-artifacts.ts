import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '../shared/errors.js';

export async function saveLocalArtifact(file: string, bytes: Buffer) {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('CONFLICT', '输出文件已存在，请选择新的文件名。', { path });
    throw error;
  }
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

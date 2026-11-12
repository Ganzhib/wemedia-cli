import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';

async function sources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

test('shared layers cannot import concrete platforms or rely on the removed single-platform CLI', async () => {
  const platformRoot = resolve('src/platform');
  for (const root of ['src/core', 'src/runtime', 'src/content', 'src/services', 'src/cli']) {
    for (const path of await sources(root)) {
      const tree = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const imported = resolve(path, '..', statement.moduleSpecifier.text);
        const allowedComposition = path === join('src', 'cli', 'wm-program.ts') && imported === join(platformRoot, 'builtins.js');
        assert.ok(allowedComposition || !imported.startsWith(platformRoot), path + ' imports ' + statement.moduleSpecifier.text);
      }
    }
  }
  await assert.rejects(readFile('src/cli.ts'), { code: 'ENOENT' });
  await assert.rejects(readFile('src/cli/program.ts'), { code: 'ENOENT' });
});

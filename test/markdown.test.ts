import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanImages, rewriteImages, readArticle, localImagePath } from '../src/content/markdown.js';
import { preflightImages } from '../src/platform/juejin/assets.js';

test('rewrites image nodes while preserving code examples and ordinary text', async () => {
  const source = '# Title\n\n![chart](./chart.png "Chart")\n\n`![example](./chart.png)`\n\n```md\n![example](./chart.png)\n```\n\n./chart.png is an example filename.\n';
  const images = scanImages(source, '/tmp');
  assert.equal(images.length, 1);
  const result = await rewriteImages(source, images, async () => 'https://cdn.example/chart.png');
  assert.match(result.content, /https:\/\/cdn.example\/chart.png/);
  assert.ok(result.content.includes('`![example](./chart.png)`'));
  assert.ok(result.content.includes('```md\n![example](./chart.png)\n```'));
  assert.ok(result.content.endsWith('./chart.png is an example filename.\n'));
});

test('supports reference images, escaped paths and deduplicated uploads', async () => {
  const source = '![one][picture]\n\n![two](<./my image.png>)\n\n[picture]: ./my%20image.png "Reference"\n';
  const images = scanImages(source, '/tmp');
  assert.equal(images.length, 2);
  let calls = 0;
  const result = await rewriteImages(source, images, async () => { calls++; return 'https://cdn.example/image.png'; });
  assert.equal(calls, 1);
  assert.ok(result.content.includes('[picture]: https://cdn.example/image.png'));
  assert.ok(result.content.includes('![one][picture]'));
});

test('ignores remote images and rejects unsupported URL schemes', () => {
  assert.equal(scanImages('![remote](https://example.com/a.png)', '/tmp').length, 0);
  assert.equal(localImagePath('//cdn.example/a.png', '/tmp'), undefined);
  assert.throws(() => scanImages('![data](data:image/png;base64,aaaa)', '/tmp'), /图片仅支持/);
});

test('parses YAML multiline metadata without truncating the article', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'juejin-markdown-'));
  try {
    const file = join(directory, 'article.md');
    await writeFile(file, '---\ntitle: "A: B"\nbrief: >-\n  first line\n  second line\ntags:\n  - React.js\n  - TypeScript\n---\n# Body\n');
    const article = await readArticle(file);
    assert.equal(article.metadata.brief, 'first line second line');
    assert.deepEqual(article.metadata.tags, ['React.js', 'TypeScript']);
    assert.equal(article.content, '# Body\n');
  } finally { await rm(directory, { recursive: true }); }
});

test('preflights all local assets before allowing uploads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'juejin-assets-'));
  try {
    await writeFile(join(directory, 'valid.png'), 'image');
    const images = scanImages('![valid](./valid.png)\n![missing](./missing.png)', directory);
    await assert.rejects(() => preflightImages(images), /ENOENT/);
  } finally { await rm(directory, { recursive: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSchema, diagramSvg } from '../src/content/visuals.js';
import { saveLocalArtifact } from '../src/runtime/local-artifacts.js';

test('diagram escapes author text and rejects broken graph references or out-of-bounds nodes', () => {
  const spec = { title: '<script>alert(1)</script>', nodes: [{ id: 'entry', title: 'A & B', x: 20, y: 120 }] };
  const svg = diagramSvg(spec);
  assert.ok(svg.includes('&lt;script&gt;')); assert.ok(svg.includes('A &amp; B')); assert.ok(!svg.includes('<script>'));
  assert.throws(() => diagramSvg({ ...spec, edges: [{ from: 'entry', to: 'missing' }] }));
  assert.throws(() => diagramSvg({ ...spec, width: 600, nodes: [{ ...spec.nodes[0], x: 500 }] }));
  assert.throws(() => diagramSvg({ ...spec, nodes: [spec.nodes[0], spec.nodes[0]] }));
  assert.equal(captureSchema.safeParse({ url: 'file:///private.txt' }).success, false);
  assert.equal(captureSchema.safeParse({ url: 'https://example.com', width: 'NaN' }).success, false);
});
test('local content records byte integrity and never overwrites an existing artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wm-media-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'article.md'); const bytes = Buffer.from('# 我的文章');
  const receipt = await saveLocalArtifact(path, bytes);
  assert.equal(receipt.bytes, bytes.length); assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(saveLocalArtifact(path, Buffer.from('replacement')), /已存在/);
  assert.deepEqual(await readFile(path), bytes);
});

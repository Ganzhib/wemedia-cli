import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceSnapshot } from '../src/content/resources.js';
import { requireDraftVersion, sameDraftContent } from '../src/platform/juejin/resource-version.js';

const image = 'https://p0-xtjj-private.juejin.cn/tos-cn-i-test/image~tplv-test:q75.awebp?policy=fabricated&rk3s=test&x-orig-authkey=fake&x-orig-expires=1&x-orig-sign=old';
const refreshed = image.replace('expires=1', 'expires=2').replace('sign=old', 'sign=new').replace('rk3s=test', 'rk3s=refreshed');
test('Juejin compares image identity while retaining raw URLs and snapshot integrity', () => {
  const before = { title: 'Title', body: `Text\n![Cover](${image})\n![Reference][a]\n\n[a]: ${image}`, cover: image };
  const after = { ...before, body: before.body.replaceAll(image, refreshed), cover: refreshed };
  const base = resourceSnapshot({ kind: 'draft', id: '1' }, 'draft', before);
  const current = resourceSnapshot(base.resource, 'draft', after);
  assert.notEqual(base.version, current.version);
  assert.doesNotThrow(() => requireDraftVersion(base, current));
  assert.equal(current.data.cover, refreshed);
  assert.equal(sameDraftContent(before, { ...after, body: after.body.replaceAll('&', '&#x26;') }), true);
  assert.throws(() => requireDraftVersion({ ...base, version: 'forged' }, current), /摘要不匹配/);
  for (const changed of [
    { ...after, title: 'Changed' }, { ...after, body: after.body + ' changed' },
    { ...after, cover: refreshed.replace('/image~', '/other~') },
    { ...after, cover: refreshed.replace('q75', 'q90') },
    { ...after, cover: refreshed.replace('policy=fabricated', 'policy=other') },
  ]) assert.throws(() => requireDraftVersion(base, resourceSnapshot(base.resource, 'draft', changed)), /远端内容已改变/);
});

test('Juejin does not ignore URL changes in code, prose links or unrelated image hosts', () => {
  for (const body of [`\`${image}\``, `[Link](${image})`, `\`\`\`text\n![Example](${image})\n\`\`\``]) {
    assert.equal(sameDraftContent({ body }, { body: body.replace(image, refreshed) }), false);
  }
  assert.equal(sameDraftContent({ cover: image.replace('p0-xtjj-private.juejin.cn', 'example.com') },
    { cover: refreshed.replace('p0-xtjj-private.juejin.cn', 'example.com') }), false);
});

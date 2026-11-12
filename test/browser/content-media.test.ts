import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureWebsite, renderDiagram } from '../../src/content/visuals.js';

test('content media captures a unique website section and renders a diagram without external requests', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<style>body{margin:0}.hero{width:500px;height:200px;background:#205b49}</style><div class="hero">Public product page</div><p>Outside capture</p>' }));
  const png = await captureWebsite(page, { url: 'https://fixture.test', selector: '.hero' });
  assert.equal(png.readUInt32BE(16), 500); assert.equal(png.readUInt32BE(20), 200);
  await assert.rejects(captureWebsite(page, { url: 'https://fixture.test', selector: '.missing' }), /匹配一个/);
  const diagram = await renderDiagram(page, { title: '入口到平台', width: 800, height: 500, nodes: [
    { id: 'cli', title: 'wm CLI', x: 30, y: 120 }, { id: 'platform', title: '平台', x: 430, y: 300 },
  ], edges: [{ from: 'cli', to: 'platform', label: '发布' }] });
  assert.equal(diagram.readUInt32BE(16), 800); assert.equal(diagram.readUInt32BE(20), 500);
  assert.equal(await page.locator('script').count(), 0);
});

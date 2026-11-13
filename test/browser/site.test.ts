import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

for (const width of [1440, 390, 320]) test(`product site scenarios, onboarding and banner work at ${width}px`, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const errors: string[] = []; const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://wm.test') return route.abort();
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    return route.fulfill({ contentType, body: await readFile('site' + file) });
  });
  await page.addInitScript("Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { document.documentElement.dataset.copied = text; } } });");
  await page.goto('https://wm.test/');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.match(await page.locator('.name-intro').innerText(), /WeMedia.*自媒体/);
  assert.equal(await page.locator('.studio-banner').getAttribute('href'), 'https://my.feishu.cn/wiki/Tj4ZwTpEUisrg3kojmbcnR9yn1I?create_from=create_doc_to_wiki');
  for (const scenario of ['draft', 'update', 'share']) {
    await page.locator(`[data-scenario="${scenario}"]`).click();
    assert.equal(await page.locator(`[data-scenario="${scenario}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-scenario][aria-pressed="true"]').count(), 1);
    const prompt = await page.locator('#scenario-prompt').innerText();
    assert.match(prompt, scenario === 'share' ? /公众号与掘金/ : scenario === 'draft' ? /只存草稿/ : /修改公众号/);
    await page.locator('[data-copy="scenario-prompt"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.copied), prompt);
    assert.equal(await page.locator('#scenario-steps li').count(), 3);
  }
  const dialog = page.getByRole('dialog');
  for (const platform of ['wechat', 'xiaohongshu', 'juejin', 'zhihu']) {
    const source = page.locator(`#platform-prompt-${platform}`);
    const prompt = await source.textContent();
    const trigger = page.locator(`[data-prompt="platform-prompt-${platform}"]`);
    const card = trigger.locator('..');
    const cardHeight = await card.evaluate(element => element.getBoundingClientRect().height);
    await page.locator(`[data-copy="platform-prompt-${platform}"]`).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.copied), prompt);
    assert.equal(await dialog.isVisible(), false);
    await trigger.click();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await page.locator('#prompt-dialog-title').textContent(), await source.getAttribute('data-title'));
    assert.equal(await page.locator('#prompt-dialog-content').textContent(), prompt);
    assert.equal(await card.evaluate(element => element.getBoundingClientRect().height), cardHeight);
    await page.locator('[data-copy="prompt-dialog-content"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.copied), prompt);
    assert.match(await page.locator('#prompt-dialog-status').innerText(), /已复制/);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  }
  await page.locator('[data-prompt="platform-prompt-wechat"]').click();
  await page.getByRole('button', { name: '关闭提示词弹窗' }).click();
  assert.equal(await dialog.isVisible(), false);
  await page.locator('[data-prompt="platform-prompt-zhihu"]').click();
  await page.mouse.click(2, 2);
  assert.equal(await dialog.isVisible(), false);
  // The whole header sticks, and anchor destinations remain below its responsive height.
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  await page.locator('nav a[href="#platforms"]').click();
  const positions = await page.evaluate(() => ({
    headerTop: document.querySelector('.site-header')!.getBoundingClientRect().top,
    headerBottom: document.querySelector('.site-header')!.getBoundingClientRect().bottom,
    sectionTop: document.getElementById('platforms')!.getBoundingClientRect().top,
  }));
  assert.equal(positions.headerTop, 0);
  assert.ok(positions.sectionTop >= positions.headerBottom);
  await page.locator('[data-copy="setup-prompt"]').click();
  assert.match(await page.evaluate(() => document.documentElement.dataset.copied ?? ''), /WeMedia.*最新版本/);
  await page.getByText('自行安装', { exact: true }).click();
  assert.equal(await page.locator('#install-command').isVisible(), true);
  assert.match(await page.locator('#install-command').innerText(), /@latest$/);
  // Clipboard denial must leave the requested text available for manual copying.
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
  await page.locator('[data-copy="install-command"]').click();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), await page.locator('#install-command').innerText());
  assert.match(await page.locator('#copy-status').innerText(), /手动复制/);
  await page.locator('[data-copy="platform-prompt-wechat"]').click();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), await page.locator('#platform-prompt-wechat').textContent());
  assert.match(await page.locator('#prompt-dialog-status').innerText(), /手动复制/);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
});

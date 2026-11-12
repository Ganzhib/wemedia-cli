import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageUploader } from '../src/platform/juejin/imagex.js';
import { JuejinHttp } from '../src/platform/juejin/http.js';
import { CliError } from '../src/shared/errors.js';

test('uploads through STS/Apply/TOS/Commit/URL without leaking cookies to upload hosts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'juejin-imagex-'));
  const calls: string[] = [];
  try {
    const file = join(directory, 'image.png');
    await writeFile(file, '123456789');
    const token = { AccessKeyId: 'access', SecretAccessKey: 'secret', SessionToken: 'token' };
    const fetchMock: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      const headers = new Headers(init?.headers);
      calls.push(parsed.pathname + ':' + (parsed.searchParams.get('Action') ?? ''));
      if (parsed.hostname === 'api.juejin.cn') {
        assert.equal(headers.get('Cookie'), 'sessionid=account-secret');
        if (parsed.pathname.endsWith('gen_token')) return Response.json({ err_no: 0, data: { token } });
        return Response.json({ err_no: 0, data: { main_url: 'https://cdn.example/image.png' } });
      }
      assert.equal(headers.get('Cookie'), null);
      if (parsed.searchParams.get('Action') === 'ApplyImageUpload') {
        assert.match(headers.get('authorization')!, /AWS4-HMAC-SHA256/);
        return Response.json({ Result: { UploadAddress: { SessionKey: 'opaque', UploadHosts: ['upload.snssdk.com'], StoreInfos: [{ StoreUri: 'image/path', Auth: 'upload-only' }] } } });
      }
      if (parsed.hostname === 'upload.snssdk.com') {
        assert.equal(headers.get('Content-CRC32'), 'cbf43926');
        assert.equal(headers.get('authorization'), 'upload-only');
        return new Response('{}');
      }
      assert.equal(init!.method, 'POST');
      return Response.json({ Result: { Results: [{ UriStatus: 2000 }] } });
    };
    const http = new JuejinHttp({ cookie: 'sessionid=account-secret', fetch: fetchMock });
    assert.deepEqual(await new ImageUploader(http, fetchMock).upload(file), { uri: 'image/path', url: 'https://cdn.example/image.png' });
    assert.deepEqual(calls, ['/imagex/v2/gen_token:', '/:ApplyImageUpload', '/image/path:', '/:CommitImageUpload', '/imagex/v2/get_img_url:']);
    const failingUrl: typeof fetch = async (url, init) => {
      if (String(url).includes('get_img_url')) throw new Error('timeout');
      return fetchMock(url, init);
    };
    const failingUploader = new ImageUploader(new JuejinHttp({ cookie: 'sessionid=account-secret', fetch: failingUrl }), failingUrl);
    await assert.rejects(failingUploader.upload(file), (error: CliError) => {
      assert.equal(error.details?.uri, 'image/path');
      assert.equal(error.details?.upload_status, 'committed');
      return true;
    });
    calls.length = 0;
    assert.equal(await new ImageUploader(http, fetchMock).resolveUrl('image/path'), 'https://cdn.example/image.png');
    assert.deepEqual(calls, ['/imagex/v2/get_img_url:']);
  } finally { await rm(directory, { recursive: true }); }
});

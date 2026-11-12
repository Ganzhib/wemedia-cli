// ImageX protocol and signing adapted from liuleihang/juejin-skills (MIT).
// See THIRD_PARTY_NOTICES.md for the original copyright and license.
import { createHash, createHmac, randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { crc32 } from 'node:zlib';
import { CliError } from '../../shared/errors.js';
import { JuejinHttp, USER_AGENT } from './http.js';

interface TemporaryToken { AccessKeyId: string; SecretAccessKey: string; SessionToken: string }
interface UploadAddress {
  SessionKey: string;
  StoreInfos: { StoreUri: string; Auth: string }[];
  UploadHosts?: string[];
}
const IMAGEX_HOST = 'https://imagex.bytedanceapi.com';
const SERVICE_ID = '73owjymdk6';
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

export async function validateImage(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new CliError('INPUT', '图片必须为文件。');
  validateImageMetadata(extname(path).toLowerCase(), info.size);
}

export function validateImageMetadata(extension: string, size: number): void {
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new CliError('INPUT', '掘金不支持此图片格式：' + extension);
  if (size === 0 || size > 5 * 1024 * 1024) throw new CliError('INPUT', '掘金图片必须非空且不超过 5 MiB。');
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function hmac(key: string | Buffer, value: string): Buffer { return createHmac('sha256', key).update(value).digest(); }

export function signImageX(token: TemporaryToken, query: Record<string, string>, method: string, now = new Date()): Record<string, string> {
  const dateTime = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const date = dateTime.slice(0, 8);
  const canonicalQuery = Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).sort().join('&');
  const signedHeaders = 'x-amz-date;x-amz-security-token';
  // The editor signs the empty payload and these two headers for Apply/Commit.
  const canonicalRequest = [method, '/', canonicalQuery,
    `x-amz-date:${dateTime}\nx-amz-security-token:${token.SessionToken}\n`, signedHeaders, hash(''),
  ].join('\n');
  const scope = `${date}/cn-north-1/imagex/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, hash(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${token.SecretAccessKey}`, date);
  const regionKey = hmac(dateKey, 'cn-north-1');
  const serviceKey = hmac(regionKey, 'imagex');
  const signature = createHmac('sha256', hmac(serviceKey, 'aws4_request')).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${token.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': dateTime, 'x-amz-security-token': token.SessionToken,
  };
}

export class ImageUploader {
  constructor(private readonly http: JuejinHttp, private readonly fetch = globalThis.fetch) {}

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new CliError('NETWORK', '图片上传请求未完成，请检查草稿和上传结果后再决定是否重试。');
    }
    if (!response.ok) throw new CliError('API', `图片上传返回 HTTP ${response.status}。`);
    return response;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(url, init);
    return response.json() as Promise<T>;
  }

  private async imageX<T>(token: TemporaryToken, query: Record<string, string>, method: string): Promise<T> {
    const response = await this.request<{ Result?: T; ResponseMetadata?: { Error?: { Code: string; Message: string } } }>(
      `${IMAGEX_HOST}/?${new URLSearchParams(query)}`, {
        method, headers: { ...signImageX(token, query, method), 'User-Agent': USER_AGENT },
        body: method === 'POST' ? '' : undefined,
      },
    );
    if (!response.Result) {
      const code = response.ResponseMetadata?.Error?.Code;
      throw new CliError('API', 'ImageX 未返回上传结果。', { imagex_code: code });
    }
    return response.Result;
  }

  async upload(path: string): Promise<string> {
    await validateImage(path);
    const uuid = `${Date.now()}${randomInt(100000, 1000000)}`;
    const { token } = await this.http.data<{ token: TemporaryToken }>(`/imagex/v2/gen_token?aid=2608&uuid=${uuid}&client=web`);
    const { UploadAddress: address } = await this.imageX<{ UploadAddress: UploadAddress }>(token, {
      Action: 'ApplyImageUpload', Version: '2018-08-01', ServiceId: SERVICE_ID,
    }, 'GET');
    if (!address.StoreInfos.length) throw new CliError('PROTOCOL', 'ImageX 没有返回可用的上传地址。');
    const store = address.StoreInfos[0];
    const host = uploadHost(address);
    const contents = await readFile(path);
    // Send only temporary upload authorization to TOS, never the account Cookie.
    await this.send(`https://${host}/${store.StoreUri}`, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: store.Auth, 'Content-Type': 'application/octet-stream',
        'Content-CRC32': crc32(contents).toString(16).padStart(8, '0'),
        'Content-Disposition': `attachment; filename="${basename(path).replace(/[^\w.\-]/g, '_')}"`,
      },
      body: new Uint8Array(contents),
    });
    const committed = await this.imageX<{ Results: { UriStatus: number }[] }>(token, {
      Action: 'CommitImageUpload', Version: '2018-08-01', ServiceId: SERVICE_ID, SessionKey: address.SessionKey,
    }, 'POST');
    if (committed.Results[0]?.UriStatus !== 2000) throw new CliError('API', 'ImageX 未确认图片提交成功。');
    try {
      return await this.resolveUrl(store.StoreUri);
    } catch (error) {
      const failure = error instanceof CliError ? error : new CliError('INTERNAL', '图片地址获取失败。');
      throw new CliError(failure.code, '图片已提交成功，但地址获取失败；使用 image resolve 查询已有图片，不要重新上传。', { ...failure.details, file: path, uri: store.StoreUri, upload_status: 'committed' });
    }
  }

  async resolveUrl(uri: string): Promise<string> {
    if (!uri.trim() || uri.length > 2048 || /[\s\u0000-\u001f]/.test(uri)) throw new CliError('INPUT', '请提供上传结果中的有效图片 URI。');
    const uuid = `${Date.now()}${randomInt(100000, 1000000)}`;
    const result = await this.http.data<{ main_url: string }>(`/imagex/v2/get_img_url?aid=2608&uuid=${uuid}&uri=${encodeURIComponent(uri)}&img_type=private`);
    return result.main_url;
  }
}

function uploadHost(address: UploadAddress): string {
  if (address.UploadHosts?.length) return address.UploadHosts[0];
  // The observed editor response also carries the host inside its encoded session key.
  try {
    const session = JSON.parse(Buffer.from(address.SessionKey, 'base64').toString('utf8')) as { uploadHost?: string };
    if (session.uploadHost) return session.uploadHost;
  } catch {
    // Some server keys are opaque. Use the host observed by the upstream implementation.
  }
  return 'tos-d-x-hl.snssdk.com';
}

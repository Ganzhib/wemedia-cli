import { CliError } from '../../shared/errors.js';
import JSONbig from 'json-bigint';

// Web responses include 19-digit numeric IDs. Preserve those tokens before JS rounds them.
const json = JSONbig({ storeAsString: true, protoAction: 'error', constructorAction: 'error' });

export interface ApiResponse<T> {
  err_no: number;
  err_msg: string;
  data: T | null;
  cursor?: string;
  has_more?: boolean;
  count?: number;
}

export const API_BASE = 'https://api.juejin.cn';
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface HttpOptions {
  cookie?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class JuejinHttp {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly cookie: string;

  constructor(options: HttpOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.cookie = options.cookie ?? '';
  }

  async request<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT, Accept: 'application/json',
      Origin: 'https://juejin.cn', Referer: 'https://juejin.cn/',
    };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      // A lost response does not mean a write failed. Never replay requests automatically.
      response = await this.fetch(`${API_BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CliError('NETWORK', `请求 ${path} 未完成；写操作结果可能未知，请先查询再决定是否重试。`, { path });
    }
    if (!response.ok) {
      throw new CliError('API', `请求 ${path} 返回 HTTP ${response.status}。`, { path, status: response.status });
    }
    let envelope: ApiResponse<T>;
    try {
      envelope = json.parse(await response.text()) as ApiResponse<T>;
    } catch {
      throw new CliError('PROTOCOL', `接口 ${path} 未返回 JSON。`, { path });
    }
    if (envelope.err_no !== 0) {
      throw new CliError('API', `掘金接口失败：${envelope.err_msg}`, { path, err_no: envelope.err_no, outcome: 'rejected' });
    }
    return envelope;
  }

  async data<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request<T>(path, body);
    if (response.data === null) {
      throw new CliError('PROTOCOL', `接口 ${path} 返回空 data。`, { path });
    }
    return response.data;
  }
}

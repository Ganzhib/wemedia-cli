import { z } from 'zod';
import type { ResourceSnapshot }  from '../core/types.js';
import { semanticDigest, canonicalJson } from '../runtime/objects.js';
import { CliError } from '../shared/errors.js';

export function resourceSnapshot<R extends ResourceSnapshot['resource'], T extends z.infer<ReturnType<typeof z.json>>>(resource: R, state: string, data: T) {
  return { resource, version: semanticDigest(data), state, data, observedAt: new Date().toISOString() };
}
export interface ContentChange { path: (string | number)[]; before?: unknown; after?: unknown }
export function contentChanges(before: unknown, after: unknown, path: (string | number)[] = []): ContentChange[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    const previous = before as Record<string, unknown>; const next = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    return [...keys].flatMap(key => contentChanges(previous[key], next[key], [...path, Array.isArray(before) ? Number(key) : key]));
  }
  return [{ path, before, after }];
}
export function requireVersion(expected: Pick<ResourceSnapshot, 'resource' | 'version' | 'data'>, current: ResourceSnapshot): void {
  if (expected.version !== semanticDigest(expected.data)) throw new CliError('INPUT', '基准快照摘要不匹配，请重新读取远端资源。', { outcome: 'rejected' });
  if (expected.version === current.version) return;
  throw new CliError('CONFLICT', '远端内容已改变，停止更新，请先核对差异。', {
    outcome: 'rejected', reason: 'remote_version_changed', resource: expected.resource,
    expected_version: expected.version, actual_version: current.version, changes: contentChanges(expected.data, current.data), current,
    required_action: 'review_remote_changes',
  });
}

export function resourceBaseline<T extends ResourceSnapshot>(snapshot: T): Omit<T, 'observedAt'> {
  const { observedAt: _time, ...baseline } = snapshot; return baseline;
}

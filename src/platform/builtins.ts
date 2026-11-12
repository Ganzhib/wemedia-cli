import { PlatformRegistry } from '../core/registry.js';
import { createJuejinPlatform } from './juejin/adapter.js';
import { createWechatPlatform } from './wechat/adapter.js';
import { createXiaohongshuPlatform } from './xiaohongshu/adapter.js';

export function defaultRegistry(): PlatformRegistry {
  return new PlatformRegistry([createJuejinPlatform(), createXiaohongshuPlatform(), createWechatPlatform()]);
}

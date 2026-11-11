// gateway.js — 本机 WorkBuddy 号池网关（workbuddy2api-panel）的连接参数与请求封装。
//
// 约束：
//   - 只与本机网关通信（默认 http://127.0.0.1:7863），拒绝外部主机，避免 api_key 外发；
//   - 密钥优先级：WORKBUDDY_POOL_API_KEY > 原 xuedinerAPI 的 *_API_KEY > 网关 config.json 的 api_key；
//   - 每个请求都带可组合的取消信号与硬超时（AbortSignal.any）。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_GATEWAY = 'http://127.0.0.1:7863';
const LOCAL_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
// 兼容拆分前的 xuedinerAPI 环境变量命名：老配置不改也能用。
const BASE_URL_ENV = ['WORKBUDDY_POOL_BASE_URL', 'XUEDINER_GATEWAY_URL', 'WORKBUDDY_GATEWAY_URL'];
const API_KEY_ENV = [
  'WORKBUDDY_POOL_API_KEY',
  'XUEDINER_API_KEY',
  'XUEDINER_GATEWAY_API_KEY',
  'WORKBUDDY_GATEWAY_API_KEY',
];
const GATEWAY_DIR_ENV = ['WORKBUDDY_POOL_GATEWAY_DIR', 'XUEDINER_GATEWAY_DIR', 'WORKBUDDY_GATEWAY_DIR'];

export class GatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = Number.isSafeInteger(options.status) ? options.status : 0;
    this.unreachable = options.unreachable === true;
    this.body = options.body ?? null;
  }
}

function envValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 解析并校验网关地址；localhost 统一改写为 127.0.0.1（避免 IPv6 解析差异）。 */
export function gatewayBase() {
  const raw = envValue(BASE_URL_ENV);
  let url;
  try {
    url = new URL(raw && raw.trim() ? raw.trim() : DEFAULT_GATEWAY);
  } catch {
    throw new GatewayError('网关地址（WORKBUDDY_POOL_BASE_URL）格式有误');
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new GatewayError('网关地址必须指向本机（127.0.0.1 / localhost）');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GatewayError('网关地址必须使用 http 或 https');
  }
  if (url.username || url.password) {
    throw new GatewayError('网关地址不能携带用户名或密码');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

/** 环境变量里的网关目录（拆分前后的命名都认），未设置时返回 null。 */
export function gatewayDirFromEnv() {
  const dir = envValue(GATEWAY_DIR_ENV);
  return dir && dir.trim() ? path.resolve(dir.trim()) : null;
}

/** DSH 主目录：优先 DSH_HOME，否则 ~/.dsh。 */
export function dshHome() {
  const home = process.env.DSH_HOME;
  if (home && home.trim()) return path.resolve(home.trim());
  return path.join(homedir(), '.dsh');
}

/** 插件自身的用户级配置：<DSH 主目录>/workbuddy-pool.json（改完下一次请求即生效）。 */
export function userConfigPath() {
  return path.join(dshHome(), 'workbuddy-pool.json');
}

/**
 * 读取用户级配置。
 * 支持的键：gatewayConfig（网关 config.json 路径）、apiKey（网关密钥，覆盖配置文件里的）。
 * @returns {Promise<null | {gatewayConfig?: string, apiKey?: string}>}
 */
export async function readUserConfig(signal) {
  let text;
  try {
    text = await readFile(userConfigPath(), { encoding: 'utf8', signal });
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(text.replace(/^\uFEFF/, ''));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * 可能存在的网关配置文件，按优先级：
 *   WORKBUDDY_POOL_CONFIG > 用户配置里的 gatewayConfig > <网关目录>/config.json
 */
export function configCandidates(user = null) {
  const files = [];
  const explicit = process.env.WORKBUDDY_POOL_CONFIG;
  if (explicit && explicit.trim()) files.push(explicit.trim());
  if (user && typeof user.gatewayConfig === 'string' && user.gatewayConfig.trim()) {
    files.push(user.gatewayConfig.trim());
  }
  const dir = gatewayDirFromEnv();
  if (dir) files.push(path.join(dir, 'config.json'));
  return files;
}

function resolveAuthDir(dir, value) {
  if (typeof value !== 'string' || value.trim() === '') return path.join(dir, 'auths');
  const raw = value.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(dir, raw);
}

/**
 * 读取网关配置（config.json）。
 * @returns {Promise<null | {path: string, dir: string, config: object, authDir: string}>}
 */
export async function readGatewayConfig(signal) {
  const user = await readUserConfig(signal);
  for (const file of configCandidates(user)) {
    const absolute = path.resolve(file);
    let text;
    try {
      text = await readFile(absolute, { encoding: 'utf8', signal });
    } catch {
      continue;
    }
    try {
      const config = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
      const dir = path.dirname(absolute);
      return { path: absolute, dir, config, authDir: resolveAuthDir(dir, config.auth_dir) };
    } catch {
      continue;
    }
  }
  return null;
}

/** 当前生效的网关密钥；空字符串表示网关未启用鉴权。 */
export async function gatewayKey(signal) {
  const value = envValue(API_KEY_ENV);
  if (value !== undefined) return value.trim();
  const user = await readUserConfig(signal);
  if (user && typeof user.apiKey === 'string' && user.apiKey.trim()) return user.apiKey.trim();
  const info = await readGatewayConfig(signal);
  if (info) {
    const key = info.config?.api_key;
    return typeof key === 'string' ? key.trim() : '';
  }
  const explicit = process.env.WORKBUDDY_POOL_CONFIG;
  if (explicit && explicit.trim()) {
    throw new GatewayError('无法读取 WORKBUDDY_POOL_CONFIG 指向的网关配置');
  }
  return '';
}

function detailOf(data, text) {
  const candidates = [data?.error, data?.message, data?.error?.message, data?.msg];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return `：${value.trim().slice(0, 300)}`;
  }
  const raw = text.trim();
  return raw ? `：${raw.slice(0, 300)}` : '';
}

/**
 * 创建网关请求函数。
 * @param {AbortSignal} [disposeSignal] 插件卸载时取消全部在途请求。
 * @returns {(target: string, options?: {method?: string, query?: object, body?: unknown, timeout?: number, signal?: AbortSignal}) => Promise<any>}
 */
export function createGatewayClient(disposeSignal) {
  return async function request(target, options = {}) {
    const method = options.method ?? 'GET';
    const timeout = options.timeout ?? 15_000;
    const base = gatewayBase();
    const url = new URL(String(target).replace(/^\//, ''), base);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    const headers = { accept: 'application/json' };
    const key = await gatewayKey(disposeSignal);
    if (key) headers.authorization = `Bearer ${key}`;
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const signals = [AbortSignal.timeout(timeout)];
    if (disposeSignal) signals.push(disposeSignal);
    if (options.signal) signals.push(options.signal);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (disposeSignal?.aborted) throw new GatewayError('插件已停止');
      if (error?.name === 'TimeoutError') {
        throw new GatewayError(`网关请求超时（${Math.round(timeout / 1000)} 秒）`);
      }
      throw new GatewayError(`无法连接本机 WorkBuddy 号池网关（${base.host}）`, { unreachable: true });
    }

    const text = await response.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new GatewayError(
          `网关鉴权失败：请在 ${userConfigPath()} 里填 {"gatewayConfig":"<网关 config.json 路径>"} `
            + '或设置 WORKBUDDY_POOL_API_KEY',
          { status: response.status, body: data },
        );
      }
      throw new GatewayError(`网关返回 HTTP ${response.status}${detailOf(data, text)}`, {
        status: response.status,
        body: data,
      });
    }
    if (data === null) {
      throw new GatewayError('网关返回的内容不是 JSON', { status: response.status });
    }
    return data;
  };
}

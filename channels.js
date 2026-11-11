// channels.js — 从网关 auths 目录读账号的「渠道」归属（国内 / 国际）。
//
// 网关把每个账号的凭证落在 <auth_dir>/workbuddy*.json，两种形态都认：
//   嵌套形 {account:{uid,enterpriseId,nickname}, auth:{accessToken,...,domain}}
//   扁平形 {accessToken,...,uid,domain}
// 域名含 codebuddy.ai 的是国际站账号，chat 入口为
// https://www.codebuddy.ai/console/chat/completions（且首条消息必须是 system）；
// 其余是国内站账号，入口为 https://copilot.tencent.com/v2/chat/completions。
// 插件只读这些文件做展示；写凭证只有登录流程（login.js）会做。
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gatewayDirFromEnv, readGatewayConfig } from './gateway.js';

export const CN_ENDPOINT = 'https://copilot.tencent.com/v2/chat/completions';
export const INTL_ENDPOINT = 'https://www.codebuddy.ai/console/chat/completions';

export function endpointFor(realm) {
  return realm === 'intl' ? INTL_ENDPOINT : CN_ENDPOINT;
}

/** 网关 auths 目录：优先取 config.json 里解析后的 auth_dir，其次 <网关目录>/auths。 */
export async function resolveAuthDir(signal) {
  const info = await readGatewayConfig(signal);
  if (info) return info.authDir;
  const dir = gatewayDirFromEnv();
  return dir ? path.join(dir, 'auths') : null;
}

function text(value, max = 120) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
    : '';
}

function describe(file, doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const auth = doc.auth && typeof doc.auth === 'object' ? doc.auth : doc;
  const account = doc.account && typeof doc.account === 'object' ? doc.account : doc;
  const uid = text(account.uid, 128);
  if (!uid) return null;

  const domain = text(auth.domain, 120);
  const realm = /codebuddy\.ai/i.test(domain) || /^workbuddy-intl-/i.test(file) ? 'intl' : 'cn';
  const expiresAt = Number.isFinite(auth.expiresAt) && auth.expiresAt > 0 ? auth.expiresAt * 1000 : null;

  return {
    uid,
    nickname: text(account.nickname, 80),
    realm,
    domain,
    endpoint: endpointFor(realm),
    file,
    expiresAt,
  };
}

/**
 * 读取全部账号的渠道信息。
 * @param {AbortSignal} [signal]
 * @returns {Promise<{dir: string|null, accounts: Array<object>, byUid: Map<string, object>}>}
 */
export async function readChannels(signal) {
  const dir = await resolveAuthDir(signal);
  const empty = { dir, accounts: [], byUid: new Map() };
  if (!dir) return empty;

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return empty;
  }

  const accounts = [];
  const byUid = new Map();
  for (const name of names) {
    if (!name.startsWith('workbuddy') || !name.endsWith('.json')) continue;
    let raw;
    try {
      raw = await readFile(path.join(dir, name), { encoding: 'utf8', signal });
    } catch {
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    const entry = describe(name, doc);
    if (!entry) continue;
    accounts.push(entry);
    byUid.set(entry.uid, entry);
  }
  accounts.sort((left, right) => left.file.localeCompare(right.file));
  return { dir, accounts, byUid };
}

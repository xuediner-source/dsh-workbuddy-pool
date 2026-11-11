// login.js — 国际站（codebuddy.ai）账号登录。
//
// 国内账号由网关面板的 /panel/api/login/start|poll 直接完成（panel.js 已封装）；
// 国际站不在面板覆盖范围内，只能驱动网关自带的登录工具
// （workbuddy-login.exe，源码见网关仓库 cmd/login）：
//   workbuddy-login.exe url intl   打印授权地址
//   workbuddy-login.exe poll intl  授权完成后打印一行 JSON 并删掉本地 state
// 拿到凭据后按网关读取的嵌套形写 <auth_dir>/workbuddy-intl-<uid>.json
// （UTF-8 无 BOM：网关的 JSON 解析不接受 BOM）。网关只在启动时扫描 auths
// 目录，所以新文件要重启网关才生效——返回值里会明确标注。
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gatewayDirFromEnv, readGatewayConfig } from './gateway.js';

const execFileAsync = promisify(execFile);
const START_TIMEOUT = 30_000;
const POLL_TIMEOUT = 60_000;
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function messageOf(error) {
  if (!(error instanceof Error)) return String(error);
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : '';
  return (stderr || stdout || error.message || '未知错误').trim();
}

function binPath(dir) {
  const explicit = process.env.WORKBUDDY_POOL_LOGIN_BIN || process.env.XUEDINER_LOGIN_BIN;
  if (explicit && explicit.trim()) return explicit.trim();
  return path.join(dir, process.platform === 'win32' ? 'workbuddy-login.exe' : 'workbuddy-login');
}

/**
 * 国际站登录驱动。
 * @param {AbortSignal} [disposeSignal]
 */
export function createIntlLogin(disposeSignal) {
  async function context() {
    const info = await readGatewayConfig(disposeSignal);
    const dir = info?.dir ?? gatewayDirFromEnv();
    if (!dir) {
      throw new Error('无法定位网关目录：请设置 WORKBUDDY_POOL_CONFIG 指向网关 config.json');
    }
    return { dir, authDir: info?.authDir ?? path.join(dir, 'auths') };
  }

  async function run(args, timeout, dir) {
    try {
      const { stdout } = await execFileAsync(binPath(dir), args, {
        cwd: dir,
        timeout,
        windowsHide: true,
        signal: disposeSignal,
      });
      return { ok: true, stdout: typeof stdout === 'string' ? stdout : '' };
    } catch (error) {
      return { ok: false, text: messageOf(error) };
    }
  }

  return {
    /** 申请国际站授权地址（登录工具会把 state 落盘，poll 时复用）。 */
    async start() {
      const { dir } = await context();
      const outcome = await run(['url', 'intl'], START_TIMEOUT, dir);
      if (!outcome.ok) throw new Error(`调用登录工具失败：${outcome.text.slice(0, 200)}`);
      const url = outcome.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`登录工具返回异常：${outcome.stdout.trim().slice(0, 160) || '(空输出)'}`);
      }
      return { ok: true, realm: 'intl', url };
    },

    /** 轮询授权结果；完成时落盘凭证并提示需重启网关。 */
    async poll() {
      const { dir, authDir } = await context();
      const outcome = await run(['poll', 'intl'], POLL_TIMEOUT, dir);
      if (!outcome.ok) {
        if (/未完成|waiting for login|登录未完成/i.test(outcome.text)) {
          return { done: false, message: '登录未完成（等待浏览器授权）' };
        }
        throw new Error(outcome.text.slice(0, 300));
      }

      const line = outcome.stdout.trim().split(/\r?\n/).filter(item => item.trim().startsWith('{')).pop();
      if (!line) return { done: false, message: '登录未完成（等待浏览器授权）' };

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { done: false, message: '登录工具输出无法解析' };
      }
      if (typeof parsed.access_token !== 'string' || !parsed.access_token || typeof parsed.uid !== 'string' || !parsed.uid) {
        return { done: false, message: '凭据不完整，请重试' };
      }
      if (!UID_PATTERN.test(parsed.uid)) throw new Error('登录工具返回的账号 UID 非法');

      const expiresIn = Number.isFinite(parsed.expires_in) ? parsed.expires_in : 0;
      const domain = typeof parsed.domain === 'string' && parsed.domain ? parsed.domain : 'www.codebuddy.ai';
      const doc = {
        account: {
          uid: parsed.uid,
          enterpriseId: typeof parsed.enterprise_id === 'string' ? parsed.enterprise_id : '',
          nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
        },
        auth: {
          accessToken: parsed.access_token,
          refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
          expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
          domain,
        },
      };

      await mkdir(authDir, { recursive: true });
      const file = path.join(authDir, `workbuddy-intl-${parsed.uid}.json`);
      // 显式 utf8 且不加 BOM：网关的 JSON 解析器会拒绝 BOM。
      await writeFile(file, JSON.stringify(doc, null, 2), { encoding: 'utf8' });

      const nickname = doc.account.nickname;
      return {
        done: true,
        uid: parsed.uid,
        nickname,
        file: path.basename(file),
        realm: 'intl',
        restartRequired: true,
        message: `已写入 ${path.basename(file)}（${nickname || parsed.uid.slice(0, 8)}），重启网关后新账号才会进池`,
      };
    },
  };
}

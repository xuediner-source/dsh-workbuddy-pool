// panel.js — 本机网关管理面板（/panel/api/*）的调用封装。
//
// 这里是原 xuedinerAPI「号池」能力的完整移植面：账号运维、成长任务、开学季、
// 全量例行任务、模型列表、运行日志与网关配置。所有请求经 gateway.js 统一
// 处理本机校验、密钥与超时；非 2xx 由 GatewayError 抛出（含网关错误文本）。
import { createGatewayClient } from './gateway.js';

const FAST = 20_000;
const SLOW = 60_000;
const LONG = 300_000;

/** 账号 UID 只允许安全字符（网关侧同样校验），避免拼出异常路径。 */
function accountPath(uid, suffix) {
  if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    throw new Error('账号 UID 无效');
  }
  return `/panel/api/accounts/${uid}/${suffix}`;
}

export function createPanelClient(disposeSignal) {
  const request = createGatewayClient(disposeSignal);

  return {
    request,

    overview: () => request('/panel/api/overview', { timeout: FAST }),
    logs: () => request('/panel/api/logs', { timeout: FAST }),
    loginStart: () => request('/panel/api/login/start', { method: 'POST', timeout: FAST }),
    loginPoll: (state) => request('/panel/api/login/poll', { query: { state }, timeout: FAST }),
    models: () => request('/panel/api/models', { timeout: SLOW }),
    config: () => request('/panel/api/config', { timeout: FAST }),
    saveConfig: (config) => request('/panel/api/config', { method: 'POST', body: config, timeout: FAST }),

    // ---- 单账号运维 ----
    revive: (uid) => request(accountPath(uid, 'revive'), { method: 'POST', timeout: SLOW }),
    disable: (uid) => request(accountPath(uid, 'disable'), { method: 'POST', timeout: FAST }),
    checkin: (uid) => request(accountPath(uid, 'checkin'), { method: 'POST', timeout: SLOW }),
    balance: (uid) => request(accountPath(uid, 'balance'), { method: 'POST', timeout: SLOW }),
    remove: (uid) => request(accountPath(uid, 'remove'), { method: 'POST', timeout: SLOW }),

    // ---- 成长任务 ----
    tasks: (uid) => request(accountPath(uid, 'tasks'), { timeout: SLOW }),
    tasksAccept: (uid, taskCodes) => request(accountPath(uid, 'tasks/accept'), {
      method: 'POST',
      body: { task_codes: taskCodes },
      timeout: SLOW,
    }),
    tasksAcceptAll: (uid) => request(accountPath(uid, 'tasks/accept_all'), { method: 'POST', timeout: LONG }),
    tasksClaim: (uid, taskCode) => request(accountPath(uid, 'tasks/claim'), {
      method: 'POST',
      body: { task_code: taskCode },
      timeout: SLOW,
    }),
    tasksAuto: (uid, taskCode) => request(accountPath(uid, 'tasks/auto'), {
      method: 'POST',
      body: { task_code: taskCode },
      timeout: SLOW,
    }),
    tasksAutoAll: (uid) => request(accountPath(uid, 'tasks/auto_all'), { method: 'POST', timeout: LONG }),

    // ---- 任务中心 ----
    scanAll: () => request('/panel/api/tasks/scan_all', { method: 'POST', timeout: LONG }),
    runQueue: (options = {}) => request('/panel/api/tasks/run_queue', {
      method: 'POST',
      body: {
        concurrency: options.concurrency ?? 1,
        growth: options.growth !== false,
        school: options.school !== false,
      },
      timeout: LONG,
    }),
    queueStatus: () => request('/panel/api/tasks/queue', { timeout: FAST }),

    // ---- 开学季 ----
    schoolStatus: () => request('/panel/api/school/status', { timeout: SLOW }),
    schoolRunAll: () => request('/panel/api/school/run_all', { method: 'POST', timeout: FAST }),

    // ---- 全量例行 ----
    routine: (name) => request(`/panel/api/${name}`, { method: 'POST', timeout: name === 'balance_all' ? SLOW : FAST }),
  };
}

/** 网关面板里可能出现的错误字段：面板用 error，DSH pool-hub 用 message。 */
export function errorText(body) {
  if (!body || typeof body !== 'object') return '';
  for (const value of [body.error, body.message, body.msg]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

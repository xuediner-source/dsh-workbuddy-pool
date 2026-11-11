// status.js — 号池快照：把网关 /panel/api/overview 归一化成设置页使用的结构。
//
// 统一走 gateway.js 的请求封装（本机校验、密钥、超时），并保留 10 秒缓存与
// 在途请求去重：设置页每 15 秒轮询一次，手动刷新可强制穿透缓存。
import { createGatewayClient } from './gateway.js';

const CACHE_MS = 10_000;

function count(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Go 用 0001-01-01 表示零值时间；统一转成毫秒时间戳或 null。 */
function timestamp(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return ms > 0 ? ms : null;
}

export const STATE_LABELS = { ready: '正常', cooling: '冷却中', breaker: '已熔断', disabled: '已禁用' };

/** 账号状态判定：禁用 > 熔断 > 冷却 > 正常。 */
export function accountState(account, now = Date.now()) {
  if (account?.disabled === true) return 'disabled';
  const breakerUntil = timestamp(account?.breaker_until);
  const coolUntil = Math.max(timestamp(account?.until) ?? 0, breakerUntil ?? 0);
  if (breakerUntil !== null && breakerUntil > now) return 'breaker';
  if (account?.cooling === true || coolUntil > now) return 'cooling';
  return 'ready';
}

export function normalizeAccount(account, index, now) {
  const uid = typeof account.uid === 'string' ? account.uid : '';
  const nickname = typeof account.nickname === 'string'
    ? account.nickname.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
    : '';
  const tail = uid ? uid.slice(-6) : '';
  const state = accountState(account, now);
  const breakerUntil = timestamp(account.breaker_until);
  const coolUntil = Math.max(timestamp(account.until) ?? 0, breakerUntil ?? 0);
  const remainingSeconds = count(account.cool_remaining_sec);
  const deadline = coolUntil > now
    ? coolUntil
    : remainingSeconds > 0 ? now + remainingSeconds * 1000 : null;
  const reason = typeof account.disabled_reason === 'string' ? account.disabled_reason.trim() : '';

  return {
    uid,
    uidShort: uid ? uid.slice(0, 8) : `#${index + 1}`,
    label: nickname || (tail ? `账号 …${tail}` : `账号 ${index + 1}`),
    state,
    stateLabel: STATE_LABELS[state],
    disabledReason: reason.slice(0, 160),
    coolKind: typeof account.cool_kind === 'string' ? account.cool_kind : '',
    credits: Number.isSafeInteger(account.credits) ? account.credits : null,
    creditTotal: count(account.credits_total) || null,
    inFlight: count(account.in_flight, null),
    successes: count(account.success_count),
    errors: count(account.err_total),
    breakerFailures: count(account.breaker_fails),
    softStreak: count(account.soft_streak),
    lastSuccess: timestamp(account.last_success),
    lastError: timestamp(account.last_err),
    coolingUntil: state === 'cooling' || state === 'breaker' ? deadline : null,
  };
}

export function snapshotFrom(data, now) {
  if (
    !Array.isArray(data?.accounts)
    || data.accounts.some(account => !account || typeof account !== 'object' || Array.isArray(account))
  ) {
    throw new Error('网关返回的号池状态格式有误');
  }

  const accounts = data.accounts.map((account, index) => normalizeAccount(account, index, now));
  return {
    fetchedAt: now,
    version: typeof data.version === 'string' ? data.version : null,
    uptimeSec: count(data.uptime_sec, null),
    authRequired: data.auth_required === true,
    redisMode: typeof data.redis_mode === 'string' ? data.redis_mode : null,
    total: count(data.total, accounts.length),
    healthy: count(data.healthy, accounts.filter(account => account.state === 'ready').length),
    cooling: count(data.cooling, accounts.filter(account => ['cooling', 'breaker'].includes(account.state)).length),
    disabled: count(data.disabled, accounts.filter(account => account.state === 'disabled').length),
    saturated: count(data.in_flight_full, null),
    stickySessions: count(data.sticky_sessions, null),
    accounts,
  };
}

export function createStatusReader(disposeSignal) {
  const request = createGatewayClient(disposeSignal);
  let snapshot = null;
  let latest = null;
  let pending = null;
  let forceNext = false;

  async function check() {
    try {
      const data = await request('/panel/api/overview', { timeout: 8_000 });
      snapshot = snapshotFrom(data, Date.now());
      latest = { ok: true, checkedAt: Date.now(), snapshot };
    } catch (error) {
      latest = {
        ok: false,
        checkedAt: Date.now(),
        snapshot,
        message: error instanceof Error ? error.message : '无法连接本机 WorkBuddy 号池网关',
      };
    }
    return latest;
  }

  function readStatus(force = false) {
    if (pending) return pending;
    if (forceNext) {
      forceNext = false;
      force = true;
    }
    if (!force && latest && Date.now() - latest.checkedAt < CACHE_MS) return Promise.resolve(latest);
    pending = check().finally(() => {
      pending = null;
    });
    return pending;
  }

  // 账号增删改后由宿主路由调用：下一次读取必定穿透 10 秒缓存。
  readStatus.invalidate = () => {
    forceNext = true;
  };
  return readStatus;
}

// index.js — 宿主侧入口：本机 WorkBuddy 号池的读取与运维接口。
//
// 两个路由（Connection 的 exact Fetch route，仅 owner Peer 可达）：
//   GET  /api/workbuddy-pool/status   号池快照 + 账号渠道归属（国内/国际）
//   POST /api/workbuddy-pool/action   所有运维动作，统一信封 {ok, data|error}
// 一个命令：
//   /workbuddy-pool [help|models|verify|checkin|travel|activity|keepalive|balance]
//
// 号池读写在网关进程里完成（本机 :7863），插件只做聚合与转发。
import { readChannels } from './channels.js';
import { createIntlLogin } from './login.js';
import { createPanelClient } from './panel.js';
import { STATE_LABELS, createStatusReader } from './status.js';
import { createChannelVerifier } from './verify.js';

const STATUS_ROUTE = '/api/workbuddy-pool/status';
const ACTION_ROUTE = '/api/workbuddy-pool/action';
const JSON_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
const ACCOUNT_OPS = new Set(['revive', 'disable', 'checkin', 'balance', 'remove']);
const OP_LABELS = {
  revive: '复活',
  disable: '禁用',
  checkin: '签到',
  balance: '刷新余额',
  remove: '移除',
};
const ROUTINES = new Map([
  ['checkin', 'checkin_all'],
  ['travel', 'travel_all'],
  ['activity', 'activity_all'],
  ['keepalive', 'keepalive_all'],
  ['balance', 'balance_all'],
]);
const ROUTINE_NAMES = new Set(ROUTINES.values());
const HELP_TEXT = [
  '/workbuddy-pool          查看号池状态',
  '/workbuddy-pool models   列出网关当前可用模型',
  '/workbuddy-pool verify [模型]  渠道验证（临时隔离其它可用账号，最长约 2 分钟）',
  '/workbuddy-pool checkin  触发全部账号每日签到',
  '/workbuddy-pool travel   触发全部账号旅行任务',
  '/workbuddy-pool activity 触发全部账号活动任务',
  '/workbuddy-pool keepalive 触发全部账号保活',
  '/workbuddy-pool balance  刷新全部账号余额',
].join('\n');

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** 命令输出：号池文本报告（渠道归属来自 auths 目录，读不到就不显示）。 */
function renderReport(result, channels) {
  const { snapshot } = result;
  if (!snapshot) return { kind: 'error', text: result.message ?? '无法读取号池状态' };

  const realms = new Map();
  for (const item of channels ?? []) realms.set(item.uid, item.realm);
  const lines = [
    `WorkBuddy 号池 · ${snapshot.healthy}/${snapshot.total} 可用 · `
      + `${snapshot.cooling} 冷却 · ${snapshot.disabled} 禁用`,
  ];
  if (!result.ok) lines.push(`刷新失败，显示上次快照。\n${result.message}`);

  for (const account of snapshot.accounts) {
    const realm = realms.get(account.uid);
    const tag = realm === 'intl' ? '[国际] ' : realm === 'cn' ? '[国内] ' : '';
    const balance = `${account.credits ?? '—'} / ${account.creditTotal ?? '—'} 积分`;
    const deadline = account.coolingUntil
      ? `，至 ${new Date(account.coolingUntil).toLocaleString('zh-CN')}`
      : '';
    const reason = account.disabledReason ? `（${account.disabledReason}）` : '';
    lines.push(
      `${tag}${account.label} · ${balance} · ${STATE_LABELS[account.state]}${reason}${deadline}`
        + ` · 在途 ${account.inFlight ?? '—'}`,
    );
  }

  const facts = [];
  if (snapshot.version) facts.push(`网关 v${snapshot.version}`);
  if (snapshot.uptimeSec !== null) facts.push(`运行 ${formatUptime(snapshot.uptimeSec)}`);
  if (snapshot.stickySessions !== null) facts.push(`${snapshot.stickySessions} 粘性会话`);
  if (snapshot.saturated !== null && snapshot.saturated > 0) facts.push('并发已占满');
  if (facts.length > 0) lines.push(facts.join(' · '));

  return { kind: 'success', text: lines.join('\n') };
}

export function apply(ctx) {
  const lifetime = new AbortController();
  const readStatus = createStatusReader(lifetime.signal);
  const panel = createPanelClient(lifetime.signal);
  const intlLogin = createIntlLogin(lifetime.signal);
  const verifier = createChannelVerifier({ panel, disposeSignal: lifetime.signal });

  ctx.effect(() => () => lifetime.abort());

  async function channelList() {
    try {
      return await readChannels(lifetime.signal);
    } catch {
      return { dir: null, accounts: [], byUid: new Map() };
    }
  }

  function uidOf(input) {
    const uid = typeof input?.uid === 'string' ? input.uid.trim() : '';
    if (!uid) throw new Error('缺少账号 UID');
    return uid;
  }

  function codeOf(input) {
    const code = typeof input?.code === 'string' ? input.code.trim() : '';
    if (!code) throw new Error('缺少任务编号');
    if (code.length > 120) throw new Error('任务编号过长');
    return code;
  }

  async function execute(action, input) {
    switch (action) {
      case 'refresh': {
        readStatus.invalidate();
        return readStatus(true);
      }
      case 'channels': {
        const { dir, accounts } = await channelList();
        return { dir, channels: accounts };
      }
      case 'models': {
        const body = await panel.models();
        return { models: Array.isArray(body?.models) ? body.models : [] };
      }
      case 'config':
        return panel.config();
      case 'save-config': {
        const config = input?.config;
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          throw new Error('缺少配置内容');
        }
        return panel.saveConfig(config);
      }
      case 'logs': {
        const body = await panel.logs();
        return { entries: Array.isArray(body?.entries) ? body.entries : [] };
      }
      case 'account': {
        const uid = uidOf(input);
        const op = typeof input?.op === 'string' ? input.op : '';
        if (!ACCOUNT_OPS.has(op)) throw new Error(`未知的账号操作：${op || '(空)'}`);
        const body = await panel[op](uid);
        readStatus.invalidate();
        return body;
      }
      case 'tasks': {
        const body = await panel.tasks(uidOf(input));
        return { tasks: Array.isArray(body?.tasks) ? body.tasks : [] };
      }
      case 'tasks-accept': {
        const codes = Array.isArray(input?.codes)
          ? input.codes.filter(item => typeof item === 'string' && item.trim())
          : [];
        if (codes.length === 0) throw new Error('缺少任务编号');
        return panel.tasksAccept(uidOf(input), codes.slice(0, 100));
      }
      case 'tasks-accept-all':
        return panel.tasksAcceptAll(uidOf(input));
      case 'tasks-claim':
        return panel.tasksClaim(uidOf(input), codeOf(input));
      case 'tasks-auto':
        return panel.tasksAuto(uidOf(input), codeOf(input));
      case 'tasks-auto-all':
        return panel.tasksAutoAll(uidOf(input));
      case 'scan':
        return panel.scanAll();
      case 'run-queue': {
        const raw = Number(input?.concurrency);
        const concurrency = Number.isSafeInteger(raw) ? Math.min(4, Math.max(1, raw)) : 1;
        return panel.runQueue({
          concurrency,
          growth: input?.growth !== false,
          school: input?.school !== false,
        });
      }
      case 'queue':
        return panel.queueStatus();
      case 'school':
        return panel.schoolStatus();
      case 'school-run':
        return panel.schoolRunAll();
      case 'routine': {
        const name = typeof input?.name === 'string' ? input.name : '';
        if (!ROUTINE_NAMES.has(name)) throw new Error('未知的例行任务');
        const body = await panel.routine(name);
        readStatus.invalidate();
        return body;
      }
      case 'login-start':
        return panel.loginStart();
      case 'login-poll': {
        const state = typeof input?.state === 'string' ? input.state.trim() : '';
        if (!state) throw new Error('缺少登录状态');
        return panel.loginPoll(state);
      }
      case 'intl-start':
        return intlLogin.start();
      case 'intl-poll': {
        const body = await intlLogin.poll();
        if (body?.done) readStatus.invalidate();
        return body;
      }
      case 'verify': {
        const outcome = await verifier.verify({
          uid: typeof input?.uid === 'string' && input.uid.trim() ? input.uid.trim() : undefined,
          model: typeof input?.model === 'string' ? input.model : undefined,
          isolate: input?.isolate !== false,
          timeout: Number.isSafeInteger(input?.timeout) ? input.timeout : undefined,
        });
        readStatus.invalidate();
        return outcome;
      }
      default:
        throw new Error(`未知操作：${action}`);
    }
  }

  async function dispatch(action, input) {
    try {
      return { ok: true, data: await execute(action, input) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: STATUS_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const { searchParams: search } = new URL(request.url);
        const result = await readStatus(search.get('refresh') === '1');
        const channels = await channelList();
        return Response.json(
          { ...result, channels: channels.accounts, channelDir: channels.dir },
          { status: result.ok ? 200 : 503, headers: JSON_HEADERS },
        );
      },
    }));

    scope.effect(() => scope.connection.fetch.register({
      path: ACTION_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let payload;
        try {
          payload = await request.json();
        } catch {
          return Response.json(
            { ok: false, error: '请求体不是合法 JSON' },
            { status: 400, headers: JSON_HEADERS },
          );
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || typeof payload.action !== 'string') {
          return Response.json({ ok: false, error: '缺少 action' }, { status: 400, headers: JSON_HEADERS });
        }
        return Response.json(await dispatch(payload.action, payload), { headers: JSON_HEADERS });
      },
    }));
  });

  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'workbuddy-pool',
      description: '查看或运维本机 WorkBuddy 号池（状态 / 模型 / 批量任务 / 渠道验证）',
      handler: async (invocation) => {
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
        const [head, ...rest] = raw.split(/\s+/).filter(Boolean);
        const command = (head ?? '').toLowerCase();

        if (!command) {
          const [result, channels] = await Promise.all([readStatus(true), channelList()]);
          return renderReport(result, channels.accounts);
        }
        if (command === 'help') return { kind: 'success', text: HELP_TEXT };
        if (command === 'models') {
          try {
            const body = await panel.models();
            const models = Array.isArray(body?.models) ? body.models : [];
            if (models.length === 0) return { kind: 'error', text: '网关没有返回模型列表' };
            return {
              kind: 'success',
              text: models.map(model => {
                const parts = [model.id];
                if (model.name) parts.push(model.name);
                if (Number.isFinite(model.context_length)) parts.push(`上下文 ${model.context_length}`);
                if (Number.isFinite(model.max_output_tokens)) parts.push(`输出 ${model.max_output_tokens}`);
                if (model.credits !== undefined && model.credits !== '') parts.push(`${model.credits} 积分`);
                return parts.join(' · ');
              }).join('\n'),
            };
          } catch (error) {
            return { kind: 'error', text: `读取模型列表失败：${messageOf(error)}` };
          }
        }
        if (command === 'verify') {
          try {
            const outcome = await verifier.verify({ model: rest[0] });
            return { kind: outcome.status === 'passed' ? 'success' : 'error', text: outcome.message };
          } catch (error) {
            return { kind: 'error', text: `渠道验证失败：${messageOf(error)}` };
          }
        }
        const routine = ROUTINES.get(command);
        if (routine) {
          try {
            const body = await panel.routine(routine);
            readStatus.invalidate();
            if (routine === 'balance_all') {
              const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
              return { kind: 'success', text: `已刷新 ${accounts.length} 个账号的余额` };
            }
            return {
              kind: 'success',
              text: body?.started ? '已触发批量任务，稍后在设置页查看账号状态' : '批量任务未启动',
            };
          } catch (error) {
            return { kind: 'error', text: `执行失败：${messageOf(error)}` };
          }
        }
        return { kind: 'error', text: `未知子命令「${command}」。\n\n${HELP_TEXT}` };
      },
    }));
  });
}

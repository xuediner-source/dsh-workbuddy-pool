// verify.js — 渠道验证：把一条最小 chat 请求打到网关，确认某个账号的上游通道可用。
//
// 背景（网关 internal/upstream/client.go）：国内站 copilot.tencent.com 走
// /v2/chat/completions，第三方客户端也能过；国际站 www.codebuddy.ai 的
// /v2/chat/completions 只认官方桌面客户端的渠道签名，第三方一律 400
// code=11-128（error displayTips 里的“渠道校验”文案极易误判成账号无权限），
// 真实入口是 /console/chat/completions，且首条消息必须是 system。网关已按
// 账号域名分流，但“分流之后到底通不通”只能实测。
//
// 做法（沿用网关仓库的 _verify-intl2.sh 隔离法）：临时禁用其它可用账号，
// 只留目标账号 → 发一条 system 在前的 chat → 立刻复活被禁用的账号。
// 复活会清掉冷却与熔断，所以只恢复“本次亲手禁用”的账号，并且只隔离当前
// 状态为 ready 的账号，避免误清别的账号的冷却。
import { readChannels } from './channels.js';
import { STATE_LABELS, normalizeAccount } from './status.js';

// 号池里既有国内站也有国际站账号，同一个模型名不一定对每个账号都成立：
// 上游对“该账号不接受的模型”回 403 code=11140 request illegal，很容易被误读成
// 通道不通。所以默认不写死模型——先问网关当前可用模型，取第一个；调用方也可以
// 显式指定。
const DEFAULT_TIMEOUT = 120_000;
const SYSTEM_PROMPT = 'You are a helpful AI assistant. Answer tersely.';
const USER_PROMPT = 'Output exactly this token and nothing else: WORKBUDDY_CHANNEL_OK';

/** 从 /panel/api/models 的返回里挑一个候选模型；拿不到就返回 null。 */
async function pickModel(panel) {
  try {
    const body = await panel.models();
    const list = Array.isArray(body?.models) ? body.models : [];
    for (const model of list) {
      const id = typeof model?.id === 'string' ? model.id.trim() : '';
      if (id) return id;
    }
  } catch {
    // 模型列表取不到时不阻塞验证，交给调用方决定。
  }
  return null;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {{panel: object, disposeSignal?: AbortSignal}} options
 */
export function createChannelVerifier({ panel, disposeSignal }) {
  return {
    /**
     * 验证单个账号的上游通道。
     * @param {{uid?: string, model?: string, isolate?: boolean, timeout?: number}} [options]
     */
    async verify(options = {}) {
      const explicit = typeof options.model === 'string' && options.model.trim()
        ? options.model.trim().slice(0, 120)
        : '';
      let model = explicit;
      if (!model) {
        // 不写死模型：号池可能只含国际站号，某个模型是否可用取决于账号本身。
        model = await pickModel(panel);
        if (!model) {
          throw new Error('无法确定验证模型：网关没有返回可用模型列表，请在验证时显式指定模型');
        }
      }
      const timeout = Number.isSafeInteger(options.timeout) && options.timeout >= 5_000
        ? options.timeout
        : DEFAULT_TIMEOUT;
      const isolate = options.isolate !== false;

      const before = await panel.overview();
      const raw = Array.isArray(before.accounts) ? before.accounts : [];
      if (raw.length === 0) throw new Error('号池中暂无账号');

      const now = Date.now();
      const rows = raw.map((account, index) => normalizeAccount(account, index, now));

      const channels = new Map();
      try {
        for (const entry of (await readChannels(disposeSignal)).accounts) channels.set(entry.uid, entry);
      } catch {
        // 渠道信息只用于展示，读不到不影响验证结论。
      }

      const wanted = typeof options.uid === 'string' ? options.uid.trim() : '';
      const target = wanted
        ? rows.find(row => row.uid === wanted)
        : rows.find(row => row.state === 'ready');
      if (!target) throw new Error(wanted ? '号池中没有该账号' : '没有可用账号（全部冷却或禁用）');
      if (target.state !== 'ready') {
        throw new Error(`账号「${target.label}」当前${STATE_LABELS[target.state]}，请先复活或等冷却结束后再验证`);
      }

      const disabled = [];
      const isolateFailures = [];
      if (isolate) {
        for (const row of rows) {
          if (row.uid === target.uid || row.state !== 'ready') continue;
          try {
            await panel.disable(row.uid);
            disabled.push(row);
          } catch (error) {
            isolateFailures.push(`${row.label}：${messageOf(error)}`);
          }
        }
      }
      const partial = isolateFailures.length > 0;

      const startedAt = Date.now();
      let response = null;
      let probeError = null;
      const restoreFailures = [];
      try {
        response = await panel.request('/v1/chat/completions', {
          method: 'POST',
          timeout,
          body: {
            model,
            stream: false,
            max_tokens: 64,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: USER_PROMPT },
            ],
          },
        });
      } catch (error) {
        probeError = messageOf(error);
      } finally {
        for (const row of disabled) {
          try {
            await panel.revive(row.uid);
          } catch (error) {
            restoreFailures.push(`${row.label}：${messageOf(error)}`);
          }
        }
      }
      const latencyMs = Date.now() - startedAt;

      // 成功次数的增量是“到底哪个账号承载了这次请求”的佐证；隔离完整时结论已定。
      let servedBy = null;
      try {
        const after = await panel.overview();
        for (const account of after.accounts ?? []) {
          const previous = raw.find(item => item.uid === account.uid);
          if (!previous) continue;
          if ((account.success_count ?? 0) > (previous.success_count ?? 0)) servedBy = account.uid;
        }
      } catch {
        // 读不到就只靠隔离结论。
      }

      const content = typeof response?.choices?.[0]?.message?.content === 'string'
        ? response.choices[0].message.content.trim().slice(0, 500)
        : '';
      const channel = channels.get(target.uid) ?? null;
      const ok = probeError === null;
      const carrier = servedBy ? rows.find(row => row.uid === servedBy) ?? null : null;
      const targetServed = servedBy === target.uid;
      // 只有“目标账号亲自承载”或“隔离后无其它候选账号”才算证实通道；
      // 其余情况即使请求成功，也只是证明了网关能出网，不能替目标账号下结论。
      const confirmed = ok && (targetServed || (servedBy === null && isolate && !partial));
      const status = !ok ? 'failed' : confirmed ? 'passed' : 'unconfirmed';
      const endpoint = channel?.endpoint ?? null;
      const route = endpoint ? ` 经 ${endpoint}` : '';

      let message;
      if (!ok) {
        message = `验证失败：${probeError}`;
      } else if (targetServed) {
        message = `验证通过：${target.label}${route}，${latencyMs} ms`;
      } else if (carrier) {
        message = `验证未完成：请求成功，但由「${carrier.label}」承载，目标账号「${target.label}」的通道未被实际验证`
          + `${isolate ? '' : '（未启用隔离，无法指定账号）'}。请重新验证并保持隔离开启。`;
      } else if (confirmed) {
        message = `验证通过：${target.label}${route}，${latencyMs} ms（已隔离其它可用账号）`;
      } else {
        message = `验证未确认：请求成功，但无法确定承载账号${partial ? '（部分账号隔离失败）' : ''}，结论仅供参考`;
      }
      if (restoreFailures.length > 0) {
        message += `。⚠ ${restoreFailures.length} 个账号恢复失败，请在账号页手动复活：${restoreFailures.join('；')}`;
      }

      return {
        ok,
        status,
        confirmed,
        message,
        target: {
          uid: target.uid,
          label: target.label,
          realm: channel?.realm ?? null,
          domain: channel?.domain ?? null,
          endpoint,
        },
        isolate: {
          enabled: isolate,
          count: disabled.length,
          partial,
          failures: isolateFailures,
        },
        restore: { ok: restoreFailures.length === 0, failures: restoreFailures },
        servedBy,
        latencyMs,
        model,
        content,
        usage: response?.usage ?? null,
      };
    },
  };
}

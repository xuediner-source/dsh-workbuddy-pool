// client.js — 设置页「WorkBuddy 号池」：账号 / 任务 / 模型 / 配置 / 日志。
//
// 宿主侧（index.js）只有两个路由：
//   GET  /api/workbuddy-pool/status   号池快照 + 渠道归属
//   POST /api/workbuddy-pool/action   {action, ...参数} → {ok, data|error}
// 号池的读写都在本机网关进程里完成，这里只负责展示与发起动作。
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-pool',
  factory(require) {
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = require('react');

    const STATUS_ROUTE = '/api/workbuddy-pool/status';
    const ACTION_ROUTE = '/api/workbuddy-pool/action';
    const POLL_MS = 15_000;
    const TICK_MS = 3_000;
    const LOG_POLL_MS = 10_000;
    const ACTION_TIMEOUT = 320_000;

    const STATE_LABELS = { ready: '正常', cooling: '冷却中', breaker: '已熔断', disabled: '已禁用' };
    const REALM_LABELS = { cn: '国内', intl: '国际' };
    const TASK_STATUS = {
      not_started: '未开始',
      pending: '待处理',
      in_progress: '进行中',
      running: '进行中',
      accepted: '已接受',
      claimed: '已领取',
      claimable: '可领取',
      completed: '已完成',
      finished: '已完成',
      locked: '未解锁',
      expired: '已过期',
      failed: '失败',
    };
    const ROUTINES = [
      ['checkin_all', '签到'],
      ['travel_all', '旅行'],
      ['activity_all', '活动'],
      ['keepalive_all', '保活'],
      ['balance_all', '刷新余额'],
    ];
    const TABS = [
      ['accounts', '账号'],
      ['tasks', '任务'],
      ['models', '模型'],
      ['config', '配置'],
      ['logs', '日志'],
    ];

    const dateFormat = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'short',
      timeStyle: 'medium',
      hourCycle: 'h23',
    });

    function formatTime(value) {
      return Number.isFinite(value) ? dateFormat.format(value) : '—';
    }

    function sinceAgo(value) {
      if (!Number.isFinite(value)) return '—';
      const diff = Date.now() - value;
      if (diff < 0) return formatTime(value);
      if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1_000))} 秒前`;
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
      if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
      return formatTime(value);
    }

    function errorText(error) {
      if (error instanceof Error && error.message) return error.message;
      return String(error ?? '未知错误');
    }

    /** 任务进度兼容两种形状：{current,target} 与 {progress,target_count}。 */
    function taskProgress(task) {
      if (!task || typeof task !== 'object') return '';
      const raw = task.progress;
      const nested = raw && typeof raw === 'object' ? raw : null;
      const current = Number.isFinite(task.current) ? task.current
        : nested && Number.isFinite(nested.current) ? nested.current
          : typeof raw === 'number' ? raw : null;
      const target = Number.isFinite(task.target) ? task.target
        : Number.isFinite(task.target_count) ? task.target_count
          : nested && Number.isFinite(nested.target) ? nested.target : null;
      if (current === null && target === null) return '';
      return target === null ? String(current) : `${current ?? 0} / ${target}`;
    }

    function logTime(value) {
      if (typeof value === 'number') return formatTime(value > 1e12 ? value : value * 1_000);
      if (typeof value === 'string') {
        const ms = Date.parse(value);
        return ms > 0 ? formatTime(ms) : value;
      }
      return '';
    }

    async function readJson(response) {
      const text = await response.text().catch(() => '');
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    async function callStatus(options = {}) {
      const url = options.refresh === true ? `${STATUS_ROUTE}?refresh=1` : STATUS_ROUTE;
      const signal = options.signal ?? AbortSignal.timeout(15_000);
      const response = await fetch(url, { signal, cache: 'no-store' });
      const body = await readJson(response);
      if (!body || typeof body.ok !== 'boolean') {
        throw new Error(`号池状态读取失败（HTTP ${response.status}）`);
      }
      return body;
    }

    async function act(action, payload = {}) {
      const response = await fetch(ACTION_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(ACTION_TIMEOUT),
        body: JSON.stringify({ action, ...payload }),
      });
      const body = await readJson(response);
      if (!body || typeof body.ok !== 'boolean') {
        throw new Error(`操作失败（HTTP ${response.status}）`);
      }
      if (body.ok !== true) {
        throw new Error(typeof body.error === 'string' && body.error ? body.error : '操作失败');
      }
      return body.data;
    }

    /** 同一时刻只允许一个动作，避免并发改号池。 */
    function useRunner(notify) {
      const [busy, setBusy] = useState('');
      const busyRef = useRef('');
      const run = useCallback(async (key, task) => {
        if (busyRef.current) return undefined;
        busyRef.current = key;
        setBusy(key);
        try {
          return await task();
        } catch (error) {
          notify('error', errorText(error));
          return undefined;
        } finally {
          busyRef.current = '';
          setBusy('');
        }
      }, [notify]);
      return [busy, run];
    }

    const styles = `
      .dsh-wbp {
        display: grid; gap: 14px; font-size: 13px;
        --wbp-line: color-mix(in srgb, currentColor 16%, transparent);
        --wbp-line-soft: color-mix(in srgb, currentColor 9%, transparent);
        --wbp-ok: var(--dsw-alias-state-success-primary, #2f9e44);
        --wbp-warn: var(--dsw-alias-state-warn-primary, #b07d00);
        --wbp-err: var(--dsw-alias-state-error-primary, #d64545);
      }
      .dsh-wbp p { margin: 0; }
      .dsh-wbp h3 { margin: 0; font-size: 13px; font-weight: 600; }
      .dsh-wbp__head {
        display: flex; gap: 12px; align-items: flex-start;
        justify-content: space-between; flex-wrap: wrap;
      }
      .dsh-wbp__title { font-weight: 600; }
      .dsh-wbp__muted { opacity: .7; font-size: 12px; }
      .dsh-wbp button {
        color: inherit; font: inherit; background: transparent; border-radius: 6px;
        border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
        padding: 4px 9px; white-space: nowrap; cursor: pointer;
      }
      .dsh-wbp button:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2, color-mix(in srgb, currentColor 8%, transparent));
      }
      .dsh-wbp button:disabled { opacity: .5; cursor: default; }
      .dsh-wbp button[data-danger="true"] { color: var(--wbp-err); }
      .dsh-wbp button[data-primary="true"] { border-color: currentColor; font-weight: 600; }
      .dsh-wbp select {
        color: inherit; font: inherit; background: transparent;
        border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
        border-radius: 6px; padding: 3px 6px;
      }
      .dsh-wbp textarea {
        width: 100%; box-sizing: border-box; color: inherit; background: transparent;
        font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
        border: 1px solid var(--wbp-line); border-radius: 8px; padding: 8px;
        resize: vertical;
      }
      .dsh-wbp__tabs {
        display: flex; gap: 4px; flex-wrap: wrap;
        border-bottom: 1px solid var(--wbp-line);
      }
      .dsh-wbp__tab {
        border: none !important; border-radius: 6px 6px 0 0 !important;
        padding: 6px 10px !important; opacity: .68;
      }
      .dsh-wbp__tab[aria-selected="true"] {
        opacity: 1; font-weight: 600;
        box-shadow: inset 0 -2px 0 currentColor;
      }
      .dsh-wbp__banner {
        display: flex; gap: 10px; align-items: flex-start;
        justify-content: space-between; border-radius: 8px; padding: 8px 10px;
        border: 1px solid var(--wbp-line);
      }
      .dsh-wbp__banner[data-kind="error"] { color: var(--wbp-err); }
      .dsh-wbp__banner[data-kind="warn"] { color: var(--wbp-warn); }
      .dsh-wbp__banner[data-kind="ok"] { color: var(--wbp-ok); }
      .dsh-wbp__card {
        display: grid; gap: 10px; padding: 12px;
        border: 1px solid var(--wbp-line); border-radius: 10px;
      }
      .dsh-wbp__card > header {
        display: flex; gap: 10px; align-items: center;
        justify-content: space-between; flex-wrap: wrap;
      }
      .dsh-wbp__row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .dsh-wbp__badge {
        display: inline-block; font-size: 11px; padding: 1px 6px;
        border-radius: 999px; border: 1px solid var(--wbp-line); white-space: nowrap;
      }
      .dsh-wbp__badge[data-state="ready"] { color: var(--wbp-ok); }
      .dsh-wbp__badge[data-state="cooling"] { color: var(--wbp-warn); }
      .dsh-wbp__badge[data-state="breaker"] { color: var(--wbp-err); }
      .dsh-wbp__badge[data-state="disabled"] { opacity: .7; }
      .dsh-wbp__badge[data-realm="intl"] { color: var(--dsw-alias-label-secondary, currentColor); }
      .dsh-wbp__table { overflow-x: auto; }
      .dsh-wbp table { border-collapse: collapse; width: 100%; }
      .dsh-wbp th, .dsh-wbp td {
        padding: 7px 9px; text-align: left; vertical-align: top;
        border-bottom: 1px solid var(--wbp-line-soft);
      }
      .dsh-wbp th { white-space: nowrap; font-weight: 600; opacity: .8; }
      .dsh-wbp td:not(:last-child) { white-space: nowrap; }
      .dsh-wbp td:last-child { width: 100%; }
      .dsh-wbp__list { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
      .dsh-wbp__logs {
        display: grid; gap: 5px; max-height: 360px; overflow: auto;
        font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .dsh-wbp__log {
        display: flex; gap: 8px; align-items: flex-start;
        border-bottom: 1px dashed var(--wbp-line-soft); padding-bottom: 4px;
      }
      .dsh-wbp__log em {
        font-style: normal; opacity: .6; white-space: nowrap; flex: none;
      }
      .dsh-wbp__log span { overflow-wrap: anywhere; }
    `;

    function AccountsTab({ view, realms, reload, notify }) {
      const [busy, run] = useRunner(notify);
      const [addFlow, setAddFlow] = useState(null);
      const [confirmUid, setConfirmUid] = useState('');
      const [verify, setVerify] = useState(null);
      const snapshot = view.snapshot;
      const accounts = snapshot?.accounts ?? [];

      useEffect(() => {
        const flow = addFlow;
        if (!flow || flow.phase !== 'waiting') return undefined;
        let active = true;
        let ticks = 0;
        let timer;
        const tick = async () => {
          if (!active) return;
          ticks += 1;
          try {
            const data = flow.realm === 'cn'
              ? await act('login-poll', { state: flow.state })
              : await act('intl-poll');
            if (!active) return;
            if (data?.done) {
              const label = data.nickname || data.uid || '';
              const text = flow.realm === 'cn'
                ? `已添加账号 ${label}${Number.isFinite(data.credits) ? `（${data.credits} 积分）` : ''}`
                : (typeof data.message === 'string' && data.message ? data.message : '国际站凭据已写入');
              setAddFlow({ realm: flow.realm, phase: 'done', message: text });
              notify('ok', text);
              reload();
              return;
            }
          } catch (error) {
            if (!active) return;
            setAddFlow({ realm: flow.realm, phase: 'fail', message: errorText(error) });
            return;
          }
          if (ticks >= 100) {
            setAddFlow({ realm: flow.realm, phase: 'fail', message: '等待授权超时，请重新发起' });
            return;
          }
          timer = setTimeout(tick, TICK_MS);
        };
        timer = setTimeout(tick, TICK_MS);
        return () => {
          active = false;
          clearTimeout(timer);
        };
      }, [addFlow, notify, reload]);

      async function startAdd(realm) {
        setAddFlow({ realm, phase: 'starting' });
        try {
          const data = realm === 'cn' ? await act('login-start') : await act('intl-start');
          const url = typeof data?.url === 'string' ? data.url : '';
          if (!url) throw new Error('网关没有返回授权地址');
          window.open(url, '_blank', 'noopener');
          setAddFlow({ realm, phase: 'waiting', url, state: data?.state });
        } catch (error) {
          setAddFlow({ realm, phase: 'fail', message: errorText(error) });
        }
      }

      function accountAction(uid, op, label) {
        setConfirmUid('');
        void run(`account:${uid}:${op}`, async () => {
          const data = await act('account', { uid, op });
          let text = `${label}完成`;
          if (op === 'checkin') {
            const extra = typeof data?.checkin_message === 'string' && data.checkin_message
              ? `：${data.checkin_message}` : '';
            const credits = Number.isFinite(data?.credits) ? `，当前 ${data.credits} 积分` : '';
            text = `签到完成${extra}${credits}`;
            if (typeof data?.balance_error === 'string' && data.balance_error) {
              text += `（余额刷新失败：${data.balance_error}）`;
            }
          } else if (op === 'balance' && Number.isFinite(data?.credits)) {
            const total = Number.isFinite(data.credits_total) ? ` / ${data.credits_total}` : '';
            text = `余额 ${data.credits}${total} 积分`;
          } else if (op === 'remove' && typeof data?.file_error === 'string' && data.file_error) {
            text = `已移除账号，但删除凭证文件失败：${data.file_error}`;
          }
          notify('ok', text);
          reload();
        });
      }

      async function verifyAccount(uid) {
        setVerify({ uid, phase: 'running', status: 'running' });
        try {
          const data = await act('verify', { uid });
          // passed / unconfirmed / failed 三态：请求成功但承载账号不是目标账号时，
          // 只是个“未确认”，不能报成验证通过。
          const status = data?.status === 'passed' || data?.status === 'unconfirmed'
            ? data.status
            : (data?.ok === true ? 'unconfirmed' : 'failed');
          const message = typeof data?.message === 'string' && data.message ? data.message : '渠道验证完成';
          setVerify({ uid, phase: 'done', status, message });
          notify(status === 'passed' ? 'ok' : status === 'failed' ? 'error' : 'warn', message);
        } catch (error) {
          const message = errorText(error);
          setVerify({ uid, phase: 'done', status: 'failed', message });
          notify('error', message);
        }
      }

      function runRoutine(name, label) {
        void run(`routine:${name}`, async () => {
          const data = await act('routine', { name });
          if (name === 'balance_all') {
            const count = Array.isArray(data?.accounts) ? data.accounts.length : 0;
            notify('ok', `已刷新 ${count} 个账号的余额`);
          } else {
            notify('ok', data?.started ? `${label}已触发，稍后刷新查看结果` : `${label}未启动`);
          }
          reload();
        });
      }

      const headings = ['账号', '渠道', '积分', '状态', '在途', '成功 / 失败', '最近成功', '操作'];

      return h('div', { className: 'dsh-wbp__card' },
        h('header', null,
          h('h3', null, '账号'),
          h('div', { className: 'dsh-wbp__row' },
            h('button', { type: 'button', disabled: busy !== '', onClick: () => void startAdd('cn') }, '添加国内账号'),
            h('button', { type: 'button', disabled: busy !== '', onClick: () => void startAdd('intl') }, '添加国际账号'),
            h('button', { type: 'button', disabled: view.pending, onClick: () => reload() }, '刷新'))),
        h('p', { className: 'dsh-wbp__muted' },
          '渠道验证会临时禁用其它「正常」账号以隔离流量，验证后自动复活；冷却或禁用中的账号不会被改动。'
          + '注意：复活是无条件恢复，被隔离账号的失败计数与软退避累积会被一并清零（账号本身仍在，只是重来一次统计）。'),

        addFlow && h('div', { className: 'dsh-wbp__banner', 'data-kind': addFlow.phase === 'fail' ? 'error' : 'ok' },
          h('div', null,
            h('p', null, addFlow.realm === 'cn' ? '添加国内账号' : '添加国际站账号'),
            h('p', { className: 'dsh-wbp__muted' },
              addFlow.phase === 'starting' ? '正在申请授权地址…'
                : addFlow.phase === 'waiting' ? '等待浏览器中完成授权，完成后自动加入号池…'
                  : addFlow.message),
            addFlow.url && h('p', { className: 'dsh-wbp__muted' }, addFlow.url)),
          h('div', { className: 'dsh-wbp__row' },
            addFlow.url && h('button', {
              type: 'button',
              onClick: () => window.open(addFlow.url, '_blank', 'noopener'),
            }, '重新打开'),
            h('button', { type: 'button', onClick: () => setAddFlow(null) }, '关闭'))),

        h('div', { className: 'dsh-wbp__row' },
          h('span', { className: 'dsh-wbp__muted' }, '全量例行：'),
          ROUTINES.map(([name, label]) => h('button', {
            key: name,
            type: 'button',
            disabled: busy !== '',
            onClick: () => runRoutine(name, label),
          }, busy === `routine:${name}` ? `${label}中…` : label))),

        accounts.length === 0
          ? h('p', null, snapshot ? '号池中暂无账号' : '暂无号池状态')
          : h('div', { className: 'dsh-wbp__table' },
            h('table', { 'aria-label': 'WorkBuddy 账号状态' },
              h('thead', null,
                h('tr', null, headings.map(label => h('th', { key: label, scope: 'col' }, label)))),
              h('tbody', null, accounts.map((account, index) => {
                const channel = realms.get(account.uid) ?? null;
                const confirming = confirmUid === account.uid;
                return h('tr', { key: account.uid || `account-${index}` },
                  h('td', null,
                    h('div', null, account.label),
                    h('div', { className: 'dsh-wbp__muted' }, account.uidShort),
                    account.disabledReason && h('div', { className: 'dsh-wbp__muted' }, account.disabledReason),
                    verify && verify.uid === account.uid && h('div', { className: 'dsh-wbp__muted' },
                      verify.phase === 'running' ? '渠道验证中，最长约 2 分钟…' : verify.message)),
                  h('td', null, channel
                    ? h('span', { className: 'dsh-wbp__badge', 'data-realm': channel.realm },
                      REALM_LABELS[channel.realm] ?? channel.realm)
                    : h('span', { className: 'dsh-wbp__muted' }, '未知')),
                  h('td', null, `${account.credits ?? '—'} / ${account.creditTotal ?? '—'}`),
                  h('td', null,
                    h('span', { className: 'dsh-wbp__badge', 'data-state': account.state }, account.stateLabel),
                    account.coolingUntil && h('div', { className: 'dsh-wbp__muted' },
                      `至 ${formatTime(account.coolingUntil)}`)),
                  h('td', null, account.inFlight ?? '—'),
                  h('td', null, `${account.successes} / ${account.errors}`),
                  h('td', { title: formatTime(account.lastSuccess) },
                    sinceAgo(account.lastSuccess),
                    account.lastError && h('div', { className: 'dsh-wbp__muted' },
                      `错 ${sinceAgo(account.lastError)}`)),
                  h('td', null, h('div', { className: 'dsh-wbp__row' },
                    h('button', {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: () => accountAction(account.uid, 'revive', '复活'),
                    }, '复活'),
                    h('button', {
                      type: 'button',
                      disabled: busy !== '' || account.state === 'disabled',
                      onClick: () => accountAction(account.uid, 'disable', '禁用'),
                    }, '禁用'),
                    h('button', {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: () => accountAction(account.uid, 'checkin', '签到'),
                    }, '签到'),
                    h('button', {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: () => accountAction(account.uid, 'balance', '刷新余额'),
                    }, '余额'),
                    h('button', {
                      type: 'button',
                      disabled: busy !== '' || (verify?.phase === 'running' && verify.uid === account.uid),
                      onClick: () => void verifyAccount(account.uid),
                    }, '验证渠道'),
                    confirming
                      ? h('button', {
                        type: 'button',
                        'data-danger': 'true',
                        disabled: busy !== '',
                        onClick: () => accountAction(account.uid, 'remove', '移除'),
                      }, '确认移除')
                      : h('button', {
                        type: 'button',
                        'data-danger': 'true',
                        disabled: busy !== '',
                        onClick: () => setConfirmUid(account.uid),
                      }, '移除'),
                    confirming && h('button', {
                      type: 'button',
                      onClick: () => setConfirmUid(''),
                    }, '取消'))));
              })))),

        view.channelDir && h('p', { className: 'dsh-wbp__muted' }, `渠道信息来自 ${view.channelDir}`));
    }

    function TasksTab({ view, notify, reload }) {
      const [busy, run] = useRunner(notify);
      const accounts = view.snapshot?.accounts ?? [];
      const firstUid = accounts[0]?.uid ?? '';
      const [uid, setUid] = useState(firstUid);
      const selected = accounts.some(account => account.uid === uid) ? uid : firstUid;
      const [tasks, setTasks] = useState(null);
      const [scan, setScan] = useState(null);
      const [school, setSchool] = useState(null);
      const [queue, setQueue] = useState(null);
      const [concurrency, setConcurrency] = useState(1);

      const loadTasks = useCallback(async (target) => {
        if (!target) {
          setTasks(null);
          return;
        }
        try {
          const data = await act('tasks', { uid: target });
          setTasks({ uid: target, items: Array.isArray(data?.tasks) ? data.tasks : [] });
        } catch (error) {
          setTasks({ uid: target, items: [], message: errorText(error) });
        }
      }, []);

      useEffect(() => {
        void loadTasks(selected);
      }, [selected, loadTasks]);

      // 依赖 running 而不是整个 queue：否则每次进度更新都会重建定时器。
      const queueRunning = queue?.running === true;
      useEffect(() => {
        if (!queueRunning) return undefined;
        let active = true;
        const timer = setInterval(async () => {
          try {
            const data = await act('queue');
            if (active && data) setQueue(data);
          } catch {
            // 队列读取失败时保留上一次进度
          }
        }, TICK_MS);
        return () => {
          active = false;
          clearInterval(timer);
        };
      }, [queueRunning]);

      function acceptAll() {
        if (!selected) return;
        void run('accept-all', async () => {
          const data = await act('tasks-accept-all', { uid: selected });
          const accepted = Number.isFinite(data?.accepted) ? data.accepted : 0;
          const failed = Number.isFinite(data?.failed) ? data.failed : 0;
          notify('ok', `已接受 ${accepted} 个任务${failed > 0 ? `，${failed} 个失败` : ''}`);
          void loadTasks(selected);
        });
      }

      function autoAll() {
        if (!selected) return;
        void run('auto-all', async () => {
          const data = await act('tasks-auto-all', { uid: selected });
          const results = Array.isArray(data?.results) ? data.results : [];
          const claimed = results.filter(item => item && item.claimed).length;
          notify('ok', `已执行 ${results.length} 个任务${claimed > 0 ? `，领取 ${claimed} 个奖励` : ''}`);
          void loadTasks(selected);
        });
      }

      function claimTask(code) {
        if (!selected || !code) return;
        void run(`claim:${code}`, async () => {
          const data = await act('tasks-claim', { uid: selected, code });
          if (data?.already_claimed) notify('info', '该任务奖励已领取');
          else notify('ok', `领取成功${Number.isFinite(data?.credit) ? `，+${data.credit} 积分` : ''}`);
          void loadTasks(selected);
          reload();
        });
      }

      function autoTask(code) {
        if (!selected || !code) return;
        void run(`auto:${code}`, async () => {
          const data = await act('tasks-auto', { uid: selected, code });
          const message = typeof data?.message === 'string' && data.message ? data.message : '任务已执行';
          notify('ok', message);
          void loadTasks(selected);
          reload();
        });
      }

      function scanAll() {
        void run('scan', async () => {
          const data = await act('scan');
          const rows = Array.isArray(data?.accounts) ? data.accounts : [];
          const pending = Number.isFinite(data?.pending_count) ? data.pending_count : null;
          setScan({ accounts: rows, pending });
          notify('ok', `扫描完成${pending === null ? '' : `，${pending} 个待办任务`}`);
        });
      }

      function startQueue() {
        void run('run-queue', async () => {
          const data = await act('run-queue', { concurrency });
          if (data?.started !== true) {
            notify('info', typeof data?.message === 'string' && data.message ? data.message : '没有待办任务');
            return;
          }
          notify('ok', `已启动 ${data.total ?? '若干'} 个任务（并发 ${concurrency}）`);
          try {
            setQueue(await act('queue'));
          } catch {
            setQueue({ running: true });
          }
        });
      }

      async function refreshQueue() {
        try {
          setQueue(await act('queue'));
        } catch (error) {
          notify('error', errorText(error));
        }
      }

      async function loadSchool() {
        try {
          const data = await act('school');
          setSchool({ accounts: Array.isArray(data?.accounts) ? data.accounts : [] });
        } catch (error) {
          notify('error', errorText(error));
        }
      }

      function runSchool() {
        void run('school-run', async () => {
          const data = await act('school-run');
          notify('ok', data?.started ? '开学季任务已触发' : '开学季任务未启动');
        });
      }

      const items = tasks && tasks.uid === selected ? tasks.items : null;

      return h('div', { className: 'dsh-wbp__card' },
        h('header', null,
          h('h3', null, '单账号任务'),
          h('div', { className: 'dsh-wbp__row' },
            h('select', { value: selected, onChange: event => setUid(event.target.value) },
              accounts.length === 0
                ? h('option', { value: '' }, '暂无账号')
                : accounts.map(account => h('option', { key: account.uid, value: account.uid }, account.label))),
            h('button', {
              type: 'button',
              disabled: busy !== '' || !selected,
              onClick: acceptAll,
            }, busy === 'accept-all' ? '接受中…' : '全部接受'),
            h('button', {
              type: 'button',
              disabled: busy !== '' || !selected,
              onClick: autoAll,
            }, busy === 'auto-all' ? '执行中…' : '全部自动完成'),
            h('button', { type: 'button', disabled: !selected, onClick: () => void loadTasks(selected) }, '刷新'))),

        !items
          ? h('p', { className: 'dsh-wbp__muted' }, '选择一个账号查看任务')
          : items.length === 0
            ? h('p', { className: 'dsh-wbp__muted' }, tasks.message ?? '该账号没有任务')
            : h('div', { className: 'dsh-wbp__table' },
              h('table', { 'aria-label': '账号任务' },
                h('thead', null,
                  h('tr', null, ['任务', '状态', '进度', '奖励', '操作'].map(label => h('th', { key: label, scope: 'col' }, label)))),
                h('tbody', null, items.map((task, index) => {
                  const code = typeof task.task_code === 'string' ? task.task_code : '';
                  return h('tr', { key: code || `task-${index}` },
                    h('td', null,
                      h('div', null, task.title || task.task_name || task.task_desc || code || '未命名任务'),
                      h('div', { className: 'dsh-wbp__muted' }, code)),
                    h('td', null,
                      TASK_STATUS[task.status] ?? task.status ?? '—',
                      task.locked === true && h('div', { className: 'dsh-wbp__muted' }, '未解锁'),
                      task.claimed === true && h('div', { className: 'dsh-wbp__muted' }, '已领取')),
                    h('td', null, taskProgress(task) || '—'),
                    h('td', null, Number.isFinite(task.credit) ? `${task.credit} 积分` : '—'),
                    h('td', null, h('div', { className: 'dsh-wbp__row' },
                      h('button', {
                        type: 'button',
                        disabled: busy !== '' || !code || task.claimed === true || task.locked === true,
                        onClick: () => claimTask(code),
                      }, '领取'),
                      h('button', {
                        type: 'button',
                        disabled: busy !== '' || !code || task.locked === true,
                        onClick: () => autoTask(code),
                      }, '自动完成'))));
                })))),

        h('div', { className: 'dsh-wbp__row' },
          h('span', { className: 'dsh-wbp__muted' }, '任务中心：'),
          h('label', { className: 'dsh-wbp__muted' }, '并发'),
          h('select', {
            value: String(concurrency),
            onChange: event => setConcurrency(Number(event.target.value) || 1),
          }, [1, 2, 3, 4].map(value => h('option', { key: value, value: String(value) }, String(value)))),
          h('button', {
            type: 'button',
            disabled: busy !== '',
            onClick: scanAll,
          }, busy === 'scan' ? '扫描中…' : '扫描全部账号'),
          h('button', {
            type: 'button',
            disabled: busy !== '',
            onClick: startQueue,
          }, busy === 'run-queue' ? '启动中…' : '执行全部待办'),
          h('button', { type: 'button', onClick: () => void refreshQueue() }, '刷新队列')),

        scan && h('div', null,
          h('p', null, `扫描结果${scan.pending === null ? '' : `：${scan.pending} 个待办任务`}`),
          scan.accounts.length === 0
            ? h('p', { className: 'dsh-wbp__muted' }, '没有可处理的账号')
            : h('ul', { className: 'dsh-wbp__list' }, scan.accounts.map(item => {
              const growth = Array.isArray(item.growth) ? item.growth : [];
              const schoolTasks = Array.isArray(item.school) ? item.school : [];
              return h('li', { key: item.uid || item.nickname || String(Math.random()) },
                h('span', null, `${item.nickname || item.uid || '账号'} · 成长 ${growth.length} · 开学季 ${schoolTasks.length}`),
                item.growth_error && h('div', { className: 'dsh-wbp__muted' }, `成长任务：${item.growth_error}`),
                item.school_error && h('div', { className: 'dsh-wbp__muted' }, `开学季：${item.school_error}`));
            }))),

        queue && h('div', null,
          h('p', null, `队列${queue.running ? '执行中' : '已结束'}`
            + ` · ${queue.started ?? 0} / ${queue.total ?? 0} · 并发 ${queue.conc ?? '—'}`),
          Array.isArray(queue.items) && queue.items.length > 0 && h('div', { className: 'dsh-wbp__table' },
            h('table', { 'aria-label': '任务队列' },
              h('thead', null,
                h('tr', null, ['账号', '类型', '任务', '状态', '说明'].map(label => h('th', { key: label, scope: 'col' }, label)))),
              h('tbody', null, queue.items.map((item, index) => h('tr', { key: `${item.uid ?? 'x'}-${item.code ?? index}-${index}` },
                h('td', null, item.nickname || item.uid || '—'),
                h('td', null, item.kind === 'school' ? '开学季' : '成长'),
                h('td', null, item.code ?? '—'),
                h('td', null, item.status ?? '—'),
                h('td', null, item.message ?? '—'))))))),

        h('div', { className: 'dsh-wbp__row' },
          h('span', { className: 'dsh-wbp__muted' }, '开学季：'),
          h('button', { type: 'button', disabled: busy !== '', onClick: () => void loadSchool() }, '刷新状态'),
          h('button', {
            type: 'button',
            disabled: busy !== '',
            onClick: runSchool,
          }, busy === 'school-run' ? '触发中…' : '一键完成')),

        school && (school.accounts.length === 0
          ? h('p', { className: 'dsh-wbp__muted' }, '没有可查看的账号')
          : h('div', { className: 'dsh-wbp__table' },
            h('table', { 'aria-label': '开学季状态' },
              h('thead', null,
                h('tr', null, ['账号', '赛季', '任务数', '机会', '说明'].map(label => h('th', { key: label, scope: 'col' }, label)))),
              h('tbody', null, school.accounts.map((item, index) => h('tr', { key: item.uid || `school-${index}` },
                h('td', null, item.nickname || item.uid || '—'),
                h('td', null, item.in_period === true ? '进行中' : '未开始'),
                h('td', null, Array.isArray(item.tasks) ? String(item.tasks.length) : '—'),
                h('td', null, Number.isFinite(item.chances) ? String(item.chances) : '—'),
                h('td', null, item.error ?? '—'))))))));
    }

    function ModelsTab({ notify }) {
      const [state, setState] = useState({ phase: 'loading', models: [], message: '' });
      const load = useCallback(async () => {
        setState(previous => ({ ...previous, phase: 'loading' }));
        try {
          const data = await act('models');
          const models = Array.isArray(data?.models) ? data.models : [];
          setState({ phase: 'done', models, message: models.length === 0 ? '网关没有返回模型列表' : '' });
        } catch (error) {
          setState({ phase: 'error', models: [], message: errorText(error) });
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      return h('div', { className: 'dsh-wbp__card' },
        h('header', null,
          h('h3', null, '可用模型'),
          h('div', { className: 'dsh-wbp__row' },
            h('button', { type: 'button', disabled: state.phase === 'loading', onClick: () => void load() },
              state.phase === 'loading' ? '读取中…' : '刷新'))),
        h('p', { className: 'dsh-wbp__muted' },
          '模型列表由网关向当前可用账号的上游查询；号池没有可用账号时网关会直接返回错误。'),
        state.message && h('p', { className: 'dsh-wbp__banner', 'data-kind': state.phase === 'error' ? 'error' : 'ok' },
          state.message),
        state.models.length > 0 && h('div', { className: 'dsh-wbp__table' },
          h('table', { 'aria-label': '模型列表' },
            h('thead', null,
              h('tr', null, ['模型', '名称', '上下文', '最大输出', '积分', '推理'].map(label => h('th', { key: label, scope: 'col' }, label)))),
            h('tbody', null, state.models.map((model, index) => h('tr', { key: model.id || `model-${index}` },
              h('td', null, model.id ?? '—'),
              h('td', null, model.name ?? '—'),
              h('td', null, Number.isFinite(model.context_length) ? String(model.context_length) : '—'),
              h('td', null, Number.isFinite(model.max_output_tokens) ? String(model.max_output_tokens) : '—'),
              h('td', null, model.credits === undefined || model.credits === null ? '—' : String(model.credits)),
              h('td', null, model.supports_reasoning === true ? '支持' : '—')))))) );
    }

    function ConfigTab({ notify, reload }) {
      const [state, setState] = useState({ phase: 'loading', path: '', text: '', message: '' });
      const load = useCallback(async () => {
        setState(previous => ({ ...previous, phase: 'loading' }));
        try {
          const data = await act('config');
          const config = data?.config ?? null;
          setState({
            phase: 'done',
            path: typeof data?.path === 'string' ? data.path : '',
            text: JSON.stringify(config, null, 2),
            message: '',
          });
        } catch (error) {
          setState({ phase: 'error', path: '', text: '', message: errorText(error) });
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      async function save() {
        let parsed;
        try {
          parsed = JSON.parse(state.text);
        } catch (error) {
          notify('error', `配置不是合法 JSON：${errorText(error)}`);
          return;
        }
        try {
          const data = await act('save-config', { config: parsed });
          const fields = Array.isArray(data?.restart_required) ? data.restart_required : [];
          notify('ok', fields.length > 0
            ? `已保存，重启网关后生效：${fields.join('、')}`
            : '已保存');
          reload();
        } catch (error) {
          notify('error', errorText(error));
        }
      }

      return h('div', { className: 'dsh-wbp__card' },
        h('header', null,
          h('h3', null, '网关配置'),
          h('div', { className: 'dsh-wbp__row' },
            h('button', { type: 'button', disabled: state.phase === 'loading', onClick: () => void load() }, '重新载入'),
            h('button', {
              type: 'button',
              'data-primary': 'true',
              disabled: state.phase !== 'done',
              onClick: () => void save(),
            }, '保存'))),
        h('p', { className: 'dsh-wbp__muted' },
          '保存会用下方内容整体覆写网关的 config.json；部分字段需要重启网关才生效。'),
        state.path && h('p', { className: 'dsh-wbp__muted' }, state.path),
        state.message && h('p', { className: 'dsh-wbp__banner', 'data-kind': 'error' }, state.message),
        state.phase === 'done' && h('textarea', {
          rows: 20,
          spellCheck: false,
          value: state.text,
          onChange: event => setState(previous => ({ ...previous, text: event.target.value })),
        }));
    }

    function LogsTab() {
      const [state, setState] = useState({ phase: 'loading', entries: [], message: '' });
      const load = useCallback(async () => {
        try {
          const data = await act('logs');
          setState({ phase: 'done', entries: Array.isArray(data?.entries) ? data.entries : [], message: '' });
        } catch (error) {
          setState({ phase: 'error', entries: [], message: errorText(error) });
        }
      }, []);

      useEffect(() => {
        let active = true;
        const tick = async () => {
          if (active) await load();
        };
        void tick();
        const timer = setInterval(() => void tick(), LOG_POLL_MS);
        return () => {
          active = false;
          clearInterval(timer);
        };
      }, [load]);

      const entries = state.entries.slice().reverse();

      return h('div', { className: 'dsh-wbp__card' },
        h('header', null,
          h('h3', null, '网关日志'),
          h('div', { className: 'dsh-wbp__row' },
            h('span', { className: 'dsh-wbp__muted' }, '每 10 秒刷新'),
            h('button', { type: 'button', onClick: () => void load() }, '刷新'))),
        state.message && h('p', { className: 'dsh-wbp__banner', 'data-kind': 'error' }, state.message),
        entries.length === 0
          ? h('p', { className: 'dsh-wbp__muted' }, state.phase === 'loading' ? '读取中…' : '暂无日志')
          : h('div', { className: 'dsh-wbp__logs' }, entries.map((entry, index) => h('div', {
            className: 'dsh-wbp__log',
            key: `${entry?.ts ?? index}-${index}`,
          },
            h('em', null, `${logTime(entry?.ts)} ${entry?.ch ?? ''}`.trim()),
            h('span', null, String(entry?.text ?? ''))))));
    }

    function PoolSection() {
      const [tab, setTab] = useState('accounts');
      const [view, setView] = useState({
        snapshot: null,
        channels: [],
        channelDir: null,
        pending: true,
        message: '',
        checkedAt: 0,
      });
      const [notice, setNotice] = useState(null);
      const notify = useCallback((kind, text) => {
        if (typeof text === 'string' && text) setNotice({ kind, text });
      }, []);

      const load = useCallback(async (force) => {
        try {
          const body = await callStatus({ refresh: force === true });
          setView({
            snapshot: body.snapshot ?? null,
            channels: Array.isArray(body.channels) ? body.channels : [],
            channelDir: typeof body.channelDir === 'string' ? body.channelDir : null,
            pending: false,
            message: body.ok === true ? '' : (typeof body.message === 'string' ? body.message : ''),
            checkedAt: Number.isFinite(body.checkedAt) ? body.checkedAt : Date.now(),
          });
        } catch (error) {
          setView(previous => ({ ...previous, pending: false, message: errorText(error) }));
        }
      }, []);

      useEffect(() => {
        let active = true;
        let timer;
        const tick = async (force) => {
          if (!active) return;
          await load(force);
          if (active) timer = setTimeout(() => void tick(false), POLL_MS);
        };
        void tick(true);
        return () => {
          active = false;
          clearTimeout(timer);
        };
      }, [load]);

      const reload = useCallback(() => {
        void load(true);
      }, [load]);

      const realms = useMemo(() => {
        const map = new Map();
        for (const item of view.channels) {
          if (item && typeof item.uid === 'string') map.set(item.uid, item);
        }
        return map;
      }, [view.channels]);

      const summary = useMemo(() => {
        const snapshot = view.snapshot;
        if (!snapshot) return view.pending ? '正在检查号池…' : '暂无号池状态';
        const parts = [
          `${snapshot.healthy}/${snapshot.total} 可用`,
          `${snapshot.cooling} 冷却`,
          `${snapshot.disabled} 禁用`,
        ];
        if (snapshot.saturated !== null) parts.push(`${snapshot.saturated} 并发占满`);
        if (snapshot.stickySessions !== null) parts.push(`${snapshot.stickySessions} 粘性会话`);
        return parts.join(' · ');
      }, [view]);

      return h('section', { className: 'dsh-wbp', 'aria-label': 'WorkBuddy 号池' },
        h('style', null, styles),
        h('div', { className: 'dsh-wbp__head' },
          h('div', null,
            h('p', { className: 'dsh-wbp__title' }, summary),
            h('p', { className: 'dsh-wbp__muted' },
              view.snapshot
                ? `最后成功读取 ${formatTime(view.snapshot.fetchedAt)}`
                  + `${view.snapshot.version ? ` · 网关 v${view.snapshot.version}` : ''}`
                  + ' · 每 15 秒检查一次'
                : '需要本机网关（默认 127.0.0.1:7863）处于运行状态')),
          h('button', { type: 'button', disabled: view.pending, onClick: reload },
            view.pending ? '刷新中…' : '立即刷新')),

        h('nav', { className: 'dsh-wbp__tabs', role: 'tablist' },
          TABS.map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            role: 'tab',
            className: 'dsh-wbp__tab',
            'aria-selected': String(tab === id),
            onClick: () => setTab(id),
          }, label))),

        view.message && h('p', { className: 'dsh-wbp__banner', 'data-kind': 'error', role: 'status' },
          view.snapshot
            ? `${view.message}。下方显示上一次成功读取的状态。`
            : view.message),

        notice && h('div', { className: 'dsh-wbp__banner', 'data-kind': notice.kind, role: 'status' },
          h('span', null, notice.text),
          h('button', { type: 'button', onClick: () => setNotice(null) }, '关闭')),

        tab === 'accounts' && h(AccountsTab, { view, realms, reload, notify }),
        tab === 'tasks' && h(TasksTab, { view, notify, reload }),
        tab === 'models' && h(ModelsTab, { notify }),
        tab === 'config' && h(ConfigTab, { notify, reload }),
        tab === 'logs' && h(LogsTab, { notify }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'workbuddy-pool', order: 89, label: () => 'WorkBuddy 号池' },
          PoolSection,
        ));
      },
    };
  },
});

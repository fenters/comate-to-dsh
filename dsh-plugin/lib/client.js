// comate-to-dsh 面板（设置 → WPS Comate）。lazy-CJS bundle，react 由 dsh 平台提供。
(function () {
  function factory(require) {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;
    var React;
    try { React = require('react'); } catch (error) { React = globalThis.React; }
    if (!React) throw new Error('comate-to-dsh: react is not available');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const BASE = '/comate';
    const READ_HEADERS = { accept: 'application/json' };
    // 写接口带自定义头，触发跨站预检挡 CSRF。
    const PANEL_HEADERS = { 'x-comate-panel': '1', 'content-type': 'application/json', accept: 'application/json' };
    const REQUEST_TIMEOUT_MS = 25_000;
    const DEEP_TIMEOUT_MS = 120_000;
    // 必须比服务端 5 分钟更久，否则用户还在登录、面板先报超时。
    const LOGIN_TIMEOUT_MS = 5 * 60_000 + 15_000;
    const ROUTE_READY_RETRY_MS = [300, 700, 1200];

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function request(path, options, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs || REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(path, { ...options, signal: controller.signal });
        const text = await res.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
        if (!res.ok) {
          const message = payload?.error || payload?.message || `HTTP ${res.status}`;
          const error = new Error(message);
          error.status = res.status;
          throw error;
        }
        return payload;
      } finally {
        clearTimeout(timer);
      }
    }

    async function getJson(path, timeoutMs) {
      let lastError = null;
      for (let attempt = 0; attempt <= ROUTE_READY_RETRY_MS.length; attempt += 1) {
        try {
          return await request(`${BASE}${path}`, { headers: READ_HEADERS }, timeoutMs);
        } catch (error) {
          lastError = error;
          if (error.status !== 404 && error.status !== 503) throw error;
          if (attempt === ROUTE_READY_RETRY_MS.length) break;
          await delay(ROUTE_READY_RETRY_MS[attempt]);
        }
      }
      throw lastError;
    }

    async function postJson(path, body, timeoutMs) {
      return request(`${BASE}${path}`, {
        method: 'POST',
        headers: PANEL_HEADERS,
        body: JSON.stringify(body || {}),
      }, timeoutMs);
    }

    function insertStyles() {
      const id = 'comate-panel-styles';
      if (document.getElementById(id)) return () => {};
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `
.cmt-wrap { display:flex; flex-direction:column; gap:16px; padding:4px 0; }
.cmt-card { border:1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius:10px; padding:14px 16px; }
.cmt-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
.cmt-title { font-weight:600; font-size:14px; }
.cmt-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
.cmt-muted { opacity:.62; font-size:12px; line-height:1.7; }
.cmt-ok { color:#2e7d32; } .cmt-bad { color:#c62828; } .cmt-warn { color:#ef6c00; }
.cmt-btn { padding:6px 13px; border-radius:7px; cursor:pointer; font-size:13px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.35)); background:transparent; color:inherit; }
.cmt-btn:hover:not(:disabled) { opacity:.78; }
.cmt-btn:disabled { opacity:.45; cursor:default; }
.cmt-btn-primary { border-color:transparent; background:var(--dsh-accent,#4c7dff); color:#fff; }
.cmt-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-top:10px; }
.cmt-stat { padding:10px 12px; border-radius:9px; background:rgba(128,128,128,.09); }
.cmt-stat-label { font-size:11.5px; opacity:.66; }
.cmt-stat-value { font-size:20px; font-weight:650; margin-top:3px; font-variant-numeric:tabular-nums; }
.cmt-stat-sub { font-size:11.5px; opacity:.6; margin-top:2px; }
.cmt-bar { height:6px; border-radius:99px; background:rgba(128,128,128,.2); overflow:hidden; margin-top:10px; }
.cmt-bar-fill { height:100%; border-radius:99px; background:var(--dsh-accent,#4c7dff); }
.cmt-list { display:flex; flex-direction:column; gap:6px; margin-top:10px; max-height:420px; overflow:auto; }
.cmt-item { display:flex; align-items:center; justify-content:space-between; gap:10px;
  padding:7px 10px; border-radius:7px; background:rgba(128,128,128,.09); font-size:13px; }
.cmt-item-check { cursor:pointer; }
.cmt-item-check:hover { background:rgba(128,128,128,.15); }
.cmt-check { flex:none; width:15px; height:15px; margin:0; accent-color:var(--dsh-accent,#4c7dff); cursor:pointer; }
.cmt-item-main { min-width:0; flex:1; }
.cmt-item-name { font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cmt-item-desc { font-size:11.5px; opacity:.6; margin-top:2px; }
.cmt-tag { font-size:11px; padding:1px 7px; border-radius:99px; background:rgba(76,125,255,.16);
  color:var(--dsh-accent,#4c7dff); margin-left:8px; white-space:nowrap; }
.cmt-tag-ent { background:rgba(46,125,50,.16); color:#2e7d32; }
.cmt-banner { padding:8px 11px; border-radius:7px; font-size:12.5px; line-height:1.6; margin-top:10px; }
.cmt-banner-bad { background:rgba(198,40,40,.12); color:#c62828; }
.cmt-banner-warn { background:rgba(239,108,0,.12); color:#ef6c00; }
.cmt-banner-ok { background:rgba(46,125,50,.12); color:#2e7d32; }
.cmt-table { width:100%; border-collapse:collapse; font-size:12.5px; margin-top:8px; }
.cmt-table th, .cmt-table td { text-align:left; padding:5px 8px; border-bottom:1px solid rgba(128,128,128,.16); }
.cmt-table th { font-weight:550; opacity:.66; font-size:11.5px; }
.cmt-num { text-align:right; font-variant-numeric:tabular-nums; }
`;
      document.head.appendChild(style);
      return () => { style.remove(); };
    }

    function stamp(at) {
      if (!at) return '';
      try { return new Date(at).toLocaleString('zh-CN'); } catch { return ''; }
    }

    function fmtNum(value, digits) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '—';
      return digits ? number.toFixed(digits) : String(Math.round(number));
    }

    function Banner({ tone, children }) {
      if (!children) return null;
      return h('div', { className: `cmt-banner cmt-banner-${tone}` }, children);
    }

    function StatusCard({ status, loading, busy, onConnect, onLogin, onRefresh }) {
      const signedIn = status?.signedIn === true;
      const counts = status?.counts || {};
      const sourceText = {
        env: '环境变量 COMATE_SID',
        saved: '上次保存的登录态',
        comate: 'WPS Comate 客户端（进程内存）',
        browser: '浏览器登录',
      }[status?.credentialSource] || (status?.credentialSource || '—');
      return h('div', { className: 'cmt-card' },
        h('div', { className: 'cmt-head' },
          h('div', { className: 'cmt-title' }, 'WPS Comate'),
          h('div', { className: 'cmt-muted' }, `v${status?.version || '?'}`)),
        h('div', { className: 'cmt-muted' },
          signedIn
            ? `已连接：${sourceText}${status?.credentialHint ? `（${status.credentialHint}）` : ''}`
            : '未连接：打开 WPS Comate 后点「自动连接」，或点「浏览器登录」。'),
        h('div', { className: 'cmt-row' },
          h('span', { className: 'cmt-muted' },
            `企业模型 ${counts.enterprise ?? 0} 个 · 内置模型 ${counts.builtin ?? 0} 个 · 个人模型 ${counts.personal ?? 0} 个`),
          status?.catalogAt ? h('span', { className: 'cmt-muted' }, `目录更新于 ${stamp(status.catalogAt)}`) : null),
        h('div', { className: 'cmt-row' },
          h('button', {
            className: 'cmt-btn cmt-btn-primary',
            disabled: busy || loading,
            onClick: onConnect,
          }, busy === 'connect' ? '连接中…' : '自动连接'),
          h('button', {
            className: 'cmt-btn',
            disabled: busy || loading,
            onClick: onLogin,
          }, busy === 'login' ? '等待浏览器登录…' : '浏览器登录'),
          h('button', {
            className: 'cmt-btn',
            disabled: busy || loading,
            onClick: onRefresh,
          }, busy === 'refresh' ? '刷新中…' : '刷新模型与额度')),
        !signedIn && status?.credentialError
          ? h(Banner, { tone: 'warn' }, status.credentialError)
          : null,
        status?.error ? h(Banner, { tone: 'bad' }, status.error) : null,
        status?.registered === false
          ? h(Banner, { tone: 'bad' }, `provider 注册失败：${status?.registerError || '未知原因'}`)
          : null);
    }

    function QuotaCard({ status }) {
      const quota = status?.quota;
      if (!quota) return null;
      const credits = quota.credits || {};
      const limit = Number(credits.dailyLimit) || 0;
      const used = Number(credits.dailyUsed) || 0;
      const remain = Number(credits.dailyRemain) || 0;
      const percent = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
      const models = [];
      const comateApp = quota.appTokens?.comate;
      if (comateApp?.models) {
        for (const item of comateApp.models) {
          if (!item.model) continue;
          models.push(item);
        }
      }
      return h('div', { className: 'cmt-card' },
        h('div', { className: 'cmt-head' },
          h('div', { className: 'cmt-title' }, '额度与积分'),
          h('div', { className: 'cmt-muted' }, status?.quotaAt ? `更新于 ${stamp(status.quotaAt)}` : '')),
        h('div', { className: 'cmt-grid' },
          h('div', { className: 'cmt-stat' },
            h('div', { className: 'cmt-stat-label' }, '每日积分上限'),
            h('div', { className: 'cmt-stat-value' }, limit ? fmtNum(limit) : '—'),
            h('div', { className: 'cmt-stat-sub' }, '每天凌晨重置')),
          h('div', { className: 'cmt-stat' },
            h('div', { className: 'cmt-stat-label' }, '今日已用'),
            h('div', { className: 'cmt-stat-value' }, fmtNum(used, 2)),
            h('div', { className: 'cmt-stat-sub' }, '内置模型按倍率消耗')),
          h('div', { className: 'cmt-stat' },
            h('div', { className: 'cmt-stat-label' }, '今日剩余'),
            h('div', { className: 'cmt-stat-value' }, fmtNum(remain, 2)),
            h('div', { className: 'cmt-stat-sub' }, '企业模型不扣积分')),
          h('div', { className: 'cmt-stat' },
            h('div', { className: 'cmt-stat-label' }, '今日 Token'),
            h('div', { className: 'cmt-stat-value' }, fmtNum(quota.usedTokens || 0)),
            h('div', { className: 'cmt-stat-sub' }, '全部模型合计'))),
        limit > 0 ? h('div', { className: 'cmt-bar' },
          h('div', { className: 'cmt-bar-fill', style: { width: `${percent}%` } })) : null,
        models.length
          ? h('table', { className: 'cmt-table' },
              h('thead', null, h('tr', null,
                h('th', null, '模型'), h('th', null, '来源'),
                h('th', { className: 'cmt-num' }, '已用 Token'))),
              h('tbody', null, models.map((item) => h('tr', { key: `${item.model}-${item.choice}` },
                h('td', null, item.model),
                h('td', null, item.choice === 'private' ? '企业' : '内置'),
                h('td', { className: 'cmt-num' }, item.totalTokens < 0 ? `${fmtNum(item.usedTokens)} / 不限` : fmtNum(item.usedTokens))))))
          : null,
        quota.details?.records?.length
          ? h('div', { className: 'cmt-muted', style: { marginTop: '10px' } },
              `最近消费：${quota.details.records.slice(0, 5).map((record) => `${record.model.split('/').slice(-1)[0]} ${fmtNum(record.credits, 2)}积分`).join(' · ')}`)
          : null);
    }

    function ModelsCard({ status, onToggle }) {
      const models = status?.models || [];
      const visibleCount = models.filter((model) => model.visible !== false).length;
      const groups = [
        { key: 'enterprise', label: '企业模型', hint: '企业自定义/私有模型，不扣积分' },
        { key: 'builtin', label: '内置模型', hint: 'Comate 内置公共额度模型，按倍率扣积分' },
        { key: 'personal', label: '个人模型', hint: 'Comate 里自己配置的 BYOK 模型，直连它配置的地址（地址与 Key 不显示）' },
      ];
      if (!models.length) {
        return h('div', { className: 'cmt-card' },
          h('div', { className: 'cmt-title' }, '模型'),
          h('div', { className: 'cmt-muted', style: { marginTop: '8px' } },
            status?.catalogError ? `目录加载失败：${status.catalogError}` : '还没有模型目录：先连接 Comate。'));
      }
      return h('div', { className: 'cmt-card' },
        h('div', { className: 'cmt-head' },
          h('div', { className: 'cmt-title' }, `模型（${visibleCount}/${models.length}）`),
          h('div', { className: 'cmt-muted' }, '取消勾选后不会出现在 DSH 模型下拉里')),
        groups.map((group) => {
          const list = models.filter((model) => model.group === group.key);
          if (!list.length) return null;
          return h('div', { key: group.key },
            h('div', { className: 'cmt-muted', style: { marginTop: '12px' } }, `${group.label} · ${group.hint}`),
            h('div', { className: 'cmt-list' }, list.map((model) => h('label', {
              className: 'cmt-item cmt-item-check',
              key: model.id,
              title: model.id,
            },
              h('input', {
                type: 'checkbox',
                className: 'cmt-check',
                checked: model.visible !== false,
                onChange: () => onToggle(model.id, model.visible === false),
              }),
              h('div', { className: 'cmt-item-main' },
                h('div', { className: 'cmt-item-name' }, model.displayName || model.name),
                h('div', { className: 'cmt-item-desc' }, model.description || model.id)),
              h('span', { className: `cmt-tag${group.key === 'enterprise' ? ' cmt-tag-ent' : ''}` }, group.label)))));
        }));
    }

    function Panel() {
      const [status, setStatus] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState('');
      const [fatal, setFatal] = useState('');

      const load = useCallback(async (force) => {
        try {
          const payload = await getJson(force ? '/status?refresh=1' : '/status');
          setStatus(payload);
          setFatal('');
        } catch (error) {
          setFatal(String(error?.message || error));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { load(false); }, [load]);

      const run = useCallback(async (kind, path, body, timeoutMs) => {
        setBusy(kind);
        try {
          await postJson(path, body, timeoutMs);
          await load(true);
        } catch (error) {
          setFatal(String(error?.message || error));
        } finally {
          setBusy('');
        }
      }, [load]);

      // 勾选先本地翻转再落盘，避免整卡重渲染时闪一下。
      const toggleModel = useCallback((modelId, nextVisible) => {
        setStatus((current) => current && {
          ...current,
          models: current.models.map((model) => (model.id === modelId ? { ...model, visible: nextVisible } : model)),
        });
        postJson('/visibility', { modelId, visible: nextVisible })
          .then((result) => {
            setStatus((current) => current && { ...current, hidden: result.hidden, visibleCount: result.modelCount });
          })
          .catch((error) => {
            setFatal(String(error?.message || error));
            load(true);
          });
      }, [load]);

      return h('div', { className: 'cmt-wrap' },
        fatal ? h(Banner, { tone: 'bad' }, `面板请求失败：${fatal}`) : null,
        h(StatusCard, {
          status, loading, busy,
          onConnect: () => run('connect', '/connect', { allowLaunch: true }, DEEP_TIMEOUT_MS),
          onLogin: () => run('login', '/login', {}, LOGIN_TIMEOUT_MS),
          onRefresh: () => run('refresh', '/refresh', {}, DEEP_TIMEOUT_MS),
        }),
        h(QuotaCard, { status }),
        h(ModelsCard, { status, onToggle: toggleModel }));
    }

    function apply(ctx) {
      const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined);
      if (!slots || typeof slots.register !== 'function') {
        try { console.error('comate-to-dsh: slots service unavailable'); } catch { /* ignore */ }
        return;
      }
      ctx.effect(() => {
        const disposeStyles = insertStyles();
        const disposeSlot = slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'comate',
          order: 61,
          label: 'WPS Comate',
        }, Panel));
        return () => {
          try { disposeSlot && disposeSlot(); } catch { /* ignore */ }
          disposeStyles();
        };
      }, 'comate.panel');
    }

    exports.name = 'comate-client';
    exports.apply = apply;
    exports.inject = ['slots'];
    exports.ComatePanel = Panel;
    exports.getJson = getJson;
    exports.postJson = postJson;
    return module.exports;
  }

  const ids = new Set(['comate-to-dsh']);
  try {
    const src = document.currentScript && document.currentScript.src;
    if (src) {
      const match = /\/plugins\/(?:\?\?)?([^/]+)\/client\.js(?:[?&#]|$)/.exec(String(src));
      if (match) ids.add(decodeURIComponent(match[1]));
    }
  } catch { /* fall back to known ids */ }
  for (const id of ids) {
    try { window.__ModuleLoader__.load({ id, factory }); } catch (error) {
      if (!/duplicate factory registration/.test(String((error && error.message) || error))) throw error;
    }
  }
})();
/** comate-to-dsh 宿主端入口：注册 provider=comate，挂面板路由与诊断服务。 */
import { VERSION, PROVIDER, DISPLAY_NAME, DEFAULTS } from '../../lib/config.mjs';
import { ComateClient } from '../../lib/client.mjs';
import { ComateAdapter } from '../../lib/adapter.mjs';
import { resolveCredentials, maskSecret, invalidateCredentialCache } from '../../lib/auth.mjs';
import { loginViaBrowser } from '../../lib/login.mjs';
import { readCachedCatalog, writeCachedCatalog } from '../../lib/catalog.mjs';
import { readHiddenModels, setHiddenModels, setModelVisible } from '../../lib/selection.mjs';
import { fetchQuota, readCachedQuota } from '../../lib/quota.mjs';
import { log as writeLog } from '../../lib/log.mjs';
import { createRouteTable, mountRoutes } from './routes.mjs';

export const name = 'comate';
export const inject = ['llm'];

export function apply(ctx, rawConfig = {}) {
  const log = (message, detail) => writeLog(`[comate] ${message}`, detail);

  const state = {
    registered: false,
    registerError: '',
    signedIn: false,
    credentialSource: '',
    credentialHint: '',
    credentialError: '',
    lastError: '',
    quota: readCachedQuota(),
    quotaAt: 0,
  };

  const cached = readCachedCatalog();
  const adapter = new ComateAdapter({
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    client: null,
    log,
    defaults: { maxOutputTokens: DEFAULTS.fallbackMaxOutputTokens },
    catalog: cached || undefined,
  });

  const client = new ComateClient({
    getCredentials: () => resolveCredentials({ force: false, allowLaunch: false, validate: true }),
    log,
    timeoutMs: Number(rawConfig.firstByteTimeoutMs) || DEFAULTS.firstByteTimeoutMs,
  });
  adapter.client = client;

  const llm = ctx.llm;
  const notifyAdaptersUpdated = () => {
    try {
      if (typeof llm?.emitAdaptersUpdated === 'function') {
        llm.emitAdaptersUpdated();
        return true;
      }
    } catch (error) {
      log('广播 llm/adapters-updated 失败', error?.message || error);
    }
    try {
      if (typeof ctx.emit === 'function') {
        ctx.emit('llm/adapters-updated');
        return true;
      }
    } catch (error) {
      log('ctx.emit llm/adapters-updated 失败', error?.message || error);
    }
    return false;
  };

  /** 等某个服务就绪后再执行；服务不存在时安静跳过。 */
  const useService = (serviceName, fn) => {
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject([serviceName], (scope) => {
          const service = scope?.[serviceName] ?? scope?.get?.(serviceName);
          if (service) fn(service, scope);
        });
        return;
      }
      const service = ctx.get?.(serviceName);
      if (service) fn(service, ctx);
    } catch (error) {
      log(`获取服务 ${serviceName} 失败`, error?.message || error);
    }
  };

  // 后台任务：目录 + 额度
  let refreshing = null;
  async function refreshAll({ reason = '' } = {}) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const credential = await resolveCredentials({ force: false, allowLaunch: false, validate: true });
      if (!credential?.sid) {
        state.signedIn = false;
        state.credentialError = credential?.error || '';
        state.lastError = credential?.error || '';
        log(`未取到登录态（${reason || '后台'}）`, credential?.error || '');
        return { signedIn: false, error: credential?.error || '', modelCount: adapter.catalog.models.length };
      }
      state.signedIn = true;
      state.credentialSource = credential.source || '';
      state.credentialHint = maskSecret(credential.sid);
      state.credentialError = '';
      state.lastError = '';
      try {
        const catalog = await adapter.refreshCatalog();
        writeCachedCatalog(catalog);
        notifyAdaptersUpdated();
        log(`模型目录已更新：企业 ${catalog.counts.enterprise} + 内置 ${catalog.counts.builtin} + 个人 ${catalog.counts.personal ?? 0}`);
      } catch (error) {
        state.lastError = `模型目录刷新失败：${String(error?.message || error)}`;
        log('模型目录刷新失败', state.lastError);
      }
      try {
        state.quota = await fetchQuota(client, { withDetails: true });
        state.quotaAt = Date.now();
      } catch (error) {
        log('额度刷新失败', String(error?.message || error));
      }
      return {
        signedIn: true,
        modelCount: adapter.catalog.models.length,
        counts: adapter.catalog.counts,
        quota: state.quota,
      };
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  // 注册 provider
  try {
    llm.registerAdapter([PROVIDER], adapter);
    state.registered = true;
    log(`已注册 provider=${PROVIDER} v${VERSION}，缓存模型 ${adapter.catalog.models.length} 个`);
  } catch (error) {
    state.registered = false;
    state.registerError = String(error?.message || error);
    state.lastError = `注册 provider 失败：${state.registerError}`;
    log('注册 provider 失败', state.registerError);
  }

  // 启动后后台预热（不 await，绝不拖慢启动）
  refreshAll({ reason: '启动' }).catch((error) => log('启动预热失败', String(error?.message || error)));

  // 定时刷新目录
  const pollMs = Number(rawConfig.pollIntervalMs) || DEFAULTS.catalogTtlMs;
  try {
    const timer = setInterval(() => {
      refreshAll({ reason: '定时' }).catch(() => {});
    }, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => clearInterval(timer), 'comate.poll');
    }
  } catch (error) {
    log('设置定时刷新失败', error?.message || error);
  }

  // 面板控制器
  const controller = {
    async status() {
      const catalog = adapter.catalog;
      const hidden = readHiddenModels();
      return {
        version: VERSION,
        provider: PROVIDER,
        registered: state.registered,
        registerError: state.registerError,
        signedIn: state.signedIn,
        credentialSource: state.credentialSource,
        credentialHint: state.credentialHint,
        credentialError: state.credentialError,
        error: state.lastError,
        modelCount: catalog.models.length,
        visibleCount: catalog.models.filter((model) => !hidden.has(model.id)).length,
        hidden: [...hidden].sort(),
        counts: catalog.counts,
        catalogAt: catalog.at,
        catalogError: adapter.catalogError,
        quota: state.quota,
        quotaAt: state.quotaAt,
        models: catalog.models.map((model) => ({
          id: model.id,
          name: model.label,
          group: model.group,
          groupLabel: model.groupLabel,
          displayName: model.displayName,
          description: model.description,
          contextWindow: model.contextWindow,
          multimodal: model.multimodal,
          ratio: model.ratio,
          visible: !hidden.has(model.id),
        })),
      };
    },

    /** 设置模型可见性：给 modelId 时单个切换，给 hidden 时整体覆盖。 */
    async visibility({ modelId, visible, hidden } = {}) {
      const next = Array.isArray(hidden)
        ? setHiddenModels(hidden)
        : setModelVisible(modelId, visible !== false);
      notifyAdaptersUpdated();
      return { hidden: next, modelCount: adapter.catalog.models.length - next.length };
    },

    async models() {
      return { ok: true, at: adapter.catalog.at, counts: adapter.catalog.counts, models: adapter.catalog.models };
    },

    async quota({ refresh = false } = {}) {
      if (!refresh && state.quota && Date.now() - state.quotaAt < DEFAULTS.quotaTtlMs) {
        return { ok: true, cached: true, quota: state.quota };
      }
      try {
        state.quota = await fetchQuota(client, { withDetails: true });
        state.quotaAt = Date.now();
        return { ok: true, cached: false, quota: state.quota };
      } catch (error) {
        return { ok: false, error: String(error?.message || error), quota: state.quota };
      }
    },

    /** 自动连接：环境变量 → 已保存 → 扫进程内存。 */
    async connect({ allowLaunch = true } = {}) {
      invalidateCredentialCache();
      const credential = await resolveCredentials({ force: true, allowLaunch, validate: true });
      if (!credential?.sid) {
        state.signedIn = false;
        state.credentialError = credential?.error || '没有可用的 Comate 登录态';
        state.lastError = state.credentialError;
        return { signedIn: false, error: state.credentialError, hint: '' };
      }
      state.signedIn = true;
      state.credentialSource = credential.source || '';
      state.credentialHint = maskSecret(credential.sid);
      state.credentialError = '';
      state.lastError = '';
      const result = await refreshAll({ reason: '面板连接' });
      return {
        signedIn: true,
        source: credential.source || '',
        hint: state.credentialHint,
        modelCount: result.modelCount,
        counts: result.counts,
      };
    },

    /** 浏览器登录兜底。 */
    async login() {
      let lastLogged = '';
      const onState = (event) => {
        const state = String(event?.state || '');
        const message = String(event?.message || '');
        // 只记状态变化，不刷过程噪音。
        if (state === 'opening' || state === 'closed') return;
        if (state === 'waiting' && message === lastLogged) return;
        lastLogged = message;
        if (message) log(`浏览器登录：${message}`);
      };
      try {
        const result = await loginViaBrowser({
          timeoutMs: DEFAULTS.browserLoginTimeoutMs,
          onState,
        });
        if (!result?.sid) {
          state.signedIn = false;
          state.credentialError = result?.error || '浏览器登录未完成';
          state.lastError = state.credentialError;
          return { signedIn: false, error: state.credentialError };
        }
        invalidateCredentialCache();
        state.signedIn = true;
        state.credentialSource = 'browser';
        state.credentialHint = maskSecret(result.sid);
        state.credentialError = '';
        state.lastError = '';
        const refreshed = await refreshAll({ reason: '浏览器登录' });
        return {
          signedIn: true,
          source: 'browser',
          hint: state.credentialHint,
          modelCount: refreshed.modelCount,
          counts: refreshed.counts,
        };
      } catch (error) {
        const message = String(error?.message || error);
        state.signedIn = false;
        state.credentialError = message;
        state.lastError = message;
        return { signedIn: false, error: message };
      }
    },

    async refresh() {
      invalidateCredentialCache();
      const result = await refreshAll({ reason: '面板刷新' });
      return {
        signedIn: result.signedIn,
        modelCount: result.modelCount,
        counts: result.counts,
        error: result.error || '',
      };
    },
  };

  // 图片附件：由宿主读字节，adapter 是纯 JS 拿不到。
  adapter.resolveImages = async (refs) => {
    let attachments;
    try {
      attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
    } catch (error) {
      throw new Error(`attachment 服务读取失败：${error?.message || error}`);
    }
    if (!attachments || typeof attachments.readImage !== 'function') {
      throw new Error('attachment 服务不可用');
    }
    const out = new Map();
    for (const [attachmentId, ref] of refs) {
      const stored = await attachments.readImage(ref);
      const mediaType = stored?.ref?.mediaType || ref.mediaType || 'image/png';
      out.set(attachmentId, `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`);
    }
    return out;
  };

  // 面板数据面（HTTP 路由）
  if (rawConfig.routes !== false) {
    try {
      useService('webServer', (webServer) => {
        const routes = createRouteTable({ controller, log });
        const dispose = mountRoutes(webServer, routes, log);
        if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'comate.panel-routes');
      });
    } catch (error) {
      log('挂载面板路由失败（不影响模型调用）', error?.message || error);
    }
  }

  // 诊断服务（失败绝不影响插件加载）
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('comate', {
        provider: PROVIDER,
        status: () => controller.status(),
        connect: (options) => controller.connect(options),
        login: () => controller.login(),
        refresh: () => controller.refresh(),
        quota: (options) => controller.quota(options),
        visibility: (options) => controller.visibility(options),
      });
    }
  } catch (error) {
    log('注册 comate 诊断服务失败（不影响模型调用）', error?.message || error);
  }

  log('comate 插件已加载');
}
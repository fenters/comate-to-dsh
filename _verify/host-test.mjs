/**
 * 宿主加载模拟：假 cordis ctx 跑 apply()，确认插件能正常加载。
 *   node _verify/host-test.mjs
 */
import { setTimeout as delay } from 'node:timers/promises';

const registrations = [];
const routes = [];
const provided = {};
let effects = 0;
let adaptersUpdated = 0;

const webServer = {
  register(route) {
    routes.push(route);
    return () => {
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
    };
  },
};

const ctx = {
  llm: {
    registerAdapter(providers, adapter) {
      registrations.push({ providers, adapter });
      return { replace() {}, release() {} };
    },
    emitAdaptersUpdated() {
      adaptersUpdated += 1;
    },
  },
  inject(services, callback) {
    const scope = {};
    if (services.includes('webServer')) scope.webServer = webServer;
    callback(scope);
  },
  effect(fn, label) {
    effects += 1;
    const dispose = fn();
    if (typeof dispose !== 'function') throw new Error(`effect(${label}) 没有返回 dispose`);
  },
  provide(name, value) {
    provided[name] = value;
  },
  get() {
    return undefined;
  },
  emit() {},
};

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const mod = await import('../dsh-plugin/lib/index.js');
check('导出 name', mod.name === 'comate', mod.name);
check('导出 inject', Array.isArray(mod.inject) && mod.inject.includes('llm'), JSON.stringify(mod.inject));

try {
  mod.apply(ctx, {});
  check('apply() 不抛错', true);
} catch (error) {
  check('apply() 不抛错', false, String(error?.stack || error));
}

check('注册了 adapter', registrations.length === 1 && registrations[0].providers[0] === 'comate');
check('挂载了面板路由', routes.length >= 5, routes.map((route) => route.path).join(', '));
check('挂载了模型可见性路由', routes.some((route) => route.path === '/comate/visibility'));
check('注册了 comate 诊断服务', Boolean(provided.comate));
check('设置了 effect 清理', effects >= 1, `${effects} 个`);

const adapter = registrations[0]?.adapter;
if (adapter) {
  const models = await adapter.listModels('comate');
  check('listModels 可用', models.length > 0, `${models.length} 个模型`);

  // 8 个契约方法必须全部自己实现（不继承基类），缺一个运行时就会 TypeError。
  const ADAPTER_CONTRACT = [
    'providerInfo',
    'providerRetryPolicy',
    'imageRequestPricing',
    'imageRequestTarget',
    'listModels',
    'resolveModel',
    'prepareCall',
    'stream',
  ];
  const missing = ADAPTER_CONTRACT.filter((name) => typeof adapter[name] !== 'function');
  check('adapter 实现了 LlmAdapter 全部 8 个契约方法', missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : '8/8');
  // 这两个是可选方法，基类默认返回 undefined / 原样尺寸，必须同步返回且不抛。
  let pricingOk = false;
  let targetOk = false;
  try {
    pricingOk = adapter.imageRequestPricing('comate', models[0]?.id) === undefined;
  } catch {
    pricingOk = false;
  }
  try {
    const image = { attachmentId: 'sha256:deadbeef', width: 800, height: 600, bytes: 1234, mediaType: 'image/png' };
    const target = adapter.imageRequestTarget('comate', models[0]?.id, image);
    targetOk = target?.width === 800 && target?.height === 600 && target?.maxBytes === 1234;
  } catch {
    targetOk = false;
  }
  check('imageRequestPricing 同步返回 undefined（声明无图片定价）', pricingOk);
  check('imageRequestTarget 原样返回图片尺寸', targetOk);

  check(
    '模型名带分组标注',
    models.length > 0 && models.every((model) => /^(企业模型|内置模型) · /.test(model.name)),
    models[0]?.name,
  );
}

// 等后台预热跑完，再看面板 status
await delay(Number(process.env.HOST_TEST_WAIT_MS) || 12_000);
if (provided.comate) {
  try {
    const status = await provided.comate.status();
    check('status() 可读', typeof status === 'object', `signedIn=${status.signedIn} models=${status.modelCount}`);
    check('status 带分组计数', status.counts?.enterprise > 0 && status.counts?.builtin > 0, JSON.stringify(status.counts));
    check('status 带额度', Boolean(status.quota?.credits?.dailyLimit), JSON.stringify(status.quota?.credits || null));
    check('广播过 adapters-updated', adaptersUpdated >= 1, `${adaptersUpdated} 次`);
  } catch (error) {
    check('status() 可读', false, String(error?.message || error));
  }
}

console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
process.exit(failures ? 1 : 0);
/**
 * LlmRuntime 契约包装器验证：`?.` 挡不住「注册了但 adapter 缺方法」，必须自己实现。
 *   node _verify/contract-test.mjs
 */
import { resolveCredentials } from '../lib/auth.mjs';
import { ComateClient } from '../lib/client.mjs';
import { normalizeCatalog } from '../lib/catalog.mjs';
import { ComateAdapter } from '../lib/adapter.mjs';

const client = new ComateClient({ getCredentials: () => resolveCredentials({ force: false }), log: () => {} });
const adapter = new ComateAdapter({ provider: 'comate', client, log: () => {} });
adapter.catalog = normalizeCatalog(await client.listCatalog());
const model = adapter.catalog.models.find((m) => m.multimodal);
if (!model) {
  console.log('没有识图模型，跳过。');
  process.exit(1);
}

// 复刻运行时
const adapters = new Map([['comate', { adapter }]]);
const registration = (p) => { const r = adapters.get(p); if (!r) throw new Error(`unregistered ${p}`); return r; };
function runtimeImageRequestPricing(provider, modelId) {
  return adapters.get(provider)?.adapter.imageRequestPricing(provider, modelId);
}
function runtimeImageRequestTarget(provider, modelId, image) {
  return registration(provider).adapter.imageRequestTarget(provider, modelId, image);
}

const image = { attachmentId: 'sha256:abc123', mediaType: 'image/png', bytes: 4096, width: 1024, height: 768, name: 'shot.png' };
let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); if (!ok) failures++; };

// 1) token meter 的 _routeImagePricing 路径
let pricing;
try { pricing = runtimeImageRequestPricing('comate', model.id); check('LlmRuntime.imageRequestPricing 不再抛 TypeError', true, `返回 ${pricing === undefined ? 'undefined' : typeof pricing}`); }
catch (e) { check('LlmRuntime.imageRequestPricing 不再抛 TypeError', false, e.message); }

// 2) 未注册 provider 仍要安全返回 undefined（基类语义）
try { const p = runtimeImageRequestPricing('nope', model.id); check('未注册 provider 安全返回 undefined', p === undefined); }
catch (e) { check('未注册 provider 安全返回 undefined', false, e.message); }

// 3) imageRequestTarget（这里没有 ?.）
try {
  const t = runtimeImageRequestTarget('comate', model.id, image);
  check('LlmRuntime.imageRequestTarget 可用且原样返回尺寸', t.width === 1024 && t.height === 768 && t.maxBytes === 4096, JSON.stringify(t));
} catch (e) { check('LlmRuntime.imageRequestTarget 可用且原样返回尺寸', false, e.message); }

// 4) pruner 的判定：拿不到计算器会抛 "no image token calculator"，这里应走 undefined 分支而非崩
const calculator = pricing;
check('pruner 拿到的是 undefined（走中性估算，不炸）', calculator === undefined);

// 5) priceSurface 的守卫：pricing===undefined 时不得调 priceImages
let guardOk = true;
try { if (pricing !== undefined) pricing.priceImages([{ type: 'image', attachment: image }]); }
catch (e) { guardOk = false; }
check('priceSurface 守卫路径安全', guardOk);

// 6) 最关键：触发与有没有图片无关 —— token meter 只看 header.config 是否存在。
{
  const plainHeader = { config: { provider: 'comate', model: model.id, maxTokens: 8000 } };
  let routeThrew = null;
  try {
    // 复刻 token meter 的 _routeImagePricing（原文照抄）
    const routeImagePricing = (header) => {
      const config = header?.config;
      if (config === void 0) return undefined;
      return runtimeImageRequestPricing(config.provider, config.model);
    };
    routeImagePricing(plainHeader);
  } catch (error) {
    routeThrew = error.message;
  }
  check('纯文本请求（零图片）走 token meter 也不抛错', routeThrew === null, routeThrew || '不抛');

  // 反证：换回只有 6 个方法的旧 adapter，同一路径必须抛 TypeError。
  class OldAdapter {
    providerInfo() {}
    providerRetryPolicy() {}
    async listModels() { return []; }
    async resolveModel() { return {}; }
    async prepareCall() { return {}; }
    async *stream() {}
  }
  const oldMap = new Map([['comate', { adapter: new OldAdapter() }]]);
  const oldRuntimePricing = (provider, modelId) => oldMap.get(provider)?.adapter.imageRequestPricing(provider, modelId);
  let oldThrew = null;
  try {
    const config = plainHeader.config;
    oldRuntimePricing(config.provider, config.model);
  } catch (error) {
    oldThrew = error.message;
  }
  check('反证：修复前的 adapter 在同一路径上确实抛 TypeError', /is not a function/.test(String(oldThrew)), String(oldThrew));
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);

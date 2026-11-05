/**
 * 反证 `imageRequestPricing is not a function`：修复前后 adapter 在同一路径上对比。
 *   node _verify/repro-image-pricing.mjs
 */
import { ComateAdapter } from '../lib/adapter.mjs';

// 照抄 LlmRuntime 的两个包装器，注意 `?.` 能挡住什么。
function runtimeImageRequestPricing(adapters, provider, model) {
  return adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
}

function runtimeImageRequestTarget(adapters, provider, model, image) {
  const registration = adapters.get(provider);
  if (!registration) throw new Error(`unregistered provider: ${provider}`);
  return registration.adapter.imageRequestTarget(provider, model, image);
}

/** 照抄 token meter 的 `_routeImagePricing`：只看 header.config，不管有没有图片。 */
function tokenMeterRouteImagePricing(adapters, header) {
  const config = header?.config;
  if (config === undefined) return undefined;
  return runtimeImageRequestPricing(adapters, config.provider, config.model);
}

// 修复前的形状：只实现 6 个方法。
class PreFixAdapter {
  providerInfo() {}
  providerRetryPolicy() {}
  async listModels() { return []; }
  async resolveModel() { return {}; }
  async prepareCall() { return {}; }
  async *stream() {}
}

const MODEL = 'acct/custom/example-model//private';

// 没有任何图片字段，就是一次纯文本对话。
const TEXT_ONLY_HEADER = { config: { provider: 'comate', model: MODEL, maxTokens: 8000 } };

const image = { attachmentId: 'sha256:abc123', mediaType: 'image/png', bytes: 4096, width: 1024, height: 768 };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('\n=== 修复前（adapter 只实现 6 个契约方法） ===\n');

const preFix = new Map([['comate', { adapter: new PreFixAdapter() }]]);

let prePricingError = null;
try {
  tokenMeterRouteImagePricing(preFix, TEXT_ONLY_HEADER);
} catch (error) {
  prePricingError = error.message;
}
check(
  '纯文本请求 → imageRequestPricing 抛 TypeError',
  /imageRequestPricing is not a function/.test(String(prePricingError)),
  String(prePricingError),
);

let preTargetError = null;
try {
  runtimeImageRequestTarget(preFix, 'comate', MODEL, image);
} catch (error) {
  preTargetError = error.message;
}
check(
  'imageRequestTarget 也抛（这条连 ?. 都没有）',
  /imageRequestTarget is not a function/.test(String(preTargetError)),
  String(preTargetError),
);

console.log('\n=== 修复后（当前插件代码，8 个契约方法齐全） ===\n');

// 用真实的 ComateAdapter（不需要登录态：这两个方法不碰网络）
const adapter = new ComateAdapter({ log: () => {} });
const postFix = new Map([['comate', { adapter }]]);

let postPricing;
let postPricingError = null;
try {
  postPricing = tokenMeterRouteImagePricing(postFix, TEXT_ONLY_HEADER);
} catch (error) {
  postPricingError = error.message;
}
check(
  '纯文本请求 → imageRequestPricing 正常返回 undefined',
  postPricingError === null && postPricing === undefined,
  postPricingError || `返回 ${postPricing}`,
);

let postTarget;
let postTargetError = null;
try {
  postTarget = runtimeImageRequestTarget(postFix, 'comate', MODEL, image);
} catch (error) {
  postTargetError = error.message;
}
check(
  'imageRequestTarget 原样返回尺寸',
  postTargetError === null
    && postTarget?.width === 1024
    && postTarget?.height === 768
    && postTarget?.maxBytes === 4096,
  postTargetError || JSON.stringify(postTarget),
);

console.log('\n=== 边界：`?.` 到底挡住了什么 ===\n');

// provider 没注册 → get() 给 undefined → ?. 短路，这是它唯一能挡的情况。
let unregistered;
let unregisteredError = null;
try {
  unregistered = tokenMeterRouteImagePricing(new Map(), TEXT_ONLY_HEADER);
} catch (error) {
  unregisteredError = error.message;
}
check(
  'provider 未注册时 ?. 生效（返回 undefined，不抛）',
  unregisteredError === null && unregistered === undefined,
  unregisteredError || 'undefined',
);

// header 缺失 → 第一行就短路。
let noHeader;
let noHeaderError = null;
try {
  noHeader = tokenMeterRouteImagePricing(preFix, undefined);
} catch (error) {
  noHeaderError = error.message;
}
check(
  'header 缺失时短路（唯一自然不触发的条件）',
  noHeaderError === null && noHeader === undefined,
  noHeaderError || 'undefined',
);

console.log(
  failures
    ? `\n${failures} 项失败`
    : '\n全部通过 —— 修复前必抛、修复后必通，同一路径对比成立。',
);
process.exit(failures ? 1 : 0);

/**
 * 个人模型（本地 BYOK）验证：解密 / models.json 解析 / 目录合并不泄漏。
 *   node _verify/personal-test.mjs
 * 真机段凭据只从环境读：COMATE_TEST_BASE_URL / COMATE_TEST_API_KEY / COMATE_TEST_MODEL。
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { comateAgentDir, comateExeCandidates } from '../lib/config.mjs';
import { findSecretKey } from '../lib/secret.mjs';

// 真机段凭据：只从环境读。仓库是公开的，硬编码 = 泄密。
const GATEWAY = process.env.COMATE_TEST_BASE_URL || '';
const GATEWAY_KEY = process.env.COMATE_TEST_API_KEY || '';
const GATEWAY_MODEL = process.env.COMATE_TEST_MODEL || 'glm-5.2';
const LIVE = Boolean(GATEWAY && GATEWAY_KEY);

// 本地段用的夹具值：与真假 key 无关，只要「写进去 = 读出来」成立即可。
const FIXTURE_KEY = GATEWAY_KEY || 'sk-fixture-0123456789abcdef';
const FIXTURE_URL = GATEWAY || 'https://gateway.example.invalid/v1';

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function skip(name, why) {
  console.log(`SKIP ${name} :: ${why}`);
}

/** 密钥是从 Comate 可执行文件里扫出来的，测试必须走同一条路。 */
function extractKey() {
  const exe = comateExeCandidates().find((candidate) => existsSync(candidate));
  if (!exe) return null;
  const models = join(comateAgentDir(), 'agent', 'models.json');
  if (!existsSync(models)) return null;
  const probe = JSON.parse(readFileSync(models, 'utf8'))?.providers?.official?.apiKey;
  if (!probe) return null;
  return findSecretKey(probe);
}

const KEY = extractKey();
if (!KEY) {
  console.log('SKIP 本机没有可用的 Comate 可执行文件与 models.json，解密段无法验证');
  console.log('\n全部通过（跳过）');
  process.exit(0);
}
check('从 Comate 可执行文件提取到 32 字节密钥', KEY.length === 32, String(KEY.length));

function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

const fixturePath = join(tmpdir(), 'comate-personal-models.fixture.json');
writeFileSync(fixturePath, JSON.stringify({
  providers: {
    official: {
      api: 'openai-completions',
      apiKey: encryptSecret(FIXTURE_KEY),
      baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
      models: [{ id: '10000001/deepseek/deepseek-v4-pro//public', name: 'deepseek-v4-pro' }],
    },
    TESTP: {
      api: 'openai-completions',
      apiKey: encryptSecret(FIXTURE_KEY),
      authHeader: true,
      baseUrl: FIXTURE_URL,
      models: [
        { id: 'glm-5.2', name: 'glm-5.2', context_window: 1000000, llm_types: ['llm-chat'] },
        { id: 'Qwen-VL', name: 'Qwen-VL', context_window: 131072, llm_types: ['llm-chat', 'llm-multimodal'] },
      ],
    },
    PLAIN: {
      api: 'openai-completions',
      apiKey: FIXTURE_KEY,
      baseUrl: FIXTURE_URL,
      models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', context_window: 393216 }],
    },
  },
}, null, 2), 'utf8');
process.env.COMATE_MODELS_PATH = fixturePath;

const { decryptSecret, listPersonalProviders, invalidatePersonalCache, personalModelKey } = await import('../lib/personal.mjs');
const { normalizeCatalog } = await import('../lib/catalog.mjs');
const { ComateAdapter } = await import('../lib/adapter.mjs');

// 1. 解密
const cipherText = encryptSecret('sk-test-abcdefghijklmnop');
check('AES-256-GCM 解密', decryptSecret(cipherText) === 'sk-test-abcdefghijklmnop', decryptSecret(cipherText));
check('明文 sk- 原样识别', decryptSecret('sk-plaintext-key-123') === 'sk-plaintext-key-123');
check('乱码不崩溃', decryptSecret('not-a-real-cipher') === null, String(decryptSecret('not-a-real-cipher')));

// 2. models.json 解析
invalidatePersonalCache();
const entries = listPersonalProviders();
check('official 被跳过', !entries.some((entry) => entry.providerKey === 'official'), JSON.stringify(entries.map((e) => e.providerKey)));
check('个人模型数量 = 3', entries.length === 3, String(entries.length));
const glm = entries.find((entry) => entry.modelId === 'glm-5.2');
check('解密后的 apiKey 可用', glm?.apiKey === FIXTURE_KEY, glm ? `${glm.apiKey?.slice(0, 6)}…` : 'missing');
check('baseUrl 保留尾斜杠处理', glm?.baseUrl === FIXTURE_URL, glm?.baseUrl);
check('明文 apiKey provider 可用', entries.some((entry) => entry.providerKey === 'PLAIN' && entry.apiKey === FIXTURE_KEY));
check('识图标记', entries.some((entry) => entry.modelId === 'Qwen-VL' && entry.multimodal === true));

// 3. 目录合并（不能泄漏地址/Key）
const cloudBody = { code: 0, data: { auto: null, items: [
  { name: '10000001/custom/quirk-model-9//private', display_name: 'quirk-model-9', model_source: 'custom', context_window: 131072, llm_types: ['llm-chat'] },
  { name: '10000001/deepseek/deepseek-v4-pro//public', display_name: 'deepseek-v4-pro', model_source: 'credits', context_window: 1000000, llm_types: ['llm-chat'] },
] } };
const catalog = normalizeCatalog(cloudBody, entries);
check('counts 三组', catalog.counts.enterprise === 1 && catalog.counts.builtin === 1 && catalog.counts.personal === 3, JSON.stringify(catalog.counts));
const personalModel = catalog.models.find((model) => model.id === personalModelKey('TESTP', 'glm-5.2'));
check('个人模型 id 可路由', Boolean(personalModel), personalModel?.id);
check('个人模型名字带分组', personalModel?.label === '个人模型 · glm-5.2', personalModel?.label);
const catalogText = JSON.stringify(catalog);
check('目录里不含地址', !catalogText.includes(FIXTURE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')));
check('目录里不含 Key', !catalogText.includes(FIXTURE_KEY));

// 4. 直连对话（需要真实上游）
if (!LIVE) {
  console.log('\n跳过真机直连段（未设置 COMATE_TEST_BASE_URL / COMATE_TEST_API_KEY）');
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

const clientStub = {
  async listCatalog() { throw new Error('不应走 llmproxy 目录'); },
  async chat() { throw new Error('不应走 llmproxy 对话'); },
};
const adapter = new ComateAdapter({
  provider: 'comate',
  displayName: 'WPS Comate',
  client: clientStub,
  catalog,
  log: (message) => console.log('  [log]', message),
});

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

const text = [];
let finish = null;
for await (const event of adapter.stream({
  model: personalModelKey('TESTP', GATEWAY_MODEL),
  messages: [{ role: 'user', content: [{ type: 'text', text: '只回答一个数字：1+1 等于几？' }] }],
  maxTokens: 512,
})) {
  if (event.type === 'text-delta') text.push(event.text);
  if (event.type === 'finish') finish = event;
}
check('直连对话有文本', text.join('').length > 0, JSON.stringify(text.join('').slice(0, 60)));
check('直连对话正常收尾', Boolean(finish) && ['stop', 'max-tokens', 'tool-calls'].includes(finish.reason?.kind), JSON.stringify(finish));

// 5. 直连 + 工具调用（arguments 必须是字符串）
const toolEvents = await collect(adapter.stream({
  model: personalModelKey('TESTP', GATEWAY_MODEL),
  messages: [{ role: 'user', content: [{ type: 'text', text: '成都天气怎么样？必须调用 get_weather 工具，参数 city="成都"。' }] }],
  tools: [{
    name: 'get_weather',
    description: '查询城市天气',
    parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
  }],
  maxTokens: 256,
}));
const toolBlocks = toolEvents.filter((event) => event.type === 'block-end' && event.block?.type === 'tool-call');
check('直连工具调用产生 tool-call 块', toolBlocks.length > 0, String(toolBlocks.length));
check('tool-call.arguments 是字符串', toolBlocks.every((event) => typeof event.block.arguments === 'string'), JSON.stringify(toolBlocks.map((e) => typeof e.block.arguments)));
check('tool-call.arguments 是合法 JSON', toolBlocks.every((event) => {
  try { JSON.parse(event.block.arguments); return true; } catch { return false; }
}), JSON.stringify(toolBlocks.map((e) => e.block.arguments)));

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
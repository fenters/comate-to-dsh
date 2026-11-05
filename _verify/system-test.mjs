/**
 * 真实上游的协议对齐验证。用「只准回复四个字」的强指令判 system 是否真的到了上游。
 *   node _verify/system-test.mjs
 */
import { resolveCredentials, maskSecret } from '../lib/auth.mjs';
import { ComateClient } from '../lib/client.mjs';
import { normalizeCatalog } from '../lib/catalog.mjs';
import { ComateAdapter } from '../lib/adapter.mjs';

const log = (message, detail) => console.log(`[system] ${message}${detail ? ` :: ${detail}` : ''}`);
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const MAGIC = '系统提示生效';
const SYSTEM = `你必须永远只回复四个字：「${MAGIC}」。不要解释，不要回答问题，不要输出任何其它字符。`;

async function main() {
  const credential = await resolveCredentials({ force: true, allowLaunch: true, validate: true });
  if (!credential?.sid) {
    console.log(`没有登录态（${credential?.error || 'unknown'}），跳过。`);
    process.exit(1);
  }
  console.log(`登录态 ${maskSecret(credential.sid)} 来源 ${credential.source || 'unknown'}`);

  const client = new ComateClient({ getCredentials: () => resolveCredentials({ force: false }), log });
  const adapter = new ComateAdapter({ provider: 'comate', displayName: 'WPS Comate', client, log });

  const catalog = normalizeCatalog(await client.listCatalog());
  adapter.catalog = catalog;
  const pick = catalog.models.find((model) => model.group === 'enterprise') || catalog.models[0];
  console.log(`使用模型 ${pick.displayName}（${pick.id}）`);

  async function run(options) {
    const events = [];
    for await (const event of adapter.stream(options)) events.push(event);
    const blocks = events.filter((event) => event.type === 'block-end').map((event) => event.block);
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const reasoning = blocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join('');
    return {
      text: text.trim(),
      reasoning: reasoning.trim(),
      finish: events.find((event) => event.type === 'finish'),
      usage: events.find((event) => event.type === 'usage')?.usage,
    };
  }

  // 1) 带 system：必须只吐魔数。思考模型预算给小了会 max-tokens 截断。
  const withSystem = await run({
    model: pick.id,
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: '成都今天天气怎么样？详细说说。' }] }],
    maxTokens: 2048,
  });
  check(
    'system 到达上游',
    withSystem.text.includes(MAGIC),
    `模型回复「${withSystem.text.slice(0, 100)}」 finish=${withSystem.finish?.reason?.kind} usage=${JSON.stringify(withSystem.usage)}`,
  );
  check(
    'system 压住了正常回答',
    !/天气|气温|晴|雨|度/.test(withSystem.text),
    withSystem.text.includes(MAGIC) ? '没有跑偏去答天气' : '模型没听 system',
  );

  // 2) 不带 system：同一问题应正常回答，反证差异由 system 造成。
  const withoutSystem = await run({
    model: pick.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '成都今天天气怎么样？详细说说。' }] }],
    maxTokens: 2048,
  });
  check(
    '不带 system 时正常回答',
    !withoutSystem.text.includes(MAGIC) && withoutSystem.text.length > 0,
    `模型回复「${withoutSystem.text.slice(0, 100)}」 finish=${withoutSystem.finish?.reason?.kind}`,
  );

  // 3) usage 是独立 chunk 且形状正确。
  const events = [];
  for await (const event of adapter.stream({
    model: pick.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只说一个字：好' }] }],
    maxTokens: 32,
  })) events.push(event);
  const usageChunks = events.filter((event) => event.type === 'usage');
  const finish = events.find((event) => event.type === 'finish');
  check('usage 是独立 chunk', usageChunks.length === 1, `${usageChunks.length} 个`);
  check('finish 上不再挂 usage', finish !== undefined && finish.usage === undefined);
  const usage = usageChunks[0]?.usage || {};
  check(
    'usage 形状是 DSH TokenUsage',
    Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens) && usage.totalTokens === undefined,
    JSON.stringify(usage),
  );
  check('finish.reason 是对象', finish?.reason && typeof finish.reason === 'object' && typeof finish.reason.kind === 'string', JSON.stringify(finish?.reason));

  // 4) 能力声明：识图模型声明 image，纯文本模型只声明 text。
  const models = await adapter.listModels('comate');
  const catalogModels = adapter.catalog.models;
  check(
    '模型能力声明与目录一致',
    models.every((model) => {
      const entry = catalogModels.find((item) => item.id === model.id);
      const expected = entry?.multimodal ? ['text', 'image'] : ['text'];
      return JSON.stringify(model.inputModalities) === JSON.stringify(expected);
    }),
    `${models.filter((m) => m.inputModalities?.includes('image')).length} 个识图 / ${models.filter((m) => !m.inputModalities?.includes('image')).length} 个纯文本`,
  );
  check(
    '至少有一个识图模型声明了 image',
    models.some((model) => model.inputModalities?.includes('image')),
    JSON.stringify(models.find((m) => m.inputModalities?.includes('image'))?.inputModalities),
  );

  // 5) 会话标题：purpose=session-title + 64 token，不关思考正文必为空。
  const title = await run({
    model: pick.id,
    system: '你负责给对话起一个中文短标题，只输出标题本身，不超过 10 个字，不要标点。',
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我看下 wps comate 连接这个插件的 bug 并修复' }] }],
    maxTokens: 64,
    purpose: 'session-title',
  });
  check(
    '会话标题能生成（purpose=session-title 关思考）',
    title.text.trim().length > 0,
    `标题「${title.text.trim().slice(0, 40)}」 finish=${title.finish?.reason?.kind} usage=${JSON.stringify(title.usage)}`,
  );

  // 6) 思考档位：未声明 efforts 会被 DSH 拒绝，off 必须真的关掉思考。
  const info = await adapter.resolveModel('comate', pick.id);
  check(
    'resolveModel 声明了思考档位',
    Array.isArray(info.reasoning?.efforts) && info.reasoning.efforts.length > 0
      && info.reasoning.efforts.every((effort) => typeof effort.id === 'string' && typeof effort.name === 'string'),
    JSON.stringify(info.reasoning?.efforts?.map((effort) => effort.id)),
  );
  const off = await run({
    model: pick.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '9.11 和 9.9 哪个大？简短回答。' }] }],
    maxTokens: 1200,
    reasoningEffort: 'off',
  });
  check(
    'reasoningEffort=off 真的关掉了思考',
    off.reasoning.length === 0 && off.text.length > 0,
    `reasoning=${off.reasoning.length} 字 text=${off.text.length} 字`,
  );

  // 7) 自动摘要：purpose=compaction，这条不通长会话会卡在压缩环节。
  const transcript = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 轮：讨论了 comate 插件的 bug 修复（abort / system / finish.reason）。`).join('\n');
  const compacted = await run({
    model: pick.id,
    purpose: 'compaction',
    maxTokens: 8192,
    messages: [{ role: 'user', content: [{ type: 'text', text: `请把下面这段对话压缩成要点：\n${transcript}` }] }],
  });
  check(
    '自动摘要（purpose=compaction）能产出内容',
    compacted.text.length > 20 && compacted.finish?.reason?.kind === 'stop',
    `${compacted.text.length} 字 finish=${compacted.finish?.reason?.kind} usage=${JSON.stringify(compacted.usage)}`,
  );

  // 8) 取消语义：错误码必须是 ABORTED，否则界面会弹错误。
  const ac = new AbortController();
  const abortStart = Date.now();
  setTimeout(() => ac.abort(), 900);
  let abortCode = null;
  let abortElapsed = 0;
  try {
    for await (const _event of adapter.stream({
      model: pick.id,
      maxTokens: 4000,
      signal: ac.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: '请非常详细地讲一下 Rust 的所有权模型。' }] }],
    })) void _event;
  } catch (error) {
    abortCode = error?.failure?.code === error?.code ? error.code : 'UNKNOWN';
    abortElapsed = Date.now() - abortStart;
  }
  check(
    '取消被分类为 ABORTED（不弹错误）',
    abortCode === 'ABORTED' && abortElapsed < 5000,
    `code=${abortCode} 耗时=${abortElapsed}ms`,
  );

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('[system] 未捕获错误', error);
  process.exit(1);
});

/**
 * 端到端冒烟：登录态 → 目录 → 额度 → 对话 → 工具调用。
 *   node _verify/smoke.mjs
 */
import { resolveCredentials, maskSecret } from '../lib/auth.mjs';
import { ComateClient } from '../lib/client.mjs';
import { normalizeCatalog } from '../lib/catalog.mjs';
import { ComateAdapter } from '../lib/adapter.mjs';
import { fetchQuota } from '../lib/quota.mjs';

const log = (message, detail) => console.log(`[smoke] ${message}${detail ? ` :: ${detail}` : ''}`);
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function main() {
  // 1) 登录态
  const credential = await resolveCredentials({ force: true, allowLaunch: true, validate: true });  check('登录态', Boolean(credential?.sid), `${credential?.source || 'none'} ${credential?.sid ? maskSecret(credential.sid) : credential?.error || ''}`);
  if (!credential?.sid) {
    console.log('\n没有登录态，后面的检查跳过。');
    process.exit(1);
  }

  const client = new ComateClient({ getCredentials: () => resolveCredentials({ force: false }), log });
  const adapter = new ComateAdapter({ provider: 'comate', displayName: 'WPS Comate', client, log });

  // 2) 模型目录
  const body = await client.listCatalog();
  const catalog = normalizeCatalog(body);
  adapter.catalog = catalog;
  check('模型目录', catalog.models.length > 0, `共 ${catalog.models.length} 个（企业 ${catalog.counts.enterprise} / 内置 ${catalog.counts.builtin}）`);
  for (const model of catalog.models) {
    console.log(`  - [${model.groupLabel}] ${model.displayName}  ${model.id}`);
    console.log(`      ${model.description}`);
  }
  const models = await adapter.listModels('comate');
  check('listModels 带分组名', models.every((item) => /^(企业模型|内置模型) · /.test(item.name)), `${models.length} 条`);

  // 3) 额度
  try {
    const quota = await fetchQuota(client, { withDetails: true });
    const credits = quota.credits;
    check(
      '额度',
      credits.dailyLimit > 0,
      `每日上限 ${credits.dailyLimit}，已用 ${credits.dailyUsed}，剩余 ${credits.dailyRemain}`,
    );
    if (quota.details) {
      console.log(`  今日明细 ${quota.details.records.length} 条（total ${quota.details.total}），今日积分 ${quota.details.todayCredits}`);
    }
    for (const [appName, app] of Object.entries(quota.appTokens || {})) {
      const used = (app.models || []).filter((item) => item.usedTokens > 0);
      if (used.length) console.log(`  ${appName}: ${used.map((item) => `${item.model}=${item.usedTokens}`).join(', ')}`);
    }
  } catch (error) {
    check('额度', false, String(error?.message || error));
  }

  // 4) 普通对话
  const pick = catalog.models.find((model) => model.group === 'enterprise') || catalog.models[0];
  const events = [];
  for await (const event of adapter.stream({
    model: pick.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话回答：1+1 等于几？' }] }],
    maxTokens: 256,
  })) {
    events.push(event);
  }
  const text = events
    .filter((event) => event.type === 'block-end' && event.block?.type === 'text')
    .map((event) => event.block.text)
    .join('');
  const finish = events.find((event) => event.type === 'finish');
  check('对话', Boolean(text), `${pick.displayName}: ${text.slice(0, 80)}（finish=${finish?.reason?.kind}）`);

  // 5) 工具调用 + arguments 必须是字符串
  const tool = {
    name: 'get_weather',
    description: '查询指定城市的天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
  };
  const toolEvents = [];
  for await (const event of adapter.stream({
    model: pick.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我查一下成都现在的天气。必须调用工具。' }] }],
    tools: [tool],
    maxTokens: 512,
  })) {
    toolEvents.push(event);
  }
  const toolCall = toolEvents.find((event) => event.type === 'block-end' && event.block?.type === 'tool-call');
  let argsOk = false;
  if (toolCall) {
    const args = toolCall.block.arguments;
    argsOk = typeof args === 'string';
    try {
      JSON.parse(args);
    } catch {
      argsOk = false;
    }
    check('工具调用', true, `${toolCall.block.name}(${String(args).slice(0, 120)})`);
  } else {
    check('工具调用', false, '模型没有发起工具调用（可能上游不支持，或提示词没触发）');
  }
  check('tool-call.arguments 是 JSON 字符串', argsOk, '会话重放不丢的前提条件');

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('[smoke] 未捕获错误', error);
  process.exit(1);
});
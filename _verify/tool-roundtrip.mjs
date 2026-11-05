/**
 * 真机工具回环：工具调用 → 结果回灌 → 继续对话，不再被上游 400。
 *   node _verify/tool-roundtrip.mjs
 */
import { resolveCredentials, maskSecret } from '../lib/auth.mjs';
import { ComateClient } from '../lib/client.mjs';
import { normalizeCatalog } from '../lib/catalog.mjs';
import { ComateAdapter, toWireMessages } from '../lib/adapter.mjs';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

const textOf = (events) => events
  .filter((event) => event.type === 'block-end' && event.block?.type === 'text')
  .map((event) => event.block.text)
  .join('');

const TOOL = {
  name: 'get_weather',
  description: '查询指定城市的天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  },
};

async function main() {
  const credential = await resolveCredentials({ force: true, allowLaunch: true, validate: true });
  check('登录态', Boolean(credential?.sid), `${credential?.source || 'none'} ${credential?.sid ? maskSecret(credential.sid) : credential?.error || ''}`);
  if (!credential?.sid) {
    console.log('\n没有登录态，无法做真机测试。');
    process.exit(1);
  }

  const client = new ComateClient({ getCredentials: () => resolveCredentials({ force: false }) });
  const adapter = new ComateAdapter({ provider: 'comate', displayName: 'WPS Comate', client });
  adapter.catalog = normalizeCatalog(await client.listCatalog());

  const pick = adapter.catalog.models.find((model) => model.displayName === 'glm-5.3-flash')
    || adapter.catalog.models.find((model) => model.group === 'builtin')
    || adapter.catalog.models[0];
  check('选中模型', Boolean(pick), pick?.label);

  // 第 1 轮：让模型发起工具调用
  const first = await collect(adapter.stream({
    model: pick.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '成都天气怎么样？必须调用 get_weather 工具，参数 city="成都"。' }] }],
    tools: [TOOL],
    maxTokens: 512,
  }));
  const call = first.find((event) => event.type === 'block-end' && event.block?.type === 'tool-call');
  check('模型发起工具调用', Boolean(call), call ? `${call.block.name}(${String(call.block.arguments).slice(0, 100)})` : '没有 tool-call');
  if (!call) {
    console.log('\n模型没发起工具调用，后面两轮回灌跳过。');
    console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
    process.exit(failures ? 1 : 0);
  }

  const callId = String(call.block.id);
  const callName = String(call.block.name);
  const callArgs = String(call.block.arguments);
  check('tool-call.arguments 是 JSON 字符串', typeof call.block.arguments === 'string');

  // 第 2 轮：assistant(tool_calls) + role:'tool' 结果回灌
  const roundMessages = [
    { role: 'user', content: [{ type: 'text', text: '成都天气怎么样？必须调用 get_weather 工具，参数 city="成都"。' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: callName, arguments: callArgs }] },
    { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: '成都：晴，25℃，东南风 2 级' }] },
  ];
  const wire = toWireMessages(roundMessages);
  check('wire 里 assistant 后紧跟 tool', wire.map((item) => item.role).join(',') === 'user,assistant,tool',
    wire.map((item) => item.role).join(','));
  check('wire 里 tool_call_id 对齐', wire[2]?.tool_call_id === callId, String(wire[2]?.tool_call_id));

  let second;
  try {
    second = await collect(adapter.stream({ model: pick.id, messages: roundMessages, tools: [TOOL], maxTokens: 512 }));
  } catch (error) {
    check('工具结果回灌成功（不再 400）', false, String(error?.message || error).slice(0, 300));
    second = null;
  }
  if (second) {
    check('工具结果回灌成功（不再 400）', true);
    check('回灌后模型继续回答', textOf(second).length > 0, textOf(second).slice(0, 80));
    check('回灌后正常收尾', second.some((event) => event.type === 'finish'));
  }

  // 第 3 轮：故意不给工具结果（模拟工具被中断）
  const missingMessages = [
    { role: 'user', content: [{ type: 'text', text: '成都天气怎么样？必须调用 get_weather 工具，参数 city="成都"。' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: callName, arguments: callArgs }] },
  ];
  const missingWire = toWireMessages(missingMessages);
  check('缺失结果时合成占位 tool', missingWire[2]?.role === 'tool' && missingWire[2]?.tool_call_id === callId,
    JSON.stringify(missingWire[2]));

  let third;
  try {
    third = await collect(adapter.stream({ model: pick.id, messages: missingMessages, tools: [TOOL], maxTokens: 512 }));
  } catch (error) {
    check('缺失结果也能继续（占位生效）', false, String(error?.message || error).slice(0, 300));
    third = null;
  }
  if (third) {
    check('缺失结果也能继续（占位生效）', true);
    check('缺失结果后模型有回应', textOf(third).length > 0, textOf(third).slice(0, 80));
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('[roundtrip] 未捕获错误', error);
  process.exit(1);
});
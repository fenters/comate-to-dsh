/**
 * 消息组装（DSH message → OpenAI wire）单元测试。
 *   node _verify/wire-test.mjs
 */
import { toWireMessages, normalizeArgumentsText, collectImageRefs } from '../lib/adapter.mjs';
import { normalizeCatalog } from '../lib/catalog.mjs';

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const roles = (wire) => wire.map((item) => item.role).join(',');

// 1. 基础形状
check('user 文本', JSON.stringify(toWireMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]))
  === JSON.stringify([{ role: 'user', content: 'hi' }]));

check('system 文本', JSON.stringify(toWireMessages([{ role: 'system', content: [{ type: 'text', text: 'sys' }] }]))
  === JSON.stringify([{ role: 'system', content: 'sys' }]));

check('developer → system', toWireMessages([{ role: 'developer', content: [{ type: 'text', text: 'dev' }] }])[0]?.role === 'system');

check('image 块（旧 dataUrl 形状兜底）', (() => {
  const wire = toWireMessages([{ role: 'user', content: [
    { type: 'text', text: '看图' },
    { type: 'image', dataUrl: 'data:image/png;base64,AAA' },
  ] }]);
  return Array.isArray(wire[0]?.content) && wire[0].content.some((part) => part.type === 'image_url');
})());

// DSH 的 ImageBlock 只带 attachment 引用，字节由宿主读出来传进来。
const DSH_IMAGE = { type: 'image', attachment: { attachmentId: 'sha256:abc123def456', mediaType: 'image/png', bytes: 9, width: 1, height: 1 } };
const imageData = new Map([['sha256:abc123def456', 'data:image/png;base64,QUJD']]);
check('image 块（DSH attachment 形状）', (() => {
  const wire = toWireMessages([{ role: 'user', content: [{ type: 'text', text: '看图' }, DSH_IMAGE] }], imageData);
  return Array.isArray(wire[0]?.content)
    && wire[0].content.some((part) => part.type === 'image_url' && part.image_url?.url === 'data:image/png;base64,QUJD');
})());
check('读不到字节的图片降级成占位文本而不是被丢弃', (() => {
  const wire = toWireMessages([{ role: 'user', content: [{ type: 'text', text: '看图' }, DSH_IMAGE] }], null);
  return typeof wire[0]?.content === 'string' && /未能读取/.test(wire[0].content);
})());
check('collectImageRefs 能找到嵌套在 tool-result 里的图片', (() => {
  const refs = collectImageRefs([{ type: 'tool-result', content: [DSH_IMAGE] }]);
  return refs.has('sha256:abc123def456');
})());

// 1.5 工具结果里夹带的图片：role:'tool' 放不了 image_url，另起一条 user 消息。
const toolImageMessages = [
  { role: 'assistant', content: [{ type: 'tool-call', id: 'shot_1', name: 'read_image', arguments: '{"file_path":"/tmp/x.png"}' }] },
  { role: 'user', content: [{
    type: 'tool-result', toolCallId: 'shot_1', isError: false,
    content: [{ type: 'text', text: 'image/png 800x600' }, DSH_IMAGE],
  }] },
];
const toolImageWire = toWireMessages(toolImageMessages, imageData);
check('工具结果里的图片不塞进 role:tool（会被上游 400）', (() => {
  const toolMsg = toolImageWire.find((item) => item.role === 'tool');
  return typeof toolMsg?.content === 'string' && !toolMsg.content.includes('image_url');
})(), 'tool.content 是纯文本');
check('工具结果里的图片补一条 user 消息带 image_url', (() => {
  const index = toolImageWire.findIndex((item) => item.role === 'tool');
  const next = toolImageWire[index + 1];
  return next?.role === 'user'
    && Array.isArray(next.content)
    && next.content.some((part) => part.type === 'image_url' && part.image_url?.url === 'data:image/png;base64,QUJD');
})(), 'tool 之后紧跟 user，里面是 image_url');
check('工具图片消息带说明文字（模型知道图片来源）', (() => {
  const next = toolImageWire[toolImageWire.findIndex((item) => item.role === 'tool') + 1];
  return Array.isArray(next?.content)
    && next.content.some((part) => part.type === 'text' && /工具结果里附带/.test(part.text));
})());
check('工具结果图片读不到时降级成占位文本且不发空 user 消息', (() => {
  const wire = toWireMessages(toolImageMessages, null);
  const body = wire.find((item) => item.role === 'tool')?.content;
  return typeof body === 'string' && /未能读取/.test(body) && !wire.some((item) => Array.isArray(item.content));
})());
check('连续多个工具结果的图片合并成一条 user 消息', (() => {
  const wire = toWireMessages([
    { role: 'assistant', content: [
      { type: 'tool-call', id: 'a1', name: 'read_image', arguments: '{}' },
      { type: 'tool-call', id: 'a2', name: 'read_image', arguments: '{}' },
    ] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'a1', content: [DSH_IMAGE] }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'a2', content: [DSH_IMAGE] }] },
  ], imageData);
  const imageUsers = wire.filter((item) => Array.isArray(item.content)
    && item.content.some((part) => part.type === 'image_url'));
  return wire.filter((item) => item.role === 'tool').length === 2 && imageUsers.length === 1;
})());
check('工具图片不插到后续用户消息后面（时序不倒置）', (() => {
  const wire = toWireMessages([
    ...toolImageMessages,
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ], imageData);
  const imageIndex = wire.findIndex((item) => Array.isArray(item.content));
  const textIndex = wire.findIndex((item) => typeof item.content === 'string' && item.content === '继续');
  return imageIndex > -1 && textIndex > -1 && imageIndex < textIndex;
})());

// 2. assistant + tool_calls
const assistantCall = {
  role: 'assistant',
  content: [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"成都"}' }],
};
const assistantWire = toWireMessages([assistantCall])[0];
check('assistant.tool_calls 形状', assistantWire?.role === 'assistant'
  && assistantWire.content === null
  && assistantWire.tool_calls?.[0]?.id === 'call_1'
  && assistantWire.tool_calls[0].type === 'function'
  && assistantWire.tool_calls[0].function?.name === 'get_weather');
check('arguments 保持字符串', typeof assistantWire?.tool_calls?.[0]?.function?.arguments === 'string');
check('arguments 对象归一化', normalizeArgumentsText({ city: '成都' }) === '{"city":"成都"}');
check('arguments 非法字符串归一化', normalizeArgumentsText('not json') === '{}');

// 3. tool 结果紧跟 assistant
const withResult = toWireMessages([
  { role: 'user', content: [{ type: 'text', text: '成都天气？' }] },
  assistantCall,
  { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '晴，25℃' }] },
]);
check('role 顺序 user,assistant,tool', roles(withResult) === 'user,assistant,tool', roles(withResult));
check('tool_call_id 对齐', withResult[2]?.tool_call_id === 'call_1', JSON.stringify(withResult[2]));
check('tool 内容取自 text 块', withResult[2]?.content === '晴，25℃');

// source.callId 兜底
const viaSource = toWireMessages([
  assistantCall,
  { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'text', text: 'ok' }] },
]);
check('toolCallId 从 source.callId 兜底', viaSource[1]?.tool_call_id === 'call_1');

// 4. 结果缺失 → 合成占位
const missing = toWireMessages([assistantCall]);
check('缺失结果合成占位', missing.length === 2 && missing[1].role === 'tool' && missing[1].tool_call_id === 'call_1', JSON.stringify(missing));
check('占位有可读文案', /缺失/.test(String(missing[1]?.content)), String(missing[1]?.content));

const beforeUser = toWireMessages([
  assistantCall,
  { role: 'user', content: [{ type: 'text', text: '继续' }] },
]);
check('占位插在下一条消息之前', roles(beforeUser) === 'assistant,tool,user', roles(beforeUser));

// 5. 多工具调用
const twoCalls = {
  role: 'assistant',
  content: [
    { type: 'tool-call', id: 'call_a', name: 'a', arguments: '{}' },
    { type: 'tool-call', id: 'call_b', name: 'b', arguments: '{}' },
  ],
};
const twoResults = toWireMessages([
  twoCalls,
  { role: 'tool', toolCallId: 'call_a', content: [{ type: 'text', text: 'A' }] },
  { role: 'tool', toolCallId: 'call_b', content: [{ type: 'text', text: 'B' }] },
]);
check('两个工具结果都对齐', roles(twoResults) === 'assistant,tool,tool'
  && twoResults[1].tool_call_id === 'call_a'
  && twoResults[2].tool_call_id === 'call_b');
check('不产生多余占位', twoResults.length === 3, String(twoResults.length));

// 6. 旧形状兜底 / 孤立结果
const legacy = toWireMessages([
  assistantCall,
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', text: '旧形状结果' }] },
]);
check('旧 tool-result 块转成 tool 消息', legacy.some((item) => item.role === 'tool' && item.tool_call_id === 'call_1' && item.content === '旧形状结果'));

const orphan = toWireMessages([{ role: 'tool', toolCallId: 'zzz', content: [{ type: 'text', text: '孤儿结果' }] }]);
check('孤立 tool 结果降级成 user', orphan[0]?.role === 'user' && String(orphan[0].content).includes('孤儿结果'));

check('空 tool 结果有兜底文案', (() => {
  const wire = toWireMessages([
    assistantCall,
    { role: 'tool', toolCallId: 'call_1', content: [] },
  ]);
  return wire[1]?.role === 'tool' && String(wire[1].content).length > 0;
})());

// 7. 完整多轮
const multiTurn = toWireMessages([
  { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
  { role: 'user', content: [{ type: 'text', text: '成都天气？' }] },
  assistantCall,
  { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '晴，25℃' }] },
  { role: 'assistant', content: [{ type: 'text', text: '成都晴，25℃。' }] },
  { role: 'user', content: [{ type: 'text', text: '谢谢' }] },
]);
check('多轮顺序正确', roles(multiTurn) === 'system,user,assistant,tool,assistant,user', roles(multiTurn));
check('每条 assistant.tool_calls 都有 tool 应答', (() => {
  let pending = [];
  for (const item of multiTurn) {
    if (item.role === 'assistant' && item.tool_calls?.length) pending = item.tool_calls.map((call) => call.id);
    if (item.role === 'tool') pending = pending.filter((id) => id !== item.tool_call_id);
  }
  return pending.length === 0;
})());

// 8. 模型名字带「· 识图」后缀
const catalog = normalizeCatalog({
  data: { items: [
    { name: '10000001/custom/qwen3.8-max//private', display_name: 'qwen3.8-max', model_source: 'custom', context_window: 131072, llm_types: ['llm-chat', 'llm-multimodal'] },
    { name: '10000001/custom/deepseek-v4-flash//private', display_name: 'deepseek-v4-flash', model_source: 'custom', context_window: 393216, llm_types: ['llm-chat'] },
    { name: '10000001/zhipu/glm-5.3-flash//public', display_name: 'glm-5.3-flash', model_source: 'credits', context_window: 1000000, llm_types: ['llm-chat', 'llm-multimodal'] },
  ] },
});
const vision = catalog.models.find((model) => model.displayName === 'qwen3.8-max');
const plain = catalog.models.find((model) => model.displayName === 'deepseek-v4-flash');
check('识图模型名字带后缀', vision?.label === '企业模型 · qwen3.8-max · 识图', vision?.label);
check('文本模型名字不带后缀', plain?.label === '企业模型 · deepseek-v4-flash', plain?.label);
check('内置识图也带后缀', catalog.models.find((model) => model.displayName === 'glm-5.3-flash')?.label === '内置模型 · glm-5.3-flash · 识图');

const personalCatalog = normalizeCatalog({ data: { items: [] } }, [
  { providerKey: 'TESTP', modelId: 'Qwen-VL', displayName: 'Qwen-VL', multimodal: true, contextWindow: 131072 },
]);
check('个人识图模型名字带后缀', personalCatalog.models[0]?.label === '个人模型 · Qwen-VL · 识图', personalCatalog.models[0]?.label);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
/**
 * 真机识图测试：真实 PNG 经 adapter 图片通道发给两个独立模型，都读出同一串随机编码才算真看见。
 *   node _verify/real-image-test.mjs
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ComateAdapter } from '../lib/adapter.mjs';
import { resolveCredentials } from '../lib/auth.mjs';
import { ComateClient } from '../lib/client.mjs';
import { normalizeCatalog } from '../lib/catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'vision-probe.png');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const client = new ComateClient({
  getCredentials: () => resolveCredentials({ force: false }),
  log: () => {},
});
const adapter = new ComateAdapter({ provider: 'comate', displayName: 'WPS Comate', client, log: () => {} });
adapter.catalog = normalizeCatalog(await client.listCatalog());

// 算出真实的 attachmentId（DSH 的 attachment 是内容寻址的）。
const original = await readFile(FIXTURE);
const hex = createHash('sha256').update(original).digest('hex');
const REAL_REF = {
  attachmentId: `sha256:${hex}`,
  mediaType: 'image/png',
  bytes: original.byteLength,
  width: 768,
  height: 512,
  name: 'vision-probe.png',
};

// 等价于 index.js 的 resolveImages；只认夹具这一张，其它模拟「读不到」。
adapter.resolveImages = async (refs) => {
  const out = new Map();
  for (const [attachmentId] of refs) {
    if (attachmentId === REAL_REF.attachmentId) {
      out.set(attachmentId, `data:${REAL_REF.mediaType};base64,${original.toString('base64')}`);
    }
  }
  return out;
};

/** 收集一次请求的流式事件。chunk 类型是 `text-delta`/`reasoning-delta`，不是 `text`。 */
async function ask({ model, imageBlock, prompt, maxTokens = 4096 }) {
  const content = [{ type: 'text', text: prompt }];
  if (imageBlock) content.push(imageBlock);
  const events = [];
  for await (const chunk of adapter.stream({
    provider: 'comate',
    model,
    messages: [{ role: 'user', content }],
    maxTokens,
    system: '你是图片信息提取助手。只报告你真正在像素里看到的内容，不要猜测或补充背景。',
  })) {
    events.push(chunk);
  }
  return {
    text: events.filter((e) => e.type === 'text-delta').map((e) => e.text).join(''),
    reasoning: events.filter((e) => e.type === 'reasoning-delta').map((e) => e.text).join(''),
    finish: events.find((e) => e.type === 'finish'),
    usage: events.find((e) => e.type === 'usage'),
  };
}

const visionModels = adapter.catalog.models.filter((m) => m.multimodal);
console.log(`识图模型：${visionModels.map((m) => m.displayName).join(' / ')}\n`);

if (visionModels.length < 2) {
  console.log('FAIL  至少需要 2 个识图模型才能做交叉验证');
  process.exit(1);
}

// 1. 字节保真
{
  const map = await adapter.resolveImages(new Map([[REAL_REF.attachmentId, REAL_REF]]));
  const url = map.get(REAL_REF.attachmentId);
  const roundTrip = Buffer.from(String(url).split(',')[1], 'base64');
  check(
    '真实 PNG → base64 data URL → 逐字节还原',
    String(url).startsWith('data:image/png;base64,') && roundTrip.equals(original),
    `${roundTrip.length} bytes, sha256 ${hex.slice(0, 12)}…`,
  );
}

// 2. 真模型看图
const PROMPT = '这张图片里有哪些文字？请逐行按原样抄下来，包括编码、数字和金额。';

for (const model of visionModels.slice(0, 2)) {
  const { text, finish, usage } = await ask({
    model: model.id,
    imageBlock: { type: 'image', attachment: REAL_REF },
    prompt: PROMPT,
  });
  check(
    `${model.displayName} 读到了图片内容`,
    text.trim().length > 20 && finish?.reason?.kind === 'stop',
    `${text.trim().slice(0, 100).replace(/\s+/g, ' ')}… | ${text.length} 字 | ${JSON.stringify(usage?.usage)}`,
  );
}

// 3. 交叉验证：两个独立模型必须读出同一串罕见编码
{
  const picks = [];
  for (const model of visionModels.slice(0, 2)) {
    const { text } = await ask({
      model: model.id,
      imageBlock: { type: 'image', attachment: REAL_REF },
      prompt: '图片右上角的标签里写着什么？只回答那个编码，不要其他内容。',
    });
    const match = /VR-CODE[：:]\s*([0-9A-Fa-f]{6,})/.exec(text) || /([0-9A-F]{10,})/.exec(text);
    picks.push({ model: model.displayName, code: match?.[1] ?? null });
  }
  const codes = picks.map((p) => p.code).filter(Boolean);
  check(
    '两个独立识图模型读出同一串编码（像素真的到了模型）',
    codes.length === 2 && codes[0] === codes[1],
    picks.map((p) => `${p.model}=${p.code}`).join(' | '),
  );
}

// 4. 对照：不给图片时必须读不出来
{
  const { text } = await ask({ model: visionModels[0].id, imageBlock: null, prompt: PROMPT });
  check(
    '无图片时读不到那串编码（对照组）',
    !/VR-CODE|2E3203BA657C|Router Bench/i.test(text),
    text.trim().slice(0, 80).replace(/\s+/g, ' ') || '(空)',
  );
}

// 5. 坏引用：降级为占位文本，整轮不失败
{
  const { text, finish } = await ask({
    model: visionModels[0].id,
    imageBlock: { type: 'image', attachment: { ...REAL_REF, attachmentId: `sha256:${'0'.repeat(64)}` } },
    prompt: '描述这张图片。',
  });
  check(
    '附件读不到时降级为占位文本（不炸整轮）',
    finish?.reason?.kind === 'stop' && text.length > 0,
    `${text.trim().slice(0, 60).replace(/\s+/g, ' ')}…`,
  );
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);

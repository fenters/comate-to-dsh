/**
 * 真机多步任务：连续多轮 assistant(tool_calls) → role:'tool' 回灌。
 *   node _verify/agent-loop.mjs [模型id ...]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { resolveCredentials } from '../lib/auth.mjs';
import { ComateClient } from '../lib/client.mjs';
import { ComateAdapter } from '../lib/adapter.mjs';
import { log } from '../lib/log.mjs';
import { DEFAULTS, PACKAGE_ROOT } from '../lib/config.mjs';

const ROOT = resolve(PACKAGE_ROOT);
const MAX_STEPS = 14;
const MAX_READ_LINES = 200;
const MAX_READ_CHARS = 24_000;
const MAX_MATCHES = 40;

const TOOL_DECLS = [
  {
    name: 'list_dir',
    description: '列出插件目录下某个子目录里的文件与大小（只读）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对插件根目录的路径，例如 lib 或 dsh-plugin/lib' } },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取插件目录下的文本文件（只读，最多返回 200 行）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对插件根目录的文件路径' },
        offset: { type: 'number', description: '起始行号（1 开始），默认 1' },
        limit: { type: 'number', description: '读取行数，默认 200' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep_text',
    description: '在插件目录里按正则搜索文本（只读）',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '限定搜索的相对目录，默认整个插件' },
      },
      required: ['pattern'],
    },
  },
];

const TASK = `这是一个只读代码分析任务，禁止修改任何文件。请分析 DSH 插件目录 ${ROOT}：
1) 用 list_dir 分别列出 lib 和 dsh-plugin/lib 两个目录里的文件及大小；
2) 用 grep_text 在 lib 里搜索 toWireMessages，并 read_file 读取该函数及其上下文，说明它如何组装 tool_calls 与工具结果；
3) read_file 读取 dsh-plugin/lib/index.js 的前 120 行，说明插件的注册流程；
4) 最后输出一份简洁的中文报告：两个目录各自的作用、消息组装的关键函数名、插件注册流程的关键步骤。
请实际调用工具取证，不要凭空猜测。`;

function safeResolve(input) {
  const abs = resolve(ROOT, String(input || '.'));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) {
    throw new Error(`拒绝访问插件目录之外的路径：${input}`);
  }
  return abs;
}

function rel(abs) {
  return relative(ROOT, abs).split(sep).join('/') || '.';
}

function listDir(path) {
  const abs = safeResolve(path);
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
    .slice(0, 200)
    .map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      try {
        return `${entry.name}  ${statSync(join(abs, entry.name)).size}B`;
      } catch {
        return entry.name;
      }
    });
  return entries.length ? entries.join('\n') : '(空目录)';
}

function readFileTool(path, offset, limit) {
  const abs = safeResolve(path);
  const stat = statSync(abs);
  if (stat.isDirectory()) throw new Error(`${path} 是目录，请用 list_dir`);
  const text = readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  const start = Math.max(0, (Number(offset) || 1) - 1);
  const count = Math.min(Number(limit) || MAX_READ_LINES, MAX_READ_LINES);
  let body = lines.slice(start, start + count).join('\n');
  if (body.length > MAX_READ_CHARS) body = body.slice(0, MAX_READ_CHARS) + '\n...[已截断]';
  return `# ${path}（共 ${lines.length} 行，显示第 ${start + 1}–${Math.min(start + count, lines.length)} 行）\n${body}`;
}

function grepText(pattern, path) {
  const abs = safeResolve(path || '.');
  let regex;
  try {
    regex = new RegExp(String(pattern), 'g');
  } catch (error) {
    throw new Error(`正则不合法：${String(error?.message || error)}`);
  }
  const matches = [];
  const walk = (dir) => {
    if (matches.length >= MAX_MATCHES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (matches.length >= MAX_MATCHES) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      let text;
      try {
        if (statSync(full).size > 300_000) continue;
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, index) => {
        if (matches.length >= MAX_MATCHES) return;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          matches.push(`${rel(full)}:${index + 1}: ${line.trim().slice(0, 160)}`);
        }
      });
    }
  };
  walk(abs);
  return matches.length ? matches.join('\n') : '(没有匹配)';
}

const TOOL_IMPL = {
  list_dir: ({ path }) => listDir(path),
  read_file: ({ path, offset, limit }) => readFileTool(path, offset, limit),
  grep_text: ({ pattern, path }) => grepText(pattern, path),
};

function blocksOf(events) {
  return events.filter((event) => event.type === 'block-end').map((event) => event.block);
}

async function runOne(adapter, modelId) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: TASK }] }];
  const steps = [];
  const toolNames = [];
  let finalText = '';
  let error = null;

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    let events = [];
    try {
      for await (const event of adapter.stream({
        model: modelId,
        messages,
        tools: TOOL_DECLS,
        maxTokens: 4096,
        streamIdleTimeoutMs: 90_000,
      })) {
        events.push(event);
      }
    } catch (err) {
      error = err;
      steps.push({ step, ok: false, error: String(err?.message || err) });
      break;
    }

    const blocks = blocksOf(events);
    const finish = events.find((event) => event.type === 'finish');
    const usageChunk = events.find((event) => event.type === 'usage');
    const calls = blocks.filter((block) => block.type === 'tool-call');
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
    // usage 走独立 chunk。
    const usage = usageChunk?.usage || {};
    steps.push({
      step,
      ok: true,
      reason: finish?.reason?.kind,
      calls: calls.length,
      textChars: text.length,
      tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
    });

    const assistantContent = blocks
      .filter((block) => block.type === 'text' || block.type === 'tool-call')
      .map((block) => (block.type === 'text' ? { type: 'text', text: block.text } : { ...block }));
    if (assistantContent.length) messages.push({ role: 'assistant', content: assistantContent });

    if (!calls.length) {
      finalText = text;
      break;
    }

    for (const call of calls) {
      toolNames.push(call.name);
      const impl = TOOL_IMPL[call.name];
      let result;
      try {
        if (!impl) throw new Error(`未知工具：${call.name}`);
        const args = JSON.parse(call.arguments || '{}');
        result = impl(args);
      } catch (err) {
        result = `工具执行失败：${String(err?.message || err)}`;
      }
      messages.push({ role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: result }] });
    }
  }

  const toolCallSteps = steps.filter((step) => (step.calls || 0) > 0).length;
  const ok = !error && finalText.trim().length > 0 && toolCallSteps >= 2;
  return { modelId, ok, error, steps, toolNames, finalText, toolCallSteps };
}

function printResult(result) {
  console.log(`\n===== ${result.modelId} =====`);
  for (const step of result.steps) {
    if (!step.ok) {
      console.log(`  第 ${step.step} 步 ✗ 失败：${step.error}`);
      continue;
    }
    console.log(`  第 ${step.step} 步：finish=${step.reason} 工具调用=${step.calls} 文本=${step.textChars} 字 tokens=${step.tokens}`);
  }
  console.log(`  工具调用序列：${result.toolNames.join(' → ') || '(无)'}`);
  console.log(`  多轮工具步数：${result.toolCallSteps}`);
  console.log(`  最终回答（前 500 字）：\n${result.finalText.slice(0, 500).replace(/\n/g, '\n    ')}`);
  console.log(`  结论：${result.ok ? 'PASS ✅' : 'FAIL ❌'}`);
}

/** 不带参数时自动挑企业模型 + 内置模型各一个纯文本的。 */
function pickDefaultModels(catalog) {
  const usable = (model) => model && !model.multimodal;
  const enterprise = catalog.models.find((model) => model.group === 'enterprise' && usable(model));
  const builtin = catalog.models.find((model) => model.group === 'builtin' && usable(model));
  return [enterprise, builtin].filter(Boolean).map((model) => model.id);
}

const main = async () => {
  const requested = process.argv.slice(2);
  const credential = await resolveCredentials({ force: true, allowLaunch: true, validate: true });
  if (!credential?.sid) throw new Error(`没有登录态：${credential?.error || '未知错误'}`);
  console.log(`登录态：${credential.source}（${credential.hint || ''}）`);

  const client = new ComateClient({ getCredentials: async () => credential, log });
  const adapter = new ComateAdapter({
    provider: 'comate',
    displayName: 'WPS Comate',
    client,
    log: () => {},
    defaults: DEFAULTS,
  });
  const catalog = await adapter.refreshCatalog();
  console.log(`目录：${catalog.models.length} 个模型`);

  const models = requested.length ? requested : pickDefaultModels(catalog);
  if (!models.length) {
    console.log('目录里没有可用的纯文本模型，无法执行多步工具测试');
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const modelId of models) {
    const hit = catalog.models.find((model) => model.id === modelId);
    if (!hit) {
      console.log(`\n===== ${modelId} =====\n  跳过：目录里没有这个模型`);
      failed += 1;
      continue;
    }
    console.log(`\n>>> 开始测试：${hit.label}（${modelId}）`);
    const result = await runOne(adapter, modelId);
    printResult(result);
    if (!result.ok) failed += 1;
  }

  if (failed) {
    console.log(`\n有 ${failed} 个模型失败`);
    process.exitCode = 1;
  } else {
    console.log('\n全部通过');
  }
};

main().catch((error) => {
  console.error('运行失败：', error);
  process.exitCode = 1;
});
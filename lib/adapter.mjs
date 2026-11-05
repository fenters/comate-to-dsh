/** ComateAdapter：把 Comate 的 OpenAI 兼容 SSE 翻译成 DSH 的流事件协议。 */
import { AuthError, ComateError, codeForStatus, retryAfterOf } from './client.mjs';
import { DEFAULTS } from './config.mjs';
import { normalizeCatalog } from './catalog.mjs';
import { listPersonalProvidersCached, resolvePersonalModel } from './personal.mjs';

export const CONTEXT_FALLBACK = DEFAULTS.fallbackContextWindow;

const nowId = (() => {
  let seq = 0;
  return (prefix) => `${prefix}_${Date.now().toString(36)}${++seq}`;
})();

/** 思维链可能放在 reasoning_content / reasoning 里。 */
function pickReasoning(delta) {
  if (typeof delta?.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta?.reasoning === 'string') return delta.reasoning;
  return '';
}

/** 取纯文本（tool 结果 / system 消息用）。 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.join('');
}

/** 工具结果的 call id，兼容 source.callId。 */
function toolCallIdOf(message) {
  return String(message?.toolCallId ?? message?.source?.callId ?? '');
}

/** 旧形状兜底：tool-result 块。 */
function toolResultText(part) {
  if (typeof part?.text === 'string') return part.text;
  if (typeof part?.output === 'string') return part.output;
  if (part?.content !== undefined) return contentText(part.content);
  try {
    return JSON.stringify(part?.output ?? part?.result ?? '');
  } catch {
    return '';
  }
}

const MISSING_TOOL_RESULT = '[工具结果缺失：该工具调用被中断或取消]';
const EMPTY_TOOL_RESULT = '（工具没有输出）';
/** 工具结果里的图片不能放进 role:'tool'（content 只能是字符串），攒起来补一条 user 消息。 */
const TOOL_RESULT_IMAGE_TEXT = '以下是工具结果里附带的图片：';
const ROLE_MAP = { assistant: 'assistant', system: 'system', developer: 'system', user: 'user' };

/** 收集消息里所有图片块的附件引用（含 tool-result 里的嵌套图片）。 */
export function collectImageRefs(blocks, out = new Map()) {
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image' && block.attachment?.attachmentId) {
      out.set(block.attachment.attachmentId, block.attachment);
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      collectImageRefs(block.content, out);
    }
  }
  return out;
}

function splitContent(content, imageData) {
  const parts = Array.isArray(content)
    ? content
    : [{ type: 'text', text: String(content ?? '') }];
  const texts = [];
  const images = [];
  const toolCalls = [];
  const toolResults = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      if (typeof part.text === 'string' && part.text) texts.push(part.text);
    } else if (part.type === 'image') {
      const attachmentId = part.attachment?.attachmentId;
      const resolved = attachmentId ? imageData?.get(attachmentId) : undefined;
      if (resolved) images.push({ type: 'image_url', image_url: { url: resolved } });
      else if (part.attachment?.attachmentId) images.push({ missing: part.attachment.attachmentId });
      else {
        // 旧形状兜底。
        const url = part.dataUrl || part.url;
        if (url) images.push({ type: 'image_url', image_url: { url } });
      }
    } else if (part.type === 'tool-call' && part.name) {
      toolCalls.push({
        id: String(part.id || ''),
        type: 'function',
        function: { name: String(part.name), arguments: normalizeArgumentsText(part.arguments) },
      });
    } else if (part.type === 'tool-result') {
      // 工具结果里的文本走 role:'tool'，图片抽出来攒到后续 user 消息。
      const nested = splitContent(part.content, imageData);
      const nestedMissing = nested.images.filter((item) => item?.missing).map((item) => item.missing);
      const nestedUsable = nested.images.filter((item) => !item?.missing);
      const text = toolResultText(part);
      const placeholder = nestedMissing.length
        ? `\n${nestedMissing.map((id) => `[图片 ${String(id).slice(0, 20)}… 未能读取]`).join('\n')}`
        : '';
      toolResults.push({
        id: String(part.toolCallId || part.id || ''),
        text: text + placeholder,
        images: nestedUsable,
      });
    }
  }
  return { texts, images, toolCalls, toolResults };
}

/** DSH 消息 → OpenAI wire 消息。工具结果必须紧跟 assistant(tool_calls)，否则上游 400。 */
export function toWireMessages(messages, imageData = null) {
  const wire = [];
  let pending = [];
  let pendingToolImages = [];

  const flushPending = () => {
    for (const slot of pending) {
      if (slot.resolved) continue;
      slot.resolved = true;
      wire.push({ role: 'tool', tool_call_id: slot.id, content: MISSING_TOOL_RESULT });
    }
    pending = [];
  };

  /** 图片攒成一条 role:'user' 消息发出（与 DSH 原生 serializeMessagesWithImages 一致）。 */
  const flushToolImages = () => {
    if (!pendingToolImages.length) return;
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    });
    pendingToolImages = [];
  };

  const pushToolResult = (id, text, images = []) => {
    const body = text && text.trim() ? text : EMPTY_TOOL_RESULT;
    const slot = pending.find((item) => item.id === id && !item.resolved);
    if (slot) {
      slot.resolved = true;
      wire.push({ role: 'tool', tool_call_id: id, content: body });
      pendingToolImages.push(...images);
      return;
    }
    // 找不到对应 tool_call 的孤立结果降级成 user 文本，避免上游 400。
    if (id) wire.push({ role: 'user', content: `[工具结果 ${id}] ${body}` });
  };

  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '');
    const { texts, images, toolCalls, toolResults } = splitContent(message.content, imageData);
    // 读不到字节的图片退化成占位文本，别留空 content。
    const missing = images.filter((item) => item?.missing).map((item) => item.missing);
    const usable = images.filter((item) => !item?.missing);
    if (missing.length) texts.push(missing.map((id) => `[图片 ${String(id).slice(0, 20)}… 未能读取]`).join('\n'));

    if (role === 'tool') {
      const id = toolCallIdOf(message);
      const text = texts.length ? texts.join('') : contentText(message.content);
      if (id) pushToolResult(id, text, usable);
      else if (text) wire.push({ role: 'user', content: `[工具结果] ${text}` });
      continue;
    }

    if (role === 'assistant') {
      flushPending();
      // 新 assistant 消息前先把攒的图片发掉，保持时序。
      flushToolImages();
      if (toolCalls.length) {
        wire.push({ role: 'assistant', content: texts.join('') || null, tool_calls: toolCalls });
        pending = toolCalls.map((call) => ({ id: call.id, resolved: false }));
      } else if (texts.length || usable.length) {
        wire.push(usable.length
          ? { role: 'assistant', content: [...texts.map((text) => ({ type: 'text', text })), ...usable] }
          : { role: 'assistant', content: texts.join('') });
      }
      // 旧形状兜底：assistant 消息里夹着 tool-result 块
      for (const result of toolResults) pushToolResult(result.id, result.text, result.images);
      continue;
    }

    // user / system / developer
    const wireRole = ROLE_MAP[role] || 'user';
    // 旧形状兜底：消息里夹着的 tool-result 块先回填，再补剩余占位。
    for (const result of toolResults) pushToolResult(result.id, result.text, result.images);
    flushPending();
    // 这条消息本身还有内容时先发工具图片，避免图片排到新内容后面。
    if (texts.length || usable.length) flushToolImages();
    if (usable.length) {
      wire.push({ role: wireRole, content: [...texts.map((text) => ({ type: 'text', text })), ...usable] });
    } else if (texts.length) {
      wire.push({ role: wireRole, content: texts.join('') });
    }
  }

  flushPending();
  flushToolImages();
  return wire;
}

/** @deprecated 仅保留给旧调用方，新代码用 {@link toWireMessages}。 */
export function appendToolResults(wire, messages) {
  for (const message of messages || []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== 'tool-result') continue;
      wire.push({
        role: 'tool',
        tool_call_id: String(part.toolCallId || part.id || ''),
        content: toolResultText(part),
      });
    }
  }
  return wire;
}

/** DSH 的 tool 声明 → OpenAI wire 形状。 */
export function toWireTools(tools) {
  const wire = [];
  for (const tool of tools || []) {
    if (!tool) continue;
    if (tool.type === 'function' && tool.function?.name) {
      wire.push(tool);
      continue;
    }
    if (tool.deferLoading === true) continue;
    const name = String(tool.name || '').trim();
    if (!name) continue;
    const parameters = tool.parameters && typeof tool.parameters === 'object'
      ? tool.parameters
      : { type: 'object', properties: {} };
    wire.push({
      type: 'function',
      function: {
        name,
        ...(tool.description ? { description: String(tool.description) } : {}),
        parameters,
      },
    });
  }
  return wire;
}

/** 任何形状的 arguments 都归一化成合法 JSON 文本。 */
export function normalizeArgumentsText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return '{}';
    }
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '{}';
    }
  }
  return '{}';
}

function mapFinishReason(reason, sawToolCall) {
  // DSH 的 FinishReason 是对象 {kind}，不是字符串。
  if (sawToolCall) return { kind: 'tool-calls' };
  switch (String(reason || '').toLowerCase()) {
    case 'length':
      return { kind: 'max-tokens' };
    case 'tool_calls':
    case 'tool-call':
      return { kind: 'tool-calls' };
    case 'content_filter':
      return {
        kind: 'error',
        failure: { message: '上游以 content_filter 结束了响应', code: 'CONTENT_FILTER' },
      };
    case 'stop':
    default:
      return { kind: 'stop' };
  }
}

function mapUsage(raw) {
  const input = Number(raw?.prompt_tokens || 0);
  const output = Number(raw?.completion_tokens || 0);
  const reasoning = Number(raw?.completion_tokens_details?.reasoning_tokens);
  const cacheRead = Number(raw?.prompt_tokens_details?.cached_tokens);
  // TokenUsage 三段互斥：inputTokens 只算未命中缓存的输入。
  const cached = Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** 单帧翻译器：一行 SSE → 0..n 个 DSH 流事件。 */
export class StreamTranslator {
  constructor() {
    this.nextIndex = 0;
    this.text = null;
    this.reasoning = null;
    this.tools = new Map();
    this.order = [];
    this.usage = null;
    this.finishReason = undefined;
    this.sawToolCall = false;
    this.error = null;
    this.done = false;
    this.idPrefix = nowId('call');
  }

  get sawContent() {
    return this.text !== null || this.reasoning !== null || this.sawToolCall;
  }

  pushLine(line) {
    const out = [];
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return out;
    const body = trimmed.slice(5).trim();
    if (!body) return out;
    if (body === '[DONE]') {
      this.done = true;
      return out;
    }
    let frame;
    try {
      frame = JSON.parse(body);
    } catch {
      return out;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return out;

    if (frame.usage) this.usage = frame.usage;
    if (frame.error != null || (frame.code != null && frame.code !== 0 && !frame.choices)) {
      const message = frame?.error?.message || frame.message || frame.msg || 'Comate 在流中途报错';
      this.error = { message: String(message) };
      return out;
    }

    const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
    if (!choice) return out;
    const delta = choice.delta || {};

    const reasoningDelta = pickReasoning(delta);
    if (reasoningDelta) {
      if (!this.reasoning) {
        this.reasoning = { index: this.nextIndex++, text: '' };
        this.order.push({ kind: 'reasoning', index: this.reasoning.index });
        out.push({ type: 'block-start', index: this.reasoning.index, blockType: 'reasoning' });
      }
      this.reasoning.text += reasoningDelta;
      out.push({ type: 'reasoning-delta', index: this.reasoning.index, text: reasoningDelta });
    }

    if (typeof delta.content === 'string' && delta.content.length) {
      if (!this.text) {
        this.text = { index: this.nextIndex++, text: '' };
        this.order.push({ kind: 'text', index: this.text.index });
        out.push({ type: 'block-start', index: this.text.index, blockType: 'text' });
      }
      this.text.text += delta.content;
      out.push({ type: 'text-delta', index: this.text.index, text: delta.content });
    }

    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const wireIndex = Number.isInteger(call.index) ? call.index : 0;
      let entry = this.tools.get(wireIndex);
      if (!entry) {
        entry = { index: this.nextIndex++, id: '', name: '', args: '' };
        this.tools.set(wireIndex, entry);
        this.sawToolCall = true;
        this.order.push({ kind: 'tool-call', index: entry.index });
        out.push({ type: 'block-start', index: entry.index, blockType: 'tool-call' });
      }
      if (call.id) entry.id = String(call.id);
      if (!entry.id) entry.id = `${this.idPrefix}_${wireIndex}`;
      if (call.function?.name) entry.name += String(call.function.name);
      const argsDelta = call.function?.arguments;
      if (typeof argsDelta === 'string' && argsDelta.length) {
        entry.args += argsDelta;
        out.push({
          type: 'tool-call-delta',
          index: entry.index,
          id: entry.id,
          ...(entry.name ? { name: entry.name } : {}),
          argumentsDelta: argsDelta,
        });
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  finish() {
    const out = [];
    for (const { kind, index } of this.order) {
      if (kind === 'text' && this.text) {
        out.push({ type: 'block-end', index, block: { type: 'text', text: this.text.text } });
      } else if (kind === 'reasoning' && this.reasoning) {
        out.push({ type: 'block-end', index, block: { type: 'reasoning', text: this.reasoning.text } });
      } else if (kind === 'tool-call') {
        for (const entry of this.tools.values()) {
          if (entry.index !== index) continue;
          if (!entry.name) continue;
          out.push({
            type: 'block-end',
            index,
            block: {
              type: 'tool-call',
              id: entry.id,
              name: entry.name,
              // 必须是合法 JSON 字符串，写成对象会让会话无法重放。
              arguments: normalizeArgumentsText(entry.args),
            },
          });
        }
      }
    }
    return out;
  }
}

export class ComateAdapter {
  /** 思考档位：只声明实测不报错的 off/low/high（max 与 medium 部分模型会报错）。 */
  static REASONING_EFFORTS = [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ];

  constructor({ provider, displayName, client, log = () => {}, defaults = {}, catalog = null, resolveImages = null }) {
    this.provider = provider;
    this.displayName = displayName || 'WPS Comate';
    this.client = client;
    this.log = log;
    this.defaults = defaults;
    this.catalog = catalog || { at: 0, models: [], counts: { enterprise: 0, builtin: 0 } };
    this.catalogError = '';
    this.refreshing = null;
    /** 由 index.js 注入：按 attachmentId 读图片字节并转 data URL。 */
    this.resolveImages = resolveImages;
  }

  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  providerRetryPolicy() {
    // 退避三件套必须嵌在 backoff 里，放顶层会被 validateKeys 拒。
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE'],
      backoff: { initialDelayMs: 600, maxDelayMs: 30_000, jitterRatio: 0.2 },
    };
  }

  /** 本路由不声明图片定价，返回 undefined 让调用方退回中性估算。 */
  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  /** 不做图片缩放，原样返回尺寸。 */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  /** 拉一次目录（并发去重）。云端失败时保留上一次的云端模型，只刷新个人模型。 */
  async refreshCatalog() {    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const personal = (() => {
        try {
          return listPersonalProvidersCached();
        } catch {
          return [];
        }
      })();
      const previous = this.catalog.models;
      let body = null;
      let cloudError = null;
      try {
        body = await this.client.listCatalog();
      } catch (error) {
        cloudError = error;
      }
      this.catalog = normalizeCatalog(body, personal, previous);
      this.catalogError = cloudError ? String(cloudError?.message || cloudError) : '';
      if (cloudError && !body && !previous.length && !personal.length) throw cloudError;
      return this.catalog;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async ensureCatalog() {
    if (this.catalog.models.length) return this.catalog;
    return this.refreshCatalog();
  }

  /** 模型能力声明：识图模型给 ['text','image']，其余 ['text']（DSH 会替换成占位文本）。 */
  static modalitiesFor(model) {
    return model?.multimodal ? ['text', 'image'] : ['text'];
  }

  /** 列表永远不抛错：DSH 启动时调它，抛错会让 provider 从选择器里消失。 */
  async listModels(provider = this.provider) {
    try {
      if (!this.catalog.models.length) await this.ensureCatalog().catch(() => {});
    } catch {
      /* ignore */
    }
    return this.catalog.models.map((model) => ({
      provider,
      id: model.id,
      name: model.label,
      description: model.description || undefined,
      contextWindow: model.contextWindow || CONTEXT_FALLBACK,
      maxOutputTokens: model.maxOutputTokens || this.defaults.maxOutputTokens || DEFAULTS.fallbackMaxOutputTokens,
      inputModalities: ComateAdapter.modalitiesFor(model),
    }));
  }

  async resolveModel(provider, model) {
    let hit = this.catalog.models.find((item) => item.id === model);
    if (!hit) {
      try {
        await this.ensureCatalog();
      } catch {
        /* ignore */
      }
      hit = this.catalog.models.find((item) => item.id === model);
    }
    return {
      provider,
      id: model,
      name: hit?.label || model,
      // contextWindow 必须嵌在 context 里，扁平字段会被丢掉。
      context: { contextWindow: hit?.contextWindow || CONTEXT_FALLBACK },
      ...(hit?.description ? { description: hit.description } : {}),
      defaultMaxTokens: hit?.maxOutputTokens || this.defaults.maxOutputTokens || DEFAULTS.fallbackMaxOutputTokens,
      inputModalities: ComateAdapter.modalitiesFor(hit),
      // 思考档位只能声明在 resolveModel 上（listModels 的模型信息没这个字段）。
      reasoning: { efforts: ComateAdapter.REASONING_EFFORTS },
    };
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  /** 个人模型直连用户自配的 OpenAI 兼容地址。 */
  async _fetchPersonal(personal, body, signal) {
    const url = `${personal.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      accept: 'text/event-stream',
      ...(personal.headers || {}),
    };
    if (personal.apiKey) {
      if (personal.authHeader) headers.authorization = `Bearer ${personal.apiKey}`;
      else headers['api-key'] = personal.apiKey;
    }
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      throw new Error(aborted
        ? '个人模型请求已取消/超时'
        : `个人模型 ${personal.providerKey}/${personal.displayName} 直连失败：${String(error?.message || error)}`);
    }
  }

  /** 主入口：产出 DSH 事件流。 */
  async *stream(options) {
    const modelId = String(options.model || '');
    if (!modelId) throw new Error('comate: 缺少模型 id');

    let imageData = null;
    if (typeof this.resolveImages === 'function') {
      const refs = new Map();
      for (const message of options.messages || []) collectImageRefs(message?.content, refs);
      if (refs.size) {
        try {
          imageData = await this.resolveImages(refs);
        } catch (error) {
          this.log('读取图片附件失败，降级为文本占位', error?.message || String(error));
        }
      }
    }
    const wireMessages = toWireMessages(options.messages, imageData);
    // system 提示词在顶层 options.system，必须显式变成第一条 wire 消息。
    if (typeof options.system === 'string' && options.system.trim()) {
      wireMessages.unshift({ role: 'system', content: options.system });
    }
    // 个人模型直连；其余走 llmproxy。
    const personal = resolvePersonalModel(modelId);
    const body = { model: personal ? personal.wireModel : modelId, messages: wireMessages, stream: true };
    if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) body.max_tokens = options.maxTokens;
    if (Number.isFinite(options.temperature)) body.temperature = options.temperature;
    // 标题生成只有 64 token，不关思考正文永远为空。
    if (options.purpose === 'session-title') body.enable_thinking = false;
    // off 走 enable_thinking:false（比 reasoning_effort:'off' 更彻底），其余透传。
    if (typeof options.reasoningEffort === 'string' && options.reasoningEffort) {
      if (options.reasoningEffort === 'off') body.enable_thinking = false;
      else body.reasoning_effort = options.reasoningEffort;
    }
    if (Array.isArray(options.stop) && options.stop.length) body.stop = options.stop;
    if (Array.isArray(options.tools) && options.tools.length) {
      const tools = toWireTools(options.tools);
      if (tools.length) body.tools = tools;
    }

    const idleMs = Number(options.streamIdleTimeoutMs) || DEFAULTS.streamIdleTimeoutMs;
    const local = new AbortController();
    const linkAbort = () => local.abort(new Error('请求已取消'));
    if (options.signal) {
      if (options.signal.aborted) linkAbort();
      else options.signal.addEventListener('abort', linkAbort, { once: true });
    }
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => local.abort(new Error('Comate 流空闲超时')), idleMs);
    };

    try {
      const res = personal
        ? await this._fetchPersonal(personal, body, local.signal)
        : await this.client.chat({ body, signal: local.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (!personal && (res.status === 401 || res.status === 403)) {
          throw new AuthError(`Comate 鉴权失败（HTTP ${res.status}）`);
        }
        const prefix = personal ? `个人模型 ${personal.providerKey}/${personal.displayName} 直连失败` : 'Comate';
        // 带 code 才能让 llm-retry 命中 retryableCodes。
        throw new ComateError(
          `${prefix} HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
          codeForStatus(res.status),
          { status: res.status, ...retryAfterOf(res) },
        );
      }
      if (!res.body) throw new ComateError('Comate 返回了空的响应体', 'EMPTY_RESPONSE');

      const translator = new StreamTranslator();
      const decoder = new TextDecoder();
      let buffer = '';
      armIdle();

      for await (const chunk of res.body) {
        armIdle();
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          for (const event of translator.pushLine(line)) yield event;
        }
        if (translator.error) throw new ComateError(translator.error.message, 'SERVER');
      }
      if (buffer.trim()) {
        for (const event of translator.pushLine(buffer)) yield event;
      }
      if (translator.error) throw new ComateError(translator.error.message, 'SERVER');

      for (const event of translator.finish()) yield event;
      // usage 必须是独立 chunk，塞进 finish 会被 assembler 丢掉。
      const usage = translator.usage ? mapUsage(translator.usage) : null;
      if (usage) yield { type: 'usage', usage };
      // 停在 stop 但一个块都没开 → 空响应，否则这一轮静默结束。
      const reason = mapFinishReason(translator.finishReason, translator.sawToolCall);
      if (reason.kind === 'stop' && !translator.sawContent) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: '模型返回了空响应（没有任何内容块）', code: 'EMPTY_RESPONSE' },
          },
        };
        return;
      }
      yield { type: 'finish', reason };
    } catch (error) {
      // 错误必须带 DSH 认得出的 code，否则会被降级成 UNKNOWN 而不是「中止」。
      if (error instanceof ComateError || error instanceof AuthError) throw error;
      const aborted = local.signal.aborted;
      const reason = local.signal.reason;
      const message = String(error?.message || reason?.message || error);
      if (aborted) {
        const idle = /空闲超时/.test(message) || /空闲超时/.test(String(reason?.message || ''));
        throw new ComateError(message, idle ? 'TIMEOUT' : 'ABORTED', { cause: error });
      }
      throw new ComateError(message, 'TRANSPORT', { cause: error });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (options.signal) options.signal.removeEventListener('abort', linkAbort);
    }
  }
}
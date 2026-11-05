/** Comate 上游 HTTP 客户端。401/403 抛 AuthError，上层据此重取登录态。 */
import { ENDPOINTS, DEFAULTS } from './config.mjs';
import { comateHeaders } from './auth.mjs';

/** 带 DSH 可识别 code 的错误：必须同时挂 own 的 code 与 failure。 */
export class ComateError extends Error {
  constructor(message, code, { status, providerRetryAfterMs, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ComateError';
    this.code = code;
    this.failure = {
      message,
      code,
      ...(Number.isInteger(status) ? { status } : {}),
      ...(Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0 ? { providerRetryAfterMs } : {}),
    };
  }
}

/** HTTP 状态 → DSH 错误码。 */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status >= 500) return 'SERVER';
  if (status === 400 || status === 422) return 'INVALID_ARGS';
  return 'UNKNOWN';
}

/** 上游业务码（body.code）→ DSH 错误码。 */
export function codeForApiCode(code) {
  const value = String(code ?? '');
  if (value === '401' || value === '403') return 'AUTH';
  if (value === '429') return 'RATE_LIMIT';
  if (/^(-?\d+)$/.test(value) && Number(value) >= 500) return 'SERVER';
  return 'UNKNOWN';
}

/**
 * 读 Retry-After 头（秒数或 HTTP 日期）。
 * DSH 的 llm-retry 会用 `providerRetryAfterMs` 覆盖本地退避，尊重上游限流节奏。
 */
export function retryAfterOf(res) {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return {};
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return { providerRetryAfterMs: Math.round(seconds * 1000) };
  const at = Date.parse(raw);
  if (Number.isFinite(at) && at > Date.now()) return { providerRetryAfterMs: at - Date.now() };
  return {};
}

export class AuthError extends ComateError {
  constructor(message) {
    super(message || 'Comate 登录态失效', 'AUTH');
    this.name = 'AuthError';
  }
}

/**
 * 合并超时与外部 signal。必须合并成一条交给 fetch：
 * 提前摘监听会让 abort 对流式响应失效。
 */
function abortSignalOf(controller, signal) {
  if (!signal) return controller.signal;
  if (typeof AbortSignal?.any === 'function') return AbortSignal.any([controller.signal, signal]);
  const onAbort = () => controller.abort(signal.reason ?? new Error('请求已取消'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

export class ComateClient {
  constructor({ getCredentials, log = () => {}, timeoutMs = DEFAULTS.firstByteTimeoutMs } = {}) {
    this.getCredentials = getCredentials;
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  async credentials({ force = false } = {}) {
    const value = await this.getCredentials({ force });
    if (!value?.sid) throw new AuthError(value?.error || '没有可用的 Comate 登录态');
    return value;
  }

  async request(path, { method = 'GET', body, sid, timeoutMs, signal } = {}) {
    const credential = sid ? { sid } : await this.credentials();
    const controller = new AbortController();
    // 首字节超时：拿到响应头即停表，长流交给调用方的空闲超时。
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs || this.timeoutMs);
    const linkedSignal = abortSignalOf(controller, signal);
    try {
      const headers = { ...comateHeaders(credential.sid) };
      if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
      const res = await fetch(`${ENDPOINTS.origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: linkedSignal,
      });
      return res;
    } catch (error) {
      const reason = controller.signal.reason;
      const cancelled = Boolean(signal?.aborted) || /取消/.test(String(reason?.message || ''));
      const timedOut = !cancelled && controller.signal.aborted;
      if (timedOut) throw new ComateError('Comate 请求超时', 'TIMEOUT');
      if (cancelled) throw new ComateError('Comate 请求已取消', 'ABORTED');
      // 网络层错误归为可重试的 TRANSPORT。
      throw new ComateError(String(error?.message || error), 'TRANSPORT', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async requestJson(path, options = {}) {
    const res = await this.request(path, options);
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`Comate 鉴权失败（HTTP ${res.status}）`);
    }
    if (!res.ok) {
      throw new ComateError(
        `Comate HTTP ${res.status}${text ? `: ${text.slice(0, 240)}` : ''}`,
        codeForStatus(res.status),
        { status: res.status, ...retryAfterOf(res) },
      );
    }
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new ComateError(`Comate 返回的不是 JSON：${text.slice(0, 160)}`, 'MALFORMED_RESPONSE');
    }
    if (parsed && typeof parsed === 'object' && parsed.code !== undefined && parsed.code !== 0) {
      const message = parsed?.msg || parsed?.message || `code=${parsed.code}`;
      if (String(parsed.code) === '401' || /未登录|not.?login/i.test(String(message))) throw new AuthError(String(message));
      throw new ComateError(`Comate 业务错误：${message}`, codeForApiCode(parsed.code));
    }
    return parsed;
  }

  /** 模型目录。返回上游原始 body，归一化在 catalog.mjs。 */
  async listCatalog() {
    return this.requestJson(ENDPOINTS.models);
  }

  /** 能力开关（生图/视频/联网）。 */
  async capabilities() {
    return this.requestJson(ENDPOINTS.config);
  }

  /** 每日积分 / 额度 / 按模型用量。 */
  async tokenUsage() {
    return this.requestJson(ENDPOINTS.tokenUsage);
  }

  /** 消费明细（分页）。 */
  async usageDetails({ page = 1, pageSize = 20 } = {}) {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    return this.requestJson(`${ENDPOINTS.usageDetails}?${query.toString()}`);
  }

  /** 发起流式对话，返回原始 Response（SSE 由 adapter 解析）。 */
  async chat({ body, signal }) {
    const res = await this.request(ENDPOINTS.chat, {
      method: 'POST',
      body,
      signal,
      timeoutMs: this.timeoutMs,
    });
    if (res.status === 401 || res.status === 403) throw new AuthError(`Comate 鉴权失败（HTTP ${res.status}）`);
    return res;
  }
}
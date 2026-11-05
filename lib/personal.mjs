/**
 * 个人模型：读本机 Comate 的 models.json 里用户自配的 BYOK 提供商。
 * 地址与 Key 只在内存里用于发请求，不落盘、不进面板、不进日志。
 */
import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { comateAgentDir } from './config.mjs';
import { log } from './log.mjs';
import { findSecretKey } from './secret.mjs';

const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const CACHE_TTL_MS = 3000;
/** 扫密钥要读 70 MB 的 exe，失败后一分钟内不再重试。 */
const SECRET_KEY_RETRY_MS = 60_000;

let cache = { at: 0, entries: [] };
let secretKey;
let secretKeyFailedAt = 0;

/** 扫到的密钥常驻内存；扫不到则退避一分钟再试，避免每次都扫 70MB 的 exe。 */
function secretKeyFor(probeValue) {
  if (secretKey) return secretKey;
  if (secretKeyFailedAt && Date.now() - secretKeyFailedAt < SECRET_KEY_RETRY_MS) return null;
  secretKey = findSecretKey(probeValue);
  if (!secretKey) secretKeyFailedAt = Date.now();
  return secretKey;
}

const stripTrailingSlash = (url) => String(url || '').trim().replace(/\/+$/, '');

function looksLikePlainKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_\-./+=]{8,}$/.test(value) && !/^[A-Za-z0-9+/=]{60,}$/.test(value);
}

/** 解 Comate 存的 apiKey：base64( iv(12) || ciphertext || tag(16) )。 */
export function decryptSecret(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('sk-')) return value;
  let buf;
  try {
    buf = Buffer.from(value, 'base64');
  } catch {
    return null;
  }
  if (buf.length <= IV_LEN + AUTH_TAG_LEN) return null;
  const key = secretKeyFor(value);
  if (!key) return null;
  try {
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - AUTH_TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN, buf.length - AUTH_TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return plain || null;
  } catch {
    return null;
  }
}

/** 本机 Comate 的 models.json（可用 COMATE_MODELS_PATH 覆盖）。 */
export function modelsConfigPath() {
  return process.env.COMATE_MODELS_PATH || join(comateAgentDir(), 'agent', 'models.json');
}

export function readModelsConfig() {
  const path = modelsConfigPath();
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    log('读取 Comate 个人模型配置失败', String(error?.message || error));
    return null;
  }
}

function secretOf(raw) {
  const decrypted = decryptSecret(raw);
  if (decrypted) return decrypted;
  return looksLikePlainKey(raw) ? raw : '';
}

/** 展开 models.json 里所有非 official 提供商；只支持 openai-completions。 */
export function listPersonalProviders() {
  const config = readModelsConfig();
  const providers = config?.providers;
  if (!providers || typeof providers !== 'object') return [];
  const entries = [];
  for (const [providerKey, raw] of Object.entries(providers)) {
    if (!raw || typeof raw !== 'object') continue;
    if (String(providerKey).toLowerCase() === 'official') continue;
    const providerApi = String(raw.api || 'openai-completions');
    if (providerApi !== 'openai-completions') {
      log(`个人模型提供商 ${providerKey} 的协议 ${providerApi} 暂不支持，已跳过`);
      continue;
    }
    const providerBaseUrl = stripTrailingSlash(raw.baseUrl || raw.base_url);
    const providerKeyPlain = secretOf(raw.apiKey);
    const providerAuthHeader = raw.authHeader !== false;
    const providerHeaders = raw.headers && typeof raw.headers === 'object' ? raw.headers : {};
    const providerLabel = String(raw.displayName || raw.display_name || raw.name || providerKey);
    const models = Array.isArray(raw.models) ? raw.models : [];
    for (const item of models) {
      if (!item || typeof item !== 'object') continue;
      const modelId = String(item.id || item.model || item.name || '').trim();
      if (!modelId) continue;
      const api = String(item.api || providerApi);
      if (api !== 'openai-completions') continue;
      const baseUrl = stripTrailingSlash(item.baseUrl || item.base_url || providerBaseUrl);
      if (!baseUrl) {
        log(`个人模型 ${providerKey}/${modelId} 缺少 API 地址，已跳过`);
        continue;
      }
      const headers = item.headers && typeof item.headers === 'object'
        ? { ...providerHeaders, ...item.headers }
        : { ...providerHeaders };
      const contextWindow = Number(item.context_window ?? item.contextWindow ?? 0);
      const maxTokens = item.max_tokens && typeof item.max_tokens === 'object' ? item.max_tokens : {};
      const maxOutput = Number(maxTokens.default ?? maxTokens.max ?? 0);
      const llmTypes = Array.isArray(item.llm_types) ? item.llm_types : [];
      entries.push({
        providerKey: String(providerKey),
        providerLabel,
        modelId,
        displayName: String(item.display_name || item.displayName || item.name || modelId),
        baseUrl,
        apiKey: secretOf(item.apiKey) || providerKeyPlain,
        authHeader: item.authHeader !== undefined ? item.authHeader !== false : providerAuthHeader,
        headers,
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
        maxOutputTokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : 0,
        multimodal: item.multimodal === true || llmTypes.some((type) => String(type).includes('multimodal')),
      });
    }
  }
  return entries;
}

/** 带 3 秒缓存：一次对话里会连着取好几次。 */
export function listPersonalProvidersCached() {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.entries;
  try {
    cache = { at: now, entries: listPersonalProviders() };
  } catch (error) {
    log('枚举个人模型失败', String(error?.message || error));
    cache = { at: now, entries: [] };
  }
  return cache.entries;
}

export function invalidatePersonalCache() {
  cache = { at: 0, entries: [] };
}

/** 模型 id 形如 personal:<提供商>:<模型>。 */
export function personalModelKey(providerKey, modelId) {
  return `personal:${providerKey}:${modelId}`;
}

export function parsePersonalModelKey(value) {
  const match = /^personal:([^:]+):(.+)$/.exec(String(value || ''));
  if (!match) return null;
  return { providerKey: match[1], modelId: match[2] };
}

/** 按模型 id 找直连配置（找不到返回 null → 走 llmproxy）。 */
export function resolvePersonalModel(value) {
  const parsed = parsePersonalModelKey(value);
  if (!parsed) return null;
  const entries = listPersonalProvidersCached();
  const hit = entries.find((entry) => entry.providerKey === parsed.providerKey && entry.modelId === parsed.modelId);
  if (!hit) return null;
  return {
    ...hit,
    /** 真正发给上游的 model 字段。 */
    wireModel: hit.modelId,
  };
}

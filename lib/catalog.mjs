/** 模型目录归一化 + 本地缓存。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { GROUPS, PATHS } from './config.mjs';
import { log } from './log.mjs';
import { personalModelKey } from './personal.mjs';

const isPrivateRoute = (name) => /\/\/private$/i.test(String(name || ''));
const isPublicRoute = (name) => /\/\/public$/i.test(String(name || ''));

export function groupOf(item) {
  const source = String(item?.model_source || '').toLowerCase();
  if (source === 'custom' || isPrivateRoute(item?.name)) return 'enterprise';
  if (source === 'credits' || isPublicRoute(item?.name)) return 'builtin';
  return 'builtin';
}

function vendorOf(name) {
  const parts = String(name || '').split('/').filter(Boolean);
  // 路由串形状：<账号ID> / <厂商> / <模型名> / <private|public>
  return parts.length >= 3 ? parts[1] : '';
}

function contextOf(item) {
  const value = Number(item?.context_window);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function maxOutputOf(item) {
  const maxTokens = item?.max_tokens;
  const candidates = [Number(maxTokens?.default), Number(maxTokens?.max)];
  for (const value of candidates) {
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

export function normalizeItem(item) {
  const id = String(item?.name || '').trim();
  if (!id) return null;
  const group = groupOf(item);
  const groupMeta = GROUPS[group];
  const displayName = String(item?.display_name || item?.displayName || id).trim();
  const contextWindow = contextOf(item);
  const maxOutputTokens = maxOutputOf(item);
  const llmTypes = Array.isArray(item?.llm_types) ? item.llm_types : [];
  const multimodal = llmTypes.some((type) => String(type).includes('multimodal'));
  const vendor = vendorOf(id);
  const tier = String(item?.model_tier || '').trim();
  const ratio = Number(item?.consume_ratio);
  const thinkingLevels = Array.isArray(item?.thinking_levels)
    ? item.thinking_levels.map((level) => String(level)).filter(Boolean)
    : [];

  const descriptionParts = [];
  if (vendor) descriptionParts.push(vendor);
  if (tier) descriptionParts.push(tier);
  if (Number.isFinite(ratio) && ratio > 0) descriptionParts.push(`倍率 x${ratio}`);
  if (contextWindow) descriptionParts.push(`${Math.round(contextWindow / 1024)}K`);
  if (multimodal) descriptionParts.push('识图');

  return {
    id,
    displayName,
    /** 下拉里显示的完整名字，带分组与识图后缀（description 在 UI 里不渲染）。 */
    label: `${groupMeta.label} · ${displayName}${multimodal ? ' · 识图' : ''}`,
    group,
    groupLabel: groupMeta.label,
    groupHint: groupMeta.hint,
    description: descriptionParts.join(' · '),
    contextWindow,
    maxOutputTokens,
    multimodal,
    vendor,
    tier,
    ratio: Number.isFinite(ratio) ? ratio : 0,
    thinking: {
      supported: Boolean(item?.support_thinking),
      levels: thinkingLevels,
      canDisable: Boolean(item?.thinking_can_disable),
      defaultEnabled: Boolean(item?.default_thinking_enabled),
    },
  };
}

/** 个人模型 → 目录条目。只放能进下拉的字段，不放 baseUrl / apiKey。 */
export function normalizePersonalItem(entry) {
  const providerKey = String(entry?.providerKey || '');
  const modelId = String(entry?.modelId || '');
  if (!providerKey || !modelId) return null;
  const displayName = String(entry?.displayName || modelId);
  const groupMeta = GROUPS.personal;
  const contextWindow = Number(entry?.contextWindow) || 0;
  const multimodal = Boolean(entry?.multimodal);
  const parts = [providerKey];
  if (contextWindow) parts.push(`${Math.round(contextWindow / 1024)}K`);
  if (multimodal) parts.push('识图');
  return {
    id: personalModelKey(providerKey, modelId),
    displayName,
    label: `${groupMeta.label} · ${displayName}${multimodal ? ' · 识图' : ''}`,
    group: 'personal',
    groupLabel: groupMeta.label,
    groupHint: groupMeta.hint,
    description: parts.join(' · '),
    contextWindow,
    maxOutputTokens: Number(entry?.maxOutputTokens) || 0,
    multimodal,
    vendor: providerKey,
    tier: '',
    ratio: 0,
    thinking: { supported: false, levels: [], canDisable: true, defaultEnabled: false },
    personal: true,
  };
}

export function normalizeCatalog(body, personalEntries = [], previousModels = null) {
  const items = Array.isArray(body?.data?.items) ? body.data.items : [];
  const models = [];
  const seen = new Set();
  // 云端目录拿不到时，沿用上一次的云端模型，只把个人模型刷新一遍。
  const cloudModels = body
    ? items.map((item) => normalizeItem(item)).filter(Boolean)
    : (Array.isArray(previousModels) ? previousModels.filter((model) => model?.group !== 'personal') : []);
  for (const model of cloudModels) {
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  for (const entry of personalEntries || []) {
    const model = normalizePersonalItem(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  // 企业模型排前面（免费），个人模型排最后。
  const order = { enterprise: 0, builtin: 1, personal: 2 };
  models.sort((a, b) => {
    const diff = (order[a.group] ?? 9) - (order[b.group] ?? 9);
    return diff !== 0 ? diff : a.displayName.localeCompare(b.displayName);
  });
  return {
    at: Date.now(),
    auto: body?.data?.auto || null,
    models,
    counts: {
      enterprise: models.filter((model) => model.group === 'enterprise').length,
      builtin: models.filter((model) => model.group === 'builtin').length,
      personal: models.filter((model) => model.group === 'personal').length,
    },
  };
}

export function readCachedCatalog() {
  try {
    if (!existsSync(PATHS.catalog)) return null;
    const parsed = JSON.parse(readFileSync(PATHS.catalog, 'utf8'));
    if (!Array.isArray(parsed?.models)) return null;
    return {
      at: Number(parsed.at) || 0,
      models: parsed.models,
      counts: parsed.counts || {
        enterprise: parsed.models.filter((model) => model.group === 'enterprise').length,
        builtin: parsed.models.filter((model) => model.group === 'builtin').length,
        personal: parsed.models.filter((model) => model.group === 'personal').length,
      },
      auto: parsed.auto || null,
    };
  } catch {
    return null;
  }
}

export function writeCachedCatalog(catalog) {
  try {
    mkdirSync(dirname(PATHS.catalog), { recursive: true });
    writeFileSync(
      PATHS.catalog,
      `${JSON.stringify({ at: catalog.at, counts: catalog.counts, auto: catalog.auto, models: catalog.models }, null, 2)}\n`,
      'utf8',
    );
  } catch (error) {
    log('写模型目录缓存失败', error?.message || String(error));
  }
}
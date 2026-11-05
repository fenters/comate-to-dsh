/** 模型可见性：记住用户在面板里取消勾选的模型，未勾选的不进模型下拉。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PATHS } from './config.mjs';
import { log } from './log.mjs';

let cache = null;

/** 读隐藏列表。文件不存在或损坏都当作「全部可见」。 */
export function readHiddenModels() {
  if (cache) return cache;
  try {
    if (existsSync(PATHS.selection)) {
      const parsed = JSON.parse(readFileSync(PATHS.selection, 'utf8'));
      cache = new Set(Array.isArray(parsed?.hidden) ? parsed.hidden.map(String) : []);
      return cache;
    }
  } catch (error) {
    log('读取模型可见性配置失败，按全部可见处理', String(error?.message || error));
  }
  cache = new Set();
  return cache;
}

function persist(hidden) {
  try {
    mkdirSync(dirname(PATHS.selection), { recursive: true });
    writeFileSync(PATHS.selection, `${JSON.stringify({ hidden: [...hidden].sort() }, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('写模型可见性配置失败', String(error?.message || error));
  }
}

/** 设置单个模型的可见性，返回最新的隐藏列表。 */
export function setModelVisible(modelId, visible) {
  const id = String(modelId || '').trim();
  if (!id) return [...readHiddenModels()];
  const hidden = readHiddenModels();
  if (visible) hidden.delete(id);
  else hidden.add(id);
  persist(hidden);
  return [...hidden].sort();
}

/** 批量设置：hidden 直接覆盖。 */
export function setHiddenModels(ids) {
  const hidden = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean));
  cache = hidden;
  persist(hidden);
  return [...hidden].sort();
}

export function isModelHidden(modelId) {
  return readHiddenModels().has(String(modelId || ''));
}

export function clearSelectionCache() {
  cache = null;
}

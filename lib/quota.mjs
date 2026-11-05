/** 额度 / 积分归一化。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { DEFAULTS, PATHS } from './config.mjs';
import { log } from './log.mjs';

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function normalizeFunction(fn) {
  return {
    appId: String(fn?.app_id || ''),
    code: String(fn?.function_code || ''),
    title: String(fn?.title || fn?.function_code || ''),
    ruleType: String(fn?.rule_type || ''),
    tokenLimit: num(fn?.token_limit, 0),
    tokenRest: num(fn?.token_rest, 0),
    tokenUsed: num(fn?.token_used, 0),
    unlimited: num(fn?.token_limit, 0) < 0,
  };
}

function normalizePeriod(period, kind) {
  return {
    kind,
    type: String(period?.period_type || kind),
    label: String(period?.period_label || (kind === 'credits' ? '每日' : '')),
    creditsLimit: num(period?.credits_limit, 0),
    creditsRest: num(period?.credits_rest, 0),
    creditsUsed: num(period?.credits_used, 0),
    functions: Array.isArray(period?.functions) ? period.functions.map(normalizeFunction) : [],
  };
}

function normalizeModelToken(token) {
  return {
    model: String(token?.model || token?.model_name || ''),
    provider: String(token?.provider || ''),
    choice: String(token?.model_choice || ''),
    totalTokens: num(token?.total_tokens, 0),
    usedTokens: num(token?.used_tokens, 0),
    unlimited: num(token?.total_tokens, 0) < 0,
  };
}

/** 把 token-usage 的原始 body 归一化成 UI 好用的结构。 */
export function normalizeQuota(body) {
  const data = body?.data && typeof body.data === 'object' ? body.data : body || {};
  const credits = data?.credits || {};
  const daily = credits?.daily_limit || {};
  const creditsPeriods = Array.isArray(data?.credits_usage?.periods)
    ? data.credits_usage.periods.map((period) => normalizePeriod(period, 'credits'))
    : [];

  const customPeriods = Array.isArray(data?.custom_model_usage?.periods)
    ? data.custom_model_usage.periods.map((period) => normalizePeriod(period, 'tokens'))
    : [];

  // 上游 appTokens 是数组，按 app_id 建索引。
  const appTokens = {};
  const appList = Array.isArray(data?.appTokens)
    ? data.appTokens
    : Object.values(data?.appTokens && typeof data.appTokens === 'object' ? data.appTokens : {});
  for (const appValue of appList) {
    if (!appValue || typeof appValue !== 'object') continue;
    const appName = String(appValue?.app_id || appValue?.app_name || '');
    if (!appName) continue;
    const tokens = Array.isArray(appValue?.model_tokens) ? appValue.model_tokens : [];
    appTokens[appName] = {
      title: String(appValue?.app_name || appValue?.title || appName),
      totalTokens: num(appValue?.total_tokens, 0),
      usedTokens: num(appValue?.used_tokens, 0),
      models: tokens.map(normalizeModelToken).filter((item) => item.model),
    };
  }

  return {
    at: Date.now(),
    date: String(data?.date || ''),
    companyId: num(data?.companyId, 0),
    userId: num(data?.userId, 0),
    usedTokens: num(data?.used_tokens, 0),
    credits: {
      dailyLimit: num(daily.limit, 0),
      dailyRemain: num(daily.remain, 0),
      dailyUsed: num(daily.used, 0),
      usageMode: String(credits?.usage_mode || ''),
      mixedPriority: String(credits?.mixed_priority || ''),
      periods: creditsPeriods,
    },
    customModelUsage: { periods: customPeriods },
    appTokens,
  };
}

/** 消费明细（分页）→ 最近记录 + 今日汇总。 */
export function normalizeUsageDetails(body) {
  const data = body?.data && typeof body.data === 'object' ? body.data : body || {};
  const items = Array.isArray(data?.items) ? data.items : [];
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const d = today.getDate();
  const todayPrefix = `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  let todayCredits = 0;
  let todayTokens = 0;
  const records = items.map((item) => {
    // time 是 ISO 字符串，也兼容毫秒时间戳。
    const rawTime = item?.time;
    const time = typeof rawTime === 'number' ? rawTime : Date.parse(String(rawTime || ''));
    const date = new Date(Number.isFinite(time) ? time : 0);
    const isToday =
      date.getFullYear() === y && date.getMonth() + 1 === m && date.getDate() === d;
    const credits = num(item?.total_credits, 0);
    const tokens = num(item?.total_tokens, 0);
    if (isToday) {
      todayCredits += credits;
      todayTokens += tokens;
    }
    return {
      requestId: String(item?.request_id || ''),
      sessionId: String(item?.session_id || ''),
      title: String(item?.title || ''),
      model: String(item?.model || ''),
      credits,
      tokens,
      time,
      eventType: String(item?.event_type || ''),
    };
  });
  return {
    at: Date.now(),
    todayPrefix,
    page: num(data?.page, 1),
    pageSize: num(data?.page_size, records.length),
    total: num(data?.total, records.length),
    todayCredits,
    todayTokens,
    records,
  };
}

export function readCachedQuota() {
  try {
    if (!existsSync(PATHS.quota)) return null;
    const parsed = JSON.parse(readFileSync(PATHS.quota, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedQuota(quota) {
  try {
    mkdirSync(dirname(PATHS.quota), { recursive: true });
    writeFileSync(PATHS.quota, `${JSON.stringify(quota, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('写额度缓存失败', error?.message || String(error));
  }
}

/** 取一次完整额度视图（积分 + 明细）。明细失败不影响积分主体。 */
export async function fetchQuota(client, { withDetails = true } = {}) {
  const body = await client.tokenUsage();
  const quota = normalizeQuota(body);
  if (withDetails) {
    try {
      const details = await client.usageDetails({ page: 1, pageSize: 20 });
      quota.details = normalizeUsageDetails(details);
    } catch (error) {
      quota.detailsError = String(error?.message || error);
    }
  }
  quota.ttlMs = DEFAULTS.quotaTtlMs;
  writeCachedQuota(quota);
  return quota;
}
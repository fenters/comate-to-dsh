/** 共享常量。 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.3.3';
export const PROVIDER = 'comate';
export const DISPLAY_NAME = 'WPS Comate';

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, '..');

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
export const DATA_DIR = process.env.COMATE_TO_DSH_HOME || join(DSH_HOME, 'comate');

export const PATHS = Object.freeze({
  credentials: join(DATA_DIR, 'credentials.json'),
  catalog: join(DATA_DIR, 'catalog.json'),
  quota: join(DATA_DIR, 'quota.json'),
  log: join(DATA_DIR, 'comate.log'),
  scanScript: join(DATA_DIR, 'scan-sid.ps1'),
});

export const ENDPOINTS = Object.freeze({
  origin: 'https://comate.wps.cn',
  models: '/llmproxy/v1/user/models',
  chat: '/llmproxy/v3/user/chat/completions',
  config: '/llmproxy/v1/config',
  tokenUsage: '/llmproxy/v1/user/token-usage',
  usageDetails: '/api/coserve/v1/usage/details',
  trial: '/api/coserve/v1/billing/v3/credits/trial',
  loginUrl: 'https://comate.wps.cn/web',
});

export const APP_ID = 'wpscomate';
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/** 模型分组。label 直接显示在 DSH 模型下拉里。 */
export const GROUPS = Object.freeze({
  enterprise: {
    key: 'enterprise',
    label: '企业模型',
    hint: '企业自定义/私有模型，不扣积分',
  },
  builtin: {
    key: 'builtin',
    label: '内置模型',
    hint: 'Comate 内置公共额度模型，按倍率扣积分',
  },
  personal: {
    key: 'personal',
    label: '个人模型',
    hint: 'Comate 里自己配置的 BYOK 模型，直连它配置的地址',
  },
});

export const DEFAULTS = Object.freeze({
  catalogTtlMs: 5 * 60 * 1000,
  quotaTtlMs: 60 * 1000,
  firstByteTimeoutMs: 60 * 1000,
  streamIdleTimeoutMs: 90 * 1000,
  fallbackContextWindow: 131072,
  fallbackMaxOutputTokens: 16384,
  logMaxBytes: 2 * 1024 * 1024,
  /** 登录浏览器窗口最长等待时间。 */
  browserLoginTimeoutMs: 5 * 60 * 1000,
});

export function comateLocalDataDir() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(local, 'cn.wpscomate.comate-agent');
}

export function comateAgentDir() {
  return join(homedir(), '.wpscomate');
}

export function comateExeCandidates() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    join(local, 'Programs', 'WPS Comate', 'WPSComate.exe'),
    join(pf, 'WPS Comate', 'WPSComate.exe'),
    join(pf86, 'WPS Comate', 'WPSComate.exe'),
    'D:\\WPS Comate\\WPSComate.exe',
    'C:\\WPS Comate\\WPSComate.exe',
  ];
}
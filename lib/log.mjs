/** 日志写入 $DSH_HOME/comate/comate.log，超限轮转。永不抛错。 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { DEFAULTS, PATHS } from './config.mjs';

let prepared = false;

function prepare() {
  if (prepared) return;
  try {
    mkdirSync(dirname(PATHS.log), { recursive: true });
    prepared = true;
  } catch {
    /* 数据目录不可写时静默降级为不落盘 */
  }
}

export function log(message, detail) {
  const suffix = detail === undefined || detail === null || detail === ''
    ? ''
    : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  const line = `[${new Date().toISOString()}] ${message}${suffix}`;
  try {
    if (process.env.COMATE_TO_DSH_VERBOSE) console.log(`[comate] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    prepare();
    if (!prepared) return;
    if (existsSync(PATHS.log) && statSync(PATHS.log).size > DEFAULTS.logMaxBytes) {
      try {
        const target = `${PATHS.log}.1`;
        // Windows 的 rename 在目标已存在时会抛 EEXIST（POSIX 会静默覆盖），
        // 于是第二、三次轮转全部失败、日志无限增长。先删再改名，两条平台一致。
        if (existsSync(target)) unlinkSync(target);
        renameSync(PATHS.log, target);
      } catch {
        /* 轮转失败不影响继续追加 */
      }
    }
    appendFileSync(PATHS.log, `${line}\n`, 'utf8');
  } catch {
    /* 落盘失败不影响调用 */
  }
}
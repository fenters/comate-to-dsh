/** 从 Comate 可执行文件里扫出解密 models.json 用的 32 字节密钥。 */
import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { comateExeCandidates } from './config.mjs';
import { log } from './log.mjs';

const KEY_LEN = 32;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
/** 快筛用：密钥里出现的特殊字符。全量扫描在下面兜底。 */
const SPECIAL = new Set([0x40, 0x21, 0x23, 0x24, 0x25, 0x5e, 0x26, 0x2a]);

function parseProbe(value) {
  const buf = Buffer.from(String(value || ''), 'base64');
  if (buf.length <= IV_LEN + AUTH_TAG_LEN) return null;
  return {
    iv: buf.subarray(0, IV_LEN),
    tag: buf.subarray(buf.length - AUTH_TAG_LEN),
    ciphertext: buf.subarray(IV_LEN, buf.length - AUTH_TAG_LEN),
  };
}

/** GCM 的认证标签能独立判断密钥对不对，不需要知道明文。 */
function decryptsWith(key, probe) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, probe.iv);
    decipher.setAuthTag(probe.tag);
    decipher.update(probe.ciphertext);
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

function* printableWindows(bytes, minSpecial) {
  const last = bytes.length - KEY_LEN;
  for (let offset = 0; offset <= last; offset += 1) {
    let special = 0;
    let printable = true;
    for (let i = 0; i < KEY_LEN; i += 1) {
      const byte = bytes[offset + i];
      if (byte < 0x20 || byte >= 0x7f) {
        printable = false;
        break;
      }
      if (SPECIAL.has(byte)) special += 1;
    }
    if (printable && special >= minSpecial) yield offset;
  }
}

/** probe 是 models.json 里任意一段密文；找到密钥返回 32 字节 Buffer，否则 null。 */
export function findSecretKey(probeValue) {
  const probe = parseProbe(probeValue);
  if (!probe) return null;
  const exe = comateExeCandidates().find((candidate) => existsSync(candidate));
  if (!exe) {
    log('未找到 Comate 可执行文件，个人模型不可用');
    return null;
  }
  let bytes;
  try {
    bytes = readFileSync(exe);
  } catch (error) {
    log('读取 Comate 可执行文件失败', String(error?.message || error));
    return null;
  }
  // 先按特殊字符快筛；WPS 改密钥形态时退回全量可打印扫描。
  for (const minSpecial of [2, 0]) {
    for (const offset of printableWindows(bytes, minSpecial)) {
      const key = bytes.subarray(offset, offset + KEY_LEN);
      if (!decryptsWith(key, probe)) continue;
      log(`已从 Comate 提取解密密钥 @0x${offset.toString(16)}`);
      return Buffer.from(key);
    }
  }
  log('未能从 Comate 可执行文件里提取解密密钥');
  return null;
}

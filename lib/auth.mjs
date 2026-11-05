/**
 * 凭据解析：拿到 Comate 的 wps_sid。
 * 顺序：COMATE_SID 环境变量 → credentials.json → Comate 进程内存 → 拉起 Comate 再扫。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { APP_ID, DEFAULTS, ENDPOINTS, PATHS, USER_AGENT, comateExeCandidates } from './config.mjs';
import { log } from './log.mjs';

const CRED_CACHE_MS = 5 * 60 * 1000;
/** 失败结果只缓存 20s，否则用户中途打开 Comate 也要等 5 分钟才恢复。 */
const CRED_FAILURE_TTL_MS = 20 * 1000;

let credCache = { at: 0, value: null };

export function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 12) return '***';
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function sidCookie(sid) {
  return `wps_sid=${sid}; csrf=${sid}`;
}

export function comateHeaders(sid) {
  return {
    cookie: sidCookie(sid),
    'x-app-id': APP_ID,
    origin: ENDPOINTS.origin,
    referer: `${ENDPOINTS.origin}/web`,
    'user-agent': USER_AGENT,
    accept: 'application/json, text/plain, */*',
  };
}

export function readSavedCredentials() {
  try {
    const parsed = JSON.parse(readFileSync(PATHS.credentials, 'utf8'));
    const sid = typeof parsed?.sid === 'string' ? parsed.sid.trim() : '';
    if (!sid) return null;
    return { sid, source: String(parsed?.source || 'saved'), savedAt: Number(parsed?.savedAt) || 0 };
  } catch {
    return null;
  }
}

export function saveCredentials({ sid, source = 'manual' }) {
  const value = String(sid || '').trim();
  if (!value) return false;
  try {
    mkdirSync(dirname(PATHS.credentials), { recursive: true });
    writeFileSync(
      PATHS.credentials,
      `${JSON.stringify({ sid: value, source, savedAt: Date.now() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch (error) {
    log('写入凭据失败', error?.message || String(error));
    return false;
  }
}

export function clearSavedCredentials() {
  try {
    if (existsSync(PATHS.credentials)) unlinkSync(PATHS.credentials);
  } catch {
    /* ignore */
  }
}

export function invalidateCredentialCache() {
  credCache = { at: 0, value: null };
}

/** 用 sid 调一次模型目录接口。 */
export async function validateSid(sid, { timeoutMs = 15_000 } = {}) {
  if (!sid) return { ok: false, status: 0, modelCount: 0, error: 'sid 为空' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('校验超时')), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINTS.origin}${ENDPOINTS.models}`, {
      headers: comateHeaders(sid),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    if (res.status === 200) {
      try {
        const body = JSON.parse(text);
        if (body?.code === 0) {
          const items = Array.isArray(body?.data?.items) ? body.data.items : [];
          return { ok: true, status: 200, modelCount: items.length, error: '' };
        }
        return { ok: false, status: 200, modelCount: 0, error: String(body?.msg || '响应 code 非 0') };
      } catch {
        return { ok: false, status: 200, modelCount: 0, error: '响应不是 JSON' };
      }
    }
    return {
      ok: false,
      status: res.status,
      modelCount: 0,
      error: `HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return { ok: false, status: 0, modelCount: 0, error: aborted ? '校验超时' : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

// ── 从 WPS Comate 进程内存里扫 sid

/** P/Invoke 内存扫描脚本（由 Windows PowerShell 5.1 执行）。 */
const SCAN_SCRIPT = String.raw`
param(
  [string]$ProcessName = 'WPSComate',
  [string]$Pattern = 'wps_sid=',
  [int]$MaxHits = 40
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ComateMemScan {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr handle, IntPtr addr, byte[] buffer, IntPtr size, out IntPtr read);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr VirtualQueryEx(IntPtr handle, IntPtr addr, out MEMORY_BASIC_INFORMATION info, IntPtr len);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORY_BASIC_INFORMATION {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public UIntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
  }

  public static List<string> Scan(int pid, string pattern, int maxHits) {
    var hits = new List<string>();
    var handle = OpenProcess(0x0410, false, pid);
    if (handle == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try {
      var needle = Encoding.UTF8.GetBytes(pattern);
      var addr = IntPtr.Zero;
      var info = new MEMORY_BASIC_INFORMATION();
      var chunkSize = 8 * 1024 * 1024;
      var buffer = new byte[chunkSize];
      while (VirtualQueryEx(handle, addr, out info, (IntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION))) != IntPtr.Zero) {
        long regionBase = info.BaseAddress.ToInt64();
        long regionSize = (long)info.RegionSize.ToUInt64();
        if (regionSize <= 0) break;
        bool readable = info.State == 0x1000 && (info.Protect & 0x100) == 0 &&
          ((info.Protect & 0x02) != 0 || (info.Protect & 0x04) != 0 || (info.Protect & 0x20) != 0 ||
           (info.Protect & 0x40) != 0 || (info.Protect & 0x80) != 0);
        if (readable) {
          long offset = 0;
          while (offset < regionSize) {
            int want = (int)Math.Min((long)chunkSize, regionSize - offset);
            IntPtr read;
            if (ReadProcessMemory(handle, (IntPtr)(regionBase + offset), buffer, (IntPtr)want, out read) && (long)read > 0) {
              int got = (int)read;
              int idx = 0;
              while ((idx = IndexOf(buffer, got, needle, idx)) >= 0) {
                int start = idx + needle.Length;
                int end = start;
                while (end < got && end - start < 512) {
                  byte b = buffer[end];
                  if (b == (byte)';' || b == (byte)'&' || b == (byte)'"' || b == (byte)' ' || b == 0 || b == 10 || b == 13) break;
                  end++;
                }
                if (end - start >= 20) {
                  hits.Add(Encoding.UTF8.GetString(buffer, start, end - start));
                  if (hits.Count >= maxHits) return hits;
                }
                idx = start;
              }
            }
            offset += want;
          }
        }
        addr = (IntPtr)(regionBase + regionSize);
      }
    } finally {
      CloseHandle(handle);
    }
    return hits;
  }

  static int IndexOf(byte[] haystack, int length, byte[] needle, int from) {
    int last = length - needle.Length;
    for (int i = from; i <= last; i++) {
      if (haystack[i] != needle[0]) continue;
      bool ok = true;
      for (int j = 1; j < needle.Length; j++) {
        if (haystack[i + j] != needle[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }
}
"@

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Write-Output 'NORUN'; exit 0 }

$seen = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($p in $procs) {
  try {
    foreach ($hit in [ComateMemScan]::Scan($p.Id, $Pattern, $MaxHits)) {
      if ($seen.Add($hit)) { Write-Output ("HIT " + $p.Id + " " + $hit) }
    }
  } catch {
    Write-Output ("WARN " + $p.Id + " " + $_.Exception.Message)
  }
}
`;

function ensureScanScript() {
  try {
    mkdirSync(dirname(PATHS.scanScript), { recursive: true });
    let current = '';
    try {
      current = readFileSync(PATHS.scanScript, 'utf8');
    } catch {
      /* 首次写入 */
    }
    if (current !== SCAN_SCRIPT) writeFileSync(PATHS.scanScript, SCAN_SCRIPT, 'utf8');
    return PATHS.scanScript;
  } catch (error) {
    log('写入内存扫描脚本失败', error?.message || String(error));
    return '';
  }
}

function powershellExe() {
  // Windows PowerShell 5.1 一定存在；pwsh 可能没装。
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function runPowerShell(scriptPath, args = [], { timeoutMs = 60_000 } = {}) {
  const exe = powershellExe();
  if (!existsSync(exe)) return { ok: false, stdout: '', stderr: 'powershell.exe 不存在', code: -1 };
  const result = spawnSync(
    exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    code: result.status,
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

/** 判断 WPS Comate 是否在运行。 */
export function isComateRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq WPSComate.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    return /wpscomate\.exe/i.test(String(result.stdout || ''));
  } catch {
    return false;
  }
}

/** 从进程内存里扫出所有像 sid 的候选串（已去重、已过滤）。 */
export function scanSidCandidates() {
  if (process.platform !== 'win32') return { candidates: [], running: false, error: '仅支持 Windows' };
  const script = ensureScanScript();
  if (!script) return { candidates: [], running: false, error: '无法写入扫描脚本' };
  const startedAt = Date.now();
  // 扫描可能要几十秒，给 90s。
  const result = runPowerShell(script, [], { timeoutMs: 90_000 });
  const candidates = [];
  const seen = new Set();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('HIT ')) continue;
    const rest = line.slice(4);
    const spaceAt = rest.indexOf(' ');
    if (spaceAt < 0) continue;
    const value = rest.slice(spaceAt + 1).trim();
    if (!/^[A-Za-z0-9_\-+/=]{20,300}$/.test(value)) continue;
    if (!seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  }
  // V02 开头是 wps_sid 的典型形态，优先；更长的优先（截断命中会短一截）。
  candidates.sort((a, b) => {
    const av = a.startsWith('V02') ? 1 : 0;
    const bv = b.startsWith('V02') ? 1 : 0;
    if (av !== bv) return bv - av;
    return b.length - a.length;
  });
  return {
    candidates,
    running: !/NORUN/.test(result.stdout),
    error: result.ok ? '' : result.stderr || result.error || `退出码 ${result.code}`,
    tookMs: Date.now() - startedAt,
  };
}

// ── 拉起 Comate（可选）

export function findComateExe() {
  for (const candidate of comateExeCandidates()) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== 'win32') return '';
  const shortcuts = [
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WPS Comate.lnk'),
    join(homedir(), 'Desktop', 'WPS Comate.lnk'),
  ].filter((item) => {
    try {
      return existsSync(item);
    } catch {
      return false;
    }
  });
  if (!shortcuts.length) return '';
  const script = join(process.env.TEMP || homedir(), 'comate-resolve-lnk.ps1');
  const body = shortcuts
    .map((item, index) => `$s${index} = New-Object -ComObject WScript.Shell; $t${index} = $s${index}.CreateShortcut('${item.replace(/'/g, "''")}').TargetPath; if ($t${index}) { Write-Output $t${index} }`)
    .join('\n');
  try {
    writeFileSync(script, `${body}\n`, 'utf8');
    const result = runPowerShell(script, [], { timeoutMs: 20_000 });
    for (const line of result.stdout.split(/\r?\n/)) {
      const value = line.trim();
      if (value && existsSync(value)) return value;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/** 启动 WPS Comate 并等它可被扫描（最多 waitMs）。 */
export async function launchComate({ waitMs = 45_000 } = {}) {
  if (isComateRunning()) return { ok: true, launched: false };
  const exe = findComateExe();
  if (!exe) return { ok: false, launched: false, error: '没有找到 WPSComate.exe（可能没安装 Comate）' };
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    log('已拉起 WPS Comate', exe);
  } catch (error) {
    return { ok: false, launched: false, error: String(error?.message || error) };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (isComateRunning()) {
      // 进程起来后还要等登录态加载进内存。
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return { ok: true, launched: true };
    }
  }
  return { ok: false, launched: true, error: 'WPS Comate 启动超时' };
}

// ── 主入口

/**
 * 解析可用凭据。
 * @param {{force?:boolean, allowLaunch?:boolean, validate?:boolean}} options
 */
export async function resolveCredentials(options = {}) {
  const { force = false, allowLaunch = false, validate = true } = options;
  if (!force && credCache.value) {
    const ttl = credCache.value.sid ? CRED_CACHE_MS : CRED_FAILURE_TTL_MS;
    if (Date.now() - credCache.at < ttl) return credCache.value;
  }

  const remember = (value) => {
    credCache = { at: Date.now(), value };
    return value;
  };

  // 1) 环境变量
  const envSid = String(process.env.COMATE_SID || '').trim();  if (envSid) {
    const check = validate ? await validateSid(envSid) : { ok: true, modelCount: 0, error: '' };
    if (check.ok) return remember({ sid: envSid, source: 'env', error: '', hint: maskSecret(envSid) });
    log('环境变量 COMATE_SID 校验失败', check.error);
  }

  // 2) 上次保存的
  const saved = readSavedCredentials();
  if (saved?.sid) {
    const check = validate ? await validateSid(saved.sid) : { ok: true, modelCount: 0, error: '' };
    if (check.ok) return remember({ sid: saved.sid, source: saved.source || 'saved', error: '', hint: maskSecret(saved.sid) });
    log('已保存的 SID 失效，准备重新获取', check.error);
    clearSavedCredentials();
  }

  // 3) 正在运行的 Comate 内存
  if (process.platform === 'win32') {
    let scan = scanSidCandidates();
    if (!scan.candidates.length && allowLaunch && !scan.running) {
      const launched = await launchComate();
      if (launched.ok) scan = scanSidCandidates();
      else log('拉起 Comate 失败', launched.error);
    }
    for (const sid of scan.candidates) {
      const check = validate ? await validateSid(sid) : { ok: true, modelCount: 0, error: '' };
      if (check.ok) {
        saveCredentials({ sid, source: 'comate' });
        log('已从 WPS Comate 进程内存取得登录态');
        return remember({ sid, source: 'comate', error: '', hint: maskSecret(sid) });
      }
    }
    if (!scan.running) {
      return remember({
        sid: '',
        source: '',
        error: scan.error || 'WPS Comate 未运行',
        hint: '',
      });
    }
    if (scan.error) log('内存扫描异常', scan.error);
  }

  return remember({
    sid: '',
    source: '',
    error: '没有可用的 Comate 登录态：请打开 WPS Comate，或点「浏览器登录」',
    hint: '',
  });
}
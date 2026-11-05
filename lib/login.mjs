/**
 * 浏览器登录兜底：用 Edge 的 CDP 开独立窗口让用户登录，再读出 wps_sid。
 * 独立 user-data-dir 既不污染日常浏览器，下次登录也能复用。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { DATA_DIR, DEFAULTS, ENDPOINTS } from './config.mjs';
import { log } from './log.mjs';

const PROFILE_DIR = join(DATA_DIR, 'browser-profile');

const EDGE_CANDIDATES = () => {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local ? join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  ].filter(Boolean);
};

export function findEdge() {
  for (const candidate of EDGE_CANDIDATES()) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return '';
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findFreePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配端口'))));
    });
  });
}

async function fetchJson(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 通过 CDP 目标读全部 cookie，返回 wps_sid 或空串。 */
async function readSidViaCdp(webSocketDebuggerUrl) {
  if (!webSocketDebuggerUrl) return '';
  if (typeof WebSocket !== 'function') return '';
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), 4000);
    try {
      socket = new WebSocket(webSocketDebuggerUrl);
    } catch {
      clearTimeout(timer);
      return resolve('');
    }
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
      } catch {
        clearTimeout(timer);
        finish('');
      }
    });
    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (payload?.id !== 1) return;
      clearTimeout(timer);
      const cookies = payload?.result?.cookies;
      if (!Array.isArray(cookies)) return finish('');
      const hit = cookies.find((cookie) => cookie?.name === 'wps_sid' && cookie?.value);
      finish(hit ? String(hit.value) : '');
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      finish('');
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      finish('');
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000, windowsHide: true });
  } catch {
    /* ignore */
  }
}

/** 打开登录窗口并等待 wps_sid。 */
export async function loginViaBrowser(options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULTS.browserLoginTimeoutMs;
  const onState = typeof options.onState === 'function' ? options.onState : () => {};
  const edge = findEdge();
  if (!edge) return { ok: false, sid: '', error: '没有找到 Microsoft Edge，无法打开登录窗口' };

  mkdirSync(PROFILE_DIR, { recursive: true });
  const port = await findFreePort();
  onState({ state: 'opening', message: '正在打开登录窗口…' });
  let child;
  try {
    child = spawn(
      edge,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=msEdgeSidebarV2',
        '--new-window',
        ENDPOINTS.loginUrl,
      ],
      { detached: false, stdio: 'ignore', windowsHide: false },
    );
  } catch (error) {
    return { ok: false, sid: '', error: `无法启动 Edge：${String(error?.message || error)}` };
  }
  child.on('error', () => {});

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  let lastMessage = '';
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null && !ready) {
        return { ok: false, sid: '', error: '登录窗口已关闭' };
      }
      if (!ready) {
        const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
        if (version) {
          ready = true;
          onState({ state: 'waiting', message: '请在打开的窗口里登录 WPS（企业）账号…' });
        } else {
          await delay(400);
          continue;
        }
      }

      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(targets)) {
        const pages = targets.filter((target) => target?.type === 'page' && target?.webSocketDebuggerUrl);
        const preferred = pages.find((target) => /wps\.cn/i.test(String(target.url || ''))) || pages[0];
        if (preferred) {
          const sid = await readSidViaCdp(preferred.webSocketDebuggerUrl);
          if (sid) {
            onState({ state: 'success', message: '已获取登录态' });
            return { ok: true, sid, error: '' };
          }
        }
        const current = pages.find((target) => /wps\.cn/i.test(String(target.url || '')));
        const message = current ? '等待登录完成…' : '等待打开 comate.wps.cn…';
        if (message !== lastMessage) {
          lastMessage = message;
          onState({ state: 'waiting', message });
        }
      }
      await delay(1500);
    }
    return { ok: false, sid: '', error: '登录等待超时，请重试' };
  } finally {
    killProcessTree(child.pid);
    onState({ state: 'closed', message: '' });
    log('浏览器登录窗口已关闭');
  }
}
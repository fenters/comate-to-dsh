/**
 * 面板同源数据面。读接口只返回非敏感元数据；写接口要求 `x-comate-panel: 1` 挡 CSRF。
 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    // 超限后继续读掉剩余字节再回 413，否则客户端可能先收到 ECONNRESET。
    if (size > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw httpError(413, '请求体过大');
  if (!chunks.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, '请求体不是有效的 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, '请求体必须是 JSON 对象');
  }
  return parsed;
}

const guard = (req) => req.headers['x-comate-panel'] === '1';

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (!res.writableEnded) sendJson(res, status, { ok: false, error: String(error?.message || error) });
    }
  };
}

const methodGuard = (req, res, allowed) => {
  if (allowed.includes(req.method)) return false;
  sendJson(res, 405, { ok: false, error: 'method not allowed' });
  return true;
};

export function createRouteTable({ controller, log = () => {} }) {
  return [
    {
      kind: 'exact',
      path: '/comate/status',
      handler: wrap(async (req, res) => {
        if (methodGuard(req, res, ['GET', 'HEAD'])) return;
        sendJson(res, 200, await controller.status());
      }),
    },
    {
      kind: 'exact',
      path: '/comate/models',
      handler: wrap(async (req, res) => {
        if (methodGuard(req, res, ['GET', 'HEAD'])) return;
        sendJson(res, 200, await controller.models());
      }),
    },
    {
      kind: 'exact',
      path: '/comate/quota',
      handler: wrap(async (req, res) => {
        if (methodGuard(req, res, ['GET', 'HEAD'])) return;
        sendJson(res, 200, await controller.quota({ refresh: false }));
      }),
    },
    {
      kind: 'exact',
      path: '/comate/connect',
      handler: wrap(async (req, res) => {
        if (methodGuard(req, res, ['POST'])) return;
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-comate-panel header' });
        const body = await readJsonBody(req);
        const result = await controller.connect({ allowLaunch: body?.allowLaunch !== false });
        log(`面板触发连接：${result.signedIn ? '成功' : '未取到登录态'}`);
        sendJson(res, 200, { ok: true, ...result });
      }),
    },
    {
      kind: 'exact',
      path: '/comate/login',
      handler: wrap(async (req, res) => {
        if (methodGuard(req, res, ['POST'])) return;
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-comate-panel header' });
        const result = await controller.login();
        log(`浏览器登录流程结束：${result.signedIn ? '成功' : result.error || '未取到登录态'}`);
        sendJson(res, 200, { ok: true, ...result });
      }),
    },
    {
      kind: 'exact',
      path: '/comate/refresh',
      handler: wrap(async (req, res) => {
        if (methodGuard(req, res, ['POST'])) return;
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-comate-panel header' });
        const result = await controller.refresh();
        log(`面板触发刷新：${result.modelCount} 个模型`);
        sendJson(res, 200, { ok: true, ...result });
      }),
    },
    {
      kind: 'exact',
      path: '/comate/visibility',
      handler: wrap(async (req, res) => {
        if (methodGuard(req, res, ['POST'])) return;
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-comate-panel header' });
        const body = await readJsonBody(req);
        const result = await controller.visibility({
          hidden: body?.hidden,
          modelId: body?.modelId,
          visible: body?.visible,
        });
        log(`面板更新模型可见性：隐藏 ${result.hidden.length} 个`);
        sendJson(res, 200, { ok: true, ...result });
      }),
    },
  ];
}

export function mountRoutes(target, routes, log = () => {}) {
  const webServer = typeof target?.register === 'function' ? target : target?.get?.('webServer');
  if (!webServer) {
    log('webServer 服务不可用，Comate 面板数据面未挂载');
    return () => {};
  }
  const disposers = [];
  for (const route of routes) {
    try {
      disposers.push(webServer.register({ kind: route.kind, path: route.path, handler: route.handler }));
    } catch (error) {
      log(`挂载路由 ${route.path} 失败`, error?.message || error);
    }
  }
  log(`已挂载 ${disposers.length}/${routes.length} 条 Comate 面板路由`);
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}
import { createRequire } from 'module';
import https from 'https';

const require = createRequire('/home/dhruvkejri1/projects/lunel/cli/package.json');
const { WebSocket } = require('ws');

const MANAGER_URL = 'https://manager.lunel.dev';
const BAD_ORIGIN = 'exp://127.0.0.1';
const GOOD_ORIGIN = 'https://lunel.dev';

function toWs(url) {
  return url.replace(/^https:/, 'wss:');
}

function requestJson(url, init = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = init.body ?? null;
    const request = https.request(
      target,
      {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        timeout: 20000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const payload = raw ? JSON.parse(raw) : null;
          resolve({
            ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 500,
            payload,
          });
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`Request timed out for ${url}`));
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function createQrCode() {
  const response = await requestJson(`${MANAGER_URL}/v2/qr`);
  if (!response.ok) {
    throw new Error(`Failed to create QR code: ${response.status}`);
  }
  return response.payload;
}

function waitForEvent(ws, timeoutMs, handlers = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.removeAllListeners('error');
        ws.once('error', () => {
          // ignore follow-up socket errors after timeout cleanup
        });
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.terminate();
        }
      } catch {
        // ignore
      }
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeAllListeners('open');
      ws.removeAllListeners('message');
      ws.removeAllListeners('close');
      ws.removeAllListeners('error');
      ws.removeAllListeners('unexpected-response');
    };

    ws.once('open', () => {
      if (!handlers.open) return;
      Promise.resolve(handlers.open())
        .then((value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
    });

    ws.on('message', (data) => {
      if (!handlers.message) return;
      Promise.resolve(handlers.message(data))
        .then((value) => {
          if (typeof value === 'undefined') return;
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
    });

    ws.once('close', (code, reason) => {
      if (!handlers.close) return;
      Promise.resolve(handlers.close(code, reason))
        .then((value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
    });

    ws.once('error', (error) => {
      if (!handlers.error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
        return;
      }
      Promise.resolve(handlers.error(error))
        .then((value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
    });

    ws.once('unexpected-response', (_req, res) => {
      if (!handlers.unexpectedResponse) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Unexpected response ${res.statusCode}`));
        return;
      }
      Promise.resolve(handlers.unexpectedResponse(res))
        .then((value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
    });
  });
}

async function assembleRole(code, role, origin) {
  const ws = new WebSocket(`${toWs(MANAGER_URL)}/v2/assemble?code=${encodeURIComponent(code)}&role=${role}`, {
    headers: origin ? { Origin: origin } : {},
    handshakeTimeout: 15000,
  });

  return await waitForEvent(ws, 15000, {
    message: (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type !== 'assembled') return undefined;
      ws.send(JSON.stringify({ type: 'ack' }));
      return parsed;
    },
    unexpectedResponse: (res) => ({ status: res.statusCode, body: res.statusMessage ?? '' }),
    error: (error) => ({ error: error.message }),
    close: (codeValue, reason) => ({ closeCode: codeValue, closeReason: reason.toString() }),
  });
}

async function expectRejectedAssemble(origin) {
  const qr = await createQrCode();
  const cliPromise = assembleRole(qr.code, 'cli');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const appResult = await assembleRole(qr.code, 'app', origin);
  const cliResult = await cliPromise;
  return { qrCode: qr.code, appResult, cliResult };
}

async function expectSuccessfulAssembly(origin) {
  const qr = await createQrCode();
  const cliPromise = assembleRole(qr.code, 'cli');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const appPromise = assembleRole(qr.code, 'app', origin);
  const [cliResult, appResult] = await Promise.all([cliPromise, appPromise]);
  return { qrCode: qr.code, cliResult, appResult };
}

async function getAssignedProxyUrl(password) {
  const response = await requestJson(`${MANAGER_URL}/v2/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(`Proxy lookup failed: ${response.status} ${JSON.stringify(response.payload)}`);
  }
  const payload = response.payload;
  if (!payload.proxyUrl) {
    throw new Error('Missing proxyUrl');
  }
  return payload.proxyUrl;
}

async function openWs(url, headers) {
  const ws = new WebSocket(url, { headers });
  return await waitForEvent(ws, 15000, {
    open: () => {
      ws.close();
      return { opened: true };
    },
    unexpectedResponse: async (res) => ({ opened: false, status: res.statusCode, statusMessage: res.statusMessage ?? '' }),
    error: (error) => ({ opened: false, error: error.message }),
  });
}

async function main() {
  const summary = {};
  summary.rejectedAssemble = await expectRejectedAssemble(BAD_ORIGIN);
  const successfulAssembly = await expectSuccessfulAssembly(GOOD_ORIGIN);
  summary.successfulAssembly = {
    qrCode: successfulAssembly.qrCode,
    cliResult: successfulAssembly.cliResult,
    appResult: successfulAssembly.appResult,
    cliHasPassword: typeof successfulAssembly.cliResult.password === 'string',
    appHasPassword: typeof successfulAssembly.appResult.password === 'string',
    passwordsMatch: successfulAssembly.cliResult.password === successfulAssembly.appResult.password,
  };

  try {
    const password = successfulAssembly.appResult.password;
    const proxyUrl = await getAssignedProxyUrl(password);
    const proxyV2Ws = `${toWs(proxyUrl)}/v2/ws/app`;
    const proxyV1Ws = `${toWs(proxyUrl)}/v1/ws/proxy?tunnelId=smoke-${Date.now()}&role=app`;

    summary.proxyUrl = proxyUrl;
    summary.badV2 = await openWs(proxyV2Ws, {
      Origin: BAD_ORIGIN,
      'x-session-password': password,
    });
    summary.goodV2 = await openWs(proxyV2Ws, {
      Origin: GOOD_ORIGIN,
      'x-session-password': password,
    });
    summary.badV1 = await openWs(proxyV1Ws, {
      Origin: BAD_ORIGIN,
      'x-session-password': password,
    });
    summary.goodV1 = await openWs(proxyV1Ws, {
      Origin: GOOD_ORIGIN,
      'x-session-password': password,
    });
  } catch (error) {
    summary.proxyStageError = error instanceof Error ? error.message : String(error);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

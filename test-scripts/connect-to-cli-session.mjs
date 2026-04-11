import https from 'https';
import { createRequire } from 'module';

const require = createRequire('/home/dhruvkejri1/projects/lunel/cli/package.json');
const { WebSocket } = require('ws');

const MANAGER_URL = process.env.LUNEL_MANAGER_URL || 'https://manager.lunel.dev';
const TRUSTED_ORIGIN = 'https://lunel.dev';

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
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const payload = raw ? JSON.parse(raw) : null;
            resolve({
              ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
              status: response.statusCode ?? 500,
              payload,
            });
          } catch (error) {
            reject(error);
          }
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

function readManagerErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  if (typeof payload.reason === 'string' && payload.reason.trim()) return payload.reason;
  return fallback;
}

function shouldRetryLegacyManagerRoute(status, message) {
  return status === 405 || (status === 404 && /not found/i.test(message));
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForAssembled(code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${toWs(MANAGER_URL)}/v2/assemble?code=${encodeURIComponent(code)}&role=app`,
      {
        headers: {
          Origin: TRUSTED_ORIGIN,
        },
        handshakeTimeout: 30000,
      },
    );

    const timeout = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(new Error('Timed out waiting for assembled payload'));
    }, 45000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeAllListeners('message');
      ws.removeAllListeners('error');
      ws.removeAllListeners('unexpected-response');
      ws.removeAllListeners('close');
    };

    ws.once('unexpected-response', (_req, res) => {
      cleanup();
      reject(new Error(`Assemble websocket rejected (${res.statusCode} ${res.statusMessage ?? ''})`));
    });

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type !== 'assembled') {
          return;
        }
        ws.send(JSON.stringify({ type: 'ack' }));
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });

    ws.once('close', (codeValue, reason) => {
      cleanup();
      reject(new Error(`Assemble websocket closed (${codeValue}: ${reason.toString()})`));
    });
  });
}

async function waitForAssembledWithRetry(code, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await waitForAssembled(code);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && /timed out/i.test(error instanceof Error ? error.message : String(error))) {
        await delay(1000 * attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function getAssignedProxyUrl(password) {
  let response = await requestJson(`${MANAGER_URL}/v2/proxy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    let message = readManagerErrorMessage(response.payload, `Proxy lookup failed (${response.status})`);
    if (shouldRetryLegacyManagerRoute(response.status, message)) {
      response = await requestJson(`${MANAGER_URL}/v2/proxy?password=${encodeURIComponent(password)}`);
      if (!response.ok) {
        message = readManagerErrorMessage(response.payload, `Proxy lookup failed (${response.status})`);
      }
    }
    if (!response.ok) {
      throw new Error(`${message}: ${JSON.stringify(response.payload)}`);
    }
  }

  if (!response.payload?.proxyUrl || typeof response.payload.proxyUrl !== 'string') {
    throw new Error(`Proxy lookup returned invalid payload: ${JSON.stringify(response.payload)}`);
  }
  return response.payload.proxyUrl;
}

function openAppSocketAttempt(proxyUrl, password, useLegacyQuery) {
  return new Promise((resolve, reject) => {
    const baseUrl = `${toWs(proxyUrl)}/v2/ws/app`;
    const wsUrl = useLegacyQuery
      ? `${baseUrl}?password=${encodeURIComponent(password)}`
      : baseUrl;
    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: TRUSTED_ORIGIN,
        'x-session-password': password,
      },
      handshakeTimeout: 30000,
    });

    const timeout = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(new Error(`Timed out opening app v2 websocket (legacyQuery=${useLegacyQuery})`));
    }, 45000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('close');
      ws.removeAllListeners('unexpected-response');
      ws.removeAllListeners('message');
    };

    ws.once('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        cleanup();
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '';
        reject(
          new Error(
            `App websocket rejected (legacyQuery=${useLegacyQuery}) (${res.statusCode} ${res.statusMessage ?? ''}) ${body}`,
          ),
        );
      });
    });

    ws.once('open', () => {
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        cleanup();
        resolve({ ok: true, useLegacyQuery });
      }, 2000);
    });

    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });

    ws.once('close', (codeValue, reason) => {
      cleanup();
      reject(new Error(`App websocket closed before open (legacyQuery=${useLegacyQuery}) (${codeValue}: ${reason.toString()})`));
    });
  });
}

async function openAppSocket(proxyUrl, password) {
  let primaryError = null;
  try {
    return await openAppSocketAttempt(proxyUrl, password, false);
  } catch (error) {
    primaryError = error;
  }

  try {
    return await openAppSocketAttempt(proxyUrl, password, true);
  } catch (legacyError) {
    throw new Error(
      `Both app socket attempts failed. primary=${primaryError instanceof Error ? primaryError.message : String(primaryError)} legacy=${legacyError instanceof Error ? legacyError.message : String(legacyError)}`,
    );
  }
}

async function main() {
  const code = process.argv[2]?.trim();
  const gatewayHint = process.argv[3]?.trim() || null;
  if (!code) {
    throw new Error('Usage: node test-scripts/connect-to-cli-session.mjs <SESSION_CODE> [GATEWAY_HINT]');
  }

  const result = {
    ok: false,
    stage: 'start',
    code,
  };

  try {
    result.stage = 'assemble';
    const assembled = await waitForAssembledWithRetry(code);
    result.assembledCode = assembled.code;

    if (typeof assembled.password !== 'string' || !assembled.password) {
      throw new Error('Assemble response missing password');
    }
    result.passwordLength = assembled.password.length;

    result.stage = 'proxy_lookup';
    let proxyUrl = null;
    try {
      proxyUrl = await getAssignedProxyUrl(assembled.password);
      result.proxyLookup = 'manager';
    } catch (error) {
      if (gatewayHint) {
        proxyUrl = gatewayHint;
        result.proxyLookup = `gateway_hint_fallback:${gatewayHint}`;
      } else {
        throw error;
      }
    }
    result.proxyUrl = proxyUrl;

    result.stage = 'open_app_socket';
    const openResult = await openAppSocket(proxyUrl, assembled.password);
    result.openResult = openResult;

    result.ok = true;
    result.stage = 'done';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

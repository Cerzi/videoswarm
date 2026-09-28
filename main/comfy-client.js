const dns = require('dns');
const http = require('http');
const https = require('https');
const { isLoopbackAddress, parseComfyUrl } = require('./comfy-connection');
const { parseComfyGraphJson, stringifyComfyGraphJson } = require('./comfy-graph-json');

// A small client for a ComfyUI on this machine. Every response is untrusted
// input: bodies are size-bounded and parsed with exact 64-bit integers. The
// address is loopback-only, checked again when the host name resolves.
//
// Node definitions are fetched per class (`/object_info/{class}`) and cached
// for a minute: the full `/object_info` is over 100 MB on a well-stocked
// install, too much to parse in the main process every minute, and the
// checks only need the classes a prompt uses plus the loaders.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INFO_TTL_MS = 60_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_ITEMS = 256;
const MAX_CLASSES_PER_REQUEST = 256;
const OOM_SIGNATURES = ['out of memory', 'outofmemoryerror', 'allocation on device', 'not enough memory'];

class ComfyClientError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ComfyClientError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const unavailable = (message) => new ComfyClientError('COMFY_UNAVAILABLE', message);

function loopbackLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: false }, (error, address, family) => {
    if (error) return callback(error);
    if (!isLoopbackAddress(address)) {
      return callback(unavailable(`${hostname} does not resolve to this computer`));
    }
    return callback(null, address, family);
  });
}

function createComfyClient({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  infoTtlMs = DEFAULT_INFO_TTL_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  now = () => Date.now(),
} = {}) {
  const origin = new URL(parseComfyUrl(url));
  const transport = origin.protocol === 'https:' ? https : http;
  const infoCache = new Map(); // class -> { at, spec }

  function request(method, pathname, body) {
    const payload = body === undefined ? null : Buffer.from(stringifyComfyGraphJson(body), 'utf8');
    return new Promise((settleResolve, settleReject) => {
      let settled = false;
      const resolve = (value) => {
        if (!settled) settleResolve(value);
        settled = true;
      };
      const reject = (error) => {
        if (!settled) settleReject(error);
        settled = true;
      };
      const req = transport.request(
        {
          protocol: origin.protocol,
          hostname: origin.hostname.replace(/^\[|\]$/g, ''),
          port: origin.port || (origin.protocol === 'https:' ? 443 : 80),
          path: pathname,
          method,
          lookup: loopbackLookup,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              reject(new ComfyClientError('COMFY_BAD_RESPONSE', `ComfyUI's answer to ${pathname} is too large`));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(
                new ComfyClientError('COMFY_HTTP_ERROR', `ComfyUI answered ${res.statusCode} to ${method} ${pathname}`, {
                  status: res.statusCode,
                  body: text.slice(0, 4096),
                })
              );
              return;
            }
            if (!text.trim()) {
              resolve({});
              return;
            }
            try {
              resolve(parseComfyGraphJson(text));
            } catch {
              reject(new ComfyClientError('COMFY_BAD_RESPONSE', `ComfyUI's answer to ${pathname} is not JSON`));
            }
          });
          res.on('error', (error) => reject(unavailable(error.message)));
        }
      );
      req.on('timeout', () => req.destroy(unavailable(`ComfyUI did not answer ${pathname} in time`)));
      req.on('error', (error) => {
        reject(error instanceof ComfyClientError ? error : unavailable(`ComfyUI is not reachable (${error.code || error.message})`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

  // Definitions of these node classes, from the cache when fresh. A class
  // ComfyUI does not know maps to null.
  async function getNodeInfo(classNames) {
    const wanted = [...new Set(classNames.filter((name) => typeof name === 'string' && name))];
    if (wanted.length > MAX_CLASSES_PER_REQUEST) {
      throw new ComfyClientError('COMFY_TOO_MANY_CLASSES', 'The prompt uses too many node classes to check');
    }
    const result = {};
    for (const name of wanted) {
      const cached = infoCache.get(name);
      if (cached && now() - cached.at < infoTtlMs) {
        result[name] = cached.spec;
        continue;
      }
      const answer = await request('GET', `/object_info/${encodeURIComponent(name)}`);
      const spec = isObject(answer?.[name]) ? answer[name] : null;
      infoCache.set(name, { at: now(), spec });
      result[name] = spec;
    }
    return result;
  }

  const queueEntry = (item) =>
    Array.isArray(item) && typeof item[1] === 'string'
      ? { number: item[0], promptId: item[1], prompt: isObject(item[2]) ? item[2] : {}, extraData: isObject(item[3]) ? item[3] : {} }
      : null;

  async function getQueue() {
    const answer = await request('GET', '/queue');
    const list = (value) => (Array.isArray(value) ? value.map(queueEntry).filter(Boolean) : []);
    return { running: list(answer?.queue_running), pending: list(answer?.queue_pending) };
  }

  async function getHistory(promptId) {
    const answer = await request('GET', `/history/${encodeURIComponent(promptId)}`);
    return isObject(answer?.[promptId]) ? answer[promptId] : null;
  }

  async function getRecentHistory(maxItems = 64) {
    const count = Math.max(1, Math.min(MAX_HISTORY_ITEMS, Math.floor(Number(maxItems) || 1)));
    const answer = await request('GET', `/history?max_items=${count}`);
    return isObject(answer) ? answer : {};
  }

  // Queue a prompt. No client_id is sent, so ComfyUI broadcasts step progress
  // to every listener, its own page included.
  async function submitPrompt({ prompt, extraPnginfo }) {
    let answer;
    try {
      answer = await request('POST', '/prompt', { prompt, extra_data: { extra_pnginfo: extraPnginfo || {} } });
    } catch (error) {
      if (error.code === 'COMFY_HTTP_ERROR' && error.status === 400) {
        throw new ComfyClientError('COMFY_REFUSED', `ComfyUI refused it: ${describeRefusal(error.body)}`);
      }
      throw error;
    }
    if (typeof answer?.prompt_id !== 'string' || !answer.prompt_id) {
      throw new ComfyClientError('COMFY_BAD_RESPONSE', 'ComfyUI did not return a prompt id');
    }
    return answer.prompt_id;
  }

  // Withdraw prompts that have not started.
  async function deleteQueued(promptIds) {
    const ids = promptIds.filter((id) => typeof id === 'string' && id);
    if (ids.length) await request('POST', '/queue', { delete: ids });
  }

  async function free({ unloadModels = true, freeMemory = true } = {}) {
    await request('POST', '/free', { unload_models: unloadModels, free_memory: freeMemory });
  }

  // A read-only check that the address answers as ComfyUI.
  async function test() {
    const queue = await getQueue();
    const info = await getNodeInfo(['SaveVideo', 'SaveImage']);
    if (!info.SaveVideo && !info.SaveImage) {
      throw new ComfyClientError('COMFY_NOT_COMFYUI', 'That address answers, but not as ComfyUI');
    }
    return { running: queue.running.length, pending: queue.pending.length };
  }

  return {
    url: origin.origin,
    getNodeInfo,
    getQueue,
    getHistory,
    getRecentHistory,
    submitPrompt,
    deleteQueued,
    free,
    test,
    clearInfoCache: () => infoCache.clear(),
  };
}

function describeRefusal(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.error?.type || 'invalid prompt';
    const details = Object.values(parsed?.node_errors || {})
      .flatMap((entry) => (Array.isArray(entry?.errors) ? entry.errors : []).map((error) => `${entry.class_type}: ${error.message}${error.details ? ` (${error.details})` : ''}`))
      .slice(0, 3);
    return [message, ...details].join('; ').slice(0, 500);
  } catch {
    return String(body || '').slice(0, 300) || 'invalid prompt';
  }
}

// What a finished /history entry says: ok, oom (the "out of memory" family),
// error with the failing node's type and message, or interrupted; how long
// execution took; and the output files it saved.
function classifyHistoryEntry(entry) {
  const status = entry && typeof entry === 'object' && entry.status && typeof entry.status === 'object' ? entry.status : {};
  const messages = (Array.isArray(status.messages) ? status.messages : []).filter(
    (message) => Array.isArray(message) && message.length > 1 && typeof message[0] === 'string'
  );
  const stamp = (kind) => {
    const found = messages.find((message) => message[0] === kind);
    const value = found?.[1]?.timestamp;
    return typeof value === 'number' ? value : null;
  };
  const start = stamp('execution_start');
  const finish = stamp('execution_success') ?? stamp('execution_error') ?? stamp('execution_interrupted');
  const seconds = start !== null && finish !== null ? Math.max(0, (finish - start) / 1000) : null;

  const outputs = [];
  for (const output of Object.values(entry?.outputs && typeof entry.outputs === 'object' ? entry.outputs : {})) {
    for (const key of ['images', 'gifs', 'videos', 'video', 'audio']) {
      for (const file of Array.isArray(output?.[key]) ? output[key] : []) {
        if (file && file.type === 'output' && typeof file.filename === 'string') {
          outputs.push({ filename: file.filename, subfolder: typeof file.subfolder === 'string' ? file.subfolder : '' });
        }
      }
    }
  }

  const base = { seconds, outputs, nodeType: null, message: '' };
  if (status.status_str === 'success') return { ...base, state: 'ok' };
  const text = stringifyComfyGraphJson(status).toLowerCase();
  const error = messages.find((message) => message[0] === 'execution_error')?.[1] || null;
  const errorDetail = error
    ? { nodeType: typeof error.node_type === 'string' ? error.node_type : null, message: String(error.exception_message ?? '').trim().slice(0, 500) }
    : {};
  if (OOM_SIGNATURES.some((signature) => text.includes(signature))) {
    return { ...base, ...errorDetail, state: 'oom', message: errorDetail.message || 'out of memory' };
  }
  if (error) return { ...base, ...errorDetail, state: 'error' };
  if (messages.some((message) => message[0] === 'execution_interrupted')) {
    return { ...base, state: 'interrupted', message: 'interrupted in ComfyUI' };
  }
  return { ...base, state: 'error', message: typeof status.status_str === 'string' ? status.status_str : 'failed' };
}

module.exports = {
  ComfyClientError,
  OOM_SIGNATURES,
  classifyHistoryEntry,
  createComfyClient,
};

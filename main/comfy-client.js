const dns = require('dns');
const http = require('http');
const https = require('https');
const { isLoopbackAddress, parseComfyUrl } = require('./comfy-connection');

// A read-only check of a ComfyUI on this machine, for Preferences' Test
// button and before a workflow window opens. Every response is untrusted
// input and size-bounded. The address is loopback-only, checked again when
// the host name resolves. Nothing is ever queued.

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const origin = new URL(parseComfyUrl(url));
  const transport = origin.protocol === 'https:' ? https : http;

  function get(pathname) {
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
          method: 'GET',
          lookup: loopbackLookup,
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
                new ComfyClientError('COMFY_HTTP_ERROR', `ComfyUI answered ${res.statusCode} to GET ${pathname}`, {
                  status: res.statusCode,
                })
              );
              return;
            }
            if (!text.trim()) {
              resolve({});
              return;
            }
            try {
              resolve(JSON.parse(text));
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
      req.end();
    });
  }

  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const count = (value) => (Array.isArray(value) ? value.length : 0);

  // Whether the address answers as ComfyUI, and how busy it is.
  async function test() {
    const queue = await get('/queue');
    let known = false;
    for (const name of ['SaveVideo', 'SaveImage']) {
      const answer = await get(`/object_info/${encodeURIComponent(name)}`);
      if (isObject(answer?.[name])) {
        known = true;
        break;
      }
    }
    if (!known) {
      throw new ComfyClientError('COMFY_NOT_COMFYUI', 'That address answers, but not as ComfyUI');
    }
    return { running: count(queue?.queue_running), pending: count(queue?.queue_pending) };
  }

  return { url: origin.origin, test };
}

module.exports = {
  ComfyClientError,
  createComfyClient,
};

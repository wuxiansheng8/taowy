import { RateLimiter } from './rateLimiter.js';

let rpcId = 1;
const DWELLIR_HTTP_BASE = 'https://api-bittensor-mainnet.n.dwellir.com';

export function normalizeEndpoint(key) {
  const raw = key.endpoint || key.apiKey || '';
  const apiKey = extractDwellirApiKey(raw);
  if (apiKey) return `${DWELLIR_HTTP_BASE}/${apiKey}`;
  if (key.endpoint) return String(key.endpoint).trim().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  return '';
}

export function toWsEndpoint(endpoint) {
  return endpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

export function extractDwellirApiKey(value = '') {
  const text = String(value).trim();
  if (!text || text.includes('******')) return '';
  const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0];
  try {
    const urlMatch = text.match(/(?:https?|wss?):\/\/[^\s]+/i);
    const url = new URL(urlMatch ? urlMatch[0] : text);
    const last = url.pathname.split('/').filter(Boolean).pop();
    return last && !last.includes('*') ? last.trim() : '';
  } catch {
    return text.replace(/^\/+|\/+$/g, '');
  }
}

export class DwellirPool {
  constructor(getConfig, logger) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.globalLimiter = new RateLimiter(20);
    this.keyLimiters = new Map();
    this.failedAttempts = new Map();
    this.cooldownUntil = new Map();
    this.cursor = 0;
  }

  enabledKeys() {
    const cfg = this.getConfig().apiPool || {};
    this.globalLimiter.setRate(cfg.globalRps || 20);
    const now = Date.now();
    const activeKeys = (cfg.keys || [])
      .filter((key) => key.enabled !== false && normalizeEndpoint(key))
      .map((key, index) => ({
        ...key,
        id: key.id || `key-${index}`,
        endpoint: normalizeEndpoint(key),
        perSecondLimit: Number(key.perSecondLimit || 20)
      }));

    // Filter out keys in cooldown unless ALL keys are in cooldown
    const nonCooledKeys = activeKeys.filter((key) => {
      const cooldown = this.cooldownUntil.get(key.id) || 0;
      return cooldown <= now;
    });

    if (nonCooledKeys.length > 0) {
      return nonCooledKeys;
    }
    return activeKeys; // Fallback to all keys if all are cooling down
  }

  nextKey() {
    const keys = this.enabledKeys();
    if (!keys.length) throw new Error('还没有配置可用的 Dwellir API');
    const key = keys[this.cursor % keys.length];
    this.cursor += 1;
    if (!this.keyLimiters.has(key.id)) this.keyLimiters.set(key.id, new RateLimiter(key.perSecondLimit));
    this.keyLimiters.get(key.id).setRate(key.perSecondLimit);
    return key;
  }

  firstWsEndpoint() {
    return this.nextWsEndpoint();
  }

  nextWsEndpoint() {
    return toWsEndpoint(this.nextKey().endpoint);
  }

  cooldownKey(keyId, durationMs, reason) {
    const until = Date.now() + durationMs;
    this.cooldownUntil.set(keyId, until);
    this.logger.warn(`API Key ${keyId} 触发冷却，原因: ${reason}，时长: ${durationMs / 1000}s`);
  }

  recordFailure(keyId, errorMsg) {
    const current = this.failedAttempts.get(keyId) || 0;
    const next = current + 1;
    this.failedAttempts.set(keyId, next);
    if (next >= 3) {
      this.cooldownKey(keyId, 3 * 60 * 1000, `连续失败 ${next} 次: ${errorMsg}`);
    }
  }

  resetFailure(keyId) {
    this.failedAttempts.set(keyId, 0);
    this.cooldownUntil.set(keyId, 0);
  }

  async rpc(method, params = []) {
    const cfg = this.getConfig().apiPool || {};
    const retries = Number(cfg.retries ?? 2);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const key = this.nextKey();
      await this.globalLimiter.take();
      await this.keyLimiters.get(key.id).take();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs || 10000));
      try {
        const res = await fetch(key.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
        });
        if (!res.ok) {
          if (res.status === 429) {
            this.cooldownKey(key.id, 5 * 60 * 1000, 'HTTP 429 Rate Limit');
          } else {
            this.recordFailure(key.id, `HTTP ${res.status}`);
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await res.json();
        if (payload.error) {
          this.recordFailure(key.id, payload.error.message || 'RPC Error');
          throw new Error(payload.error.message || JSON.stringify(payload.error));
        }
        this.resetFailure(key.id);
        return payload.result;
      } catch (error) {
        lastError = error;
        if (error.name === 'AbortError') {
          this.cooldownKey(key.id, 2 * 60 * 1000, 'Timeout');
        } else if (!error.message.includes('HTTP')) {
          this.recordFailure(key.id, error.message);
        }
        this.logger.warn('Dwellir RPC 请求失败，准备重试', { method, attempt, endpoint: maskEndpoint(key.endpoint), error: error.message });
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

function maskEndpoint(endpoint) {
  return endpoint.replace(/(api-bittensor-mainnet\.n\.dwellir\.com\/).+$/i, '$1******');
}

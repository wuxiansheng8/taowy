import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppLogger } from './logger.js';
import { DwellirPool, extractDwellirApiKey, normalizeEndpoint, toWsEndpoint } from './dwellirPool.js';
import { BittensorMonitor } from './bittensorMonitor.js';
import { Notifier } from './notifier.js';
import { checkPassword, publicConfig, requireAuth } from './auth.js';
import { loadConfig, saveConfig, rootDir } from './storage.js';
import { configureSniper, getSniper } from './sniper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
let config = loadConfig();
const logger = new AppLogger();
const getConfig = () => config;
const pool = new DwellirPool(getConfig, logger);
const notifier = new Notifier(getConfig, logger);
configureSniper({ getConfig, logger, notifier, pool });
const monitor = new BittensorMonitor({ pool, getConfig, logger, notifier });
const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'wangye.sid',
  secret: process.env.SESSION_SECRET || 'wangye-co-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_BASE_DELAY_MS = 400;
const LOGIN_MAX_DELAY_MS = 5000;

app.post('/api/login', async (req, res) => {
  const body = req.body || {};
  const key = loginAttemptKey(req);
  const attempt = getLoginAttempt(key);
  if (attempt.lockedUntil > Date.now()) {
    await sleep(LOGIN_MAX_DELAY_MS);
    res.status(429).json({ error: '登录失败次数过多，请稍后再试' });
    return;
  }

  const ok = await checkPassword(config, body.username, body.password);
  if (!ok) {
    const failures = recordLoginFailure(key);
    await sleep(loginFailureDelay(failures));
    logger.warn('网页登录失败', { username: body.username });
    res.status(401).json({ error: '账号或密码错误' });
    return;
  }
  clearLoginAttempt(key);
  req.session.user = { username: config.auth.username };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session?.user || null });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  res.json(monitor.snapshot(req.query.sort || 'netuid'));
});

app.get('/api/race', requireAuth, (req, res) => {
  res.json(monitor.snapshot().race);
});

app.get('/api/logs', requireAuth, (req, res) => {
  res.json(logger.list({ q: req.query.q, level: req.query.level, limit: req.query.limit || 500 }));
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json(publicConfig(config));
});

app.put('/api/settings', requireAuth, (req, res) => {
  const next = sanitizeSettings(config, req.body);
  config = next;
  saveConfig(config);
  monitor.schedule();
  monitor.connectWs('设置更新').catch((error) => logger.warn('新区块订阅重连失败', { error: error.message }));
  logger.info('系统设置已更新', { username: req.session.user.username });
  res.json(publicConfig(config));
});

app.post('/api/password', requireAuth, async (req, res) => {
  if (!req.body.password || String(req.body.password).length < 8) {
    res.status(400).json({ error: '密码至少 8 位' });
    return;
  }
  config.auth.username = req.body.username || config.auth.username;
  config.auth.passwordHash = await bcrypt.hash(req.body.password, 10);
  saveConfig(config);
  logger.info('网页账号密码已更新');
  res.json({ ok: true });
});

app.post('/api/refresh', requireAuth, async (req, res) => {
  res.json(await monitor.refresh('手动刷新'));
});

app.post('/api/telegram/test', requireAuth, async (req, res) => {
  const current = config.telegram || {};
  const body = req.body?.telegram || {};
  const tg = {
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
    botToken: body.botToken && !String(body.botToken).includes('******')
      ? String(body.botToken).trim()
      : current.botToken,
    chatId: body.chatId !== undefined ? String(body.chatId).trim() : current.chatId
  };
  if (!tg.enabled || !tg.botToken || !tg.chatId) {
    res.status(400).json({ error: '请先启用 Telegram 并保存 Bot Token 和 Chat ID' });
    return;
  }
  const now = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
  const result = await notifier.telegram(`TAO 子网提醒\nTelegram 测试推送成功\n北京时间 ${now}`, tg);
  if (!result.ok) {
    res.status(502).json({ error: `Telegram 推送失败：${result.error || '配置不可用'}` });
    return;
  }
  logger.info('Telegram 测试推送已发送', { username: req.session.user.username });
  res.json({ ok: true });
});

app.post('/api/dwellir/test', requireAuth, async (req, res) => {
  const keys = sanitizeApiKeysForTest(req.body?.keys, config.apiPool.keys || []);
  const timeoutMs = clamp(req.body?.timeoutMs, 1000, 30000, 8000);
  const results = await Promise.all(keys.map((key) => testDwellirKey(key, timeoutMs)));
  logger.info('Dwellir API 连通性检测完成', {
    username: req.session.user.username,
    total: results.length,
    ok: results.filter((item) => item.http.ok && item.ws.ok).length
  });
  res.json({ ok: true, results });
});

app.post('/api/sniper/balances', requireAuth, async (req, res) => {
  const walletList = await getSniper().refreshAllBalances();
  res.json({ ok: true, walletList });
});

app.post('/api/sniper/reload-wallets', requireAuth, async (req, res) => {
  dotenv.config({ path: path.join(rootDir, '.env'), override: true });
  const walletList = await getSniper().reloadWallets();
  logger.info('自动打新钱包已手动刷新', { username: req.session.user.username, wallets: walletList.length });
  res.json({ ok: true, walletList });
});

app.post('/api/sniper/buy', requireAuth, async (req, res) => {
  if (req.body?.sniper) {
    config = sanitizeSettings(config, { sniper: req.body.sniper });
    saveConfig(config);
  }
  const netuid = Number(req.body?.netuid);
  if (!Number.isInteger(netuid) || netuid < 1 || netuid > 128) {
    res.status(400).json({ error: '请输入 1-128 的子网编号' });
    return;
  }
  const result = await getSniper().buySubnet(netuid, `Subnet ${netuid}`);
  logger.info('手动指定子网购买已触发', { username: req.session.user.username, netuid, result });
  res.json(result);
});

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('state', monitor.snapshot());
  const offState = monitor.onUpdate((payload) => send(payload.type, payload.data));
  const offLog = logger.on((entry) => send('log', entry));
  const ping = setInterval(() => send('ping', { ts: Date.now() }), 25000);
  req.on('close', () => {
    clearInterval(ping);
    offState();
    offLog();
  });
});

app.use(express.static(publicDir));
app.get(/.*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const port = Number(process.env.PORT || config.server.port || 3000);
app.listen(port, () => {
  logger.info(`wangye-co 已启动，端口 ${port}`);
  monitor.start().catch((error) => logger.warn('采集器启动失败', { error: error.message }));
});

function sanitizeSettings(current, body) {
  const next = structuredClone(current);
  if (body.apiPool) {
    next.apiPool.globalRps = clamp(body.apiPool.globalRps, 1, 10000, current.apiPool.globalRps);
    next.apiPool.timeoutMs = clamp(body.apiPool.timeoutMs, 1000, 120000, current.apiPool.timeoutMs);
    next.apiPool.retries = clamp(body.apiPool.retries, 0, 10, current.apiPool.retries);
    next.apiPool.keys = (body.apiPool.keys || []).map((key, index) => {
      const prior = current.apiPool.keys?.find((old) => old.id === key.id) || {};
      const incoming = key.endpoint && !key.endpoint.includes('******')
        ? key.endpoint
        : (key.apiKey && !key.apiKey.includes('******') ? key.apiKey : '');
      const apiKey = extractDwellirApiKey(incoming) || prior.apiKey || extractDwellirApiKey(prior.endpoint);
      const endpoint = apiKey ? normalizeEndpoint({ apiKey }) : (prior.endpoint || '');
      return {
        id: key.id || `api-${Date.now()}-${index}`,
        name: key.name || `API ${index + 1}`,
        enabled: key.enabled !== false,
        endpoint,
        apiKey,
        perSecondLimit: clamp(key.perSecondLimit, 1, 10000, prior.perSecondLimit || 20)
      };
    });
  }
  if (body.collector) {
    next.collector.pollIntervalMs = clamp(body.collector.pollIntervalMs, 10000, 3600000, current.collector.pollIntervalMs);
    next.collector.verifyIntervalMs = clamp(body.collector.verifyIntervalMs, 30000, 3600000, current.collector.verifyIntervalMs);
    next.collector.blockTimeMs = clamp(body.collector.blockTimeMs, 1000, 60000, current.collector.blockTimeMs);
    next.collector.maxSubnets = clamp(body.collector.maxSubnets, 1, 1024, current.collector.maxSubnets);
  }
  if (body.telegram) {
    next.telegram.enabled = Boolean(body.telegram.enabled);
    next.telegram.botToken = body.telegram.botToken && !body.telegram.botToken.includes('******')
      ? String(body.telegram.botToken).trim()
      : current.telegram.botToken;
    next.telegram.chatId = body.telegram.chatId !== undefined ? String(body.telegram.chatId).trim() : current.telegram.chatId;
  }
  if (body.github) {
    next.github.repo = body.github.repo || current.github.repo;
    next.github.branch = body.github.branch || current.github.branch || 'main';
  }
  if (body.sniper) {
    next.sniper.enabled = Boolean(body.sniper.enabled);
    next.sniper.renameEnabled = Boolean(body.sniper.renameEnabled);
    next.sniper.amountTao = clamp(body.sniper.amountTao, 0.001, 10000, current.sniper.amountTao);
    next.sniper.maxRetries = clamp(body.sniper.maxRetries, 0, 1000, current.sniper.maxRetries);
    next.sniper.burstCount = Math.floor(clamp(body.sniper.burstCount, 1, 50, current.sniper.burstCount || 1));
    next.sniper.retryIntervalMs = clamp(body.sniper.retryIntervalMs, 0, 60000, current.sniper.retryIntervalMs);
    next.sniper.txTimeoutMs = clamp(body.sniper.txTimeoutMs, 1000, 30000, current.sniper.txTimeoutMs || 5000);

    next.sniper.renameAmountTao = clamp(body.sniper.renameAmountTao, 0.001, 10000, current.sniper.renameAmountTao || 1.0);
    next.sniper.renameMaxRetries = clamp(body.sniper.renameMaxRetries, 0, 1000, current.sniper.renameMaxRetries !== undefined ? current.sniper.renameMaxRetries : 5);
    next.sniper.renameBurstCount = Math.floor(clamp(body.sniper.renameBurstCount, 1, 50, current.sniper.renameBurstCount || 1));
    next.sniper.renameRetryIntervalMs = clamp(body.sniper.renameRetryIntervalMs, 0, 60000, current.sniper.renameRetryIntervalMs !== undefined ? current.sniper.renameRetryIntervalMs : 200);
    next.sniper.renameTxTimeoutMs = clamp(body.sniper.renameTxTimeoutMs, 1000, 30000, current.sniper.renameTxTimeoutMs || 5000);

    next.sniper.defaultHotkey = sanitizeHotkey(
      body.sniper.defaultHotkey !== undefined ? body.sniper.defaultHotkey : current.sniper.defaultHotkey
    );
    if (body.sniper.hotkeys) {
      next.sniper.hotkeys = sanitizeHotkeys(body.sniper.hotkeys, next.collector.maxSubnets || 128);
    } else {
      next.sniper.hotkeys = current.sniper.hotkeys || {};
    }

    // 保存钱包备注和开关
    if (body.sniper.wallets) {
      next.sniper.wallets = {};
      for (const [addr, w] of Object.entries(body.sniper.wallets)) {
        next.sniper.wallets[addr] = {
          name: String(w.name || '').trim(),
          enabled: w.enabled !== false
        };
      }
    }
  }
  return next;
}

function sanitizeApiKeysForTest(inputKeys, currentKeys) {
  return (inputKeys || []).map((key, index) => {
    const prior = currentKeys?.find((old) => old.id === key.id) || {};
    const incoming = key.endpoint && !String(key.endpoint).includes('******')
      ? key.endpoint
      : (key.apiKey && !String(key.apiKey).includes('******') ? key.apiKey : '');
    const apiKey = extractDwellirApiKey(incoming) || prior.apiKey || extractDwellirApiKey(prior.endpoint);
    const endpoint = apiKey ? normalizeEndpoint({ apiKey }) : normalizeEndpoint({ endpoint: prior.endpoint || incoming });
    return {
      id: key.id || prior.id || `api-${index}`,
      name: key.name || prior.name || `API ${index + 1}`,
      enabled: key.enabled !== false,
      endpoint
    };
  }).filter((key) => key.endpoint);
}

async function testDwellirKey(key, timeoutMs) {
  const startedAt = Date.now();
  const [http, ws] = await Promise.all([
    testHttpRpc(key.endpoint, timeoutMs),
    testWsRpc(toWsEndpoint(key.endpoint), timeoutMs)
  ]);
  return {
    id: key.id,
    name: key.name,
    endpoint: maskEndpoint(key.endpoint),
    wsEndpoint: maskEndpoint(toWsEndpoint(key.endpoint)),
    enabled: key.enabled,
    elapsedMs: Date.now() - startedAt,
    http,
    ws
  };
}

async function testHttpRpc(endpoint, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = JSON.parse(text);
    if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: healthSummary(payload.result)
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error.name === 'AbortError' ? '请求超时' : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

function testWsRpc(endpoint, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve({
        latencyMs: Date.now() - startedAt,
        ...result
      });
    };
    const timer = setTimeout(() => finish({ ok: false, error: '连接或响应超时' }), timeoutMs);
    try {
      ws = new WebSocket(endpoint);
      ws.on('open', () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }));
      });
      ws.on('message', (data) => {
        try {
          const payload = JSON.parse(data.toString());
          if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
          finish({ ok: true, detail: healthSummary(payload.result) });
        } catch (error) {
          finish({ ok: false, error: error.message });
        }
      });
      ws.on('error', (error) => finish({ ok: false, error: error.message }));
      ws.on('close', (code, reason) => {
        finish({ ok: false, error: `连接关闭 ${code}${reason ? `: ${reason}` : ''}` });
      });
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
  });
}

function healthSummary(result) {
  if (!result || typeof result !== 'object') return '';
  const peers = result.peers ?? result.numPeers;
  const syncing = result.isSyncing ?? result.shouldHavePeers;
  const parts = [];
  if (peers !== undefined) parts.push(`peers ${peers}`);
  if (syncing !== undefined) parts.push(`syncing ${syncing}`);
  return parts.join(', ');
}

function maskEndpoint(value) {
  return String(value || '').replace(/(api-bittensor-mainnet\.n\.dwellir\.com\/).+$/i, '$1******');
}

function sanitizeHotkeys(input, maxSubnets = 128) {
  const out = {};
  for (const [netuidText, hotkeyValue] of Object.entries(input || {})) {
    const netuid = Number(netuidText);
    const hotkey = sanitizeHotkey(hotkeyValue);
    if (!Number.isInteger(netuid) || netuid < 1 || netuid > maxSubnets) continue;
    if (!hotkey) continue;
    out[String(netuid)] = hotkey;
  }
  return out;
}

function sanitizeHotkey(value) {
  const hotkey = String(value || '').trim();
  if (!hotkey) return '';
  return /^[1-9A-HJ-NP-Za-km-z]{47,64}$/.test(hotkey) ? hotkey : '';
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function loginAttemptKey(req) {
  const username = String(req.body?.username || '').trim().toLowerCase();
  return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${username}`;
}

function getLoginAttempt(key) {
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    const fresh = { failures: 0, resetAt: now + LOGIN_WINDOW_MS, lockedUntil: 0 };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  return attempt;
}

function recordLoginFailure(key) {
  const attempt = getLoginAttempt(key);
  attempt.failures += 1;
  if (attempt.failures >= LOGIN_MAX_FAILURES) {
    attempt.lockedUntil = Date.now() + LOGIN_WINDOW_MS;
  }
  return attempt.failures;
}

function clearLoginAttempt(key) {
  loginAttempts.delete(key);
}

function loginFailureDelay(failures) {
  const exponentialDelay = LOGIN_BASE_DELAY_MS * (2 ** Math.max(0, failures - 1));
  return Math.min(LOGIN_MAX_DELAY_MS, exponentialDelay);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

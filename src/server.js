import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppLogger } from './logger.js';
import { DwellirPool, extractDwellirApiKey, normalizeEndpoint } from './dwellirPool.js';
import { BittensorMonitor } from './bittensorMonitor.js';
import { Notifier } from './notifier.js';
import { checkPassword, publicConfig, requireAuth } from './auth.js';
import { loadConfig, saveConfig } from './storage.js';
import { configureSniper, getSniper } from './sniper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
let config = loadConfig();
const logger = new AppLogger();
const getConfig = () => config;
const pool = new DwellirPool(getConfig, logger);
const notifier = new Notifier(getConfig, logger);
configureSniper({ getConfig, logger, notifier });
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

app.post('/api/sniper/balances', requireAuth, async (req, res) => {
  const walletList = await getSniper().refreshAllBalances();
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
    next.sniper.amountTao = clamp(body.sniper.amountTao, 0.001, 10000, current.sniper.amountTao);
    next.sniper.maxSlippage = clamp(body.sniper.maxSlippage, 0, 100, current.sniper.maxSlippage);
    next.sniper.maxRetries = clamp(body.sniper.maxRetries, 0, 1000, current.sniper.maxRetries);
    next.sniper.retryIntervalMs = clamp(body.sniper.retryIntervalMs, 0, 60000, current.sniper.retryIntervalMs);
    next.sniper.txTimeoutMs = clamp(body.sniper.txTimeoutMs, 1000, 30000, current.sniper.txTimeoutMs || 5000);

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

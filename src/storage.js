import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = path.join(rootDir, 'data');
export const configPath = path.join(dataDir, 'config.json');
export const statePath = path.join(dataDir, 'state.json');
export const hotkeyCachePath = path.join(dataDir, 'hotkey-cache.json');

const defaultHash = bcrypt.hashSync('admin123', 10);
const DEFAULT_SNIPER_HOTKEY = '5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde';

export const defaultConfig = {
  server: { port: Number(process.env.PORT || 3000) },
  auth: {
    username: process.env.WEB_USERNAME || 'admin',
    passwordHash: process.env.WEB_PASSWORD ? bcrypt.hashSync(process.env.WEB_PASSWORD, 10) : defaultHash
  },
  apiPool: {
    globalRps: 15,
    timeoutMs: 10000,
    retries: 2,
    keys: []
  },
  collector: {
    pollIntervalMs: 300000,
    verifyIntervalMs: 300000,
    blockTimeMs: 12000,
    maxSubnets: 128
  },
  telegram: {
    enabled: false,
    botToken: '',
    chatId: ''
  },
  github: {
    repo: process.env.GITHUB_REPO || '',
    branch: 'main'
  },
  sniper: {
    enabled: false,
    renameEnabled: false,
    swapEnabled: false,
    amountTao: 1.0,
    maxRetries: 5,
    burstCount: 1,
    retryIntervalMs: 200,
    txTimeoutMs: 5000,
    renameAmountTao: 1.0,
    renameMaxRetries: 5,
    renameBurstCount: 1,
    renameRetryIntervalMs: 200,
    renameTxTimeoutMs: 5000,
    swapAmountTao: 1.0,
    swapMaxRetries: 5,
    swapBurstCount: 1,
    swapRetryIntervalMs: 200,
    swapTxTimeoutMs: 5000,
    defaultHotkey: DEFAULT_SNIPER_HOTKEY,
    hotkeys: {}, // 格式: { "116": "hotkey 地址" }
    wallets: {} // 格式: { "address": { name: "备注", enabled: true } }
  }
};

export function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function mergeConfig(base, saved) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(saved || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(out[key] || {}), ...value }
      : value;
  }
  return out;
}

export function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(configPath)) {
    saveConfig(defaultConfig);
    return structuredClone(defaultConfig);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return mergeConfig(defaultConfig, raw);
}

export function saveConfig(config) {
  ensureDataDir();
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, configPath);
}

export function loadState() {
  ensureDataDir();
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(state) {
  ensureDataDir();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, statePath);
}

export function loadHotkeyCache() {
  ensureDataDir();
  if (!fs.existsSync(hotkeyCachePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(hotkeyCachePath, 'utf8'));
  } catch {
    return {};
  }
}

export function saveHotkeyCache(cache) {
  ensureDataDir();
  const tmp = `${hotkeyCachePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, hotkeyCachePath);
}

import { spawn } from 'node:child_process';
import path from 'node:path';
import { rootDir } from './storage.js';
import { toWsEndpoint } from './dwellirPool.js';

export class PythonCollector {
  constructor(pool, getConfig, logger) {
    this.pool = pool;
    this.getConfig = getConfig;
    this.logger = logger;
    this.exactAlphaCache = new Map();
    this.exactAlphaTimer = null;
    this.exactAlphaRunning = false;
    this.exactAlphaCursor = 0;
  }

  startExactAlphaUpdater(onUpdate) {
    clearInterval(this.exactAlphaTimer);
    const intervalMs = Math.max(1000, Number(process.env.EXACT_DEREGISTRATION_INTERVAL_MS || 1000));
    this.exactAlphaTimer = setInterval(() => {
      this.tickExactAlpha(onUpdate).catch((error) => {
        this.logger.warn('后台注销价更新失败', { error: error.message });
      });
    }, intervalMs);
    this.tickExactAlpha(onUpdate).catch((error) => {
      this.logger.warn('后台注销价启动更新失败', { error: error.message });
    });
  }

  async collect() {
    const key = this.pool.nextKey();
    const endpoint = toWsEndpoint(key.endpoint);
    this.logger.info('Python subnet 采集使用 Dwellir API', { name: key.name || key.id });
    const py = process.env.PYTHON_BIN || process.env.PYTHON || 'python3';
    const script = path.join(rootDir, 'scripts', 'bt_collector.py');
    const cfg = this.getConfig();
    const timeoutMs = Math.max(180000, Number(cfg.apiPool.timeoutMs || 10000) * 4);
    const data = await this.runPython(py, [
      script,
      '--endpoint', endpoint,
      '--block-time-ms', String(cfg.collector.blockTimeMs || 12000),
      '--exact-alpha-netuids', ''
    ], timeoutMs);
    mergeExactAlpha(data, this.exactAlphaSnapshot());
    return data;
  }

  async tickExactAlpha(onUpdate) {
    if (this.exactAlphaRunning) return;
    const netuid = this.nextDueExactNetuid();
    if (netuid == null) return;

    this.exactAlphaRunning = true;
    try {
      const cfg = this.getConfig();
      const key = this.pool.nextKey();
      const py = process.env.PYTHON_BIN || process.env.PYTHON || 'python3';
      const script = path.join(rootDir, 'scripts', 'bt_collector.py');
      const timeoutMs = Math.min(60000, Math.max(15000, Number(cfg.apiPool.timeoutMs || 10000) * 4));
      this.logger.info('后台注销价更新', { netuid, api: key.name || key.id });
      const result = await this.runPython(py, [
        script,
        '--endpoint', toWsEndpoint(key.endpoint),
        '--block-time-ms', String(cfg.collector.blockTimeMs || 12000),
        '--exact-alpha-netuids', String(netuid),
        '--exact-only'
      ], timeoutMs);
      const alphaStaked = nullableNumber(result.alphaStaked?.[String(netuid)]);
      if (alphaStaked != null && alphaStaked > 0) {
        this.exactAlphaCache.set(netuid, { alphaStaked, updatedAt: Date.now() });
        onUpdate?.({ netuid, alphaStaked, updatedAt: Date.now(), stats: this.exactAlphaStats() });
      }
    } catch (error) {
      this.logger.warn('后台注销价单项更新失败', { netuid, error: error.message });
    } finally {
      this.exactAlphaRunning = false;
    }
  }

  nextDueExactNetuid() {
    const netuids = exactDeregistrationNetuids();
    if (!netuids.length) return null;
    const ttlMs = Math.max(60000, Number(process.env.EXACT_DEREGISTRATION_TTL_MS || 60 * 60 * 1000));
    const now = Date.now();
    for (let i = 0; i < netuids.length; i += 1) {
      const index = (this.exactAlphaCursor + i) % netuids.length;
      const netuid = netuids[index];
      const cached = this.exactAlphaCache.get(netuid);
      if (!cached || now - cached.updatedAt >= ttlMs) {
        this.exactAlphaCursor = (index + 1) % netuids.length;
        return netuid;
      }
    }
    return null;
  }

  exactAlphaSnapshot() {
    const alphaStaked = {};
    for (const [netuid, item] of this.exactAlphaCache) {
      alphaStaked[String(netuid)] = item.alphaStaked;
    }
    return {
      alphaStaked,
      collectorStats: this.exactAlphaStats()
    };
  }

  exactAlphaStats() {
    return {
      alphaStakedCount: this.exactAlphaCache.size,
      alphaStaked116: this.exactAlphaCache.get(116)?.alphaStaked ?? null
    };
  }

  runPython(py, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(py, args, {
        cwd: rootDir,
        env: { ...process.env, PYTHONUTF8: '1' },
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Python 采集超时'));
      }, timeoutMs);
      child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
      child.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Python 采集退出码 ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`Python 采集结果解析失败: ${error.message}`));
        }
      });
    });
  }
}

function exactDeregistrationNetuids() {
  const configured = process.env.EXACT_DEREGISTRATION_NETUIDS;
  return configured ? parseNetuidList(configured) : Array.from({ length: 128 }, (_, i) => i + 1);
}

function parseNetuidList(value) {
  const seen = new Set();
  return String(value || '').split(',')
    .flatMap((part) => expandNetuidPart(part.trim()))
    .filter((netuid) => {
      if (!Number.isInteger(netuid) || netuid <= 0 || seen.has(netuid)) return false;
      seen.add(netuid);
      return true;
    });
}

function expandNetuidPart(part) {
  if (!part) return [];
  const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!range) return [Number(part)];
  const start = Number(range[1]);
  const end = Number(range[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function mergeExactAlpha(data, exact) {
  const alphaStaked = exact.alphaStaked || {};
  for (const subnet of data.subnets || []) {
    const value = nullableNumber(alphaStaked[String(subnet.netuid)]);
    if (value != null) subnet.alphaStaked = value;
  }
  data.collectorStats = {
    ...(data.collectorStats || {}),
    ...(exact.collectorStats || {})
  };
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

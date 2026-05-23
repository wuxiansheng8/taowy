import { spawn } from 'node:child_process';
import path from 'node:path';
import { rootDir } from './storage.js';
import { toWsEndpoint } from './dwellirPool.js';

export class PythonCollector {
  constructor(pool, getConfig, logger) {
    this.pool = pool;
    this.getConfig = getConfig;
    this.logger = logger;
  }

  async collect() {
    const key = this.pool.nextKey();
    const endpoint = toWsEndpoint(key.endpoint);
    this.logger.info('Python subnet 采集使用 Dwellir API', { name: key.name || key.id });
    const py = process.env.PYTHON_BIN || process.env.PYTHON || 'python3';
    const script = path.join(rootDir, 'scripts', 'bt_collector.py');
    const cfg = this.getConfig();
    const timeoutMs = Math.max(180000, Number(cfg.apiPool.timeoutMs || 10000) * 4);
    const exactNetuids = parseNetuidList(process.env.EXACT_DEREGISTRATION_NETUIDS || '116');
    const exactPromise = exactNetuids.length
      ? this.collectExactAlpha({ py, script, cfg, netuids: exactNetuids }).catch((error) => {
          this.logger.warn('精确注销价采集失败，主采集继续使用估算值', { error: error.message });
          return null;
        })
      : Promise.resolve(null);

    const data = await this.runPython(py, [
      script,
      '--endpoint', endpoint,
      '--block-time-ms', String(cfg.collector.blockTimeMs || 12000),
      '--exact-alpha-netuids', ''
    ], timeoutMs);
    const exact = await exactPromise;
    if (exact) mergeExactAlpha(data, exact);
    return data;
  }

  async collectExactAlpha({ py, script, cfg, netuids }) {
    const keys = this.pool.enabledKeys();
    if (!keys.length || !netuids.length) return null;
    const chunks = chunkRoundRobin(netuids, keys.length);
    const timeoutMs = Math.min(90000, Math.max(30000, Number(cfg.apiPool.timeoutMs || 10000) * 6));
    const jobs = chunks.map((chunk, index) => {
      if (!chunk.length) return null;
      const key = keys[index];
      this.logger.info('精确注销价使用 Dwellir API', { name: key.name || key.id, netuids: chunk.join(',') });
      return this.runPython(py, [
        script,
        '--endpoint', toWsEndpoint(key.endpoint),
        '--block-time-ms', String(cfg.collector.blockTimeMs || 12000),
        '--exact-alpha-netuids', chunk.join(','),
        '--exact-only'
      ], timeoutMs);
    }).filter(Boolean);
    const results = await Promise.allSettled(jobs);
    const merged = { alphaStaked: {}, collectorStats: { alphaStakedCount: 0, alphaStaked116: null } };
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        this.logger.warn('精确注销价分片采集失败', { error: result.reason?.message || String(result.reason) });
        continue;
      }
      Object.assign(merged.alphaStaked, result.value.alphaStaked || {});
    }
    merged.collectorStats.alphaStakedCount = Object.keys(merged.alphaStaked).length;
    merged.collectorStats.alphaStaked116 = nullableNumber(merged.alphaStaked['116']);
    return merged.collectorStats.alphaStakedCount ? merged : null;
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

function parseNetuidList(value) {
  const seen = new Set();
  return String(value || '').split(',')
    .map((part) => Number(part.trim()))
    .filter((netuid) => {
      if (!Number.isInteger(netuid) || netuid <= 0 || seen.has(netuid)) return false;
      seen.add(netuid);
      return true;
    });
}

function chunkRoundRobin(items, count) {
  const chunks = Array.from({ length: Math.max(1, count) }, () => []);
  items.forEach((item, index) => {
    chunks[index % chunks.length].push(item);
  });
  return chunks;
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

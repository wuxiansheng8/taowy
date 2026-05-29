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
    const collectorApi = {
      name: key.name || key.id,
      id: key.id,
      endpoint: maskEndpoint(endpoint)
    };
    this.logger.info('Python subnet 采集使用 Dwellir API', collectorApi);
    const py = process.env.PYTHON_BIN || process.env.PYTHON || 'python3';
    const script = path.join(rootDir, 'scripts', 'bt_collector.py');
    const cfg = this.getConfig();
    const timeoutMs = Math.max(180000, Number(cfg.apiPool.timeoutMs || 10000) * 4);
    const data = await this.runPython(py, [
      script,
      '--endpoint', endpoint,
      '--block-time-ms', String(cfg.collector.blockTimeMs || 12000)
    ], timeoutMs);
    data.collectorApi = collectorApi;
    return data;
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


function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

function maskEndpoint(endpoint) {
  return endpoint.replace(/(api-bittensor-mainnet\.n\.dwellir\.com\/).+$/i, '$1******');
}

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
    return new Promise((resolve, reject) => {
      const child = spawn(py, [
        script,
        '--endpoint', endpoint,
        '--block-time-ms', String(cfg.collector.blockTimeMs || 12000),
        '--exact-alpha-netuids', String(process.env.EXACT_DEREGISTRATION_NETUIDS || '116')
      ], {
        cwd: rootDir,
        env: { ...process.env, PYTHONUTF8: '1' },
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      const timeoutMs = Math.max(180000, Number(cfg.apiPool.timeoutMs || 10000) * 4);
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

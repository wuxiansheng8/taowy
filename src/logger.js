import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDataDir } from './storage.js';
import { bjIso } from './time.js';

const logPath = path.join(dataDir, 'app.ndjson');
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export class AppLogger {
  constructor() {
    ensureDataDir();
    this.listeners = new Set();
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  write(level, message, meta = {}) {
    const entry = {
      ts: Date.now(),
      bjTime: bjIso(),
      level,
      message,
      meta
    };
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    this.prune();
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  info(message, meta) { return this.write('info', message, meta); }
  warn(message, meta) { return this.write('warn', message, meta); }
  error(message, meta) { return this.write('error', message, meta); }
  alert(message, meta) { return this.write('alert', message, meta); }

  list({ q = '', level = '', page = 1, pageSize = 200 } = {}) {
    page = Math.max(1, Number(page) || 1);
    pageSize = Math.min(200, Math.max(1, Number(pageSize) || 200));

    if (!fs.existsSync(logPath)) {
      return { items: [], total: 0, page: 1, pageSize, totalPages: 0 };
    }

    const cutoff = Date.now() - LOG_RETENTION_MS;
    const allItems = fs.readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((item) => item && item.ts >= cutoff)
      .filter((item) => !level || item.level === level)
      .filter((item) => !q || JSON.stringify(item).toLowerCase().includes(q.toLowerCase()));

    const reversed = [...allItems].reverse();
    const total = reversed.length;
    const totalPages = Math.ceil(total / pageSize);

    const targetPage = totalPages > 0 ? Math.min(page, totalPages) : 1;
    const start = (targetPage - 1) * pageSize;
    const items = reversed.slice(start, start + pageSize);

    return {
      items,
      total,
      page: targetPage,
      pageSize,
      totalPages
    };
  }

  prune() {
    if (!fs.existsSync(logPath)) return;
    const cutoff = Date.now() - LOG_RETENTION_MS;
    const kept = fs.readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        try { return JSON.parse(line).ts >= cutoff; } catch { return false; }
      });
    fs.writeFileSync(logPath, `${kept.join('\n')}${kept.length ? '\n' : ''}`, 'utf8');
  }
}

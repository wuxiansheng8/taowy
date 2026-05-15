const $ = (sel) => document.querySelector(sel);
const state = { data: null, settings: null, logs: [], sort: 'netuid' };
let balanceRefreshTimer = null;

const pages = {
  dashboard: ['总览', $('#dashboardPage')],
  launches: ['新子网狙击抢跑', $('#launchesPage')],
  race: ['赛马/淘汰风险', $('#racePage')],
  settings: ['系统设置', $('#settingsPage')],
  logs: ['日志', $('#logsPage')]
};

setInterval(() => {
  $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
  renderUptime();
}, 1000);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) }
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

async function boot() {
  const me = await api('/api/me');
  if (me.user) showApp();
  else showLogin();
}

function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}

async function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  await Promise.all([loadDashboard(), loadSettings(), loadLogs()]);
  const es = new EventSource('/api/events');
  es.addEventListener('refresh', (ev) => updateDashboard(JSON.parse(ev.data)));
  es.addEventListener('head', (ev) => updateDashboard(JSON.parse(ev.data)));
  es.addEventListener('alert', (ev) => updateDashboard(JSON.parse(ev.data)));
  es.addEventListener('flow', (ev) => updateDashboard(JSON.parse(ev.data)));
  es.addEventListener('log', (ev) => {
    const entry = JSON.parse(ev.data);
    state.logs.push(entry);
    renderLogs();
    if (isSniperSuccessLog(entry)) scheduleBalanceRefresh();
  });
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUser').value, password: $('#loginPass').value })
    });
    showApp();
  } catch (error) {
    $('#loginMsg').textContent = error.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  location.reload();
});

document.querySelectorAll('.nav').forEach((btn) => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

function switchPage(name) {
  document.querySelectorAll('.nav').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === name));
  Object.entries(pages).forEach(([key, [, el]]) => el.classList.toggle('active', key === name));
  $('#pageTitle').textContent = pages[name][0];
}

$('#sortSelect').addEventListener('change', async (event) => {
  state.sort = event.target.value;
  if (state.data) {
    renderCards(state.data.subnets || []);
    return;
  }
  await loadDashboard();
});

$('#refreshBtn').addEventListener('click', async () => {
  $('#statusLine').textContent = '正在刷新...';
  updateDashboard(await api('/api/refresh', { method: 'POST', body: '{}' }));
});

async function loadDashboard() {
  updateDashboard(await api(`/api/dashboard?sort=${state.sort}`));
}

function updateDashboard(data) {
  state.data = data;
  $('#statusLine').textContent = `${data.status === 'ok' ? '已连接' : '等待配置'} · 更新 ${data.updatedAt ? fmtTime(data.updatedAt) : '--'}`;
  $('#statBlock').textContent = data.currentBlock || '--';
  $('#statCount').textContent = `${data.race?.currentSubnetCount || data.subnets.length}/${data.race?.maxSubnets || 128}`;
  $('#statFlow').textContent = flowText(data.chainFlow);
  renderUptime();
  if (data.lastAlert) {
    $('#alertBox').classList.remove('hidden');
    $('#alertBox').textContent = `最近提醒：区块 ${data.lastAlert.blockNumber} ${data.lastAlert.eventLabel || data.lastAlert.event}`;
  }
  renderCards(data.subnets || []);
  renderLaunches(data.launches || []);
  renderRace(data.race || {});
}

function renderCards(items) {
  $('#cards').innerHTML = sortSubnets(items, state.sort).map((s) => `
    <article class="card risk-${s.riskLevel}">
      <div class="card-head">
        <h3>${escapeHtml(s.name)} <span>(SN${s.netuid})</span></h3>
      </div>
      <div class="card-price-row">
        <strong class="card-price">${fmtTokenPrice(s.alphaPrice)}</strong>
        ${priceChangeBadge(s.priceChange10m)}
      </div>
      <div class="card-metrics">
        <div><span>当前市值</span><b>${fmtFixed(s.marketCap, 2, ' TAO')}</b></div>
        <div><span>1小时交易量</span><b>${fmtFixed(s.volume1h, 2)}</b></div>
        <div><span>24小时交易量</span><b>${fmtFixed(s.volume24h, 2)}</b></div>
        <div><span>注销价格</span><b>${fmtTokenPrice(s.deregistrationPrice ?? s.emaPrice)}</b></div>
      </div>
    </article>
  `).join('');
}

function sortSubnets(items, sort) {
  return [...items].sort((a, b) => {
    if (sort === 'volume1h') return num(b.volume1h, -1) - num(a.volume1h, -1) || num(a.netuid, 0) - num(b.netuid, 0);
    if (sort === 'volume24h') return num(b.volume24h, -1) - num(a.volume24h, -1) || num(a.netuid, 0) - num(b.netuid, 0);
    return num(a.netuid, 0) - num(b.netuid, 0);
  });
}

function renderLaunches(items) {
  const rows = [...items].slice(0, 10);
  $('#launchRows').innerHTML = rows.map((item) => `
    <tr>
      <td>${fmtTime(item.ts)}</td>
      <td>SN${escapeHtml(item.netuid)}</td>
      <td>${escapeHtml(item.name || '--')}</td>
      <td>${item.registrationBlock ?? '--'}</td>
      <td>${item.currentBlock ?? '--'}</td>
      <td>${escapeHtml(item.source || '--')}</td>
    </tr>
  `).join('') || '<tr><td colspan="6">暂无新子网上线记录</td></tr>';
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function renderRace(race) {
  $('#raceFacts').innerHTML = facts({
    '当前子网数量': race.currentSubnetCount ?? '--',
    '是否达到上限': race.atLimit ? '是' : '否',
    '当前注册成本': fmtFixed(race.registrationCost, 2, ' TAO'),
    '新区块保护': formatProtection(race.immunityPeriod),
    '当前区块高度': race.currentBlock ?? '--',
    '下一个可淘汰候选': race.nextPruneCandidate ?? '--',
    '不在免疫期数量': race.nonImmuneCount ?? '--'
  });
  $('#emaRows').innerHTML = (race.lowestEmaRanking || []).map((r) =>
    `<tr><td>${r.rank}</td><td>#${r.netuid} ${escapeHtml(r.name)}</td><td>${fmt(r.emaPrice)}</td></tr>`
  ).join('') || '<tr><td colspan="3">暂无数据</td></tr>';
  $('#immuneRows').innerHTML = (race.immuneSubnets || []).map((s) =>
    `<tr><td>#${s.netuid} ${escapeHtml(s.name)}</td><td>${s.registrationBlock ?? '--'}</td><td>${s.immunityEndsAtBlock ?? '--'}</td><td>${s.remainingText}</td></tr>`
  ).join('') || '<tr><td colspan="4">暂无免疫期 subnet</td></tr>';
}

function facts(map) {
  return Object.entries(map).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function formatProtection(blocks) {
  const n = Number(blocks);
  if (!Number.isFinite(n)) return '--';
  const days = Math.round((n * 12) / 86400);
  return `${n.toLocaleString('zh-CN')} ≈ ${days}天`;
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  const cfg = state.settings;
  const form = $('#settingsForm');
  form.globalRps.value = cfg.apiPool.globalRps;
  form.timeoutMs.value = cfg.apiPool.timeoutMs;
  form.retries.value = cfg.apiPool.retries;
  form.pollIntervalMs.value = cfg.collector.pollIntervalMs;
  form.verifyIntervalMs.value = cfg.collector.verifyIntervalMs;
  form.blockTimeMs.value = cfg.collector.blockTimeMs;
  form.tgEnabled.checked = cfg.telegram.enabled;
  form.botToken.value = cfg.telegram.botToken;
  form.chatId.value = cfg.telegram.chatId;
  form.webUsername.value = cfg.auth.username;
  populateSniperForm(cfg.sniper);
  renderApiRows(cfg.apiPool.keys || []);
}

function populateSniperForm(sniper = {}) {
  const form = $('#sniperForm');
  form.sniperEnabled.checked = Boolean(sniper.enabled);
  form.sniperAmountTao.value = sniper.amountTao ?? 1;
  form.sniperMaxSlippage.value = sniper.maxSlippage ?? 10;
  form.sniperMaxRetries.value = sniper.maxRetries ?? 5;
  form.sniperRetryIntervalMs.value = sniper.retryIntervalMs ?? 200;
  form.sniperTxTimeoutMs.value = sniper.txTimeoutMs ?? 5000;
  renderSniperWallets(sniper.walletList || []);
  renderHotkeyCache(sniper.hotkeyCache || []);
}

function renderApiRows(keys) {
  $('#apiList').innerHTML = keys.map((key, i) => apiRow(key, i)).join('');
}

function renderSniperWallets(wallets) {
  const container = $('#sniperWalletList');
  if (!container) return;
  if (!wallets.length) {
    container.innerHTML = '<p class="desc">未在 .env 中检测到钱包，请配置 SNIPER_MNEMONIC</p>';
    return;
  }
  container.innerHTML = '<h4>已识别的打新钱包</h4>' + wallets.map(w => sniperWalletRow(w)).join('');
}

function sniperWalletRow(w) {
  return `<div class="api-row sniper-wallet-row" data-address="${w.address}">
    <label class="check"><input data-field="enabled" type="checkbox" ${w.enabled !== false ? 'checked' : ''}>启用</label>
    <label>备注<input data-field="name" value="${escapeAttr(w.name || '')}" placeholder="小号 1"></label>
    <label>可用余额<input readonly value="${formatWalletBalance(w.freeTao)}" style="background:#f0f0f0;"></label>
    <label>地址<input readonly value="${w.address}" style="background:#f0f0f0;font-family:monospace;font-size:11px;"></label>
  </div>`;
}

function formatWalletBalance(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '查询中';
  return `${n.toLocaleString('zh-CN', { maximumFractionDigits: 6 })} TAO`;
}

function renderHotkeyCache(items) {
  const rows = (items || []).map((item) => `
    <tr>
      <td>SN${item.netuid}</td>
      <td class="mono">${item.hotkey ? escapeHtml(item.hotkey) : '--'}</td>
      <td>${escapeHtml(item.source || '--')}</td>
      <td>${item.updatedAt ? fmtTime(item.updatedAt) : '--'}</td>
    </tr>
  `).join('');
  $('#hotkeyRows').innerHTML = rows || '<tr><td colspan="4">暂无验证者缓存</td></tr>';
}

function apiRow(key, i) {
  return `<div class="api-row" data-id="${key.id || ''}">
    <label class="check"><input data-field="enabled" type="checkbox" ${key.enabled !== false ? 'checked' : ''}>启用</label>
    <label>名称<input data-field="name" value="${escapeAttr(key.name || `API ${i + 1}`)}"></label>
    <label>Endpoint 或 API Key<input data-field="endpoint" value="${escapeAttr(key.endpoint || key.apiKey || '')}" placeholder="https://.../key 或 key"></label>
    <label>单 key RPS<input data-field="perSecondLimit" type="number" min="1" value="${key.perSecondLimit || 20}"></label>
    <button type="button" data-remove>删除</button>
  </div>`;
}

$('#addApiBtn').addEventListener('click', () => {
  $('#apiList').insertAdjacentHTML('beforeend', apiRow({ id: `new-${Date.now()}`, enabled: true, perSecondLimit: 20 }, $('#apiList').children.length));
});

$('#apiList').addEventListener('click', (event) => {
  if (event.target.matches('[data-remove]')) event.target.closest('.api-row').remove();
});

$('#testTelegramBtn').addEventListener('click', async () => {
  const btn = $('#testTelegramBtn');
  btn.disabled = true;
  $('#settingsMsg').textContent = '正在发送 Telegram 测试...';
  try {
    const form = $('#settingsForm');
    await api('/api/telegram/test', {
      method: 'POST',
      body: JSON.stringify({
        telegram: {
          enabled: form.tgEnabled.checked,
          botToken: form.botToken.value.trim(),
          chatId: form.chatId.value.trim()
        }
      })
    });
    $('#settingsMsg').textContent = 'Telegram 测试已发送，请查看 TG';
  } catch (error) {
    $('#settingsMsg').textContent = error.message;
  } finally {
    btn.disabled = false;
  }
});

$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const keys = [...$('#apiList').querySelectorAll('.api-row')].map((row) => {
    const input = row.querySelector('[data-field="endpoint"]').value.trim();
    const apiKey = normalizeDwellirInput(input);
    return {
      id: row.dataset.id,
      enabled: row.querySelector('[data-field="enabled"]').checked,
      name: row.querySelector('[data-field="name"]').value.trim(),
      endpoint: apiKey ? `https://api-bittensor-mainnet.n.dwellir.com/${apiKey}` : input,
      apiKey,
      perSecondLimit: Number(row.querySelector('[data-field="perSecondLimit"]').value)
    };
  });
  const payload = {
    apiPool: {
      globalRps: Number(form.globalRps.value),
      timeoutMs: Number(form.timeoutMs.value),
      retries: Number(form.retries.value),
      keys
    },
    collector: {
      pollIntervalMs: Number(form.pollIntervalMs.value),
      verifyIntervalMs: Number(form.verifyIntervalMs.value),
      blockTimeMs: Number(form.blockTimeMs.value)
    },
    telegram: {
      enabled: form.tgEnabled.checked,
      botToken: form.botToken.value.trim(),
      chatId: form.chatId.value.trim()
    },
  };
  await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
  if (form.webPassword.value) {
    await api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ username: form.webUsername.value.trim(), password: form.webPassword.value })
    });
    form.webPassword.value = '';
  }
  $('#settingsMsg').textContent = '已保存';
  await loadSettings();
});

$('#sniperForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveSniperSettings(event.currentTarget);
  $('#sniperMsg').textContent = '已保存';
  await loadSettings();
});

$('#refreshBalancesBtn').addEventListener('click', async () => {
  const btn = $('#refreshBalancesBtn');
  btn.disabled = true;
  $('#sniperMsg').textContent = '正在检查余额...';
  try {
    await refreshSniperBalances();
    $('#sniperMsg').textContent = '余额已更新';
  } catch (error) {
    $('#sniperMsg').textContent = error.message;
  } finally {
    btn.disabled = false;
  }
});

function isSniperSuccessLog(entry) {
  return entry?.level === 'alert' && String(entry.message || '').includes('[打新成功]');
}

function scheduleBalanceRefresh() {
  clearTimeout(balanceRefreshTimer);
  balanceRefreshTimer = setTimeout(async () => {
    try {
      await refreshSniperBalances();
      $('#sniperMsg').textContent = '交易成功，余额已自动刷新';
    } catch (error) {
      $('#sniperMsg').textContent = `交易成功，余额刷新失败：${error.message}`;
    }
  }, 3000);
}

async function refreshSniperBalances() {
  const result = await api('/api/sniper/balances', { method: 'POST', body: '{}' });
  renderSniperWallets(result.walletList || []);
  return result.walletList || [];
}

$('#reloadWalletsBtn').addEventListener('click', async () => {
  const btn = $('#reloadWalletsBtn');
  btn.disabled = true;
  $('#sniperMsg').textContent = '正在重新读取 .env 钱包...';
  try {
    const result = await api('/api/sniper/reload-wallets', { method: 'POST', body: '{}' });
    renderSniperWallets(result.walletList || []);
    $('#sniperMsg').textContent = `钱包已刷新，识别到 ${(result.walletList || []).length} 个`;
  } catch (error) {
    $('#sniperMsg').textContent = error.message;
  } finally {
    btn.disabled = false;
  }
});

$('#manualBuyBtn').addEventListener('click', async () => {
  const form = $('#sniperForm');
  const netuid = Number(form.manualNetuid.value);
  if (!Number.isInteger(netuid) || netuid < 1 || netuid > 128) {
    $('#sniperMsg').textContent = '请输入 1-128 的子网编号';
    return;
  }
  const btn = $('#manualBuyBtn');
  btn.disabled = true;
  $('#sniperMsg').textContent = `正在保存设置并购买 SN${netuid}...`;
  try {
    const sniper = collectSniperSettings(form);
    const result = await api('/api/sniper/buy', {
      method: 'POST',
      body: JSON.stringify({ netuid, sniper })
    });
    $('#sniperMsg').textContent = result.ok
      ? `已触发 SN${netuid} 购买，hotkey ${shortAddress(result.hotkey)}，启用钱包 ${result.activeWallets} 个`
      : `未触发：${result.reason || '没有可用钱包'}`;
    await loadSettings();
  } catch (error) {
    $('#sniperMsg').textContent = error.message;
  } finally {
    btn.disabled = false;
  }
});

function collectSniperSettings(form) {
  return {
    enabled: form.sniperEnabled.checked,
    amountTao: Number(form.sniperAmountTao.value),
    maxSlippage: Number(form.sniperMaxSlippage.value),
    maxRetries: Number(form.sniperMaxRetries.value),
    retryIntervalMs: Number(form.sniperRetryIntervalMs.value),
    txTimeoutMs: Number(form.sniperTxTimeoutMs.value),
    wallets: [...document.querySelectorAll('.sniper-wallet-row')].reduce((acc, row) => {
      acc[row.dataset.address] = {
        enabled: row.querySelector('[data-field="enabled"]').checked,
        name: row.querySelector('[data-field="name"]').value.trim()
      };
      return acc;
    }, {})
  };
}

function shortAddress(address) {
  const text = String(address || '');
  if (text.length <= 14) return text || '--';
  return `${text.slice(0, 6)}...${text.slice(-6)}`;
}

async function saveSniperSettings(form) {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ sniper: collectSniperSettings(form) }) });
}

async function loadLogs() {
  const q = encodeURIComponent($('#logSearch').value || '');
  const level = encodeURIComponent($('#logLevel').value || '');
  state.logs = await api(`/api/logs?q=${q}&level=${level}`);
  renderLogs();
}

$('#logSearch').addEventListener('input', debounce(loadLogs, 300));
$('#logLevel').addEventListener('change', loadLogs);

function renderLogs() {
  const logs = [...state.logs].slice(-500).reverse();
  $('#logs').innerHTML = logs.map((log) => `
    <div class="log ${log.level}">
      <b>${escapeHtml(log.level)}</b>${escapeHtml(log.bjTime)} ${escapeHtml(log.message)}
      <pre>${escapeHtml(JSON.stringify(log.meta || {}, null, 2))}</pre>
    </div>
  `).join('') || '<div class="log">暂无日志</div>';
}

function fmt(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return escapeHtml(String(value));
  return `${n.toLocaleString('zh-CN', { maximumFractionDigits: 8 })}${suffix}`;
}

function fmtFixed(value, digits = 2, suffix = '') {
  if (value === null || value === undefined || value === '') return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return escapeHtml(String(value));
  return `${n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
}

function fmtTokenPrice(value) {
  if (value === null || value === undefined || value === '') return 'τ--';
  const n = Number(value);
  if (!Number.isFinite(n)) return `τ${escapeHtml(String(value))}`;
  return `τ${n.toLocaleString('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

function priceChangeBadge(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '<small class="price-change flat">10分钟 --</small>';
  if (Math.abs(n) < 0.0000005) return '<small class="price-change flat">10分钟 0.000000</small>';
  const cls = n > 0 ? 'up' : 'down';
  const sign = n > 0 ? '+' : '';
  return `<small class="price-change ${cls}">10分钟 ${sign}${fmtCompactDelta(n)}</small>`;
}

function fmtCompactDelta(value) {
  const n = Number(value);
  const abs = Math.abs(n);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function normalizeDwellirInput(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('******')) return '';
  const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0];
  try {
    const urlMatch = text.match(/(?:https?|wss?):\/\/[^\s]+/i);
    const url = new URL(urlMatch ? urlMatch[0] : text);
    return url.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return text.replace(/^\/+|\/+$/g, '');
  }
}

function fmtAmount(value) {
  const n = Number(value || 0);
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

function flowText(flow = {}) {
  const value = `${fmtAmount(flow.stakeTaoToday)}/${fmtAmount(flow.unstakeTaoToday)}`;
  if (flow.amountReliable === false) return `${value}（部分金额未识别）`;
  return value;
}

function renderUptime() {
  const el = $('#statUptime');
  if (!el) return;
  if (!state.data?.startedAt) {
    el.textContent = '--';
    return;
  }
  el.textContent = durationText(Date.now() - new Date(state.data.startedAt).getTime());
}

function durationText(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分`;
  if (hours > 0) return `${hours}小时 ${minutes}分 ${seconds}秒`;
  if (minutes > 0) return `${minutes}分 ${seconds}秒`;
  return `${seconds}秒`;
}

function fmtTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\n', ' ');
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

boot().catch((error) => {
  $('#loginMsg').textContent = error.message;
  showLogin();
});

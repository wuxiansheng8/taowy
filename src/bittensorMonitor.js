import { ApiPromise, WsProvider } from '@polkadot/api';
import { PythonCollector } from './pythonCollector.js';
import { blocksToDuration } from './time.js';
import { loadState, saveState } from './storage.js';
import { getSniper } from './sniper.js';

const STATE_VERSION = 7;
const MAX_FLOW_TAO_PER_EVENT = 100000;
const MAX_FLOW_ALPHA_PER_EVENT = 1000000000;
const TAO_USD_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd';
const TAO_USD_CACHE_MS = 5 * 60 * 1000;
const WS_CONNECT_TIMEOUT_MS = 8000;
const WS_SUBSCRIBE_TIMEOUT_MS = 8000;
const WS_URGENT_RECONNECT_ROUNDS = 2;
const CHAIN_FLOW_RECENT_RETENTION_MS = 48 * 60 * 60 * 1000;
const CHAIN_FLOW_DAILY_RETENTION_DAYS = 3;
const CHAIN_FLOW_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;
const CHAIN_FLOW_BACKFILL_CHECKPOINT_BLOCKS = 50;

const ZERO_STATE = {
  status: 'waiting',
  updatedAt: null,
  currentBlock: 0,
  taoUsdPrice: null,
  registrationCost: null,
  immunityPeriod: null,
  subnets: Array.from({ length: 128 }, (_, i) => ({
    netuid: i + 1,
    name: `Subnet ${i + 1}`,
    alphaPrice: null,
    registrationCost: null,
    emaPrice: null,
    marketCap: null,
    marketCapUsd: null,
    volume1h: null,
    volume24h: null,
    registrationBlock: null,
    immunityPeriod: null,
    inImmunity: false,
    raceEligible: false,
    riskLevel: 'unknown'
  })),
  race: {},
  chainFlow: {
    stakeTaoToday: 0,
    unstakeAlphaToday: 0,
    stakeEventsToday: 0,
    unstakeEventsToday: 0,
    indexedToBlock: 0,
    indexing: false,
    utcDate: utcDateKey(Date.now()),
    daily: {},
    recent: []
  },
  launches: [],
  lastAlert: null,
  errors: []
};

export class BittensorMonitor {
  constructor({ pool, getConfig, logger, notifier }) {
    this.pool = pool;
    this.getConfig = getConfig;
    this.logger = logger;
    this.notifier = notifier;
    this.python = new PythonCollector(pool, getConfig, logger);
    this.startedAt = Date.now();
    this.state = structuredClone(ZERO_STATE);
    this.clients = new Set();
    this.pollTimer = null;
    this.wsRotateTimer = null;
    this.api = null;
    this.currentWsApi = null;
    this.wsConnecting = null;
    this.lastSubnetSnapshot = new Map();
    this.volumeHistory = new Map();
    this.priceHistory = new Map();
    this.taoUsdCache = { value: null, fetchedAt: 0 };
    this.refreshPromise = null;
    this.lastChainFlowCheckpointAt = 0;
    this.restoreState();
    getSniper().setMonitor(this);
  }

  onUpdate(listener) {
    this.clients.add(listener);
    return () => this.clients.delete(listener);
  }

  emit(type = 'state') {
    const payload = { type, data: this.snapshot() };
    for (const client of this.clients) client(payload);
  }

  snapshot(sort = 'netuid') {
    const subnets = [...this.state.subnets].sort((a, b) => compareSubnets(a, b, sort));
    return {
      ...this.state,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      subnets
    };
  }

  async start() {
    this.schedule();
    this.connectWs().catch((error) => this.logger.warn('新区块订阅启动失败', { error: error.message }));
    this.refresh('启动采集').catch((error) => this.recordError(error));
    this.backfillTodayChainFlow('启动补扫').catch((error) => this.logger.warn('今日质押/解质押补扫失败', { error: error.message }));
  }

  schedule() {
    clearInterval(this.pollTimer);
    clearInterval(this.wsRotateTimer);
    const cfg = this.getConfig().collector;
    this.pollTimer = setInterval(() => this.refresh('定时采集').catch((e) => this.recordError(e)), cfg.pollIntervalMs || 60000);
    const wsRotateIntervalMs = Math.max(10 * 60 * 1000, Number(cfg.wsRotateIntervalMs || 30 * 60 * 1000));
    this.wsRotateTimer = setInterval(() => this.connectWs('定时轮换').catch((e) => this.recordError(e)), wsRotateIntervalMs);
  }

  async refresh(reason = '手动刷新') {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(reason).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async doRefresh(reason = '手动刷新') {
    try {
      const data = await this.collect();
      await this.applyCollected(data, reason);
      this.logger.info(`${reason}完成`, {
        block: this.state.currentBlock,
        subnetCount: this.state.race.currentSubnetCount,
        collectorApi: data.collectorApi || null,
        wsApi: this.currentWsApi || null
      });
      this.persistState();
      this.emit('refresh');
    } catch (error) {
      this.recordError(error);
      this.state.status = 'degraded';
      this.emit('error');
    }
    return this.snapshot();
  }

  async collect() {
    const [data, prune, taoUsdPrice] = await Promise.all([
      this.python.collect(),
      this.pool.rpc('subnetInfo_getSubnetToPrune').catch(() => null),
      this.fetchTaoUsdPrice().catch((error) => {
        this.logger.warn('TAO 美元价格获取失败', { error: error.message });
        return this.taoUsdCache.value;
      })
    ]);
    data.taoUsdPrice = taoUsdPrice;
    if (data.nextPruneCandidate == null && prune != null) data.nextPruneCandidate = parseMaybeNumber(prune);
    return data;
  }

  async applyCollected(data, reason = '采集') {
    if (!Array.isArray(data.subnets) || !data.subnets.length) {
      throw new Error('采集结果为空，保留上次快照');
    }
    const cfg = this.getConfig().collector;
    const taoUsdPrice = nullableNumber(data.taoUsdPrice ?? this.state.taoUsdPrice);
    const subnets = normalizeSubnets(this.decorateMetrics(data.subnets || []), data.registrationCost, data.immunityPeriod, data.currentBlock, cfg, taoUsdPrice);

    // 从上一次的状态缓存中复用 registrationCostPaid (如果注册区块号没有发生改变)
    const prevSubnetsMap = new Map((this.state.subnets || []).map(s => [s.netuid, s]));
    for (const s of subnets) {
      const prev = prevSubnetsMap.get(s.netuid);
      if (prev && prev.registrationBlock === s.registrationBlock && prev.registrationCostPaid != null) {
        s.registrationCostPaid = prev.registrationCostPaid;
      } else {
        s.registrationCostPaid = null;
      }
    }

    // 针对目前处于免疫期、但还不知道当时注册成本的子网进行历史查询 (查询注册区块的前一个区块的值，以获得注册前的实际成本)
    const subnetsToFetch = subnets.filter(s => s.inImmunity && s.registrationBlock != null && s.registrationBlock > 0 && s.registrationCostPaid === null);
    if (subnetsToFetch.length > 0) {
      this.logger.info(`开始获取 ${subnetsToFetch.length} 个免疫期子网的注册历史成本...`);
      await Promise.all(subnetsToFetch.map(async (s) => {
        try {
          const blockHash = await this.pool.rpc('chain_getBlockHash', [s.registrationBlock - 1]);
          if (blockHash) {
            const rawCost = await this.pool.rpc('subnetInfo_getLockCost', [blockHash]);
            const cost = Number(rawCost) / 1e9;
            if (Number.isFinite(cost)) {
              s.registrationCostPaid = cost;
              this.logger.info(`获取子网 SN${s.netuid} 注册成本成功: ${cost} TAO (注册于区块 ${s.registrationBlock})`);
            }
          }
        } catch (err) {
          this.logger.warn(`获取子网 SN${s.netuid} 在区块 ${s.registrationBlock - 1} 的注册成本失败`, { error: err.message });
        }
      }));
    }

    const ranked = [...subnets].filter((s) => s.raceEligible).sort((a, b) => num(a.emaPrice, Infinity) - num(b.emaPrice, Infinity));
    const nextPrune = data.nextPruneCandidate ?? ranked[0]?.netuid ?? null;
    const bottom10Netuids = new Set(ranked.slice(0, 10).map(s => s.netuid));
    for (const s of subnets) {
      if (s.inImmunity) {
        s.riskLevel = 'immune';
      } else if (s.netuid === nextPrune || bottom10Netuids.has(s.netuid)) {
        s.riskLevel = 'warning';
      } else {
        s.riskLevel = 'watch';
      }
    }
    const immune = subnets.filter((s) => s.inImmunity).sort((a, b) => num(a.immunityEndsAtBlock, 0) - num(b.immunityEndsAtBlock, 0));
    const snapshot = buildSubnetSnapshot(subnets);
    this.detectSubnetDiff(snapshot, reason, data.currentBlock || this.state.currentBlock);
    this.lastSubnetSnapshot = snapshot;
    this.state = {
      status: 'ok',
      updatedAt: new Date().toISOString(),
      currentBlock: data.currentBlock || this.state.currentBlock,
      taoUsdPrice,
      registrationCost: data.registrationCost ?? null,
      immunityPeriod: data.immunityPeriod ?? null,
      subnets,
      race: {
        currentSubnetCount: subnets.length,
        maxSubnets: cfg.maxSubnets || 128,
        atLimit: subnets.length >= (cfg.maxSubnets || 128),
        registrationCost: data.registrationCost ?? null,
        immunityPeriod: data.immunityPeriod ?? null,
        currentBlock: data.currentBlock || null,
        nextPruneCandidate: data.nextPruneCandidate ?? ranked[0]?.netuid ?? null,
        nonImmuneCount: subnets.filter((s) => s.raceEligible).length,
        lowestEmaRanking: ranked.slice(0, 10).map((s, index) => ({ rank: index + 1, netuid: s.netuid, name: s.name, emaPrice: s.emaPrice })),
        immuneSubnets: immune.map((s) => ({
          netuid: s.netuid,
          name: s.name,
          registrationBlock: s.registrationBlock,
          immunityEndsAtBlock: s.immunityEndsAtBlock,
          remainingBlocks: s.remainingImmunityBlocks,
          remainingText: blocksToDuration(s.remainingImmunityBlocks || 0, cfg.blockTimeMs),
          registrationCostPaid: s.registrationCostPaid ?? null
        }))
      },
      chainFlow: this.prunedChainFlow(),
      launches: (this.state.launches || []).slice(0, 10),
      lastAlert: this.state.lastAlert,
      errors: this.state.errors.slice(-10)
    };
  }


  decorateMetrics(items) {
    const now = Date.now();
    const volumeCutoff = now - 25 * 60 * 60 * 1000;
    const priceCutoff = now - 30 * 60 * 1000;
    return items.map((item) => {
      const netuid = Number(item.netuid ?? item.netUID ?? item.uid ?? item.id);
      const rawVolume = nullableNumber(item.rawVolume ?? item.cumulativeVolume);
      const alphaPrice = nullableNumber(item.alphaPrice ?? item.alpha_price ?? item.price);
      const next = { ...item };
      if (Number.isFinite(netuid) && rawVolume != null) {
        const history = (this.volumeHistory.get(netuid) || []).filter((point) => point.ts >= volumeCutoff);
        history.push({ ts: now, value: rawVolume });
        this.volumeHistory.set(netuid, history);
        next.volume1h = item.volume1h ?? deltaSince(history, now - 60 * 60 * 1000);
        next.volume24h = item.volume24h ?? deltaSince(history, now - 24 * 60 * 60 * 1000);
      }
      if (Number.isFinite(netuid) && alphaPrice != null) {
        const history = (this.priceHistory.get(netuid) || []).filter((point) => point.ts >= priceCutoff);
        history.push({ ts: now, value: alphaPrice });
        this.priceHistory.set(netuid, history);
        next.priceChange10m = deltaFromPointAtOrBefore(history, now - 10 * 60 * 1000);
      }
      return next;
    });
  }

  async connectWs(reason = '启动订阅') {
    if (this.wsConnecting) return this.wsConnecting;
    this.wsConnecting = this.doConnectWs(reason).finally(() => {
      this.wsConnecting = null;
    });
    return this.wsConnecting;
  }

  async doConnectWs(reason = '启动订阅') {
    const keys = this.pool.enabledKeys();
    if (!keys.length) throw new Error('还没有配置可用的 Dwellir API');

    let lastError = null;
    const rounds = isUrgentWsReason(reason) ? WS_URGENT_RECONNECT_ROUNDS : 1;
    const totalAttempts = keys.length * rounds;
    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      const key = this.pool.nextKey();
      const endpoint = key.endpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
      const round = Math.floor(attempt / keys.length) + 1;
      const keyAttempt = (attempt % keys.length) + 1;
      let api = null;
      try {
        api = await this.createWsApi(endpoint);
        await this.subscribeNewHeads(api);

        this.persistChainFlowCheckpoint({ force: true });
        const previousApi = this.api;
        this.api = api;
        this.currentWsApi = {
          name: key.name || key.id,
          id: key.id,
          endpoint: maskEndpoint(endpoint)
        };
        if (previousApi) previousApi.disconnect().catch(() => {});

        this.attachDisconnectHandler(api);

        // 初始化打新钱包
        getSniper().init(this.api).catch(e => this.logger.error('Sniper init error:', e));

        this.logger.info('已订阅 Bittensor 新区块头', { reason, api: this.currentWsApi, attempt: attempt + 1, round });
        this.backfillTodayChainFlow(`${reason}后补扫`).catch((error) => this.logger.warn('今日质押/解质押补扫失败', { error: error.message }));
        return;
      } catch (error) {
        lastError = error;
        if (api) api.disconnect().catch(() => {});
        this.logger.warn(`WebSocket 连接失败，切换下一个 API (${attempt + 1}/${totalAttempts})`, {
          reason,
          endpoint: maskEndpoint(endpoint),
          round,
          keyAttempt,
          error: error.message
        });
      }
    }

    throw lastError || new Error(`所有 WebSocket API 均连接失败，已尝试 ${rounds} 轮`);
  }

  async createWsApi(endpoint) {
    const provider = new WsProvider(endpoint, 4000);
    let api = null;
    try {
      api = await withTimeout(
        ApiPromise.create({ provider, throwOnConnect: true }),
        WS_CONNECT_TIMEOUT_MS,
        'WebSocket 连接超时'
      );
      await withTimeout(api.isReady, WS_CONNECT_TIMEOUT_MS, 'WebSocket API 初始化超时');
      if (!api.isConnected) throw new Error('WebSocket API 未连接');
      return api;
    } catch (error) {
      if (api) api.disconnect().catch(() => {});
      else provider.disconnect?.();
      throw error;
    }
  }

  attachDisconnectHandler(apiInstance) {
    apiInstance.on('disconnected', () => {
      if (this.api !== apiInstance) return; // 忽略已被替换的老实例
      this.logger.warn('[监控] 检测到 WebSocket 连接已断开，启动自愈轮换...');
      this.connectWs('连接断开自愈').catch((err) => this.logger.error('[监控] 断线自愈重连失败:', err.message));
    });
  }

  async subscribeNewHeads(api) {
    await withTimeout(api.rpc.chain.subscribeNewHeads(async (header) => {
      const blockNumber = header.number.toNumber();
      this.state.currentBlock = blockNumber;
      this.emit('head');
      try {
        const hash = await api.rpc.chain.getBlockHash(blockNumber);
        const events = await api.query.system.events.at(hash);
        await this.handleEvents(blockNumber, events);
      } catch (error) {
        this.logger.warn('读取新区块 events 失败', { blockNumber, error: error.message });
      }
    }), WS_SUBSCRIBE_TIMEOUT_MS, '新区块订阅超时');
  }

  async handleEvents(blockNumber, events) {
    let flowChanged = false;
    for (const [index, record] of events.entries()) {
      const { event } = record;
      const section = event.section || '';
      const method = event.method || '';
      const text = `${section}.${method}`;
      if (/subtensor/i.test(section) && /(register|deregister|subnet|network|prune|identity)/i.test(method)) {
        const translated = translateSubtensorEvent(method, text);
        const payload = {
          blockNumber,
          event: text,
          eventLabel: translated.label,
          wsApi: this.currentWsApi || null,
          data: event.data?.toHuman?.() || event.data?.toString?.()
        };
        if (translated.lifecycle) {
          if (/SubnetAdded|NetworkAdded/i.test(method)) {
            const netuid = eventNumber(event.data, 0, 'netuid');
            if (netuid !== null) {
              getSniper().onNewSubnet(netuid, `Subnet ${netuid}`, event.data?.toHuman?.() || event.data?.toString?.());
            }
          }
          if (/SubnetRemoved|NetworkRemoved|SubnetPruned|NetworkPruned|Pruned/i.test(method)) {
            const netuid = eventNumber(event.data, 0, 'netuid');
            if (netuid !== null) {
              getSniper().clearProcessedNetuid(netuid);
            }
          }

          this.state.lastAlert = payload;
          this.persistState();
          this.notifier.alert(`区块 ${blockNumber}：${translated.label}`, payload).catch(() => {});
          this.emit('alert');

          await this.verifySubnetList('新区块事件校验');
        } else {
          this.logger.info(`区块 ${blockNumber}：${translated.label}`, payload);
        }
      }
      if (/^subtensor(Module)?$/i.test(section) && /^(StakeAdded|StakeRemoved)$/i.test(method)) {
        const human = event.data?.toHuman?.() || event.data?.toString?.();
        const raw = event.data?.toJSON?.() || human;
        const flow = flowFromStakeEvent(method, raw);
        if (flow) {
          this.recordChainFlow(flow, {
            ts: Date.now(),
            blockNumber,
            eventIndex: index,
            event: text,
            data: human,
            source: 'ws'
          });
          flowChanged = true;
        }
      }
    }
    this.advanceChainFlowIndexedToBlock(blockNumber);
    this.persistChainFlowCheckpoint({ force: flowChanged });
    if (flowChanged) this.emit('flow');
  }

  async backfillTodayChainFlow(reason = '今日补扫') {
    const api = this.api;
    if (!api?.isConnected) return;
    if (this.state.chainFlow?.indexing) return;
    const currentBlock = Number(this.state.currentBlock || 0);
    if (!Number.isFinite(currentBlock) || currentBlock <= 0) return;

    const today = utcDateKey(Date.now());
    const cfg = this.getConfig().collector || {};
    const blockTimeMs = Math.max(1000, Number(cfg.blockTimeMs || 12000));
    const utcStart = Date.parse(`${today}T00:00:00.000Z`);
    const approxStart = Math.max(1, currentBlock - Math.ceil((Date.now() - utcStart) / blockTimeMs) - 20);
    const fromBlock = Math.max(approxStart, Number(this.state.chainFlow.indexedToBlock || 0) + 1);
    if (fromBlock > currentBlock) return;

    if (fromBlock <= approxStart || !this.state.chainFlow.daily?.[today]) {
      this.state.chainFlow = resetDailyChainFlow(this.state.chainFlow, today);
    }
    this.state.chainFlow.indexing = true;
    this.logger.info('开始补扫今日质押/解质押事件', { reason, fromBlock, toBlock: currentBlock });
    let scanned = 0;
    try {
      for (let blockNumber = fromBlock; blockNumber <= currentBlock; blockNumber += 1) {
        const hash = await api.rpc.chain.getBlockHash(blockNumber);
        const events = await api.query.system.events.at(hash);
        this.recordChainFlowEvents(blockNumber, events, {
          ts: blockTimestampFromCurrent(blockNumber, currentBlock, blockTimeMs),
          source: 'backfill'
        });
        this.advanceChainFlowIndexedToBlock(blockNumber);
        scanned += 1;
        if (scanned % CHAIN_FLOW_BACKFILL_CHECKPOINT_BLOCKS === 0) {
          this.persistChainFlowCheckpoint({ force: true });
        }
        if (scanned % 100 === 0) await delay(1);
      }
      this.logger.info('今日质押/解质押事件补扫完成', {
        fromBlock,
        toBlock: currentBlock,
        scanned,
        stakeTaoToday: this.state.chainFlow.stakeTaoToday,
        unstakeAlphaToday: this.state.chainFlow.unstakeAlphaToday
      });
    } finally {
      this.state.chainFlow.indexing = false;
      this.state.chainFlow = this.prunedChainFlow();
      this.persistChainFlowCheckpoint({ force: true });
      this.emit('flow');
    }
  }

  advanceChainFlowIndexedToBlock(blockNumber) {
    const current = Number(this.state.chainFlow?.indexedToBlock || 0);
    const next = Number(blockNumber);
    if (!Number.isFinite(next) || next <= 0) return;
    this.state.chainFlow.indexedToBlock = Math.max(current, next);
  }

  persistChainFlowCheckpoint({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.lastChainFlowCheckpointAt < CHAIN_FLOW_CHECKPOINT_INTERVAL_MS) {
      return false;
    }
    this.lastChainFlowCheckpointAt = now;
    this.persistState();
    return true;
  }

  recordChainFlowEvents(blockNumber, events, { ts = Date.now(), source = 'backfill' } = {}) {
    for (const [index, record] of events.entries()) {
      const { event } = record;
      const section = event.section || '';
      const method = event.method || '';
      if (!/^subtensor(Module)?$/i.test(section) || !/^(StakeAdded|StakeRemoved)$/i.test(method)) continue;
      const human = event.data?.toHuman?.() || event.data?.toString?.();
      const raw = event.data?.toJSON?.() || human;
      const flow = flowFromStakeEvent(method, raw);
      if (!flow) continue;
      this.recordChainFlow(flow, {
        ts,
        blockNumber,
        eventIndex: index,
        event: `${section}.${method}`,
        data: human,
        source
      });
    }
  }

  recordChainFlow(flow, meta) {
    const utcDate = utcDateKey(meta.ts || Date.now());
    this.state.chainFlow = this.prunedChainFlowFrom(this.state.chainFlow);
    const daily = { ...(this.state.chainFlow.daily || {}) };
    const bucket = normalizeDailyFlowBucket(daily[utcDate], utcDate);
    const eventId = `${meta.blockNumber}-${meta.eventIndex}-${flow.flowType}`;
    if (bucket.seen.includes(eventId)) {
      this.state.chainFlow.daily = daily;
      return false;
    }

    bucket.seen.push(eventId);
    if (flow.flowType === 'stake') {
      bucket.stakeTao += flow.amount;
      bucket.stakeEvents += 1;
    } else {
      bucket.unstakeAlpha += flow.amount;
      bucket.unstakeEvents += 1;
    }
    daily[utcDate] = bucket;

    this.state.chainFlow.daily = daily;
    this.state.chainFlow.recent.push({
      ts: meta.ts || Date.now(),
      utcDate,
      blockNumber: meta.blockNumber,
      eventIndex: meta.eventIndex,
      event: meta.event,
      eventLabel: flow.flowType === 'stake' ? '买入/质押' : '卖出/解质押',
      flowType: flow.flowType,
      amount: flow.amount,
      unit: flow.unit,
      netuid: flow.netuid,
      source: meta.source,
      data: meta.data
    });
    this.state.chainFlow = this.prunedChainFlowFrom(this.state.chainFlow);
    return true;
  }

  restoreState() {
    const saved = loadState();
    if (!saved?.state) return;
    const subnets = saved.state.subnets || [];
    if (saved.version < 6) {
      for (const s of subnets) {
        s.registrationCostPaid = null;
      }
    }
    const restoredChainFlow = saved.version >= 7
      ? this.prunedChainFlowFrom(saved.state.chainFlow)
      : migrateLegacyChainFlow(saved.state.chainFlow);
    this.state = {
      ...structuredClone(ZERO_STATE),
      ...saved.state,
      subnets,
      chainFlow: restoredChainFlow,
      errors: []
    };
    this.lastSubnetSnapshot = buildSubnetSnapshot(this.state.subnets || []);
    this.volumeHistory = new Map(Object.entries(saved.volumeHistory || {}).map(([key, value]) => [Number(key), value]));
  }

  persistState() {
    const previous = loadState();
    const currentHasRealData = hasRealSubnetData(this.state.subnets);
    const previousHasRealData = hasRealSubnetData(previous?.state?.subnets);
    const state = currentHasRealData || !previousHasRealData
      ? this.state
      : {
          ...previous.state,
          status: this.state.status,
          currentBlock: this.state.currentBlock || previous.state.currentBlock,
          updatedAt: this.state.updatedAt || previous.state.updatedAt,
          chainFlow: this.state.chainFlow,
          lastAlert: this.state.lastAlert || previous.state.lastAlert,
          errors: []
        };
    saveState({
      version: STATE_VERSION,
      savedAt: new Date().toISOString(),
      state: {
        ...state,
        errors: []
      },
      volumeHistory: currentHasRealData
        ? Object.fromEntries(this.volumeHistory)
        : (previous?.volumeHistory || Object.fromEntries(this.volumeHistory))
    });
  }

  prunedChainFlow() {
    return this.prunedChainFlowFrom(this.state.chainFlow);
  }

  prunedChainFlowFrom(chainFlow) {
    const today = utcDateKey(Date.now());
    const cutoff = Date.now() - CHAIN_FLOW_RECENT_RETENTION_MS;
    const recent = (chainFlow?.recent || [])
      .filter((item) => item.ts >= cutoff)
      .map(normalizeFlowItem)
      .filter(Boolean)
      .slice(-5000);
    const daily = pruneDailyFlow(chainFlow?.daily, today);
    const todayBucket = normalizeDailyFlowBucket(daily[today], today);
    return {
      stakeTaoToday: roundAmount(todayBucket.stakeTao),
      unstakeAlphaToday: roundAmount(todayBucket.unstakeAlpha),
      unstakeTaoToday: null,
      stakeEventsToday: todayBucket.stakeEvents,
      unstakeEventsToday: todayBucket.unstakeEvents,
      indexedToBlock: Number(chainFlow?.indexedToBlock || 0),
      indexing: Boolean(chainFlow?.indexing),
      utcDate: today,
      daily,
      recent
    };
  }

  async verifySubnetList(reason = 'subnet list 校验') {
    await this.refresh(reason);
  }

  detectSubnetDiff(next, reason = '采集对比', currentBlock = null) {
    if (!this.lastSubnetSnapshot.size) return;
    const diff = diffSubnetSnapshots(this.lastSubnetSnapshot, next);
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      if (diff.added.length) this.recordLaunches(diff.added, reason, currentBlock);
      if (diff.removed.length) {
        for (const item of diff.removed) {
          getSniper().clearProcessedNetuid(item.netuid);
        }
      }
      if (diff.changed.length) {
        for (const item of diff.changed) {
          const nameChange = item.fields.find(f => f.field === 'name');
          if (nameChange) {
            getSniper().onSubnetNameChanged(item.netuid, nameChange.after, nameChange.before)
              .catch(err => this.logger.error('子网改名打新执行异常:', err));
          }
        }
      }
      this.notifier.alert(formatSubnetDiffAlert(diff), diff).catch(() => {});
    }
  }

  recordLaunches(items, source, currentBlock) {
    const existing = new Set((this.state.launches || []).map((item) => item.id));
    const created = items.map((item) => {
      const registrationBlock = nullableNumber(item.registrationBlock);
      const id = `${item.netuid}-${registrationBlock ?? currentBlock ?? Date.now()}`;

      // 触发自动打新 (如果是通过对比快照发现的)
      getSniper().onNewSubnet(item.netuid, item.name);

      return {
        id,
        ts: Date.now(),
        source,
        netuid: item.netuid,
        name: item.name || `Subnet ${item.netuid}`,
        registrationBlock,
        currentBlock: nullableNumber(currentBlock)
      };
    }).filter((item) => !existing.has(item.id));
    if (!created.length) return;
    this.state.launches = [...created, ...(this.state.launches || [])].slice(0, 10);
    this.logger.info('记录新子网上线', { launches: created.map((item) => ({ netuid: item.netuid, name: item.name, source: item.source })) });
  }

  recordError(error) {
    const item = { ts: Date.now(), message: error.message };
    this.state.errors.push(item);
    this.logger.warn('采集器异常', item);
  }

  async fetchTaoUsdPrice() {
    const now = Date.now();
    if (this.taoUsdCache.value != null && now - this.taoUsdCache.fetchedAt < TAO_USD_CACHE_MS) {
      return this.taoUsdCache.value;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      try {
        const res = await fetch(TAO_USD_PRICE_URL, {
          headers: { accept: 'application/json' },
          signal: controller.signal
        });
        if (res.ok) {
          const json = await res.json();
          const value = nullableNumber(json?.bittensor?.usd);
          if (value != null && value > 0) {
            this.taoUsdCache = { value, fetchedAt: now };
            return value;
          }
        }
      } catch (cgError) {
        this.logger.warn('CoinGecko TAO 价格获取失败，尝试备用源', { error: cgError.message });
      }

      // Fallback to Binance
      const binanceRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=TAOUSDT', {
        signal: controller.signal
      });
      if (!binanceRes.ok) throw new Error(`Binance HTTP ${binanceRes.status}`);
      const binanceJson = await binanceRes.json();
      const binanceValue = nullableNumber(binanceJson?.price);
      if (binanceValue == null || binanceValue <= 0) throw new Error('Binance 价格响应无效');
      this.taoUsdCache = { value: binanceValue, fetchedAt: now };
      return binanceValue;
    } catch (error) {
      this.logger.warn('所有 TAO 价格接口均获取失败', { error: error.message });
      if (this.taoUsdCache.value != null) {
        return this.taoUsdCache.value;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeSubnets(items, registrationCost, immunityPeriod, currentBlock, cfg, taoUsdPrice = null) {
  const block = Number(currentBlock || 0);
  const fallback = Array.from({ length: cfg.maxSubnets || 128 }, (_, i) => ({ netuid: i + 1 }));
  const source = items.length ? items : fallback;
  return source.map((item) => {
    const netuid = Number(item.netuid ?? item.netUID ?? item.uid ?? item.id);
    const regBlock = nullableNumber(item.registrationBlock ?? item.registration_block ?? item.createdAtBlock);
    const imm = nullableNumber(item.immunityPeriod ?? item.immunity_period ?? immunityPeriod);
    const end = regBlock != null && imm != null ? regBlock + imm : null;
    const remaining = end != null ? Math.max(0, end - block) : null;
    const immunityKnown = end != null && block > 0;
    const inImmunity = immunityKnown ? remaining > 0 : false;
    const raceEligible = immunityKnown ? !inImmunity : false;
    const alphaIn = nullableNumber(item.alphaIn ?? item.alpha_in);
    const alphaOut = nullableNumber(item.alphaOut ?? item.alpha_out);
    const alphaStaked = nullableNumber(item.alphaStaked ?? item.alpha_staked ?? item.alphaStake ?? item.alpha_stake);
    const taoIn = nullableNumber(item.taoIn ?? item.tao_in);
    const marketCapTao = nullableNumber(item.marketCap ?? item.market_cap ?? item.marketCapTao ?? item.market_cap_tao)
      ?? computeMarketCap(item);
    const liquidationPrice = computeLiquidationPrice(item);
    const marketCapUsd = marketCapTao != null && taoUsdPrice != null ? marketCapTao * taoUsdPrice : null;
    return {
      netuid,
      name: item.name || item.subnetName || `Subnet ${netuid}`,
      alphaPrice: nullableNumber(item.alphaPrice ?? item.alpha_price ?? item.price),
      priceChange10m: nullableNumber(item.priceChange10m ?? item.price_change_10m),
      marketCap: marketCapTao,
      marketCapTao,
      marketCapUsd,
      liquidationPrice,
      deregistrationPrice: liquidationPrice, // For backward compatibility
      alphaIn,
      alphaOut,
      alphaStaked,
      taoIn,
      registrationCost: nullableNumber(item.registrationCost ?? item.registration_cost ?? registrationCost),
      registrationCostPaid: nullableNumber(item.registrationCostPaid),
      emaPrice: nullableNumber(item.emaPrice ?? item.ema_price ?? item.moving_price),
      volume1h: nullableNumber(item.volume1h ?? item.volume_1h),
      volume24h: nullableNumber(item.volume24h ?? item.volume_24h),
      registrationBlock: regBlock,
      immunityPeriod: imm,
      immunityEndsAtBlock: end,
      remainingImmunityBlocks: remaining,
      immunityKnown,
      inImmunity,
      raceEligible,
      riskLevel: immunityKnown ? (inImmunity ? 'immune' : (item.riskLevel || 'watch')) : 'unknown'
    };
  }).filter((item) => Number.isFinite(item.netuid)).sort((a, b) => a.netuid - b.netuid);
}

function computeMarketCap(item) {
  const price = nullableNumber(item.alphaPrice ?? item.alpha_price ?? item.price);
  const alphaIn = nullableNumber(item.alphaIn ?? item.alpha_in);
  const alphaOut = nullableNumber(item.alphaOut ?? item.alpha_out);
  const supply = (alphaIn != null ? alphaIn : 0) + (alphaOut != null ? alphaOut : 0);
  if (!Number.isFinite(price) || !Number.isFinite(supply) || supply <= 0) return null;
  return price * supply;
}

function computeLiquidationPrice(item) {
  const taoIn = nullableNumber(item.taoIn ?? item.tao_in);
  const alphaOut = nullableNumber(item.alphaOut ?? item.alpha_out);
  if (!Number.isFinite(taoIn) || !Number.isFinite(alphaOut) || taoIn <= 0 || alphaOut <= 0) return null;
  return taoIn / alphaOut;
}

function hasRealSubnetData(subnets) {
  return Array.isArray(subnets) && subnets.some((item) => {
    if (!item || !Number.isFinite(Number(item.netuid))) return false;
    if (item.alphaPrice != null || item.marketCap != null || item.emaPrice != null || item.volume1h != null || item.volume24h != null) return true;
    return typeof item.name === 'string' && !/^Subnet \d+$/i.test(item.name);
  });
}

function isSubnetLifecycleEvent(method) {
  return /(subnet|network).*(add|added|remove|removed|deregister|prune)|^(SubnetAdded|SubnetRemoved|NetworkAdded|NetworkRemoved|SubnetPruned)$/i.test(method);
}

function translateSubtensorEvent(method, fallback) {
  const name = String(method || '');
  if (/NeuronRegistered/i.test(name)) return { label: '子网节点注册', lifecycle: false };
  if (/NeuronDeregistered|NeuronRemoved/i.test(name)) return { label: '子网节点注销', lifecycle: false };
  if (/Identity/i.test(name)) return { label: '子网信息更新', lifecycle: true };
  if (/SubnetAdded|NetworkAdded/i.test(name)) return { label: '新子网创建', lifecycle: true };
  if (/SubnetRemoved|NetworkRemoved/i.test(name)) return { label: '子网移除', lifecycle: true };
  if (/SubnetPruned|NetworkPruned|Pruned/i.test(name)) return { label: '子网被淘汰', lifecycle: true };
  if (isSubnetLifecycleEvent(name)) return { label: '子网生命周期变更', lifecycle: true };
  return { label: fallback, lifecycle: false };
}

function flowFromStakeEvent(method, data) {
  const name = String(method || '');
  if (/^StakeAdded$/i.test(name)) {
    const netuid = eventNumber(data, 4, 'netuid');
    if (isRootNetuid(netuid)) return null;
    return buildFlow('stake', eventTokenAmount(data, 2, 'tao_amount', 1e9), netuid, 'TAO', MAX_FLOW_TAO_PER_EVENT);
  }
  if (/^StakeRemoved$/i.test(name)) {
    const netuid = eventNumber(data, 4, 'netuid');
    if (isRootNetuid(netuid)) return null;
    return buildFlow('unstake', eventTokenAmount(data, 2, 'alpha_amount', 1e9), netuid, 'Alpha', MAX_FLOW_ALPHA_PER_EVENT);
  }
  return null;
}

function buildFlow(flowType, amount, netuid, unit, maxAmount) {
  if (!Number.isFinite(amount) || amount <= 0 || amount > maxAmount) return null;
  if (!Number.isFinite(Number(netuid)) || isRootNetuid(netuid)) return null;
  return { flowType, amount, unit, netuid: Number(netuid) };
}

function normalizeFlowItem(item) {
  if (!item || !['stake', 'unstake'].includes(item.flowType)) return null;
  const amount = Number(item.amount ?? item.amountTao);
  const netuid = Number(item.netuid);
  const unit = item.unit || (item.flowType === 'stake' ? 'TAO' : 'Alpha');
  const maxAmount = item.flowType === 'stake' ? MAX_FLOW_TAO_PER_EVENT : MAX_FLOW_ALPHA_PER_EVENT;
  if (!Number.isFinite(amount) || amount <= 0 || amount > maxAmount) return null;
  if (!Number.isFinite(netuid) || isRootNetuid(netuid)) return null;
  return { ...item, amount, unit, netuid };
}

function eventTokenAmount(data, index, key, scale) {
  const raw = eventValue(data, index, key);
  const n = parseNumeric(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / scale;
}

function eventNumber(data, index, key) {
  const n = parseNumeric(eventValue(data, index, key));
  return Number.isFinite(n) ? n : null;
}

function eventValue(data, index, key) {
  if (Array.isArray(data)) return data[index];
  if (data && typeof data === 'object') {
    if (data[key] !== undefined) return data[key];
    const snake = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    if (data[snake] !== undefined) return data[snake];
    return Object.values(data)[index];
  }
  return null;
}

function parseNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && 'value' in value) return parseNumeric(value.value);
  const text = String(value).replaceAll(',', '');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function isRootNetuid(netuid) {
  return Number(netuid) === 0;
}

function normalizeDailyFlowBucket(bucket, utcDate) {
  return {
    utcDate,
    stakeTao: Number(bucket?.stakeTao || 0),
    unstakeAlpha: Number(bucket?.unstakeAlpha || 0),
    stakeEvents: Number(bucket?.stakeEvents || 0),
    unstakeEvents: Number(bucket?.unstakeEvents || 0),
    seen: Array.isArray(bucket?.seen) ? bucket.seen.slice(-20000) : []
  };
}

function pruneDailyFlow(daily = {}, today = utcDateKey(Date.now())) {
  const keys = Object.keys(daily || {}).sort().slice(-CHAIN_FLOW_DAILY_RETENTION_DAYS);
  if (!keys.includes(today)) keys.push(today);
  return Object.fromEntries(keys.map((key) => [key, normalizeDailyFlowBucket(daily[key], key)]));
}

function resetDailyChainFlow(chainFlow, today = utcDateKey(Date.now())) {
  const next = {
    ...structuredClone(ZERO_STATE.chainFlow),
    ...(chainFlow || {}),
    utcDate: today,
    daily: pruneDailyFlow(chainFlow?.daily, today),
    recent: Array.isArray(chainFlow?.recent) ? chainFlow.recent : []
  };
  next.daily[today] = normalizeDailyFlowBucket(null, today);
  next.indexedToBlock = 0;
  return next;
}

function migrateLegacyChainFlow(chainFlow) {
  const today = utcDateKey(Date.now());
  const next = {
    ...structuredClone(ZERO_STATE.chainFlow),
    ...(chainFlow || {}),
    daily: {},
    recent: []
  };
  next.daily[today] = normalizeDailyFlowBucket(null, today);
  return next;
}

function roundAmount(value) {
  const n = Number(value || 0);
  return Number(n.toFixed(9));
}

function blockTimestampFromCurrent(blockNumber, currentBlock, blockTimeMs) {
  return Date.now() - Math.max(0, currentBlock - blockNumber) * blockTimeMs;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcDateKey(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ts));
}

function compareSubnets(a, b, sort) {
  if (sort === 'ema') return num(a.emaPrice, Infinity) - num(b.emaPrice, Infinity) || a.netuid - b.netuid;
  if (sort === 'marketCap') return marketCapValue(b) - marketCapValue(a) || a.netuid - b.netuid;
  if (sort === 'volume1h') return num(b.volume1h, -1) - num(a.volume1h, -1) || a.netuid - b.netuid;
  if (sort === 'volume24h') return num(b.volume24h, -1) - num(a.volume24h, -1) || a.netuid - b.netuid;
  return a.netuid - b.netuid;
}

function marketCapValue(item) {
  return num(item.marketCapUsd ?? item.marketCapTao ?? item.marketCap, -1);
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

function parseMaybeNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

function deltaSince(history, sinceTs) {
  if (history.length < 2) return null;
  const current = history[history.length - 1].value;
  let base = history[0].value;
  for (const point of history) {
    if (point.ts >= sinceTs) {
      base = point.value;
      break;
    }
  }
  const delta = current - base;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

function deltaFromPointAtOrBefore(history, sinceTs) {
  if (history.length < 2) return null;
  const current = history[history.length - 1].value;
  let base = null;
  for (const point of history) {
    if (point.ts <= sinceTs) base = point.value;
    else break;
  }
  if (base === null) return null;
  const delta = current - base;
  return Number.isFinite(delta) ? delta : null;
}

function buildSubnetSnapshot(subnets) {
  return new Map((subnets || [])
    .map((item) => {
      const netuid = Number(item.netuid);
      if (!Number.isFinite(netuid)) return null;
      return [netuid, {
        netuid,
        name: normalizeText(item.name),
        registrationBlock: nullableNumber(item.registrationBlock),
        immunityEndsAtBlock: nullableNumber(item.immunityEndsAtBlock)
      }];
    })
    .filter(Boolean)
    .sort(([a], [b]) => a - b));
}

function diffSubnetSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changedItems = [];
  for (const [netuid, next] of after) {
    const prev = before.get(netuid);
    if (!prev) {
      added.push(next);
      continue;
    }
    const fields = [];
    for (const field of ['name', 'registrationBlock', 'immunityEndsAtBlock']) {
      if (!sameSnapshotValue(prev[field], next[field])) {
        fields.push({ field, before: prev[field], after: next[field] });
      }
    }
    if (fields.length) changedItems.push({ netuid, name: next.name, fields });
  }
  for (const [netuid, prev] of before) {
    if (!after.has(netuid)) removed.push(prev);
  }
  return {
    added: added.sort((a, b) => a.netuid - b.netuid),
    removed: removed.sort((a, b) => a.netuid - b.netuid),
    changed: changedItems.sort((a, b) => a.netuid - b.netuid)
  };
}

function formatSubnetDiffAlert(diff) {
  const parts = ['检测到 subnet 变化'];
  if (diff.added.length) parts.push(`新增: ${formatSubnetList(diff.added)}`);
  if (diff.removed.length) parts.push(`移除: ${formatSubnetList(diff.removed)}`);
  if (diff.changed.length) parts.push(`字段变化: ${formatChangedSubnetList(diff.changed)}`);
  return parts.join('\n');
}

function formatSubnetList(items) {
  const limit = 30;
  const shown = items.slice(0, limit).map((item) => `#${item.netuid}${item.name ? ` ${item.name}` : ''}`);
  if (items.length > limit) shown.push(`另有 ${items.length - limit} 个`);
  return shown.join(', ');
}

function formatChangedSubnetList(items) {
  const limit = 12;
  const shown = items.slice(0, limit).map(formatChangedSubnet);
  if (items.length > limit) shown.push(`另有 ${items.length - limit} 个`);
  return shown.join('; ');
}

function formatChangedSubnet(item) {
  const fields = item.fields.map((change) => `${snapshotFieldLabel(change.field)} ${formatSnapshotValue(change.before)} -> ${formatSnapshotValue(change.after)}`).join(', ');
  return `#${item.netuid}${item.name ? ` ${item.name}` : ''} (${fields})`;
}

function snapshotFieldLabel(field) {
  return {
    name: '名称',
    registrationBlock: '注册区块',
    immunityEndsAtBlock: '免疫结束区块'
  }[field] || field;
}

function formatSnapshotValue(value) {
  return value === null || value === undefined || value === '' ? '--' : String(value);
}

function sameSnapshotValue(a, b) {
  return formatSnapshotValue(a) === formatSnapshotValue(b);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function num(value, fallback) {
  return value === null || value === undefined ? fallback : Number(value);
}

function maskEndpoint(endpoint) {
  return endpoint.replace(/(api-bittensor-mainnet\.n\.dwellir\.com\/).+$/i, '$1******');
}

function isUrgentWsReason(reason) {
  return /打新|交易|紧急/.test(String(reason || ''));
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

import { ApiPromise, WsProvider } from '@polkadot/api';
import { PythonCollector } from './pythonCollector.js';
import { blocksToDuration } from './time.js';
import { loadState, saveState } from './storage.js';
import { getSniper } from './sniper.js';

const STATE_VERSION = 5;
const MAX_FLOW_TAO_PER_EVENT = 100000;
const TAO_USD_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd';
const TAO_USD_CACHE_MS = 5 * 60 * 1000;

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
    unstakeTaoToday: 0,
    stakeEventsToday: 0,
    unstakeEventsToday: 0,
    utcDate: utcDateKey(Date.now()),
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
    this.wsConnecting = null;
    this.lastSubnetSnapshot = new Map();
    this.volumeHistory = new Map();
    this.priceHistory = new Map();
    this.taoUsdCache = { value: null, fetchedAt: 0 };
    this.refreshPromise = null;
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
      this.applyCollected(data, reason);
      this.logger.info(`${reason}完成`, {
        block: this.state.currentBlock,
        subnetCount: this.state.race.currentSubnetCount
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

  applyCollected(data, reason = '采集') {
    if (!Array.isArray(data.subnets) || !data.subnets.length) {
      throw new Error('采集结果为空，保留上次快照');
    }
    const cfg = this.getConfig().collector;
    const taoUsdPrice = nullableNumber(data.taoUsdPrice ?? this.state.taoUsdPrice);
    const subnets = normalizeSubnets(this.decorateMetrics(data.subnets || []), data.registrationCost, data.immunityPeriod, data.currentBlock, cfg, taoUsdPrice);
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
          remainingText: blocksToDuration(s.remainingImmunityBlocks || 0, cfg.blockTimeMs)
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
    if (this.api) {
      await this.api.disconnect();
      this.api = null;
    }
    const endpoint = this.pool.nextWsEndpoint();
    const provider = new WsProvider(endpoint, 5000);
    this.api = await ApiPromise.create({ provider, throwOnConnect: false });

    // 初始化打新钱包
    getSniper().init(this.api).catch(e => this.logger.error('Sniper init error:', e));

    await this.api.rpc.chain.subscribeNewHeads(async (header) => {
      const blockNumber = header.number.toNumber();
      this.state.currentBlock = blockNumber;
      this.emit('head');
      try {
        const hash = await this.api.rpc.chain.getBlockHash(blockNumber);
        const events = await this.api.query.system.events.at(hash);
        await this.handleEvents(blockNumber, events);
      } catch (error) {
        this.logger.warn('读取新区块 events 失败', { blockNumber, error: error.message });
      }
    });
    this.logger.info('已订阅 Bittensor 新区块头', { reason, endpoint: maskEndpoint(endpoint) });
  }

  async handleEvents(blockNumber, events) {
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
          data: event.data?.toHuman?.() || event.data?.toString?.()
        };
        if (translated.lifecycle) {
          if (/SubnetAdded|NetworkAdded/i.test(method)) {
            const netuid = eventNumber(event.data, 0, 'netuid');
            if (netuid !== null) {
              getSniper().onNewSubnet(netuid, `Subnet ${netuid}`, event.data?.toHuman?.() || event.data?.toString?.());
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
          this.state.chainFlow.recent.push({
            ts: Date.now(),
            utcDate: utcDateKey(Date.now()),
            blockNumber,
            event: text,
            eventLabel: flow.flowType === 'stake' ? '买入/质押' : '卖出/解质押',
            flowType: flow.flowType,
            amountTao: flow.amountTao,
            netuid: flow.netuid,
            data: human
          });
          this.state.chainFlow = this.prunedChainFlow();
          this.persistState();
          this.emit('flow');
        }
      }
    }
  }

  restoreState() {
    const saved = loadState();
    if (!saved?.state) return;
    this.state = {
      ...structuredClone(ZERO_STATE),
      ...saved.state,
      chainFlow: saved.version === STATE_VERSION ? this.prunedChainFlowFrom(saved.state.chainFlow) : structuredClone(ZERO_STATE.chainFlow),
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
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const recent = (chainFlow?.recent || [])
      .filter((item) => item.ts >= cutoff)
      .map(normalizeFlowItem)
      .filter(Boolean)
      .slice(-500);
    const todayItems = recent.filter((item) => item.utcDate === today);
    const stakeItems = todayItems.filter((item) => item.flowType === 'stake');
    const unstakeItems = todayItems.filter((item) => item.flowType === 'unstake');
    const stakeKnown = stakeItems.filter((item) => Number.isFinite(item.amountTao)).length;
    const unstakeKnown = unstakeItems.filter((item) => Number.isFinite(item.amountTao)).length;
    return {
      stakeTaoToday: sumAmounts(stakeItems),
      unstakeTaoToday: sumAmounts(unstakeItems),
      stakeEventsToday: stakeItems.length,
      unstakeEventsToday: unstakeItems.length,
      stakeAmountEventsToday: stakeKnown,
      unstakeAmountEventsToday: unstakeKnown,
      amountReliable: stakeKnown === stakeItems.length && unstakeKnown === unstakeItems.length,
      utcDate: today,
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
    return buildFlow('stake', eventTao(data, 2, 'tao_amount'), netuid);
  }
  if (/^StakeRemoved$/i.test(name)) {
    const netuid = eventNumber(data, 4, 'netuid');
    if (isRootNetuid(netuid)) return null;
    return buildFlow('unstake', eventTao(data, 2, 'tao_amount'), netuid);
  }
  return null;
}

function buildFlow(flowType, amountTao, netuid) {
  if (!Number.isFinite(amountTao) || amountTao <= 0 || amountTao > MAX_FLOW_TAO_PER_EVENT) return null;
  if (!Number.isFinite(Number(netuid)) || isRootNetuid(netuid)) return null;
  return { flowType, amountTao, netuid: Number(netuid) };
}

function normalizeFlowItem(item) {
  if (!item || !['stake', 'unstake'].includes(item.flowType)) return null;
  const amountTao = Number(item.amountTao);
  const netuid = Number(item.netuid);
  if (!Number.isFinite(amountTao) || amountTao <= 0 || amountTao > MAX_FLOW_TAO_PER_EVENT) return null;
  if (!Number.isFinite(netuid) || isRootNetuid(netuid)) return null;
  return { ...item, amountTao, netuid };
}

function eventTao(data, index, key) {
  const raw = eventValue(data, index, key);
  const n = parseNumeric(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 1e9;
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

function sumAmounts(items) {
  return items.reduce((total, item) => total + (Number.isFinite(item.amountTao) ? item.amountTao : 0), 0);
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

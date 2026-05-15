import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const HOTKEY_CACHE_TTL_MS = 60 * 60 * 1000;
const HOTKEY_WARM_LIMIT = 30;

class Sniper {
  constructor() {
    this.getConfig = () => ({});
    this.logger = console;
    this.notifier = { alert: async () => {} };
    this.api = null;
    this.keyring = null;
    this.walletMap = new Map();
    this.nextNonceByAddress = new Map();
    this.balanceByAddress = new Map();
    this.hotkeyByNetuid = new Map();
    this.isInitializing = false;
    this.processedNetuids = new Set();
  }

  configure({ getConfig, logger, notifier }) {
    if (getConfig) this.getConfig = getConfig;
    if (logger) this.logger = logger;
    if (notifier) this.notifier = notifier;
  }

  async init(api, { force = false } = {}) {
    if (this.isInitializing) return;
    this.isInitializing = true;
    try {
      this.api = api;
      const rawMnemonics = process.env.SNIPER_MNEMONIC;
      if (!rawMnemonics) {
        if (force) {
          this.walletMap.clear();
          this.nextNonceByAddress.clear();
          this.balanceByAddress.clear();
        }
        this.logger.warn('未配置 SNIPER_MNEMONIC，自动打新功能将不可用');
        return;
      }

      const mnemonics = rawMnemonics.split(',').map(m => m.trim()).filter(Boolean);

      await cryptoWaitReady();
      this.keyring = new Keyring({ type: 'sr25519' });
      this.walletMap.clear();
      this.nextNonceByAddress.clear();
      this.balanceByAddress.clear();

      for (const m of mnemonics) {
        try {
          const pair = this.keyring.addFromMnemonic(m);
          this.walletMap.set(pair.address, { pair });
          this.logger.info(`自动打新钱包已加载: ${pair.address}`);
        } catch (e) {
          this.logger.error(`加载助记词失败: ${m.slice(0, 10)}... 错误: ${e.message}`);
        }
      }

      await Promise.allSettled(Array.from(this.walletMap.keys()).map((address) => this.refreshWalletState(address)));
      this.logger.info(`共加载 ${this.walletMap.size} 个可用打新钱包`);
    } catch (error) {
      this.logger.error('初始化自动打新钱包失败:', error);
    } finally {
      this.isInitializing = false;
    }
  }

  async reloadWallets() {
    if (!this.api) throw new Error('链 API 尚未连接，无法刷新钱包');
    await this.init(this.api, { force: true });
    return this.getWalletsStatus();
  }

  // 获取当前所有钱包的状态（用于前端展示）
  getWalletsStatus() {
    const config = this.getConfig();
    const walletSettings = config.sniper?.wallets || {};
    this.refreshBalancesSoon();

    return Array.from(this.walletMap.keys()).map(address => {
      const setting = walletSettings[address] || {};
      const balance = this.balanceByAddress.get(address);
      return {
        address,
        name: setting.name || '',
        enabled: setting.enabled !== false, // 默认启用
        freeTao: balance?.freeTao ?? null,
        balanceUpdatedAt: balance?.updatedAt ?? null
      };
    });
  }

  getHotkeyCacheStatus(maxNetuid = 128) {
    return Array.from({ length: maxNetuid }, (_, index) => {
      const netuid = index + 1;
      const cached = this.hotkeyByNetuid.get(netuid);
      return {
        netuid,
        hotkey: cached?.hotkey || '',
        source: cached?.source || '',
        updatedAt: cached?.updatedAt ? new Date(cached.updatedAt).toISOString() : null
      };
    });
  }

  async onNewSubnet(netuid, name, eventData = null) {
    return this.executeSubnetBuy(netuid, name, {
      requireEnabled: true,
      dedupe: true,
      label: '多钱包打新',
      triggerText: '多钱包打新触发',
      eventData
    });
  }

  async buySubnet(netuid, name = null) {
    return this.executeSubnetBuy(netuid, name || `Subnet ${netuid}`, {
      requireEnabled: false,
      dedupe: false,
      label: '手动指定购买',
      triggerText: '手动指定购买触发',
      refreshBalances: true
    });
  }

  async executeSubnetBuy(netuid, name, options = {}) {
    if (!this.api) throw new Error('链 API 尚未连接，无法发起购买');
    const target = await this.resolveHotkey(netuid, options.eventData);
    if (!target?.hotkey) {
      const reason = `子网 #${netuid} 未找到可用 hotkey`;
      this.logger.warn(reason);
      return { ok: false, skipped: true, reason };
    }
    const targetHotkey = target.hotkey;
    const config = this.getConfig();
    const settings = config.sniper;

    if (options.requireEnabled && !settings?.enabled) return { ok: false, skipped: true, reason: '自动打新未启用' };
    if (options.dedupe && this.processedNetuids.has(netuid)) return { ok: false, skipped: true, reason: '子网已处理' };
    if (options.dedupe) this.processedNetuids.add(netuid);
    if (options.refreshBalances) await this.refreshAllBalances();

    const activePairs = [];
    const skippedWallets = [];
    const walletSettings = settings.wallets || {};
    const amountTao = settings.amountTao || 1.0;
    const maxRetries = settings.maxRetries === 0 ? Infinity : (settings.maxRetries || 5);
    const retryInterval = settings.retryIntervalMs ?? 200;
    const txTimeoutMs = settings.txTimeoutMs || 5000;

    for (const [address, data] of this.walletMap.entries()) {
      const setting = walletSettings[address] || {};
      if (setting.enabled === false) continue;
      const balance = this.balanceByAddress.get(address);
      if (balance && Number.isFinite(balance.freeTao) && balance.freeTao < amountTao) {
        skippedWallets.push({ address, name: setting.name || address.slice(-4), freeTao: balance.freeTao, reason: '余额不足' });
        this.logger.warn(`钱包【${setting.name || address.slice(-4)}】可用余额不足，跳过打新`, {
          address,
          freeTao: balance.freeTao,
          amountTao
        });
        continue;
      }
      activePairs.push({ pair: data.pair, name: setting.name || address.slice(-4) });
    }

    if (activePairs.length === 0) {
      this.logger.warn(`检测到子网 #${netuid}，但没有可用钱包`);
      return { ok: false, skipped: true, reason: '没有可用钱包', skippedWallets };
    }

    this.logger.info(`[${options.label || '打新'}] 检测到子网 #${netuid} (${name || '未知'})，启动 ${activePairs.length} 个钱包并发购买...`);

    Promise.all(activePairs.map(item =>
      this.executeSnipe(item.pair, item.name, netuid, amountTao, maxRetries, retryInterval, txTimeoutMs, targetHotkey)
    )).catch(err => {
      this.logger.error(`[${options.label || '打新'}] 异常:`, err);
    });

    this.notifier.alert(`[${options.triggerText || '打新触发'}] 子网 #${netuid}\n目标 hotkey: ${targetHotkey}\n开启钱包: ${activePairs.length} 个\n每单金额: ${amountTao} TAO`, { netuid, hotkey: targetHotkey })
      .catch(() => {});
    return { ok: true, netuid, hotkey: targetHotkey, activeWallets: activePairs.length, skippedWallets };
  }

  async executeSnipe(pair, walletName, netuid, amountTao, maxRetries, retryInterval, txTimeoutMs, targetHotkey) {
    let attempts = 0;
    const amountBigInt = BigInt(Math.floor(amountTao * 1e9));

    while (attempts <= maxRetries) {
      attempts++;
      try {
        this.logger.info(`[打新] 钱包【${walletName}】尝试购买 #${netuid} (第 ${attempts} 次)...`);

        const tx = this.api.tx.subtensorModule.addStake(targetHotkey, netuid, amountBigInt);
        const result = await this.sendTx(tx, pair, txTimeoutMs);

        if (result.success) {
          const msg = `[打新成功] 钱包: ${walletName}\n子网 #${netuid} 购买成功！\n耗时: 第 ${attempts} 次尝试\n交易哈希: ${result.hash}`;
          this.logger.info(msg);
          this.notifier.alert(msg, { netuid, wallet: pair.address, hash: result.hash });
          return;
        } else {
          throw new Error(result.error || '交易失败');
        }
      } catch (error) {
        const isLast = attempts > maxRetries;
        const errorMsg = error.message || String(error);
        this.logger.error(`[打新失败] 钱包【${walletName}】子网 #${netuid} 第 ${attempts} 次尝试失败: ${errorMsg}`);

        if (/HotKeyAccountNotExists/i.test(errorMsg)) {
          this.invalidateHotkey(netuid, targetHotkey, errorMsg);
          break;
        }
        if (isLast) break;
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      }
    }
  }

  async refreshNonce(address) {
    if (!this.api) return null;
    const nonce = await this.api.rpc.system.accountNextIndex(address);
    const nextNonce = Number(nonce.toString());
    this.nextNonceByAddress.set(address, nextNonce);
    return nextNonce;
  }

  async resolveHotkey(netuid, eventData = null) {
    const numericNetuid = Number(netuid);
    const cached = this.hotkeyByNetuid.get(numericNetuid);
    if (cached?.verified && Date.now() - cached.updatedAt < HOTKEY_CACHE_TTL_MS) return cached;
    const resolved = await this.querySubnetHotkey(netuid);
    if (resolved?.hotkey && await this.verifyHotkey(netuid, resolved.hotkey)) {
      const verified = { ...resolved, verified: true, updatedAt: Date.now() };
      this.hotkeyByNetuid.set(numericNetuid, verified);
      this.logger.info(`子网 #${netuid} 自动选择 hotkey`, resolved);
      return verified;
    }
    return null;
  }

  invalidateHotkey(netuid, hotkey, reason = '') {
    const numericNetuid = Number(netuid);
    const cached = this.hotkeyByNetuid.get(numericNetuid);
    if (cached?.hotkey === hotkey) {
      this.hotkeyByNetuid.delete(numericNetuid);
      this.logger.warn(`子网 #${netuid} hotkey 已失效并清除缓存`, { hotkey, reason });
    }
  }

  warmHotkeyCache(subnets = []) {
    if (!this.api) return;
    const staleNetuids = subnets
      .map((item) => Number(item?.netuid))
      .filter((netuid) => Number.isInteger(netuid) && netuid > 0)
      .filter((netuid) => {
        const cached = this.hotkeyByNetuid.get(netuid);
        return !cached || Date.now() - cached.updatedAt >= HOTKEY_CACHE_TTL_MS;
      })
      .slice(0, HOTKEY_WARM_LIMIT);
    if (!staleNetuids.length) return;
    Promise.allSettled(staleNetuids.map((netuid) => this.resolveHotkey(netuid)))
      .then(() => this.logger.info('Hotkey 缓存预热完成', { count: staleNetuids.length }))
      .catch(() => {});
  }

  hotkeyFromEvent(data) {
    const text = JSON.stringify(data || '');
    const match = text.match(/[1-9A-HJ-NP-Za-km-z]{47,48}/);
    return match ? match[0] : null;
  }

  async querySubnetHotkey(netuid) {
    const module = this.api.query.subtensorModule;
    if (!module) return null;
    for (const method of ['keys', 'hotkeys', 'uids', 'neurons']) {
      try {
        if (!module[method]?.entries) continue;
        const entries = await this.queryStorageEntries(module[method], netuid);
        const hotkey = this.hotkeyFromEntries(entries, netuid);
        if (hotkey) return { hotkey, source: `subtensorModule.${method}`, trusted: true };
      } catch {}
    }
    return null;
  }

  async queryStorageEntries(storage, netuid) {
    try {
      const scoped = await storage.entries(netuid);
      if (scoped?.length) return scoped;
    } catch {}
    try {
      const allEntries = await storage.entries();
      return this.filterEntriesByNetuid(allEntries, netuid);
    } catch {
      return [];
    }
  }

  filterEntriesByNetuid(entries, netuid) {
    const numericNetuid = Number(netuid);
    return (entries || []).filter(([storageKey, value]) => {
      const keyHuman = storageKey?.toHuman?.();
      const valueHuman = value?.toHuman?.();
      const keyArgs = Array.isArray(keyHuman) ? keyHuman : (Array.isArray(storageKey?.args) ? storageKey.args.map(arg => arg.toString()) : []);
      return this.containsNetuid(keyArgs, numericNetuid) || this.containsNetuid(valueHuman, numericNetuid);
    });
  }

  containsNetuid(value, netuid) {
    if (Array.isArray(value)) return value.some((item) => this.containsNetuid(item, netuid));
    if (value && typeof value === 'object') return Object.values(value).some((item) => this.containsNetuid(item, netuid));
    return Number(String(value).replace(/,/g, '')) === netuid;
  }

  hotkeyFromEntries(entries, netuid) {
    for (const [storageKey, value] of entries) {
      const keyHotkeys = this.hotkeysFromValue(storageKey?.toHuman?.() || storageKey?.toString?.());
      const valueHotkeys = this.hotkeysFromValue(value?.toHuman?.() || value?.toString?.());
      const hotkeys = [...keyHotkeys, ...valueHotkeys].filter((hotkey) => hotkey !== String(netuid));
      if (hotkeys.length) return hotkeys[hotkeys.length - 1];
    }
    return null;
  }

  hotkeysFromValue(data) {
    const text = JSON.stringify(data || '');
    return text.match(/[1-9A-HJ-NP-Za-km-z]{47,48}/g) || [];
  }

  async verifyHotkey(netuid, hotkey) {
    const module = this.api.query.subtensorModule;
    if (!module || !hotkey) return false;
    const checks = [
      () => module.hotkeys?.(netuid, hotkey),
      () => module.keys?.(netuid, hotkey),
      () => module.uids?.(netuid, hotkey),
      () => module.neurons?.(netuid, hotkey)
    ];
    for (const check of checks) {
      try {
        const value = await check();
        if (this.storageHasValue(value)) return true;
      } catch {}
    }
    return false;
  }

  storageHasValue(value) {
    if (!value) return false;
    if (value.isSome) return true;
    if (value.isEmpty) return false;
    const text = value.toString?.() || '';
    return Boolean(text && text !== '0' && text !== '[]' && text !== '{}');
  }

  async refreshBalance(address) {
    if (!this.api) return null;
    const account = await this.api.query.system.account(address);
    const freePlanck = BigInt(account.data.free.toString());
    const freeTao = Number(freePlanck) / 1e9;
    const balance = { freeTao, updatedAt: new Date().toISOString() };
    this.balanceByAddress.set(address, balance);
    return balance;
  }

  async refreshWalletState(address) {
    const [nonce] = await Promise.allSettled([
      this.refreshNonce(address),
      this.refreshBalance(address)
    ]);
    return nonce.status === 'fulfilled' ? nonce.value : null;
  }

  async refreshAllBalances() {
    await Promise.allSettled(Array.from(this.walletMap.keys()).map((address) => this.refreshWalletState(address)));
    return this.getWalletsStatus();
  }

  refreshBalancesSoon() {
    if (!this.api) return;
    for (const address of this.walletMap.keys()) {
      const cached = this.balanceByAddress.get(address);
      if (cached && Date.now() - Date.parse(cached.updatedAt) < 10000) continue;
      this.refreshBalance(address).catch(() => {});
    }
  }

  reserveNonce(address) {
    const nextNonce = this.nextNonceByAddress.get(address);
    if (!Number.isFinite(nextNonce)) return null;
    this.nextNonceByAddress.set(address, nextNonce + 1);
    return nextNonce;
  }

  async sendTx(tx, pair, txTimeoutMs = 5000) {
    return new Promise((resolve) => {
      let unsubscribe = null;
      let settled = false;
      const address = pair.address;
      const reservedNonce = this.reserveNonce(address);
      const options = {};
      if (reservedNonce !== null) options.nonce = reservedNonce;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (typeof unsubscribe === 'function') unsubscribe();
        resolve(result);
      };
      const timeout = setTimeout(() => {
        this.refreshNonce(address).catch(() => {});
        finish({ success: false, error: '交易提交超时' });
      }, txTimeoutMs);

      tx.signAndSend(pair, options, ({ status, dispatchError }) => {
        if (status.isInBlock || status.isFinalized) {
          this.refreshWalletState(address).catch(() => {});
          if (dispatchError) {
            let errorInfo = dispatchError.toString();
            if (dispatchError.isModule) {
              const decoded = this.api.registry.findMetaError(dispatchError.asModule);
              errorInfo = `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`;
            }
            finish({ success: false, error: errorInfo });
          } else {
            finish({ success: true, hash: status.asInBlock?.toHex() || status.asFinalized?.toHex() });
          }
        } else if (status.isError) {
          this.refreshNonce(address).catch(() => {});
          finish({ success: false, error: '网络错误' });
        }
      }).then((unsub) => {
        if (settled && typeof unsub === 'function') unsub();
        else unsubscribe = unsub;
      }).catch(error => {
        this.refreshNonce(address).catch(() => {});
        finish({ success: false, error: error.message });
      });
    });
  }
}

let instance = null;
export function getSniper() {
  if (!instance) instance = new Sniper();
  return instance;
}

export function configureSniper(deps) {
  getSniper().configure(deps);
}

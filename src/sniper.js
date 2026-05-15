import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

class Sniper {
  constructor() {
    this.getConfig = () => ({});
    this.logger = console;
    this.notifier = { alert: async () => {} };
    this.api = null;
    this.keyring = null;
    this.walletMap = new Map();
    this.nextNonceByAddress = new Map();
    this.isInitializing = false;
    this.processedNetuids = new Set();
  }

  configure({ getConfig, logger, notifier }) {
    if (getConfig) this.getConfig = getConfig;
    if (logger) this.logger = logger;
    if (notifier) this.notifier = notifier;
  }

  async init(api) {
    if (this.isInitializing) return;
    this.isInitializing = true;
    try {
      this.api = api;
      const rawMnemonics = process.env.SNIPER_MNEMONIC;
      if (!rawMnemonics) {
        this.logger.warn('未配置 SNIPER_MNEMONIC，自动打新功能将不可用');
        return;
      }

      const mnemonics = rawMnemonics.split(',').map(m => m.trim()).filter(Boolean);
      
      await cryptoWaitReady();
      this.keyring = new Keyring({ type: 'sr25519' });
      this.walletMap.clear();
      this.nextNonceByAddress.clear();

      for (const m of mnemonics) {
        try {
          const pair = this.keyring.addFromMnemonic(m);
          this.walletMap.set(pair.address, { pair });
          this.logger.info(`自动打新钱包已加载: ${pair.address}`);
        } catch (e) {
          this.logger.error(`加载助记词失败: ${m.slice(0, 10)}... 错误: ${e.message}`);
        }
      }

      await Promise.allSettled(Array.from(this.walletMap.keys()).map((address) => this.refreshNonce(address)));
      this.logger.info(`共加载 ${this.walletMap.size} 个可用打新钱包`);
    } catch (error) {
      this.logger.error('初始化自动打新钱包失败:', error);
    } finally {
      this.isInitializing = false;
    }
  }

  // 获取当前所有钱包的状态（用于前端展示）
  getWalletsStatus() {
    const config = this.getConfig();
    const walletSettings = config.sniper?.wallets || {};
    
    return Array.from(this.walletMap.keys()).map(address => {
      const setting = walletSettings[address] || {};
      return {
        address,
        name: setting.name || '',
        enabled: setting.enabled !== false // 默认启用
      };
    });
  }

  async onNewSubnet(netuid, name) {
    const config = this.getConfig();
    const settings = config.sniper;

    if (!settings?.enabled) return;
    if (this.processedNetuids.has(netuid)) return;
    this.processedNetuids.add(netuid);

    const activePairs = [];
    const walletSettings = settings.wallets || {};

    for (const [address, data] of this.walletMap.entries()) {
      const setting = walletSettings[address] || {};
      if (setting.enabled !== false) {
        activePairs.push({ pair: data.pair, name: setting.name || address.slice(-4) });
      }
    }

    if (activePairs.length === 0) {
      this.logger.warn(`检测到新子网 #${netuid}，但没有已启用的打新钱包`);
      return;
    }

    this.logger.info(`[多钱包打新] 检测到新子网 #${netuid} (${name || '未知'})，启动 ${activePairs.length} 个钱包并发购买...`);
    
    const amountTao = settings.amountTao || 1.0;
    const maxRetries = settings.maxRetries === 0 ? Infinity : (settings.maxRetries || 5);
    const retryInterval = settings.retryIntervalMs || 500;

    Promise.all(activePairs.map(item =>
      this.executeSnipe(item.pair, item.name, netuid, amountTao, maxRetries, retryInterval)
    )).catch(err => {
      this.logger.error(`[多钱包打新] 异常:`, err);
    });

    this.notifier.alert(`[多钱包打新触发] 检测到新子网 #${netuid}\n开启钱包: ${activePairs.length} 个\n每单金额: ${amountTao} TAO`, { netuid })
      .catch(() => {});
  }

  async executeSnipe(pair, walletName, netuid, amountTao, maxRetries, retryInterval) {
    let attempts = 0;
    const amountBigInt = BigInt(Math.floor(amountTao * 1e9));

    while (attempts <= maxRetries) {
      attempts++;
      try {
        this.logger.info(`[打新] 钱包【${walletName}】尝试购买 #${netuid} (第 ${attempts} 次)...`);

        const tx = this.api.tx.subtensorModule.addStake(pair.address, netuid, amountBigInt);
        const result = await this.sendTx(tx, pair);

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

  reserveNonce(address) {
    const nextNonce = this.nextNonceByAddress.get(address);
    if (!Number.isFinite(nextNonce)) return null;
    this.nextNonceByAddress.set(address, nextNonce + 1);
    return nextNonce;
  }

  async sendTx(tx, pair) {
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
      }, 12000);

      tx.signAndSend(pair, options, ({ status, dispatchError }) => {
        if (status.isInBlock || status.isFinalized) {
          this.refreshNonce(address).catch(() => {});
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

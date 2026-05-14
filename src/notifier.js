export class Notifier {
  constructor(getConfig, logger) {
    this.getConfig = getConfig;
    this.logger = logger;
  }

  async telegram(text, overrideConfig = null) {
    const cfg = overrideConfig || this.getConfig().telegram || {};
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return { ok: false, skipped: true };
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text })
      });
      if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
      return { ok: true };
    } catch (error) {
      this.logger.warn('Telegram 推送失败', { error: error.message });
      return { ok: false, error: error.message };
    }
  }

  async alert(message, meta = {}) {
    this.logger.alert(message, meta);
    await this.telegram(`TAO 子网提醒\n${message}`);
  }
}

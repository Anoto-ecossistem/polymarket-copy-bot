import { config, validateConfig } from './config.js';
import { TradeMonitor } from './monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import type { Trade } from './monitor.js';
import { TradeExecutor } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { logger } from './logger.js';

class PolymarketCopyBot {
  private monitor: TradeMonitor;
  private wsMonitor?: WebSocketMonitor;
  private executor: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private isRunning: boolean = false;
  private processedTrades: Set<string> = new Set();
  private botStartTime: number = 0;
  private readonly maxProcessedTrades = 10000;
  private stats = {
    tradesDetected: 0,
    tradesCopied: 0,
    tradesFailed: 0,
    totalVolume: 0,
  };

  constructor() {
    this.monitor = new TradeMonitor();
    this.executor = new TradeExecutor();
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions);
  }
  
  async initialize(): Promise<void> {
    logger.info('🤖 Polymarket Copy Trading Bot');
    logger.info('================================');
    logger.info(`Target wallet: ${config.targetWallet}`);
    logger.info(`Position multiplier: ${config.trading.positionSizeMultiplier * 100}%`);
    logger.info(`Max trade size: ${config.trading.maxTradeSize} USDC`);
    logger.info(`Order type: ${config.trading.orderType}`);
    logger.info(`Copy sells: ${config.trading.copySells ? 'Yes' : 'No (BUY only)'}`);
    logger.info(`WebSocket: ${config.monitoring.useWebSocket ? 'Enabled' : 'Disabled'}`);
    if (config.risk.maxSessionNotional > 0 || config.risk.maxPerMarketNotional > 0) {
      logger.info(`Risk caps: session=${config.risk.maxSessionNotional || '∞'} USDC, per-market=${config.risk.maxPerMarketNotional || '∞'} USDC`);
    }
    logger.info(`Auth mode: EOA (signature type 0)`);
    logger.info('================================\n');

    validateConfig();

    this.botStartTime = Date.now();
    logger.info(`⏰ Bot start time: ${new Date(this.botStartTime).toISOString()}`);
    logger.info('   (Only trades after this time will be copied)\n');

    await this.monitor.initialize();
    await this.executor.initialize();
    await this.reconcilePositions();

    if (config.monitoring.useWebSocket) {
      this.wsMonitor = new WebSocketMonitor();
      try {
        const wsAuth = this.executor.getWsAuth();
        const channel = config.monitoring.useUserChannel ? 'user' : 'market';
        await this.wsMonitor.initialize(this.handleNewTrade.bind(this), channel, wsAuth);
        logger.info(`✅ WebSocket monitor initialized (${channel} channel)\n`);

        if (channel === 'market' && config.monitoring.wsAssetIds.length > 0) {
          for (const assetId of config.monitoring.wsAssetIds) {
            await this.wsMonitor.subscribeToMarket(assetId);
          }
        }

        if (channel === 'user' && config.monitoring.wsMarketIds.length > 0) {
          for (const marketId of config.monitoring.wsMarketIds) {
            await this.wsMonitor.subscribeToCondition(marketId);
          }
        }
      } catch (error) {
        logger.error('⚠️  WebSocket initialization failed, falling back to REST API only');
        logger.error('   Error:', String(error));
        this.wsMonitor = undefined;
      }
    }
  }
  
  async start(): Promise<void> {
    this.isRunning = true;
    const monitoringMethods = [];
    if (this.wsMonitor) monitoringMethods.push('WebSocket');
    monitoringMethods.push('REST API');

    logger.info(`🚀 Bot started! Monitoring via: ${monitoringMethods.join(' + ')}\n`);

    while (this.isRunning) {
      try {
        await this.monitor.pollForNewTrades(this.handleNewTrade.bind(this));
        this.monitor.pruneProcessedHashes();
      } catch (error) {
        logger.error('Error in monitoring loop:', String(error));
      }

      await this.sleep(config.monitoring.pollInterval);
    }
  }
  
  private async handleNewTrade(trade: Trade): Promise<void> {
    if (trade.timestamp && trade.timestamp < this.botStartTime) {
      return;
    }

    const tradeKeys = this.getTradeKeys(trade);
    if (tradeKeys.some((key) => this.processedTrades.has(key))) {
      return;
    }

    for (const key of tradeKeys) {
      this.processedTrades.add(key);
    }
    this.pruneProcessedTrades();
    this.stats.tradesDetected++;

    logger.info('\n' + '='.repeat(50));
    logger.info(`🎯 NEW TRADE DETECTED`);
    logger.info(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    logger.info(`   Market: ${trade.market}`);
    logger.info(`   Side: ${trade.side} ${trade.outcome}`);
    logger.info(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    logger.info(`   Token ID: ${trade.tokenId}`);
    logger.info('='.repeat(50));

    if (trade.side === 'SELL' && !config.trading.copySells) {
      logger.warn('⚠️  Skipping SELL trade (COPY_SELLS=false, BUY-only mode)');
      return;
    }

    const copyNotional = this.executor.calculateCopySize(trade.size);

    if (trade.side === 'SELL') {
      const copyShares = this.executor.calculateSharesForNotional(copyNotional, trade.price);
      const position = this.positions.getPosition(trade.tokenId);
      if (!position || position.shares < copyShares) {
        logger.warn(`⚠️  Skipping SELL trade: insufficient position (have ${position?.shares?.toFixed(4) ?? 0}, need ${copyShares.toFixed(4)} shares)`);
        return;
      }
    }

    if (this.wsMonitor) {
      await this.wsMonitor.subscribeToMarket(trade.tokenId);
    }
    const riskCheck = this.risk.checkTrade(trade, copyNotional);
    if (!riskCheck.allowed) {
      logger.warn(`⚠️  Risk check blocked trade: ${riskCheck.reason}`);
      return;
    }

    try {
      const result = await this.executor.executeCopyTrade(trade, copyNotional);
      this.risk.recordFill({
        trade,
        notional: result.copyNotional,
        shares: result.copyShares,
        price: result.price,
        side: result.side,
      });
      this.stats.tradesCopied++;
      this.stats.totalVolume += result.copyNotional;
      logger.info(`✅ Successfully copied trade!`);
      logger.info(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);

      if (config.run.exitAfterFirstSellCopy && result.side === 'SELL') {
        logger.info('\n🎯 EXIT_AFTER_FIRST_SELL_COPY: First SELL copied successfully. Exiting.');
        this.stop();
        process.exit(0);
      }
    } catch (error: any) {
      this.stats.tradesFailed++;
      logger.error(`❌ Failed to copy trade`);
      if (error?.message) {
        logger.error(`   Reason: ${error.message}`);
      }
      logger.info(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);
    }
  }

  private async reconcilePositions(): Promise<void> {
    try {
      const positions = await this.executor.getPositions();
      if (!positions || positions.length === 0) {
        logger.info('🧾 Positions: none found (fresh session)');
        return;
      }

      const { loaded, skipped } = this.positions.loadFromClobPositions(positions);
      const totalNotional = this.positions.getTotalNotional();
      logger.info(`🧾 Positions loaded: ${loaded} (skipped ${skipped}), total notional ≈ ${totalNotional.toFixed(2)} USDC`);
    } catch (error: any) {
      logger.warn(`🧾 Positions reconciliation failed: ${error.message || 'Unknown error'}`);
    }
  }
  
  stop(): void {
    this.isRunning = false;

    if (this.wsMonitor) {
      this.wsMonitor.close();
    }

    logger.info('\n🛑 Bot stopped');
    this.printStats();
  }
  
  printStats(): void {
    logger.info('\n📊 Session Statistics:');
    logger.info(`   Trades detected: ${this.stats.tradesDetected}`);
    logger.info(`   Trades copied: ${this.stats.tradesCopied}`);
    logger.info(`   Trades failed: ${this.stats.tradesFailed}`);
    logger.info(`   Total volume: ${this.stats.totalVolume.toFixed(2)} USDC`);
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getTradeKeys(trade: Trade): string[] {
    const keys: string[] = [];

    if (trade.txHash) {
      keys.push(trade.txHash);
    }

    const fallbackKey = `${trade.tokenId}|${trade.side}|${trade.size}|${trade.price}|${trade.timestamp}`;
    keys.push(fallbackKey);

    return keys;
  }

  private pruneProcessedTrades(): void {
    if (this.processedTrades.size <= this.maxProcessedTrades) {
      return;
    }

    const entries = Array.from(this.processedTrades);
    this.processedTrades = new Set(entries.slice(-Math.floor(this.maxProcessedTrades / 2)));
  }
}

async function main() {
  const bot = new PolymarketCopyBot();
  
  process.on('SIGINT', () => {
    logger.info('\n\nReceived SIGINT, shutting down...');
    bot.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });
  
  try {
    await bot.initialize();
    await bot.start();
  } catch (error) {
    logger.fatal('Fatal error:', String(error));
    process.exit(1);
  }
}

main();

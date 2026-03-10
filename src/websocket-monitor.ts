import WebSocket from 'ws';
import { config } from './config.js';
import type { Trade } from './monitor.js';
import { logger } from './logger.js';

interface WebSocketMessage {
  event_type?: string;
  asset_id?: string;
  market?: string;
  price?: string;
  size?: string;
  channel?: string;
  event?: string;
}

interface LastTradeMessage {
  event_type: 'last_trade_price';
  asset_id: string;
  market: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  timestamp: number;
  outcome?: string;
  maker?: string;
  taker?: string;
}

export type WsChannel = 'market' | 'user';

export interface WsAuth {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export class WebSocketMonitor {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private connectPromise: Promise<void> | undefined;
  private isConnected = false;
  private subscribedAssets = new Set<string>();
  private subscribedMarkets = new Set<string>();
  private pingInterval: NodeJS.Timeout | null = null;
  private readonly WS_URL_MARKET = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  private readonly WS_URL_USER = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
  private channel: WsChannel = 'market';
  private auth: WsAuth | undefined;

  private onTradeCallback?: (trade: Trade) => Promise<void>;

  async initialize(
    onTrade: (trade: Trade) => Promise<void>,
    channel: WsChannel = 'market',
    auth?: WsAuth
  ): Promise<void> {
    this.onTradeCallback = onTrade;
    this.channel = channel;
    this.auth = auth;
    if (this.channel === 'user' && !this.auth) {
      throw new Error('User channel requires WebSocket auth (apiKey/secret/passphrase)');
    }

    if (!this.hasSubscriptions()) {
      logger.info('ℹ️  WebSocket waiting for first subscription before connecting');
      return;
    }

    await this.ensureConnected();
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.info('🔌 Connecting to Polymarket WebSocket...');
        const url = this.channel === 'user' ? this.WS_URL_USER : this.WS_URL_MARKET;
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          logger.info('✅ WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startPingInterval();
          this.sendInitialSubscribe();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          const reasonText = reason?.toString() || 'no reason';
          logger.error(`❌ WebSocket disconnected (code=${code}, reason=${reasonText})`);
          this.isConnected = false;
          this.ws = null;
          this.stopPingInterval();
          if (this.hasSubscriptions()) {
            this.attemptReconnect();
          }
        });

        this.ws.on('error', (error: Error) => {
          logger.error('WebSocket error:', error.message);
          reject(error);
        });

        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000);
      } catch (error) {
        reject(error);
      }
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }

  private hasSubscriptions(): boolean {
    if (this.channel === 'user') {
      return this.subscribedMarkets.size > 0;
    }
    return this.subscribedAssets.size > 0;
  }

  async subscribeToMarket(tokenId: string): Promise<void> {
    if (this.channel !== 'market') {
      logger.warn(`⚠️  subscribeToMarket ignored (current channel: ${this.channel})`);
      return;
    }

    if (this.subscribedAssets.has(tokenId)) {
      return;
    }

    this.subscribedAssets.add(tokenId);
    if (!this.isConnected || !this.ws) {
      logger.info(`ℹ️  Queued market subscription for ${tokenId}; connecting websocket`);
      await this.ensureConnected();
      return;
    }

    const subscribeMessage = {
      assets_ids: [tokenId],
      operation: 'subscribe',
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    logger.info(`📡 Subscribed to market: ${tokenId}`);
  }

  async subscribeToCondition(conditionId: string): Promise<void> {
    if (this.channel !== 'user') {
      logger.warn(`⚠️  subscribeToCondition ignored (current channel: ${this.channel})`);
      return;
    }
    if (this.subscribedMarkets.has(conditionId)) {
      return;
    }

    this.subscribedMarkets.add(conditionId);
    if (!this.isConnected || !this.ws) {
      logger.info(`ℹ️  Queued user-channel subscription for ${conditionId}; connecting websocket`);
      await this.ensureConnected();
      return;
    }

    const subscribeMessage = {
      markets: [conditionId],
      operation: 'subscribe',
      auth: this.buildWsAuth(),
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    logger.info(`📡 Subscribed to market (user channel): ${conditionId}`);
  }

  async unsubscribeFromMarket(tokenId: string): Promise<void> {
    if (this.channel !== 'market') {
      return;
    }
    if (!this.isConnected || !this.ws) {
      return;
    }

    const unsubscribeMessage = {
      assets_ids: [tokenId],
      operation: 'unsubscribe',
    };

    this.ws.send(JSON.stringify(unsubscribeMessage));
    this.subscribedAssets.delete(tokenId);
    logger.info(`📡 Unsubscribed from market: ${tokenId}`);
  }

  async unsubscribeFromCondition(conditionId: string): Promise<void> {
    if (this.channel !== 'user') {
      return;
    }
    if (!this.isConnected || !this.ws) {
      return;
    }

    const unsubscribeMessage = {
      markets: [conditionId],
      operation: 'unsubscribe',
      auth: this.buildWsAuth(),
    };

    this.ws.send(JSON.stringify(unsubscribeMessage));
    this.subscribedMarkets.delete(conditionId);
    logger.info(`📡 Unsubscribed from market (user channel): ${conditionId}`);
  }

  private handleMessage(data: string): void {
    if (!data || data === 'PING') {
      this.ws?.send('PONG');
      return;
    }
    if (data === 'PONG') {
      return;
    }

    try {
      const message = JSON.parse(data) as WebSocketMessage | LastTradeMessage;

      if ((message as WebSocketMessage).event === 'ping') {
        this.ws?.send(JSON.stringify({ event: 'pong' }));
        return;
      }

      if (message.event_type === 'last_trade_price') {
        this.handleTradeMessage(message as LastTradeMessage);
      }
    } catch (error) {
      logger.error('Error parsing WebSocket message:', String(error));
    }
  }

  private async handleTradeMessage(message: LastTradeMessage): Promise<void> {
    try {
      const targetLower = config.targetWallet.toLowerCase();
      const isMaker = message.maker?.toLowerCase() === targetLower;
      const isTaker = message.taker?.toLowerCase() === targetLower;

      if (!isMaker && !isTaker) {
        return;
      }

      const rawTimestamp = message.timestamp || Date.now();
      const normalizedTimestamp = rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;

      const trade: Trade = {
        txHash: `ws-${Date.now()}`,
        timestamp: normalizedTimestamp,
        market: message.market,
        tokenId: message.asset_id,
        side: message.side,
        price: parseFloat(message.price),
        size: parseFloat(message.size),
        outcome: this.normalizeOutcome(message.outcome),
      };

      logger.info(`⚡ WebSocket trade detected: ${trade.side} ${trade.size} USDC @ ${trade.price.toFixed(3)}`);

      // Trigger callback
      if (this.onTradeCallback) {
        await this.onTradeCallback(trade);
      }
    } catch (error) {
      logger.error('Error handling trade message:', String(error));
    }
  }

  private normalizeOutcome(value?: string): 'YES' | 'NO' | 'UNKNOWN' {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (normalized === 'YES' || normalized === 'NO') {
      return normalized;
    }
    return 'UNKNOWN';
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        try {
          this.ws.send('PING');
        } catch {
          this.ws.ping();
        }
      }
    }, 10000); // Ping every 10 seconds
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('❌ Max reconnection attempts reached. Giving up on WebSocket.');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    logger.info(`🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(async () => {
      try {
        await this.ensureConnected();

        if (this.channel === 'user') {
          for (const marketId of this.subscribedMarkets) {
            await this.subscribeToCondition(marketId);
          }
        } else {
          for (const assetId of this.subscribedAssets) {
            await this.subscribeToMarket(assetId);
          }
        }
      } catch (error) {
        logger.error('Reconnection failed:', String(error));
        this.attemptReconnect();
      }
    }, delay);
  }

  close(): void {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    logger.info('🔌 WebSocket connection closed');
  }

  getConnectionStatus(): {
    connected: boolean;
    subscribedMarkets: number;
    reconnectAttempts: number;
  } {
    return {
      connected: this.isConnected,
      subscribedMarkets: this.subscribedMarkets.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  private buildWsAuth(): { apikey: string; apiKey: string; secret: string; passphrase: string } | undefined {
    if (!this.auth) return undefined;
    return {
      apikey: this.auth.apiKey,
      apiKey: this.auth.apiKey,
      secret: this.auth.secret,
      passphrase: this.auth.passphrase,
    };
  }

  private sendInitialSubscribe(): void {
    if (!this.ws) return;

    const payload: any = { type: this.channel };
    if (this.channel === 'market') {
      payload.assets_ids = Array.from(this.subscribedAssets);
    } else {
      payload.markets = Array.from(this.subscribedMarkets);
      payload.auth = this.buildWsAuth();
    }

    // Only send if we have something to subscribe to
    if ((payload.assets_ids && payload.assets_ids.length) || (payload.markets && payload.markets.length)) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}

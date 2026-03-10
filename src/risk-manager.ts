import type { Trade } from './monitor.js';
import { config } from './config.js';
import { PositionTracker } from './positions.js';

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export class RiskManager {
  private sessionNotional = 0;
  private positions: PositionTracker;

  constructor(positions: PositionTracker) {
    this.positions = positions;
  }

  checkTrade(trade: Trade, copyNotional: number): RiskCheckResult {
    if (copyNotional <= 0) {
      return { allowed: false, reason: 'Copy notional is <= 0' };
    }

    if (config.risk.maxSessionNotional > 0) {
      const nextSession = this.sessionNotional + copyNotional;
      if (nextSession > config.risk.maxSessionNotional) {
        return {
          allowed: false,
          reason: `Session notional cap exceeded (${nextSession.toFixed(2)} > ${config.risk.maxSessionNotional})`,
        };
      }
    }

    if (config.risk.maxPerMarketNotional > 0 && trade.side === 'BUY') {
      const current = this.positions.getNotional(trade.tokenId);
      const next = current + copyNotional;
      if (next > config.risk.maxPerMarketNotional) {
        return {
          allowed: false,
          reason: `Per-market notional cap exceeded (${next.toFixed(2)} > ${config.risk.maxPerMarketNotional})`,
        };
      }
    }

    return { allowed: true };
  }

  recordFill(params: {
    trade: Trade;
    notional: number;
    shares: number;
    price: number;
    side: 'BUY' | 'SELL';
  }): void {
    this.sessionNotional += params.notional;
    this.positions.recordFill(params);
  }

  getSessionNotional(): number {
    return this.sessionNotional;
  }
}

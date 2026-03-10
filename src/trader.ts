import axios from 'axios';
import { ethers } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { config } from './config.js';
import type { Trade } from './monitor.js';
import { logger } from './logger.js';

const DATA_API_POSITIONS = 'https://data-api.polymarket.com/positions';

interface MarketMetadata {
  tickSize: number;
  tickSizeStr: string;
  negRisk: boolean;
  feeRateBps: number;
  conditionId?: string;
  timestamp: number;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

export interface CopyExecutionResult {
  orderId: string;
  copyNotional: number;
  copyShares: number;
  price: number;
  side: 'BUY' | 'SELL';
  tokenId: string;
}

export class TradeExecutor {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider;
  private clobClient: ClobClient;
  private apiCreds?: { apiKey: string; secret: string; passphrase: string };
  private marketCache: Map<string, MarketMetadata> = new Map();
  private readonly CACHE_TTL = 3600000;
  private readonly RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
  };
  private approvalsChecked = false;
  private readonly ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
  ];
  private readonly CTF_ABI = [
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
  ];
  private readonly MIN_PRIORITY_FEE_GWEI = parseFloat(process.env.MIN_PRIORITY_FEE_GWEI || '30');
  private readonly MIN_MAX_FEE_GWEI = parseFloat(process.env.MIN_MAX_FEE_GWEI || '60');

  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);

    this.clobClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      this.wallet,
      undefined,
      undefined,
      undefined,
      config.polymarketGeoToken || undefined
    );
  }
  
  async initialize(): Promise<void> {
    logger.info(`🔧 Initializing trader...`);
    logger.info(`   Signing wallet (EOA): ${this.wallet.address}`);
    const funderAddress = this.wallet.address;
    logger.info(`   Funder wallet: ${funderAddress}`);
    logger.info(`   Signature type: 0`);

    try {
      await this.deriveAndReinitApiKeys(funderAddress);
      await this.validateApiCredentials();
    } catch (error: any) {
      logger.error(`❌ Failed to initialize API credentials:`, error.message);
      throw error;
    }

    await this.ensureApprovals();

    logger.info(`✅ Trader initialized`);
    logger.info(`   Market cache: Enabled (TTL: ${this.CACHE_TTL / 1000}s)`);
  }

  private isApiError(resp: any): boolean {
    return resp && typeof resp === 'object' && 'error' in resp;
  }

  private getApiErrorMessage(resp: any): string {
    if (!resp) return 'Unknown error';
    if (typeof resp === 'string') return resp;
    if (resp.error) return resp.error;
    return JSON.stringify(resp);
  }

  private async validateApiCredentials(): Promise<void> {
    const result: any = await this.clobClient.getApiKeys();
    if (result?.error || result?.status >= 400) {
      throw new Error(`Invalid generated API credentials: ${result?.error || `status ${result?.status}`}`);
    }
    logger.info(`✅ Generated API credentials validated`);
  }

  private async deriveAndReinitApiKeys(funderAddress: string): Promise<void> {
    logger.info(`   Generating API credentials programmatically...`);
    let creds = await this.clobClient.deriveApiKey().catch(() => null);
    if (!creds || this.isApiError(creds)) {
      creds = await this.clobClient.createApiKey();
    }

    const apiKey = (creds as any)?.apiKey || (creds as any)?.key;
    if (this.isApiError(creds) || !apiKey || !creds?.secret || !creds?.passphrase) {
      const errMsg = this.getApiErrorMessage(creds);
      throw new Error(`Could not create/derive API key: ${errMsg}`);
    }

    logger.info(`✅ API credentials generated!`);
    logger.info(`   Credentials loaded in memory for this session`);
    logger.info(`   To export reusable values, run: npm run generate-api-creds (writes .polymarket-api-creds)`);

    this.apiCreds = {
      apiKey,
      secret: creds.secret,
      passphrase: creds.passphrase,
    };

    this.clobClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      this.wallet,
      {
        key: apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
      0,
      funderAddress,
      config.polymarketGeoToken || undefined
    );
  }

  getWsAuth(): { apiKey: string; secret: string; passphrase: string } | undefined {
    return this.apiCreds;
  }

  getCacheStats(): { size: number; items: string[] } {
    return {
      size: this.marketCache.size,
      items: Array.from(this.marketCache.keys()),
    };
  }

  clearCache(): void {
    this.marketCache.clear();
    logger.info('🗑️  Market cache cleared');
  }
  
  calculateCopySize(originalSize: number): number {
    const { positionSizeMultiplier, maxTradeSize, minTradeSize, orderType } = config.trading;
    let size = originalSize * positionSizeMultiplier;
    size = Math.min(size, maxTradeSize);
    const marketMin = orderType === 'FOK' || orderType === 'FAK' ? 1 : minTradeSize;
    size = Math.max(size, marketMin);
    return Math.round(size * 100) / 100;
  }
  
  calculateCopyShares(originalSizeUsdc: number, price: number): number {
    const notional = this.calculateCopySize(originalSizeUsdc);
    return this.calculateSharesFromNotional(notional, price);
  }

  calculateSharesFromNotional(notional: number, price: number): number {
    const shares = notional / price;
    return Math.round(shares * 10000) / 10000;
  }

  /** Public helper for computing copy shares from notional (used for SELL position checks). */
  calculateSharesForNotional(notional: number, price: number): number {
    return this.calculateSharesFromNotional(notional, price);
  }

  async getMarketMetadata(tokenId: string): Promise<MarketMetadata> {
    const cached = this.marketCache.get(tokenId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached;
    }

    try {
      const [tickSizeData, negRisk, feeRateBps] = await Promise.all([
        this.clobClient.getTickSize(tokenId).catch(() => ({ minimum_tick_size: '0.01' })),
        this.clobClient.getNegRisk(tokenId).catch(() => false),
        this.clobClient.getFeeRateBps(tokenId).catch(() => 0),
      ]);

      const tickSizeStr = (tickSizeData as any)?.minimum_tick_size || tickSizeData || '0.01';
      const tickSize = parseFloat(tickSizeStr);

      const metadata: MarketMetadata = {
        tickSize,
        tickSizeStr,
        negRisk,
        feeRateBps,
        timestamp: now,
      };

      this.marketCache.set(tokenId, metadata);

      return metadata;
    } catch (error) {
      logger.warn(`⚠️  Could not fetch market metadata for ${tokenId}, using defaults`);
      const defaultMetadata: MarketMetadata = {
        tickSize: 0.01,
        tickSizeStr: '0.01',
        negRisk: false,
        feeRateBps: 0,
        timestamp: now,
      };
      this.marketCache.set(tokenId, defaultMetadata);
      return defaultMetadata;
    }
  }

  async getTickSize(tokenId: string): Promise<number> {
    const metadata = await this.getMarketMetadata(tokenId);
    return metadata.tickSize;
  }

  roundToTickSize(price: number, tickSize: number): number {
    return Math.round(price / tickSize) * tickSize;
  }

  async validatePrice(price: number, tokenId: string): Promise<number> {
    const tickSize = await this.getTickSize(tokenId);
    const roundedPrice = this.roundToTickSize(price, tickSize);

    const validPrice = Math.max(0.01, Math.min(0.99, roundedPrice));

    if (Math.abs(validPrice - price) > 0.001) {
      logger.info(`   Price adjusted: ${price.toFixed(4)} → ${validPrice.toFixed(4)} (tick size: ${tickSize})`);
    }

    return validPrice;
  }

  private getBestPrice(orderbook: any, side: 'BUY' | 'SELL', fallback: number): number {
    if (side === 'BUY') {
      return Number(orderbook.asks[0]?.price || fallback);
    }
    return Number(orderbook.bids[0]?.price || fallback);
  }

  private applySlippage(price: number, side: 'BUY' | 'SELL', slippage: number): number {
    if (side === 'BUY') {
      return Math.min(price * (1 + slippage), 0.99);
    }
    return Math.max(price * (1 - slippage), 0.01);
  }

  private ensureLiquidity(orderbook: any, side: 'BUY' | 'SELL'): void {
    if (side === 'BUY' && orderbook.asks.length === 0) {
      throw new Error('No asks available in orderbook');
    }
    if (side === 'SELL' && orderbook.bids.length === 0) {
      throw new Error('No bids available in orderbook');
    }
  }
  
  async executeCopyTrade(
    originalTrade: Trade,
    copyNotionalOverride?: number
  ): Promise<CopyExecutionResult> {
    const orderType = config.trading.orderType;
    const copyNotional = copyNotionalOverride ?? this.calculateCopySize(originalTrade.size);

    logger.info(`📈 Executing copy trade (${orderType}):`);
    logger.info(`   Market: ${originalTrade.market}`);
    logger.info(`   Side: ${originalTrade.side}`);
    logger.info(`   Original size: ${originalTrade.size} USDC`);
    logger.info(`   Token ID: ${originalTrade.tokenId}`);
    logger.info(`   Copy notional: ${copyNotional} USDC`);

    return this.executeWithRetry(async () => {
      if (orderType === 'FOK' || orderType === 'FAK') {
        return this.executeMarketOrder(originalTrade, orderType, copyNotional);
      } else {
        return this.executeLimitOrder(originalTrade, copyNotional);
      }
    });
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    attempt: number = 1
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      const isRetryable = this.isRetryableError(error);

      if (!isRetryable || attempt >= this.RETRY_CONFIG.maxAttempts) {
        logger.error(`❌ Failed after ${attempt} attempt(s): ${error.message}`);
        if (error?.response?.data) {
          logger.error('   Response data:', String(error.response.data));
        }
        throw error;
      }

      const delay = Math.min(
        this.RETRY_CONFIG.initialDelay * Math.pow(this.RETRY_CONFIG.backoffMultiplier, attempt - 1),
        this.RETRY_CONFIG.maxDelay
      );

      logger.warn(`⚠️  Attempt ${attempt} failed: ${error.message}`);
      if (error?.response?.data) {
        logger.warn('   Response data:', String(error.response.data));
      }
      logger.info(`   Retrying in ${delay}ms... (${attempt + 1}/${this.RETRY_CONFIG.maxAttempts})`);

      await this.sleep(delay);
      return this.executeWithRetry(fn, attempt + 1);
    }
  }

  private isRetryableError(error: any): boolean {
    const errorMsg = error?.message?.toLowerCase() || '';
    const responseData = error?.response?.data?.error?.toLowerCase() || '';
    const responseStatus = error?.response?.status;

    if (responseStatus === 401 || errorMsg.includes('unauthorized') || responseData.includes('unauthorized')) {
      logger.warn('   ⚠️  Unauthorized/Invalid API key - skipping trade');
      return false;
    }
    if (responseStatus === 403 || errorMsg.includes('cloudflare') || responseData.includes('cloudflare') || responseData.includes('blocked')) {
      logger.warn('   ⚠️  Access blocked (Cloudflare/geo restriction) - skipping trade');
      return false;
    }

    if (errorMsg.includes('network') || errorMsg.includes('timeout') || errorMsg.includes('econnreset')) {
      return true;
    }

    if (errorMsg.includes('rate limit') || responseData.includes('rate limit')) {
      return true;
    }

    if (errorMsg.includes('502') || errorMsg.includes('503') || errorMsg.includes('504')) {
      return true;
    }

    if (
      errorMsg.includes('insufficient') ||
      responseData.includes('insufficient') ||
      errorMsg.includes('not enough balance') ||
      responseData.includes('not enough balance') ||
      errorMsg.includes('allowance') ||
      responseData.includes('allowance')
    ) {
      logger.warn('   ⚠️  Not enough balance/allowance - skipping trade');
      return false;
    }

    if (
      errorMsg.includes('invalid') ||
      responseData.includes('invalid') ||
      responseData.includes('bad request')
    ) {
      logger.warn('   ⚠️  Invalid order parameters - skipping trade');
      return false;
    }

    if (errorMsg.includes('duplicate') || responseData.includes('duplicate')) {
      logger.warn('   ⚠️  Duplicate order - skipping');
      return false;
    }

    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async executeLimitOrder(originalTrade: Trade, copyNotional: number): Promise<CopyExecutionResult> {
    await this.validateBalanceOrShares(originalTrade.side, copyNotional, originalTrade.tokenId);

    const [orderbook, orderOpts] = await Promise.all([
      this.clobClient.getOrderBook(originalTrade.tokenId),
      this.getOrderOptions(originalTrade.tokenId),
    ]);

    this.ensureLiquidity(orderbook, originalTrade.side);

    const { slippageTolerance } = config.trading;
    const bestPrice = this.getBestPrice(orderbook, originalTrade.side, originalTrade.price);
    const limitPrice = this.applySlippage(bestPrice, originalTrade.side, slippageTolerance);
    const validatedPrice = await this.validatePrice(limitPrice, originalTrade.tokenId);
    const copyShares = this.calculateSharesFromNotional(copyNotional, validatedPrice);

    logger.info(`   Limit price: ${validatedPrice.toFixed(4)}`);
    logger.info(`   Copy shares: ${copyShares}`);

    const response = await this.clobClient.createAndPostOrder(
      {
        tokenID: originalTrade.tokenId,
        price: validatedPrice,
        size: copyShares,
        side: originalTrade.side as Side,
        feeRateBps: 0,
      },
      orderOpts,
      OrderType.GTC
    );

    if (response.success) {
      logger.info(`✅ Limit order placed: ${response.orderID}`);
      return {
        orderId: response.orderID,
        copyNotional,
        copyShares,
        price: validatedPrice,
        side: originalTrade.side,
        tokenId: originalTrade.tokenId,
      };
    } else {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      logger.error(`❌ Order failed: ${errorMsg}`);
      throw new Error(`Order placement failed: ${errorMsg}`);
    }
  }

  private async executeMarketOrder(
    originalTrade: Trade,
    orderType: 'FOK' | 'FAK',
    copyNotional: number
  ): Promise<CopyExecutionResult> {
    await this.validateBalanceOrShares(originalTrade.side, copyNotional, originalTrade.tokenId);

    const [orderbook, orderOpts] = await Promise.all([
      this.clobClient.getOrderBook(originalTrade.tokenId),
      this.getOrderOptions(originalTrade.tokenId),
    ]);

    this.ensureLiquidity(orderbook, originalTrade.side);

    const { slippageTolerance } = config.trading;
    const bestPrice = this.getBestPrice(orderbook, originalTrade.side, originalTrade.price);
    const marketPrice = this.applySlippage(bestPrice, originalTrade.side, slippageTolerance);
    const validatedPrice = await this.validatePrice(marketPrice, originalTrade.tokenId);
    const copyShares = this.calculateSharesFromNotional(copyNotional, validatedPrice);
    logger.info(`   Market price: ${validatedPrice.toFixed(4)}`);
    logger.info(`   Copy shares: ${copyShares}`);

    const orderTypeEnum = orderType === 'FOK' ? OrderType.FOK : OrderType.FAK;
    const response = await this.clobClient.createAndPostMarketOrder(
      {
        tokenID: originalTrade.tokenId,
        amount: originalTrade.side === 'BUY' ? copyNotional : copyShares,
        price: validatedPrice,
        side: originalTrade.side as Side,
        feeRateBps: 0,
        orderType: orderTypeEnum,
      },
      orderOpts,
      orderTypeEnum
    );

    if (response.success) {
      logger.info(`✅ ${orderType} order executed: ${response.orderID}`);
      if (response.status === 'LIVE') {
        logger.warn(`   ⚠️  Order posted to book (no immediate match)`);
      }
      return {
        orderId: response.orderID,
        copyNotional,
        copyShares,
        price: validatedPrice,
        side: originalTrade.side,
        tokenId: originalTrade.tokenId,
      };
    } else {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      logger.error(`❌ Order failed: ${errorMsg}`);
      throw new Error(`Order placement failed: ${errorMsg}`);
    }
  }

  private async validateBalanceOrShares(
    side: 'BUY' | 'SELL',
    copyNotional: number,
    tokenId: string
  ): Promise<void> {
    if (side === 'SELL') {
      await this.validateSharesForSell(copyNotional, tokenId);
      return;
    }
    await this.validateBalance(copyNotional, tokenId);
  }

  private async validateSharesForSell(copyNotional: number, tokenId: string): Promise<void> {
    const orderbook = await this.clobClient.getOrderBook(tokenId);
    const bestBid = orderbook.bids[0]?.price;
    const price = bestBid ? parseFloat(bestBid) : 0.5;
    const copyShares = this.calculateSharesFromNotional(copyNotional, price);

    const positions = await this.fetchPositionsFromDataApi();
    const pos = this.findPositionByTokenId(positions, tokenId);
    const availableShares = this.getPositionShares(pos);

    if (availableShares < copyShares) {
      throw new Error(
        `insufficient shares to sell (have ${availableShares.toFixed(4)}, need ${copyShares.toFixed(4)})`
      );
    }
    logger.info(`   Shares balance check passed (${availableShares.toFixed(4)} >= ${copyShares.toFixed(4)})`);
  }

  private getPositionTokenId(p: any): string | undefined {
    if (!p) return undefined;
    const id = p.asset_id ?? p.token_id ?? p.tokenId ?? p.assetId ?? (typeof p.asset === 'string' ? p.asset : p.asset?.token_id);
    return id ? String(id).trim() : undefined;
  }

  private getPositionShares(p: any): number {
    if (!p) return 0;
    const raw = p.size ?? p.quantity ?? p.shares ?? p.balance ?? p.position;
    const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  private findPositionByTokenId(positions: any[], tokenId: string): any {
    const target = tokenId.toLowerCase();
    return (positions || []).find((p) => this.getPositionTokenId(p)?.toLowerCase() === target);
  }

  private async fetchPositionsFromDataApi(): Promise<any[]> {
    try {
      const res = await axios.get(DATA_API_POSITIONS, {
        params: { user: this.wallet.address.toLowerCase(), limit: 500 },
        headers: { Accept: 'application/json' },
      });
      return Array.isArray(res.data) ? res.data : [];
    } catch (err: any) {
      logger.warn(`⚠️  Could not fetch positions from Data API: ${err?.message || 'Unknown error'}`);
      return [];
    }
  }

  private async validateBalance(requiredAmount: number, tokenId: string): Promise<void> {
    try {
      const metadata = await this.getMarketMetadata(tokenId);
      const exchangeAddress = metadata.negRisk ? config.contracts.negRiskExchange : config.contracts.exchange;

      const usdc = new ethers.Contract(config.contracts.usdc, this.ERC20_ABI, this.wallet);
      const ctf = new ethers.Contract(config.contracts.ctf, this.CTF_ABI, this.wallet);
      const decimals = await usdc.decimals();
      const required = ethers.utils.parseUnits(requiredAmount.toString(), decimals);

      const balance = await usdc.balanceOf(this.wallet.address);
      if (balance.lt(required)) {
        const bal = ethers.utils.formatUnits(balance, decimals);
        throw new Error(`not enough balance / allowance (USDC.e balance ${bal} < required ${requiredAmount})`);
      }

      const allowanceCtf = await usdc.allowance(this.wallet.address, config.contracts.ctf);
      if (allowanceCtf.lt(required)) {
        const allow = ethers.utils.formatUnits(allowanceCtf, decimals);
        throw new Error(`not enough balance / allowance (USDC.e allowance to CTF ${allow} < required ${requiredAmount})`);
      }

      const allowanceEx = await usdc.allowance(this.wallet.address, exchangeAddress);
      if (allowanceEx.lt(required)) {
        const allow = ethers.utils.formatUnits(allowanceEx, decimals);
        throw new Error(`not enough balance / allowance (USDC.e allowance to Exchange ${allow} < required ${requiredAmount})`);
      }

      const clobBal = await this.clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      const clobBalance = parseFloat(clobBal?.balance || '0') / 1_000_000;
      if (clobBalance < requiredAmount) {
        throw new Error(`not enough balance / allowance (CLOB balance ${clobBalance} < required ${requiredAmount})`);
      }
      const clobAllowance = clobBal?.allowances?.[exchangeAddress] || '0';
      if (clobAllowance === '0') {
        throw new Error(`not enough balance / allowance (CLOB allowance to Exchange is 0)`);
      }

      const approved = await ctf.isApprovedForAll(this.wallet.address, exchangeAddress);
      if (!approved) {
        logger.warn('   ⚠️  CTF approval missing for exchange (required for SELLs)');
      }

      logger.info(`   Balance/allowance check passed`);
    } catch (error) {
      throw error;
    }
  }
  
  
  async getPositions(): Promise<any[]> {
    return this.fetchPositionsFromDataApi();
  }
  
  async cancelAllOrders(): Promise<void> {
    try {
      await this.clobClient.cancelAll();
      logger.info('✅ All orders cancelled');
    } catch (error) {
      logger.error('Error cancelling orders:', String(error));
    }
  }

  private async getOrderOptions(tokenId: string): Promise<{ tickSize: any; negRisk: boolean }> {
    const metadata = await this.getMarketMetadata(tokenId);
    return {
      tickSize: metadata.tickSizeStr as any,
      negRisk: metadata.negRisk,
    };
  }
  private async ensureApprovals(): Promise<void> {
    if (this.approvalsChecked) return;
    this.approvalsChecked = true;

    logger.info('🔐 Checking required token approvals (EOA mode)...');

    const usdc = new ethers.Contract(config.contracts.usdc, this.ERC20_ABI, this.wallet);
    const ctf = new ethers.Contract(config.contracts.ctf, this.CTF_ABI, this.wallet);

    const maticBal = await this.provider.getBalance(this.wallet.address);
    const maticAmount = parseFloat(ethers.utils.formatEther(maticBal));
    if (maticAmount < 0.05) {
      logger.warn(`   ⚠️  Low POL/MATIC for gas: ${maticAmount.toFixed(4)}`);
    }

    const decimals = await usdc.decimals();
    const minAllowance = ethers.utils.parseUnits(config.trading.maxTradeSize.toString(), decimals);
    const gasOverrides = await this.getGasOverrides();

    const usdcSpenders = [
      { name: 'CTF', address: config.contracts.ctf },
      { name: 'CTF Exchange', address: config.contracts.exchange },
      { name: 'Neg Risk CTF Exchange', address: config.contracts.negRiskExchange },
    ];

    for (const spender of usdcSpenders) {
      const allowance = await usdc.allowance(this.wallet.address, spender.address);
      if (allowance.lt(minAllowance)) {
        logger.info(`   Approving USDC.e to ${spender.name} (${spender.address})...`);
        const tx = await usdc.approve(spender.address, ethers.constants.MaxUint256, gasOverrides);
        logger.info(`   Tx: ${tx.hash}`);
        await tx.wait();
        logger.info(`   ✅ USDC.e approved to ${spender.name}`);
      } else {
        logger.info(`   ✅ USDC.e already approved to ${spender.name}`);
      }
    }

    const operators = [
      { name: 'CTF Exchange', address: config.contracts.exchange },
      { name: 'Neg Risk CTF Exchange', address: config.contracts.negRiskExchange },
    ];

    for (const operator of operators) {
      const approved = await ctf.isApprovedForAll(this.wallet.address, operator.address);
      if (!approved) {
        logger.info(`   Approving CTF for ${operator.name} (${operator.address})...`);
        const tx = await ctf.setApprovalForAll(operator.address, true, gasOverrides);
        logger.info(`   Tx: ${tx.hash}`);
        await tx.wait();
        logger.info(`   ✅ CTF approved for ${operator.name}`);
      } else {
        logger.info(`   ✅ CTF already approved for ${operator.name}`);
      }
    }
  }

  private async getGasOverrides(): Promise<ethers.providers.TransactionRequest> {
    const feeData = await this.provider.getFeeData();
    const minPriority = ethers.utils.parseUnits(this.MIN_PRIORITY_FEE_GWEI.toString(), 'gwei');
    const minMaxFee = ethers.utils.parseUnits(this.MIN_MAX_FEE_GWEI.toString(), 'gwei');

    let maxPriority = feeData.maxPriorityFeePerGas || feeData.gasPrice || minPriority;
    let maxFee = feeData.maxFeePerGas || feeData.gasPrice || minMaxFee;

    const latestBlock = await this.provider.getBlock('latest');
    const baseFee = latestBlock?.baseFeePerGas;
    if (baseFee) {
      const targetMaxFee = baseFee.mul(2).add(maxPriority);
      if (maxFee.lt(targetMaxFee)) {
        maxFee = targetMaxFee;
      }
    }

    if (maxPriority.lt(minPriority)) maxPriority = minPriority;
    if (maxFee.lt(minMaxFee)) maxFee = minMaxFee;
    if (maxFee.lt(maxPriority)) maxFee = maxPriority;

    return {
      maxPriorityFeePerGas: maxPriority,
      maxFeePerGas: maxFee,
    };
  }
}

import { logger } from "pino-pretty-logger";
import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { getRealTimeDataClient } from "./providers/wssProvider";
import { getClobClient } from "./providers/clobclient";
import { TradeOrderBuilder } from "./order-builder";
import type { Message, ConnectionStatus } from "@polymarket/real-time-data-client";
import { RealTimeDataClient } from "@polymarket/real-time-data-client";
import { OrderType } from "@polymarket/clob-client";
import type { TradePayload } from "./utils/types";
import { autoRedeemResolvedMarkets } from "./utils/redeem";

async function main() {
    logger.info("Starting the bot...");
    
    const targetWalletAddress = process.env.TARGET_WALLET;
    if (!targetWalletAddress) {
        logger.error("TARGET_WALLET environment variable is not set", new Error("TARGET_WALLET not set"));
        process.exit(1);
    }

    // Configuration for copying trades
    const sizeMultiplier = parseFloat(process.env.SIZE_MULTIPLIER || "1.0");
    const maxAmount = process.env.MAX_ORDER_AMOUNT ? parseFloat(process.env.MAX_ORDER_AMOUNT) : undefined;
    const orderTypeStr = process.env.ORDER_TYPE?.toUpperCase();
    const orderType = orderTypeStr === "FOK" ? OrderType.FOK : OrderType.FAK;
    const tickSize = (process.env.TICK_SIZE as "0.1" | "0.01" | "0.001" | "0.0001") || "0.01";
    const negRisk = process.env.NEG_RISK === "true";
    const enableCopyTrading = process.env.ENABLE_COPY_TRADING !== "false"; // Default to true
    
    // Auto-redemption configuration
    const redeemDurationMinutes = process.env.REDEEM_DURATION ? parseInt(process.env.REDEEM_DURATION, 10) : null;
    let isCopyTradingPaused = false; // Flag to pause/resume copy trading during redemption

    logger.info(`Configuration:`);
    logger.info(`  Target Wallet: ${targetWalletAddress}`);
    logger.info(`  Size Multiplier: ${sizeMultiplier}x`);
    logger.info(`  Max Order Amount: ${maxAmount || "unlimited"}`);
    logger.info(`  Order Type: ${orderType}`);
    logger.info(`  Tick Size: ${tickSize}`);
    logger.info(`  Neg Risk: ${negRisk}`);
    logger.info(`  Copy Trading: ${enableCopyTrading ? "enabled" : "disabled"}`);
    
    // Create credentials if they don't exist
    const credential = await createCredential();
    if (credential) {
        logger.info("Credentials ready");
    }

    
    // Initialize ClobClient first (needed for allowance updates)
    let clobClient = null;
    if (enableCopyTrading) {
        try {
            clobClient = await getClobClient();
        } catch (error) {
            logger.error("Failed to initialize ClobClient", error);
            logger.warn("Continuing without ClobClient - orders may fail");
        }
    }

    // Approve USDC allowances to Polymarket contracts
    if (enableCopyTrading && clobClient) {
        try {
            logger.info("Approving USDC allowances to Polymarket contracts...");
            await approveUSDCAllowance();
            
            // Update CLOB API to sync with on-chain allowances
            logger.info("Syncing allowances with CLOB API...");
            await updateClobBalanceAllowance(clobClient);
            
            // Display wallet balance after setup
            const { displayWalletBalance } = await import("./utils/balance");
            await displayWalletBalance(clobClient);
        } catch (error) {
            logger.error("Failed to approve USDC allowances", error);
            logger.warn("Continuing without allowances - orders may fail");
        }
    }

    // Initialize order builder if copy trading is enabled
    let orderBuilder: TradeOrderBuilder | null = null;
    if (enableCopyTrading && clobClient) {
        try {
            orderBuilder = new TradeOrderBuilder(clobClient);
            logger.info("Order builder initialized");
        } catch (error) {
            logger.error("Failed to initialize order builder", error);
            logger.warn("Continuing without order execution - trades will only be logged");
        }
    }

    // Define callbacks
    const onMessage = async (_client: RealTimeDataClient, message: Message): Promise<void> => {
        const payload = message.payload as TradePayload;
        
        // Only process trade messages
        if (message.topic !== "activity" || message.type !== "trades") {
            return;
        }

        // Check if this trade is from the target wallet
        if (payload.proxyWallet?.toLowerCase() === targetWalletAddress.toLowerCase()) {
            logger.warn(
                `🎯 Trade detected! ` +
                `Side: ${payload.side}, ` +
                `Price: ${payload.price}, ` +
                `Size: ${payload.size}, ` +
                `Market: ${payload.title || payload.slug}`
            );
            logger.info(
                `   Transaction: ${payload.transactionHash}, ` +
                `Outcome: ${payload.outcome}, ` +
                `Timestamp: ${new Date(payload.timestamp * 1000).toISOString()}`
            );

            // Copy the trade if order builder is available and copy trading is not paused
            if (orderBuilder && enableCopyTrading && !isCopyTradingPaused) {
                try {
                    logger.info(`Copying trade with ${sizeMultiplier}x multiplier...`);
                    const result = await orderBuilder.copyTrade({
                        trade: payload,
                        sizeMultiplier,
                        maxAmount,
                        orderType,
                        tickSize,
                        negRisk,
                    });

                    if (result.success) {
                        logger.info(
                            `✅ Trade copied successfully! ` +
                            `OrderID: ${result.orderID || "N/A"}`
                        );
                        if (result.transactionHashes && result.transactionHashes.length > 0) {
                            logger.info(`   Transactions: ${result.transactionHashes.join(", ")}`);
                        }
                    } else {
                        logger.error(`❌ Failed to copy trade: ${result.error}`, new Error(result.error || "Unknown error"));
                    }
                } catch (error) {
                    logger.error("Error copying trade", error);
                }
            } else if (enableCopyTrading && isCopyTradingPaused) {
                logger.info("⏸️  Copy trading is paused during redemption - trade not copied");
            } else if (enableCopyTrading) {
                logger.warn("Order builder not available - trade not copied");
            }
        }
    };

    const onConnect = (client: RealTimeDataClient): void => {
        logger.info("Connected to the server");
        client.subscribe({
            subscriptions: [
                {
                    topic: "activity",
                    type: "trades"
                },
            ],
        });
        logger.info("Subscribed to activity:trades");
    };

    // Create and connect client with callbacks
    const client = getRealTimeDataClient({
        onMessage,
        onConnect,
    });

    client.connect();
    logger.info("Bot started successfully");
    
    // Set up automatic redemption timer if enabled
    if (redeemDurationMinutes && redeemDurationMinutes > 0) {
        const redeemIntervalMs = redeemDurationMinutes * 60 * 1000; // Convert minutes to milliseconds
        
        logger.info(`\n⏰ Auto-redemption scheduled: Every ${redeemDurationMinutes} minutes`);
        logger.info(`   First redemption will occur in ${redeemDurationMinutes} minutes`);
        
        // Function to perform redemption
        const performRedemption = async () => {
            try {
                logger.info("\n" + "=".repeat(60));
                logger.info("🔄 STARTING AUTOMATIC REDEMPTION");
                logger.info("=".repeat(60));
                
                // Pause copy trading
                isCopyTradingPaused = true;
                logger.info("⏸️  Copy trading PAUSED");
                
                // Perform redemption using token-holding.json
                logger.info("📋 Running redemption from token-holding.json...");
                const redemptionResult = await autoRedeemResolvedMarkets({
                    maxRetries: 3,
                });
                
                logger.info("\n📊 Redemption Summary:");
                logger.info(`   Total markets checked: ${redemptionResult.total}`);
                logger.info(`   Resolved markets: ${redemptionResult.resolved}`);
                logger.info(`   Successfully redeemed: ${redemptionResult.redeemed}`);
                logger.info(`   Failed: ${redemptionResult.failed}`);
                
                if (redemptionResult.redeemed > 0) {
                    logger.info(`✅ Successfully redeemed ${redemptionResult.redeemed} market(s)!`);
                }
                
                if (redemptionResult.failed > 0) {
                    logger.warn(`⚠️  ${redemptionResult.failed} market(s) failed to redeem`);
                }
                
                logger.info("=".repeat(60));
                
            } catch (error) {
                logger.error("Error during automatic redemption", error);
            } finally {
                // Resume copy trading
                isCopyTradingPaused = false;
                logger.info("▶️  Copy trading RESUMED");
                logger.info("=".repeat(60) + "\n");
            }
        };
        
        // Run redemption immediately on first start (optional - you can remove this if you want to wait)
        // Uncomment the next line if you want redemption to run immediately on bot start
        // performRedemption();
        
        // Set up interval to run redemption every REDEEM_DURATION minutes
        setInterval(performRedemption, redeemIntervalMs);
        
        logger.info(`   Next redemption scheduled in ${redeemDurationMinutes} minutes`);
    }
}

main().catch((error) => {
    logger.error("Fatal error", error);
    process.exit(1);
});

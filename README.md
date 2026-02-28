# Polymarket Copy Bot · Copy Trading Bot

**Polymarket copy bot** — a **polymarket copy trading bot** that watches a target wallet’s trades in real time and mirrors them on your account with configurable size, order type, and optional auto-redemption of resolved markets.

> **Keywords:** Polymarket copy bot · polymarket copy trading bot · Polymarket copy trading · prediction market bot · mirror trading Polymarket

## About this project

This repo is a **Polymarket copy trading bot** (also searchable as *Polymarket copy bot*): it connects to Polymarket's real-time feed, follows a chosen wallet's activity, and places matching orders on your account. Use it for mirror/copy trading on Polymarket prediction markets with optional auto-redemption of resolved markets.

## Rust version

``
cd rust
``

``
cargo run
``

## Contact

For support or suggestions:

[![Telegram](https://img.shields.io/badge/Telegram-@cryp_mancer-2CA5E0?style=flat-square&logo=telegram&logoColor=white)](https://t.me/cryp_mancer)  
[![Gmail](https://img.shields.io/badge/Gmail-crypmancer@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white)](mailto:crypmancer@gmail.com)

## Features

- **Real-time copy trading** – Subscribes to Polymarket’s activity feed and copies trades from a chosen wallet as they happen.
- **Configurable execution** – Size multiplier, max order size, order type (FAK/FOK), tick size, and neg-risk support.
- **USDC & CLOB setup** – Approves USDC allowances and syncs with the CLOB API on startup.
- **Automatic redemption** – Optional periodic redemption of resolved markets (with copy trading paused during redemption).
- **Standalone redeem tools** – Redeem by condition ID or run batch redemption from holdings/API.

## Requirements

- **Node.js** 18+ (or **Bun** for redeem/auto-redeem scripts)
- **Polygon** wallet with USDC for trading and gas

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

Create a `.env` file in the project root. Required and optional variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Your wallet private key (for signing orders and redeeming). |
| `TARGET_WALLET` | Yes* | Ethereum address of the wallet whose trades to copy. |
| `RPC_TOKEN` | Yes** | Polygon RPC URL or API token (e.g. Alchemy/Infura) for chain and contract calls. |
| `CHAIN_ID` | No | Chain ID (default: Polygon). |
| `CLOB_API_URL` | No | CLOB API base URL (default: `https://clob.polymarket.com`). |
| `USER_REAL_TIME_DATA_URL` | No | Real-time data WebSocket host (uses Polymarket default if unset). |
| `SIZE_MULTIPLIER` | No | Multiply copied size by this (default: `1.0`). |
| `MAX_ORDER_AMOUNT` | No | Cap per order size (no cap if unset). |
| `ORDER_TYPE` | No | `FAK` or `FOK` (default: `FAK`). |
| `TICK_SIZE` | No | `0.1`, `0.01`, `0.001`, or `0.0001` (default: `0.01`). |
| `NEG_RISK` | No | `true` or `false` for neg-risk markets. |
| `ENABLE_COPY_TRADING` | No | `true` or `false` (default: `true`). |
| `REDEEM_DURATION` | No | Auto-redeem interval in **minutes** (e.g. `60` = every hour). If set, copy trading is paused during redemption. |
| `DEBUG` | No | `true` for extra logging. |

\* Required when copy trading is enabled.  
\** Required for allowance checks and redemption.

**Example `.env`:**

```env
PRIVATE_KEY=0x...
TARGET_WALLET=0x...
RPC_TOKEN=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# Optional
SIZE_MULTIPLIER=1.0
MAX_ORDER_AMOUNT=100
ORDER_TYPE=FAK
TICK_SIZE=0.01
NEG_RISK=false
REDEEM_DURATION=60
```

### 3. Run the bot

```bash
npm start
```

This will:

1. Create credentials if needed.
2. Initialize the CLOB client and approve USDC allowances (when copy trading is enabled).
3. Connect to the real-time feed and subscribe to `activity:trades`.
4. Copy trades from `TARGET_WALLET` using your configured multiplier and limits.
5. If `REDEEM_DURATION` is set, run redemption on that interval and pause copy trading during redemption.

## Scripts

| Command | Description |
|--------|-------------|
| `npm start` | Start the copy-trading bot (`ts-node src/index.ts`). |
| `npm run redeem` | Standalone redemption by condition ID (`ts-node src/redeem.ts`). |

### Redeem script

Redeem a single market by condition ID:

```bash
npm run redeem -- <conditionId> [indexSet1 indexSet2 ...]
# Example:
npm run redeem -- 0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1 1 2
```

Or set in `.env`:

```env
CONDITION_ID=0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1
INDEX_SETS=1,2
```

Then:

```bash
npm run redeem
```

If no condition ID is given, the script prints current holdings and usage.

### Auto-redeem script (Bun)

For batch redemption and market checks, use the auto-redeem script (Bun):

```bash
bun src/auto-redeem.ts                    # Redeem all resolved markets from holdings
bun src/auto-redeem.ts --api              # Fetch markets from API and redeem winning positions
bun src/auto-redeem.ts --dry-run          # Preview only, no redemption
bun src/auto-redeem.ts --check <conditionId>  # Check if a market is resolved
```

## Project structure

```
src/
├── index.ts              # Main copy-trading bot entry
├── redeem.ts             # CLI: redeem by condition ID
├── auto-redeem.ts        # Batch redemption and --check (Bun)
├── order-builder/        # Order construction and copy-trade execution
├── providers/            # CLOB client and real-time WebSocket provider
├── security/             # Credentials, USDC allowance, CLOB balance allowance
└── utils/                # Types, logger, balance, holdings, redeem helpers
```

## How it works

1. **Connection** – The bot connects to Polymarket’s real-time data service and subscribes to trade activity.
2. **Filtering** – Each trade is checked for `proxyWallet === TARGET_WALLET`.
3. **Copy** – Matching trades are sent to the order builder, which places orders on the CLOB with your `SIZE_MULTIPLIER`, `MAX_ORDER_AMOUNT`, `ORDER_TYPE`, `TICK_SIZE`, and `NEG_RISK` settings.
4. **Redemption** – If `REDEEM_DURATION` is set, on a timer the bot pauses copy trading, runs redemption (e.g. from `token-holding.json`), then resumes.

## Security notes

- **Never commit `.env` or your `PRIVATE_KEY`.** Use environment variables or a secrets manager in production.
- Run with a dedicated wallet and only fund it with what you’re willing to trade.
- Copy trading carries risk; the bot mirrors another wallet’s actions without guarantees.

# Polymarket Copy Bot · Copy Trading Bot

**Polymarket copy bot** — a **polymarket copy trading bot** that watches a target wallet's trades in real time and mirrors them on your account across **all Polymarket markets**. Copy crypto, sports, politics, economics, entertainment, and any other prediction market with configurable size, order type, and optional auto-redemption of resolved markets.

> **Search keywords:** Polymarket copy bot · polymarket copy trading bot · Polymarket copy trading · polymarket trading bot · polymarket CLOB · polymarket API · mirror trading · copy trading bot · social trading · follow trading · trade copier · prediction market bot · crypto copy trading · sports betting copy · sports trading bot · political betting · election betting · polymarket redemption · automated trading · polygon trading bot · event markets · binary options

## All Markets Supported

This bot copies trades on **every Polymarket market** without restriction. Whatever market type your target wallet trades, the bot mirrors it:

| Market Category | Examples |
|-----------------|----------|
| **Crypto** | Bitcoin price, ETH, altcoins, DeFi protocols |
| **Sports** | NFL, NBA, MLB, soccer, MMA, boxing, esports |
| **Politics** | Elections, legislation, geopolitical events |
| **Economics** | Fed rates, inflation, GDP, employment |
| **Entertainment** | Awards, celebrity events, media |
| **Science & Tech** | AI, space, product launches |
| **Other** | Weather, viral trends, any prediction market |

No configuration changes needed — set your `TARGET_WALLET` and the bot copies all their activity across markets.

## About this project

This repo is a **Polymarket copy trading bot** (also searchable as *Polymarket copy bot*): it connects to Polymarket's real-time feed, follows a chosen wallet's activity, and places matching orders on your account. Use it for mirror/copy trading on any Polymarket prediction market with optional auto-redemption of resolved markets.

## Rust version

```
cd rust
```

```
cargo run
```

## Contact

For support or suggestions:

[![Telegram](https://img.shields.io/badge/Telegram-@cryp_mancer-2CA5E0?style=flat-square&logo=telegram&logoColor=white)](https://t.me/cryp_mancer)  
[![Gmail](https://img.shields.io/badge/Gmail-crypmancer@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white)](mailto:crypmancer@gmail.com)

## Features

- **Real-time copy trading** – Subscribes to Polymarket's activity feed and copies trades from a chosen wallet as they happen.
- **All market types** – Works across crypto, sports, politics, economics, and every other Polymarket category.
- **Configurable execution** – Size multiplier, max order size, order type (FAK/FOK), tick size, and neg-risk support.
- **USDC & CLOB setup** – Approves USDC allowances and syncs with the CLOB API on startup.
- **Automatic redemption** – Optional periodic redemption of resolved markets (with copy trading paused during redemption).
- **Standalone redeem tools** – Redeem by condition ID or run batch redemption from holdings/API.

## Functionalities in Detail

### 1. Real-Time Copy Trading

| Capability | Description |
|------------|-------------|
| **WebSocket feed** | Connects to Polymarket's live trade stream (`wss://ws-live-data.polymarket.com`) |
| **Trade detection** | Filters trades where `proxyWallet` matches your `TARGET_WALLET` |
| **Instant mirroring** | Places BUY/SELL orders immediately when the target wallet trades |
| **Market-agnostic** | No filters — copies all markets the target wallet trades |

### 2. Order Execution

| Capability | Description |
|------------|-------------|
| **Size multiplier** | Scale copied size (e.g. `0.5` = 50%, `2.0` = 2x) |
| **Max order cap** | Limit per-order USDC spend via `MAX_ORDER_AMOUNT` |
| **Order types** | FAK (Fill-and-Kill) or FOK (Fill-or-Kill) |
| **Tick size** | Price precision: `0.1`, `0.01`, `0.001`, or `0.0001` |
| **Neg-risk support** | Trade neg-risk markets when `NEG_RISK=true` |
| **Balance checks** | Validates USDC before BUY; uses holdings for SELL |

### 3. Position Tracking

| Capability | Description |
|------------|-------------|
| **Local holdings** | Tracks positions in `src/data/token-holding.json` |
| **BUY tracking** | Adds tokens received to holdings after each buy |
| **SELL tracking** | Removes tokens from holdings after each sell |
| **Redemption cleanup** | Clears market from holdings after successful redemption |

### 4. Redemption (Resolved Markets)

| Capability | Description |
|------------|-------------|
| **Single redeem** | `npm run redeem -- <conditionId>` — redeem one market |
| **Auto (holdings)** | Redeem all resolved markets from `token-holding.json` |
| **Auto (API)** | `bun src/auto-redeem.ts --api` — fetch positions from Polymarket and redeem |
| **Resolution check** | Uses CTF contract to verify market resolution and winning outcomes |
| **Winning-only redeem** | Redeems only outcomes you hold that won |
| **Retry logic** | Exponential backoff for RPC/network errors (3 attempts) |

### 5. Security & Setup

| Capability | Description |
|------------|-------------|
| **API credential creation** | Derives/creates CLOB API keys on first run |
| **USDC approvals** | Approves USDC for CTF, Exchange, NegRisk contracts |
| **Token approvals** | Approves conditional tokens for Exchange after buys |
| **CLOB sync** | Updates CLOB API with on-chain allowance state |
| **Balance display** | Logs USDC balance and allowance on key operations |

## Requirements

- **Node.js** 18+ (or **Bun** for redeem/auto-redeem scripts)
- **Polygon** wallet with USDC for trading and gas

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Build (required before start)

```bash
npm run build
```

### 3. Environment variables

Create a `.env` file in the project root. Required and optional variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Your wallet private key (for signing orders and redeeming). |
| `TARGET_WALLET` | Yes* | Ethereum address of the wallet whose trades to copy. |
| `RPC_URL` | Yes** | Polygon RPC URL (e.g. Alchemy, Infura) for chain and contract calls. |
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
RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# Optional
SIZE_MULTIPLIER=1.0
MAX_ORDER_AMOUNT=100
ORDER_TYPE=FAK
TICK_SIZE=0.01
NEG_RISK=false
REDEEM_DURATION=60
```

### 4. Run the bot

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
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm start` | Start the copy-trading bot. |
| `npm run redeem` | Standalone redemption by condition ID. |

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

| Command | Description |
|---------|-------------|
| `bun src/auto-redeem.ts` | Redeem all resolved markets from `token-holding.json` |
| `bun src/auto-redeem.ts --api` | Fetch positions from Polymarket API and redeem winning markets |
| `bun src/auto-redeem.ts --dry-run` | Preview only, no redemption |
| `bun src/auto-redeem.ts --check <conditionId>` | Check if a specific market is resolved |
| `bun src/auto-redeem.ts --check <conditionId> --redeem` | Check and then redeem if resolved |

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

1. **Connection** – The bot connects to Polymarket's real-time data service and subscribes to trade activity (all markets).
2. **Filtering** – Each trade is checked for `proxyWallet === TARGET_WALLET`.
3. **Copy** – Matching trades are sent to the order builder, which places orders on the CLOB with your `SIZE_MULTIPLIER`, `MAX_ORDER_AMOUNT`, `ORDER_TYPE`, `TICK_SIZE`, and `NEG_RISK` settings.
4. **Redemption** – If `REDEEM_DURATION` is set, on a timer the bot pauses copy trading, runs redemption (e.g. from `token-holding.json`), then resumes.

## Security notes

- **Never commit `.env` or your `PRIVATE_KEY`.** Use environment variables or a secrets manager in production.
- Run with a dedicated wallet and only fund it with what you're willing to trade.
- Copy trading carries risk; the bot mirrors another wallet's actions without guarantees.

## Search & Discovery

Find this project by searching for:

**Core:** polymarket copy bot · polymarket copy trading bot · polymarket trading bot · polymarket bot  
**Trading:** copy trading · mirror trading · social trading · follow trading · trade copier · automated trading  
**Markets:** prediction markets · event markets · crypto copy trading · sports betting copy · political betting · election betting  
**Tech:** polymarket CLOB · polymarket API · polygon · USDC · polymarket redemption

## Usage

[Telegram Copy Trading Bot](https://t.me/polycopingbot) (Maintenance at the moment)

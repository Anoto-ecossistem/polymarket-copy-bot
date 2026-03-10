import dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { logger } from './logger.js';

dotenv.config();

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  const apiKey = process.env.POLYMARKET_USER_API_KEY || process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_USER_SECRET || process.env.POLYMARKET_SECRET;
  const passphrase = process.env.POLYMARKET_USER_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE;

  if (!privateKey) {
    throw new Error('Missing PRIVATE_KEY in .env');
  }
  if (!apiKey || !secret || !passphrase) {
    throw new Error('Missing POLYMARKET_USER_API_KEY / POLYMARKET_USER_SECRET / POLYMARKET_USER_PASSPHRASE in .env');
  }

  const signer = new Wallet(privateKey);
  const client = new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    { key: apiKey, secret, passphrase },
    0,
    signer.address,
    process.env.POLYMARKET_GEO_TOKEN || undefined
  );

  const result: any = await client.getApiKeys();
  if (result?.error || result?.status >= 400) {
    throw new Error(result?.error || `API returned status ${result?.status}`);
  }

  logger.info('✅ Static API credentials are valid for this signer');
  logger.info(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  logger.error('❌ API credential validation failed:', error.message || error);
  const msg = String(error?.message || '').toLowerCase();
  if (msg.includes('unauthorized/invalid api key')) {
    logger.error('   Hint: Builder dashboard keys are not user trading credentials.');
    logger.error('   Generate user credentials from PRIVATE_KEY with: npm run generate-api-creds');
  }
  process.exit(1);
});

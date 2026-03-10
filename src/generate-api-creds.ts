import dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import * as fs from 'fs';
import { logger } from './logger.js';

dotenv.config();

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Missing PRIVATE_KEY in .env');
  }

  const signer = new Wallet(privateKey);
  const client = new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    undefined,
    undefined,
    undefined,
    process.env.POLYMARKET_GEO_TOKEN || undefined
  );

  let creds = await client.deriveApiKey().catch(() => null);
  if (!creds || (creds as any).error) {
    creds = await client.createApiKey();
  }

  const apiKey = (creds as any)?.apiKey || (creds as any)?.key;
  const secret = (creds as any)?.secret;
  const passphrase = (creds as any)?.passphrase;

  if (!apiKey || !secret || !passphrase) {
    throw new Error('Could not generate API credentials');
  }

  const outputFile = '.polymarket-api-creds';
  const fileContents =
    'POLYMARKET_USER_API_KEY=' + apiKey + '\n' +
    'POLYMARKET_USER_SECRET=' + secret + '\n' +
    'POLYMARKET_USER_PASSPHRASE=' + passphrase + '\n';

  fs.writeFileSync(outputFile, fileContents, { mode: 0o600 });

  logger.info(`✅ API credentials have been generated successfully and written to ${outputFile}. Handle them securely and do not log them in plaintext.`);
}

main().catch((error) => {
  logger.error('❌ Failed to generate API credentials:', error.message || error);
  process.exit(1);
});

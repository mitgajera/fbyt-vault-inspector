import { PublicKey } from '@solana/web3.js';

/** FBYT vault program on mainnet (address embedded in the app.fbyt.io bundle IDL). */
export const PROGRAM_ID = new PublicKey('DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm');

export const DEFAULT_RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
export const KAMINO_LEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

/** Fallback symbols so common mints read well even when metadata lookups fail. */
export const KNOWN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': 'JLP',
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 'JTO',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JitoSOL',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'WBTC',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'WETH',
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTH',
};

/** VaultPool.vault_pool_status as observed on mainnet (1 = active, 2 = closed). Fundraising and dormant are time-derived. */
export const VAULT_STATUS: Record<number, string> = { 0: 'Created', 1: 'Active', 2: 'Closed' };

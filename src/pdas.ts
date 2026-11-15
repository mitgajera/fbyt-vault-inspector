import { PublicKey } from '@solana/web3.js';
import { ATA_PROGRAM, PROGRAM_ID, TOKEN_PROGRAM } from './config.js';

// Seeds mirror the `pda` blocks of the fbyt_vault IDL. Note the mixed casing: "oracle_pool" is
// snake_case while every other seed is PascalCase.
const pda = (...seeds: (Buffer | PublicKey)[]) =>
  PublicKey.findProgramAddressSync(seeds.map((s) => (s instanceof PublicKey ? s.toBuffer() : s)), PROGRAM_ID)[0];
const str = (s: string) => Buffer.from(s);
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export const pdas = {
  adminPool: () => pda(str('AdminPool')),
  lendingConfig: () => pda(str('LendingConfig')),
  swapAuthority: () => pda(str('SwapAuthority')),
  moneyManagerPool: (admin: PublicKey, manager: PublicKey) => pda(str('MoneyManagerPool'), admin, manager),
  /** `n` is MoneyManagerPool.vaults_amount at creation time: the manager's own vault counter. */
  vaultPool: (admin: PublicKey, manager: PublicKey, n: bigint | number) => pda(str('VaultPool'), admin, manager, u64(n)),
  assetRegistry: (vault: PublicKey) => pda(str('AssetRegistry'), vault),
  vaultLedger: (vault: PublicKey) => pda(str('VaultLedger'), vault),
  priceSnapshot: (vault: PublicKey) => pda(str('PriceSnapshot'), vault),
  investorPool: (investor: PublicKey, admin: PublicKey, vault: PublicKey, mint: PublicKey) =>
    pda(str('InvestorPool'), investor, admin, vault, mint),
  oraclePool: (admin: PublicKey, mint: PublicKey) => pda(str('oracle_pool'), admin, mint),
  kaminoPosition: (vault: PublicKey, reserve: PublicKey) => pda(str('KaminoPosition'), vault, reserve),
  kaminoReserve: (reserve: PublicKey) => pda(str('KaminoReserve'), reserve),
  claim: (vault: PublicKey, mint: PublicKey, recipient: PublicKey, kind: number) =>
    pda(str('Claim'), vault, mint, recipient, Buffer.from([kind])),
};

/** Associated token account; vault balances live in ATAs owned by the VaultPool PDA. */
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

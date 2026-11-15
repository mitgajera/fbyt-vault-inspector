import { Connection, PublicKey } from '@solana/web3.js';
import { c, date, heading, num, table, toJson, usd } from '../format.js';
import { pdas } from '../pdas.js';
import { decode, fetchAll } from '../program.js';
import { getMany, resolveTokens } from '../tokens.js';

/** Every InvestorPool a wallet owns, valued from each vault's cached value_usd. */
export async function inspectInvestor(conn: Connection, wallet: string, json: boolean) {
  const investor = new PublicKey(wallet);
  const pools = await fetchAll(conn, 'InvestorPool', { investor });
  const vaultInfos = await getMany(conn, pools.map((p) => p.data.vault_pool));
  const tokens = await resolveTokens(conn, pools.map((p) => p.data.token_mint));

  const positions = pools.map((p, i) => {
    const vInfo = vaultInfos[i];
    const v = vInfo ? decode('VaultPool', vInfo.data as Buffer) : undefined;
    const shares = BigInt(p.data.shares.toString());
    const base = v ? BigInt(v.total_shares.toString()) + BigInt(v.pending_mm_fee_shares.toString()) : 0n;
    const fraction = base > 0n ? Number(shares) / Number(base) : 0;
    return {
      investorPool: p.pubkey,
      vault: p.data.vault_pool as PublicKey,
      baseToken: tokens.get(p.data.token_mint.toBase58())?.symbol,
      shares,
      fraction,
      valueUsd: v ? fraction * (num(v.value_usd) / 1e6) : 0,
      vaultClosed: v ? num(v.vault_pool_status) === 2 : true,
      isManager: v ? (v.money_manager as PublicKey).equals(investor) : false,
      createdAt: num(p.data.created_at),
      lastDepositAt: num(p.data.last_deposit_at),
      pdaSeeds: '["InvestorPool", investor, admin_pool, vault_pool, token_mint]',
      pdaOk: pdas.investorPool(investor, p.data.admin_pool, p.data.vault_pool, p.data.token_mint).equals(p.pubkey),
    };
  });
  positions.sort((a, b) => b.valueUsd - a.valueUsd);

  if (json) {
    console.log(toJson({ investor, positions }));
    return;
  }
  heading(`Investor ${wallet}`);
  console.log(c.dim('  Shares are internal accounting in each InvestorPool PDA, not SPL tokens, so they do not show in the wallet.\n'));
  table(
    ['vault', 'base', 'shares', 'ownership', '≈ value', 'first deposit', 'last deposit', 'pda'],
    positions.map((p) => [
      p.vault.toBase58() + (p.isManager ? c.cyan(' (own vault)') : '') + (p.vaultClosed ? c.dim(' (closed)') : ''),
      p.baseToken ?? '?',
      p.shares.toLocaleString('en-US'),
      `${(p.fraction * 100).toFixed(2)}%`,
      usd(p.valueUsd),
      date(p.createdAt),
      date(p.lastDepositAt),
      p.pdaOk ? c.green('✓') : c.red('✗'),
    ]),
    ['l', 'l', 'r', 'r', 'r', 'l', 'l', 'l'],
  );
  const total = positions.reduce((s, p) => s + p.valueUsd, 0);
  console.log(`\n  ${positions.length} positions · ≈ ${usd(total)} ${c.dim("(from each vault's cached value_usd)")}\n`);
}

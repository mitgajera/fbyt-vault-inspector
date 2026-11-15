import { Connection, PublicKey } from '@solana/web3.js';
import { bps, c, heading, microUsd, num, rel, short, table, toJson } from '../format.js';
import { pdas } from '../pdas.js';
import { decode, fetchAll } from '../program.js';
import { resolveTokens } from '../tokens.js';
import { vaultPhase } from './vault.js';

export type VaultsOptions = { manager?: string; limit: number; sort: 'value' | 'investors' | 'recent' | 'trade'; phase?: string; json: boolean };

/** Every VaultPool on mainnet (optionally one manager's), ranked. One getProgramAccounts call. */
export async function listVaults(conn: Connection, opts: VaultsOptions) {
  const where: Record<string, PublicKey> = opts.manager ? { money_manager: new PublicKey(opts.manager) } : {};
  const [vaults, adminInfo] = await Promise.all([fetchAll(conn, 'VaultPool', where), conn.getAccountInfo(pdas.adminPool())]);
  const idle = adminInfo ? num(decode('AdminPool', adminInfo.data as Buffer).idle_period) : 0;
  const tokens = await resolveTokens(conn, [...new Map(vaults.map((v) => [v.data.token_mint.toBase58(), v.data.token_mint as PublicKey])).values()]);

  let rows = vaults.map(({ pubkey, data: v }) => ({
    address: pubkey,
    manager: v.money_manager as PublicKey,
    phase: vaultPhase(v, idle).phase,
    investors: num(v.investor_count),
    valueUsd: num(v.value_usd) / 1e6,
    valueAt: num(v.value_at),
    base: tokens.get(v.token_mint.toBase58())?.symbol ?? short(v.token_mint),
    mgmtBps: num(v.money_management_yearly_fee),
    perfBps: num(v.performance_fee),
    createdAt: num(v.created_at),
    lastTradeAt: num(v.last_trade_at),
    delegate: !(v.trading_delegate as PublicKey).equals(PublicKey.default),
    kamino: num(v.kamino_positions),
  }));
  if (opts.phase) rows = rows.filter((r) => r.phase.toLowerCase() === opts.phase!.toLowerCase());

  const key = { value: 'valueUsd', investors: 'investors', recent: 'createdAt', trade: 'lastTradeAt' }[opts.sort] as keyof (typeof rows)[0];
  rows.sort((a, b) => Number(b[key]) - Number(a[key]));

  const phases = rows.reduce<Record<string, number>>((m, r) => ((m[r.phase] = (m[r.phase] ?? 0) + 1), m), {});
  const summary = {
    vaults: rows.length,
    phases,
    totalValueUsd: rows.reduce((s, r) => s + r.valueUsd, 0),
    withInvestors: rows.filter((r) => r.investors > 0).length,
    withTradingDelegate: rows.filter((r) => r.delegate).length,
    usingKamino: rows.filter((r) => r.kamino > 0).length,
  };
  const shown = opts.limit > 0 ? rows.slice(0, opts.limit) : rows;

  if (opts.json) {
    console.log(toJson({ summary, vaults: shown }));
    return;
  }
  heading(opts.manager ? `Vaults managed by ${opts.manager}` : 'FBYT vaults on mainnet');
  console.log(
    `  ${summary.vaults} vaults · ${Object.entries(phases).map(([p, n]) => `${n} ${p}`).join(', ')} · ` +
      `cached value ${microUsd(summary.totalValueUsd * 1e6)} · ${summary.withInvestors} with investors · ` +
      `${summary.withTradingDelegate} with a trading delegate · ${summary.usingKamino} using Kamino`,
  );
  console.log(c.dim(`  sorted by ${opts.sort}; value_usd is the program's cached figure from the last deposit/withdraw/refresh\n`));
  table(
    ['vault', 'manager', 'phase', 'base', 'investors', 'value', 'mgmt', 'perf', 'last trade', 'flags'],
    shown.map((r) => [
      r.address.toBase58(),
      short(r.manager),
      r.phase,
      r.base,
      r.investors,
      microUsd(r.valueUsd * 1e6),
      bps(r.mgmtBps),
      bps(r.perfBps),
      rel(r.lastTradeAt),
      [r.delegate && 'bot', r.kamino && 'kamino'].filter(Boolean).join(','),
    ]),
    ['l', 'l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'l'],
  );
  if (opts.limit > 0 && rows.length > opts.limit) console.log(c.dim(`\n  … ${rows.length - opts.limit} more (use --limit 0 for all)`));
  console.log();
}

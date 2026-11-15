import { Connection, PublicKey } from '@solana/web3.js';
import { bps, c, date, duration, heading, kv, maskRpc, microUsd, num, table, toJson } from '../format.js';
import { pdas } from '../pdas.js';
import { PROGRAM_ID } from '../config.js';
import { decode, fetchAll } from '../program.js';
import { resolveTokens } from '../tokens.js';

const keyKind = (k: PublicKey) => (PublicKey.isOnCurve(k.toBytes()) ? 'keypair (single signer)' : 'PDA (e.g. multisig vault)');

/** Protocol-wide config: AdminPool limits, asset whitelist (OraclePools), Kamino reserves, upgrade authority. */
export async function inspectProtocol(conn: Connection, json: boolean) {
  const adminKey = pdas.adminPool();
  const [adminInfo, programInfo] = await Promise.all([conn.getAccountInfo(adminKey), conn.getAccountInfo(PROGRAM_ID)]);
  if (!adminInfo || !programInfo) throw new Error('AdminPool or program account not found');
  const a = decode('AdminPool', adminInfo.data as Buffer);

  // Upgradeable loader: program account → ProgramData (slot u64, Option<Pubkey> authority).
  const programData = new PublicKey((programInfo.data as Buffer).subarray(4, 36));
  const pd = await conn.getAccountInfo(programData, { dataSlice: { offset: 0, length: 45 } });
  const pdBuf = pd!.data as Buffer;
  const upgradeAuthority = pdBuf[12] === 1 ? new PublicKey(pdBuf.subarray(13, 45)) : null;
  const lastDeploySlot = Number(pdBuf.readBigUInt64LE(4));

  const [oracles, reserves] = await Promise.all([fetchAll(conn, 'OraclePool', { admin_pool: adminKey }), fetchAll(conn, 'KaminoReserve', { admin_pool: adminKey })]);
  const tokens = await resolveTokens(conn, [...oracles.map((o) => o.data.token_mint), ...reserves.map((r) => r.data.liquidity_mint)]);

  const assets = oracles
    .map((o) => ({
      oraclePool: o.pubkey,
      mint: o.data.token_mint as PublicKey,
      symbol: tokens.get(o.data.token_mint.toBase58())?.symbol,
      approved: !!o.data.is_approved,
      maxSlippageBps: num(o.data.max_slippage_bps),
      pythFeedId: Buffer.from(o.data.feed_id).toString('utf8').replace(/\0/g, ''),
    }))
    .sort((x, y) => Number(y.approved) - Number(x.approved) || String(x.symbol).localeCompare(String(y.symbol)));

  const report = {
    program: PROGRAM_ID,
    programData,
    lastDeploySlot,
    upgradeAuthority,
    upgradeAuthorityKind: upgradeAuthority ? keyKind(upgradeAuthority) : 'immutable',
    adminPool: adminKey,
    admin: a.admin,
    adminKind: keyKind(a.admin),
    pendingAdmin: (a.pending_admin as PublicKey).equals(PublicKey.default) ? null : a.pending_admin,
    operator: a.operator,
    operatorKind: keyKind(a.operator),
    config: a,
    assets,
    kaminoReserves: reserves.map((r) => ({ address: r.pubkey, reserve: r.data.reserve, underlying: tokens.get(r.data.liquidity_mint.toBase58())?.symbol, approved: !!r.data.approved })),
  };
  if (json) {
    console.log(toJson(report));
    return;
  }

  const warn = (kind: string) => (kind.startsWith('keypair') ? c.yellow(kind) : c.green(kind));
  heading('Program & authorities');
  kv([
    ['Program', PROGRAM_ID.toBase58()],
    ['ProgramData', `${programData.toBase58()} ${c.dim('last deployed at slot ' + lastDeploySlot)}`],
    ['Upgrade authority', upgradeAuthority ? `${upgradeAuthority.toBase58()}  ${warn(report.upgradeAuthorityKind)}` : c.green('none (immutable)')],
    ['Admin', `${a.admin.toBase58()}  ${warn(report.adminKind)}`],
    ['Pending admin', report.pendingAdmin ? report.pendingAdmin.toBase58() : c.dim('none (two-step transfer idle)')],
    ['Operator (crank)', `${a.operator.toBase58()}  ${warn(report.operatorKind)}`],
    ['Vaults ever created', num(a.vault_pool_count)],
  ]);

  heading('Fees');
  kv([
    ['Vault creation fee', `${num(a.creation_fee) / 1e9} SOL ${c.dim(`(${a.creation_fee} lamports)`)}`],
    ['Manager caps', `management ≤ ${bps(a.money_management_yearly_fee_max)}/yr, performance ≤ ${bps(a.performance_fee_max)}`],
    ['Protocol share', `${bps(a.protocol_money_management_fee)} of management fees, ${bps(a.protocol_performance_fee)} of performance fees`],
    [
      'Trading fee tiers',
      (a.trading_fee_tiers as { upper_bound_usd: number; bps: number }[])
        .slice(0, num(a.trading_fee_tier_count))
        .map((t) => `${t.bps} bp${t.upper_bound_usd ? ' ≤ $' + t.upper_bound_usd.toLocaleString('en-US') : ' above'}`)
        .join(', ') + c.dim(`  (min ${microUsd(a.trading_fee_min_micro_usd)}, cap ${microUsd(a.trading_fee_cap_micro_usd)}, paid in SOL)`),
    ],
  ]);

  heading('Vault limits');
  kv([
    ['Min raise / contribution', `${microUsd(a.raise_amount_min_usd)} / ${microUsd(a.contribution_amount_min_usd)}`],
    ['Max fundraising period', duration(num(a.fundrising_period_max))],
    ['Max withdraw cooldown', duration(num(a.withdraw_cooldown_max))],
    ['Idle → dormant after', duration(num(a.idle_period))],
    ['Max assets per vault', num(a.max_asset_count)],
    ['Dust threshold', microUsd(a.dust_threshold_usd)],
  ]);

  heading('Swap & oracle guards');
  kv([
    ['Max slippage (default)', bps(a.max_slippage_bps)],
    ['Daily loss limit', bps(a.daily_loss_limit_bps)],
    ['Holding period', duration(num(a.holding_period))],
    ['Activity minimum', `${bps(a.activity_min_bps)} of value to reset idle timer`],
    ['Price max age', `deposit ${a.deposit_price_max_age}s · swap ${a.swap_price_max_age}s · oracle ${a.oracle_max_age}s`],
    ['Max Pyth confidence', bps(a.max_price_conf_bps)],
    ['Price discontinued after', duration(num(a.price_discontinued_after))],
  ]);

  heading(`Tradeable asset whitelist: OraclePools (${assets.filter((x) => x.approved).length} approved / ${assets.length})`);
  table(
    ['symbol', 'mint', 'approved', 'max slippage', 'pyth feed'],
    assets.map((x) => [
      x.symbol ?? '?',
      x.mint.toBase58(),
      x.approved ? c.green('yes') : c.dim('no'),
      x.maxSlippageBps ? bps(x.maxSlippageBps) : c.dim('default'),
      x.pythFeedId.length > 20 ? x.pythFeedId.slice(0, 18) + '…' : x.pythFeedId,
    ]),
  );
  if (report.kaminoReserves.length) {
    heading('Kamino reserves');
    table(['underlying', 'reserve', 'approved'], report.kaminoReserves.map((r) => [r.underlying ?? '?', r.reserve.toBase58(), r.approved ? c.green('yes') : c.dim('no')]));
  }
  console.log(c.dim(`\n  Read at ${date(Date.now() / 1000)} from ${maskRpc(conn.rpcEndpoint)}\n`));
}

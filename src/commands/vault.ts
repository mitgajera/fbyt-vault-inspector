import { Connection, PublicKey } from '@solana/web3.js';
import { VAULT_STATUS, PROGRAM_ID } from '../config.js';
import { tokensForEvents, summarizeEvent } from '../events.js';
import {
  amount, big, bps, c, date, duration, heading, isDefaultKey, kv, microUsd, num, rel, short, table, toJson, usd, when,
} from '../format.js';
import { pdas } from '../pdas.js';
import { accountTypeOf, decode, fetchAll, type Decoded } from '../program.js';
import { ataBalances, getMany, resolveTokens } from '../tokens.js';
import { fetchDecodedTx } from '../txdecode.js';

export type VaultOptions = { investors: boolean; history: number; json: boolean };

/** Lifecycle phase as the app shows it: status byte for closed, timestamps for the rest. */
export function vaultPhase(v: Decoded, idlePeriod: number, now = Date.now() / 1000) {
  const raiseEnd = num(v.created_at) + num(v.raise_period);
  const withdrawFrom = raiseEnd + num(v.withdraw_cooldown);
  const lastActivity = Math.max(num(v.last_trade_at), raiseEnd);
  const idleDeadline = lastActivity + idlePeriod;
  let phase = 'Active';
  if (num(v.vault_pool_status) === 2 || num(v.closed_at) > 0) phase = 'Closed';
  else if (now < raiseEnd) phase = 'Fundraising';
  else if (idlePeriod && now > idleDeadline) phase = 'Dormant';
  return { phase, raiseEnd, withdrawFrom, idleDeadline, withdrawalsOpen: phase !== 'Fundraising' && now >= withdrawFrom };
}

const priceOf = (e: Decoded) => num(e.price) * 10 ** num(e.exponent);

export async function inspectVault(conn: Connection, address: string, opts: VaultOptions) {
  const vaultKey = new PublicKey(address);
  const info = await conn.getAccountInfo(vaultKey);
  if (!info) throw new Error(`Account ${address} not found`);
  if (!info.owner.equals(PROGRAM_ID)) throw new Error(`Account is owned by ${info.owner.toBase58()}, not the FBYT program`);
  const type = accountTypeOf(info.data as Buffer);
  if (type !== 'VaultPool') throw new Error(`Account is ${type ? `an FBYT ${type}` : 'an unknown FBYT'} account, not a VaultPool`);
  const v = decode('VaultPool', info.data as Buffer);

  const admin = v.admin_pool as PublicKey;
  const manager = v.money_manager as PublicKey;
  const expected = {
    adminPool: pdas.adminPool(),
    moneyManagerPool: pdas.moneyManagerPool(admin, manager),
    assetRegistry: pdas.assetRegistry(vaultKey),
    vaultLedger: pdas.vaultLedger(vaultKey),
    priceSnapshot: pdas.priceSnapshot(vaultKey),
  };
  const [adminInfo, mmInfo, regInfo, ledgerInfo, snapInfo] = await getMany(conn, Object.values(expected));
  const adminPool = adminInfo ? decode('AdminPool', adminInfo.data as Buffer) : undefined;
  const mmPool = mmInfo ? decode('MoneyManagerPool', mmInfo.data as Buffer) : undefined;
  const registry = regInfo ? decode('AssetRegistry', regInfo.data as Buffer) : undefined;
  const ledger = ledgerInfo ? decode('VaultLedger', ledgerInfo.data as Buffer) : undefined;
  const snapshot = snapInfo ? decode('PriceSnapshot', snapInfo.data as Buffer) : undefined;

  // Re-derive the VaultPool address itself: seeds use the manager's vault counter at creation time.
  let creationNonce: number | undefined;
  for (let n = 0; mmPool && n <= num(mmPool.vaults_amount); n++) {
    if (pdas.vaultPool(admin, manager, n).equals(vaultKey)) {
      creationNonce = n;
      break;
    }
  }

  // Holdings: registry mints, vault ATAs, ledger obligations, snapshot prices.
  const baseMint = v.token_mint as PublicKey;
  const mints: PublicKey[] = registry?.asset_mints?.length ? registry.asset_mints : [baseMint];
  const tokens = await resolveTokens(conn, [baseMint, ...mints]);
  const balances = await ataBalances(conn, vaultKey, mints.map((m) => tokens.get(m.toBase58())!));
  const ledgerEntries: Decoded[] = (ledger?.entries ?? []).filter((e: Decoded) => !isDefaultKey(e.mint));
  const snapEntries: Decoded[] = (snapshot?.entries ?? []).slice(0, num(snapshot?.count));

  const holdings = balances.map((b) => {
    const le = ledgerEntries.find((e) => e.mint.equals(b.token.mint));
    const owed = le ? big(le.manager_owed) + big(le.admin_owed) : 0n;
    const reserved = le ? big(le.claims_reserved) : 0n;
    const net = b.raw - owed - reserved;
    const se = snapEntries.find((e) => e.mint.equals(b.token.mint));
    const price = se && !num(se.is_ctoken) ? priceOf(se) : undefined;
    const value = price !== undefined ? (Number(net) / 10 ** b.token.decimals) * price : undefined;
    return {
      mint: b.token.mint, symbol: b.token.symbol, decimals: b.token.decimals, ata: b.ata, ataExists: b.exists,
      balance: b.raw, owedFees: owed, claimsReserved: reserved, net, price, priceTime: se ? num(se.publish_time) : 0,
      oracleApproved: se ? !!num(se.approved) : undefined, isKaminoCToken: se ? !!num(se.is_ctoken) : false, valueUsd: value,
    };
  });

  const [investorPools, claims, kamino] = await Promise.all([
    opts.investors ? fetchAll(conn, 'InvestorPool', { vault_pool: vaultKey }) : Promise.resolve([]),
    big(v.reserved?.[0]?.amount) + big(v.reserved?.[1]?.amount) > 0n || ledgerEntries.some((e) => big(e.claims_reserved) > 0n)
      ? fetchAll(conn, 'Claim', { vault_pool: vaultKey })
      : Promise.resolve([]),
    num(v.kamino_position_accounts) > 0 ? fetchAll(conn, 'KaminoPosition', { vault_pool: vaultKey }) : Promise.resolve([]),
  ]);

  // Kamino supply positions: value the principal at the underlying's snapshot price (excludes accrued interest).
  const kaminoTokens = kamino.length ? await resolveTokens(conn, kamino.map((k) => k.data.liquidity_mint)) : new Map();
  const kaminoRows = kamino.map((k) => {
    const t = kaminoTokens.get(k.data.liquidity_mint.toBase58())!;
    const se = snapEntries.find((e) => e.mint.equals(k.data.liquidity_mint));
    const principal = big(k.data.principal);
    return {
      address: k.pubkey, reserve: k.data.reserve, symbol: t.symbol, principal, decimals: t.decimals, ctokens: big(k.data.ctokens),
      feeBps: num(k.data.fee_bps), valueUsd: se ? (Number(principal) / 10 ** t.decimals) * priceOf(se) : undefined,
    };
  });

  // kTokens held in the vault ATA are valued through their KaminoPosition rows, not as holdings.
  const navParts = [
    ...holdings.filter((h) => !(h.isKaminoCToken && kaminoRows.length)).map((h) => h.valueUsd),
    ...kaminoRows.map((k) => k.valueUsd),
  ];
  // An empty vault (nothing held, nothing lent) is worth $0 even before any price snapshot exists.
  const isEmpty = holdings.every((h) => h.balance === 0n) && kaminoRows.length === 0;
  const navComplete = isEmpty || navParts.every((x) => x !== undefined);
  const nav = navParts.reduce<number>((s, x) => s + (x ?? 0), 0);
  const cachedValue = num(v.value_usd) / 1e6;
  const shareBase = big(v.total_shares) + big(v.pending_mm_fee_shares);
  const navForShares = navComplete && nav > 0 ? nav : cachedValue;

  const investors = investorPools
    .map(({ pubkey, data }) => {
      const shares = big(data.shares);
      const fraction = shareBase > 0n ? Number(shares) / Number(shareBase) : 0;
      return {
        investorPool: pubkey, investor: data.investor as PublicKey, shares, fraction, valueUsd: fraction * navForShares,
        highWatermark: big(data.hight_watermark), createdAt: num(data.created_at), lastDepositAt: num(data.last_deposit_at),
        pdaOk: pdas.investorPool(data.investor, admin, vaultKey, data.token_mint).equals(pubkey),
        isManager: (data.investor as PublicKey).equals(manager),
      };
    })
    .sort((a, b) => (b.shares > a.shares ? 1 : -1));

  const idlePeriod = num(adminPool?.idle_period);
  const life = vaultPhase(v, idlePeriod);

  const roleOf = (k: PublicKey) =>
    k.equals(manager) ? 'manager' : !isDefaultKey(v.trading_delegate) && k.equals(v.trading_delegate) ? 'delegate'
      : adminPool && k.equals(adminPool.operator) ? 'operator' : adminPool && k.equals(adminPool.admin) ? 'admin'
        : investorPools.some((p) => (p.data.investor as PublicKey).equals(k)) ? 'investor' : short(k);
  const history: { signature: string; time: number; ok: boolean; signer: string; ixs: string[]; summary: string[] }[] = [];
  if (opts.history > 0) {
    const sigs = await conn.getSignaturesForAddress(vaultKey, { limit: opts.history });
    for (const s of sigs) {
      const tx = await fetchDecodedTx(conn, s.signature);
      if (!tx) continue;
      const evTokens = await tokensForEvents(conn, tx.events);
      history.push({
        signature: s.signature, time: tx.blockTime, ok: !tx.error, signer: roleOf(tx.feePayer),
        ixs: tx.instructions.map((i) => i.name),
        summary: tx.events.filter((e) => !/Snapshot|Refreshed/.test(e.name)).map((e) => `${e.name.replace(/Event$/, '')}: ${summarizeEvent(e, evTokens)}`),
      });
    }
  }

  const report = {
    address: vaultKey, phase: life.phase, statusByte: num(v.vault_pool_status),
    manager, tradingDelegate: isDefaultKey(v.trading_delegate) ? null : v.trading_delegate,
    protocolAdmin: adminPool?.admin, operator: adminPool?.operator,
    pdas: {
      vaultPool: { address: vaultKey, seeds: `["VaultPool", admin_pool, money_manager, ${creationNonce ?? '?'}]`, verified: creationNonce !== undefined },
      adminPool: { address: expected.adminPool, verified: expected.adminPool.equals(admin) },
      moneyManagerPool: { address: expected.moneyManagerPool, verified: !!mmPool },
      assetRegistry: { address: expected.assetRegistry, verified: expected.assetRegistry.equals(v.asset_registry) },
      vaultLedger: { address: expected.vaultLedger, verified: !!ledger },
      priceSnapshot: { address: expected.priceSnapshot, verified: !!snapshot },
    },
    baseToken: tokens.get(baseMint.toBase58()),
    terms: {
      index: num(v.index), managementFeeYearlyBps: num(v.money_management_yearly_fee), performanceFeeBps: num(v.performance_fee),
      protocolShareOfFeesBps: { management: num(adminPool?.protocol_money_management_fee), performance: num(adminPool?.protocol_performance_fee) },
      minContributionUsd: num(v.min_contribute_amount_usd) / 1e6, minRaiseUsd: num(v.min_raise_amount_usd) / 1e6,
      raisePeriodSec: num(v.raise_period), withdrawCooldownSec: num(v.withdraw_cooldown), mmFeeWithdrawPeriodSec: num(v.mm_withdraw_period),
      openEnded: !!v.is_open_ended,
    },
    lifecycle: {
      createdAt: num(v.created_at), raiseEnd: life.raiseEnd, withdrawalsOpenFrom: life.withdrawFrom, withdrawalsOpen: life.withdrawalsOpen,
      lastTradeAt: num(v.last_trade_at), idleDeadline: life.idleDeadline, lastMmFeeChargeAt: num(v.last_mm_fee_charge_at), closedAt: num(v.closed_at),
    },
    accounting: {
      investorCount: num(v.investor_count), raisedUsd: num(v.raised_amount_usd) / 1e6, totalShares: big(v.total_shares),
      pendingMmFeeShares: big(v.pending_mm_fee_shares), cachedValueUsd: cachedValue, cachedValueAt: num(v.value_at),
      navUsd: navComplete ? nav : null, snapshotWrittenAt: num(snapshot?.written_at),
    },
    risk: {
      dailyLossLimitBps: num(adminPool?.daily_loss_limit_bps), lossWindowStart: num(v.loss_window_start),
      lossWindowUsd: num(v.loss_window_usd) / 1e6, activityVolumeUsd: num(v.activity_volume_usd) / 1e6,
    },
    holdings, kamino: kaminoRows, claims: claims.map((x) => ({ address: x.pubkey, ...x.data })), investors, history,
    raw: v,
  };

  if (opts.json) {
    console.log(toJson(report));
    return report;
  }
  render(report);
  return report;
}

// The report is printed, not computed on, so the renderer takes it loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(r: any) {
  const phaseColor = { Active: c.green, Fundraising: c.yellow, Dormant: c.magenta, Closed: c.dim }[r.phase as string] ?? ((s: string) => s);
  console.log(c.bold(`\nFBYT Vault ${r.address.toBase58()}`) + `  ${phaseColor(r.phase)} ${c.dim(`(status byte ${r.statusByte} = ${VAULT_STATUS[r.statusByte] ?? '?'})`)}`);
  console.log(c.dim(`https://app.fbyt.io/invest/vault?vault=${r.address.toBase58()}  ·  https://solscan.io/account/${r.address.toBase58()}`));

  heading('Roles & permissions');
  kv([
    ['Money manager', `${r.manager.toBase58()}  ${c.dim('signs create_vault, swap, set/revoke delegate, close_vault')}`],
    ['Trading delegate', r.tradingDelegate ? `${r.tradingDelegate.toBase58()}  ${c.yellow('can swap; cannot withdraw')}` : c.dim('none')],
    ['Protocol admin', `${r.protocolAdmin?.toBase58() ?? '—'}  ${c.dim('AdminPool.admin: fee caps, oracle whitelist')}`],
    ['Operator', `${r.operator?.toBase58() ?? '—'}  ${c.dim('crank: init_vault_accounts, withdraw_money_management_fee')}`],
    ['Asset custody', c.dim('vault ATAs owned by the VaultPool PDA (no private key; only the program can sign)')],
  ]);

  heading('PDA derivation (re-derived locally from IDL seeds)');
  table(
    ['account', 'address', 'check'],
    Object.entries(r.pdas).map(([name, p]: [string, any]) => [name, p.address.toBase58(), p.verified ? c.green('✓') + (p.seeds ? c.dim(' ' + p.seeds) : '') : c.red('✗')]),
  );

  const t = r.terms;
  heading('Terms');
  kv([
    ['Base token', `${r.baseToken.symbol} ${c.dim(r.baseToken.mint.toBase58())}`],
    ['Management fee', `${bps(t.managementFeeYearlyBps)} / year  ${c.dim(`(protocol keeps ${bps(t.protocolShareOfFeesBps.management)} of it)`)}`],
    ['Performance fee', `${bps(t.performanceFeeBps)} over per-investor high-water mark  ${c.dim(`(protocol keeps ${bps(t.protocolShareOfFeesBps.performance)})`)}`],
    ['Min contribution', usd(t.minContributionUsd)],
    ['Min raise', usd(t.minRaiseUsd)],
    ['Raise period', duration(t.raisePeriodSec)],
    ['Withdraw cooldown', duration(t.withdrawCooldownSec)],
    ['MM fee period', duration(t.mmFeeWithdrawPeriodSec)],
    ['Open-ended', t.openEnded ? 'yes (deposits after raise)' : 'no'],
  ]);

  const l = r.lifecycle;
  heading('Lifecycle');
  kv([
    ['Created', when(l.createdAt)],
    ['Raise ends', when(l.raiseEnd)],
    ['Withdrawals open', `${when(l.withdrawalsOpenFrom)}  ${l.withdrawalsOpen ? c.green('open') : c.yellow('locked')}`],
    ['Last trade', when(l.lastTradeAt)],
    ['Dormant after', r.phase === 'Closed' ? '—' : when(l.idleDeadline)],
    ['Last mgmt-fee charge', when(l.lastMmFeeChargeAt)],
    ...(l.closedAt ? [['Closed', when(l.closedAt)] as [string, string]] : []),
  ]);

  heading('Holdings (vault ATAs − fees owed − claim reserves) × Pyth snapshot price');
  table(
    ['asset', 'balance', 'owed fees', 'reserved', 'price', 'price age', 'value'],
    r.holdings.map((h: any) => [
      `${h.symbol}${h.isKaminoCToken ? c.dim(' (kToken)') : ''}${h.oracleApproved === false ? c.red(' !approved') : ''}`,
      amount(h.balance, h.decimals),
      h.owedFees ? amount(h.owedFees, h.decimals) : c.dim('0'),
      h.claimsReserved ? amount(h.claimsReserved, h.decimals) : c.dim('0'),
      h.price !== undefined ? usd(h.price) : c.dim('n/a'),
      h.priceTime ? rel(h.priceTime) : c.dim('—'),
      h.valueUsd !== undefined ? usd(h.valueUsd) : c.dim(h.isKaminoCToken ? 'see Kamino' : 'n/a'),
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
  );
  if (r.kamino.length) {
    heading('Kamino lending positions');
    table(
      ['underlying', 'principal', 'cTokens', 'fee', '≈ value (principal)'],
      r.kamino.map((k: any) => [k.symbol, amount(k.principal, k.decimals), amount(k.ctokens, k.decimals), bps(k.feeBps), k.valueUsd !== undefined ? usd(k.valueUsd) : 'n/a']),
      ['l', 'r', 'r', 'r', 'r'],
    );
  }

  const a = r.accounting;
  heading('Accounting');
  kv([
    ['NAV (computed now)', a.navUsd !== null ? c.bold(usd(a.navUsd)) : c.yellow('incomplete (missing prices)')],
    ['Cached value_usd', `${usd(a.cachedValueUsd)}  ${c.dim('set ' + rel(a.cachedValueAt))}`],
    ['Price snapshot', a.snapshotWrittenAt ? `written ${rel(a.snapshotWrittenAt)} ${c.dim('(deposits/withdrawals need ≤ 60 s)')}` : '—'],
    ['Investors', a.investorCount],
    ['Raised (USD at deposit)', usd(a.raisedUsd)],
    ['Total shares', a.totalShares.toLocaleString('en-US')],
    ['Pending mgmt-fee shares', a.pendingMmFeeShares.toLocaleString('en-US')],
  ]);

  const k = r.risk;
  const used = a.cachedValueUsd > 0 ? (k.lossWindowUsd / a.cachedValueUsd) * 10000 : 0;
  heading('Swap risk guards');
  kv([
    ['Daily loss limit', `${bps(k.dailyLossLimitBps)} of value`],
    ['Loss in current window', `${usd(k.lossWindowUsd)} (${bps(used)} used) ${c.dim('window started ' + rel(k.lossWindowStart))}`],
    ['Activity since idle reset', usd(k.activityVolumeUsd)],
  ]);

  if (r.investors.length) {
    heading(`Investors (${r.investors.length})`);
    table(
      ['investor', 'shares', 'ownership', '≈ value', 'first deposit', 'last deposit', 'pda'],
      r.investors.map((i: any) => [
        i.investor.toBase58() + (i.isManager ? c.cyan(' (manager)') : ''),
        i.shares.toLocaleString('en-US'),
        `${(i.fraction * 100).toFixed(2)}%`,
        usd(i.valueUsd),
        date(i.createdAt),
        date(i.lastDepositAt),
        i.pdaOk ? c.green('✓') : c.red('✗'),
      ]),
      ['l', 'r', 'r', 'r', 'l', 'l', 'l'],
    );
  }
  if (r.claims.length) {
    heading('Withheld claims (frozen / paused transfers)');
    table(['claim', 'mint', 'recipient', 'amount', 'kind'], r.claims.map((x: any) => [short(x.address), short(x.mint), short(x.recipient), String(x.amount), String(x.kind)]));
  }
  if (r.history.length) {
    heading(`Recent activity (last ${r.history.length} txs)`);
    for (const h of r.history) {
      console.log(
        `  ${c.dim(date(h.time))} ${h.ok ? '' : c.red('FAILED ')}${c.bold(h.ixs.join(', ') || '(no FBYT ix)')} ${c.cyan('by ' + h.signer)} ${c.dim(short(h.signature, 6))}`,
      );
      for (const s of h.summary) console.log(`      ${s}`);
    }
  }
  console.log();
}

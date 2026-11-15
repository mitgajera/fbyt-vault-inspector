import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../config.js';
import { amount, c, date, heading, kv, num, short, table, toJson } from '../format.js';
import { pdas } from '../pdas.js';
import { decode, fetchAll } from '../program.js';
import { resolveTokens } from '../tokens.js';
import bs58 from 'bs58';
import { PROGRAM_ID } from '../config.js';
import { coder } from '../program.js';
import { programLabel } from '../txdecode.js';

type Hist = {
  signature: string; time: number; ok: boolean; error?: string; feePayer: boolean; programs: string[]; fbyt: string[];
  solDelta: number; tokenDeltas: { owner: string; mint: string; decimals: number; delta: bigint }[]; note?: string;
};

/** One jsonParsed getTransaction (works for every tx version), summarised for the wallet table. */
async function rawSummary(rpc: string, signature: string, wallet: PublicKey): Promise<Hist | null> {
  let r;
  for (let attempt = 0; attempt < 6 && !r; attempt++) {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }] }),
    });
    if (res.status === 429) {
      await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
      continue;
    }
    r = (await res.json()).result;
    if (!r) return null;
  }
  if (!r) throw new Error('RPC rate limit: pass --rpc with a private endpoint');
  const keys: string[] = r.transaction.message.accountKeys.map((k: { pubkey: string }) => k.pubkey);
  const idx = keys.indexOf(wallet.toBase58());
  const logs: string[] = r.meta.logMessages ?? [];
  const invoked = [...new Set(logs.map((l) => l.match(/^Program (\w+) invoke \[1\]/)?.[1]).filter((x): x is string => !!x))];
  // FBYT's program doesn't log instruction names, so decode its top-level and inner instruction data.
  type RawIx = { programId: string; data?: string };
  const allIxs: RawIx[] = [
    ...r.transaction.message.instructions,
    ...(r.meta.innerInstructions ?? []).flatMap((g: { instructions: RawIx[] }) => g.instructions),
  ];
  const fbyt = allIxs
    .filter((ix) => ix.programId === PROGRAM_ID.toBase58() && ix.data)
    .map((ix) => coder.instruction.decode(Buffer.from(bs58.decode(ix.data!)))?.name ?? 'unknown');
  const deltas = new Map<number, { owner: string; mint: string; decimals: number; delta: bigint }>();
  for (const b of r.meta.preTokenBalances ?? []) deltas.set(b.accountIndex, { owner: b.owner, mint: b.mint, decimals: b.uiTokenAmount.decimals, delta: -BigInt(b.uiTokenAmount.amount) });
  for (const b of r.meta.postTokenBalances ?? []) {
    const d = deltas.get(b.accountIndex) ?? { owner: b.owner, mint: b.mint, decimals: b.uiTokenAmount.decimals, delta: 0n };
    d.delta += BigInt(b.uiTokenAmount.amount);
    deltas.set(b.accountIndex, d);
  }
  return {
    signature, time: r.blockTime ?? 0, ok: !r.meta.err, error: r.meta.err ? JSON.stringify(r.meta.err) : undefined,
    feePayer: keys[0] === wallet.toBase58(),
    programs: invoked.map(programLabel).filter((l) => !['Compute Budget', 'System', 'SPL Token', 'Associated Token'].includes(l)),
    fbyt,
    solDelta: idx >= 0 ? (r.meta.postBalances[idx] - r.meta.preBalances[idx]) / 1e9 : 0,
    tokenDeltas: [...deltas.values()].filter((d) => d.delta !== 0n && d.owner === wallet.toBase58()),
    note: `v${r.version}`,
  };
}

/**
 * Everything about one wallet from FBYT's point of view: SOL, token accounts (and any delegate
 * approvals on them, the usual drainer foothold), FBYT manager pool, vaults, positions, and a
 * per-transaction summary of its recent history.
 */
export async function inspectWallet(conn: Connection, address: string, opts: { limit: number; json: boolean }) {
  const wallet = new PublicKey(address);
  const info = await conn.getAccountInfo(wallet);
  const sol = (info?.lamports ?? 0) / 1e9;

  // Token accounts, including delegate approvals and close authorities.
  const tokenAccounts = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await conn.getParsedTokenAccountsByOwner(wallet, { programId });
    for (const a of res.value) {
      const i = a.account.data.parsed.info;
      tokenAccounts.push({
        account: a.pubkey, mint: new PublicKey(i.mint), amount: i.tokenAmount.uiAmountString as string, state: i.state as string,
        delegate: i.delegate as string | undefined, delegatedAmount: i.delegatedAmount?.uiAmountString as string | undefined,
        closeAuthority: i.closeAuthority as string | undefined,
      });
    }
  }
  const tokens = await resolveTokens(conn, tokenAccounts.map((t) => t.mint));

  // FBYT footprint.
  const admin = pdas.adminPool();
  const mmPoolKey = pdas.moneyManagerPool(admin, wallet);
  const mmInfo = await conn.getAccountInfo(mmPoolKey);
  const mmPool = mmInfo ? decode('MoneyManagerPool', mmInfo.data as Buffer) : undefined;
  const [vaults, positions] = await Promise.all([
    fetchAll(conn, 'VaultPool', { money_manager: wallet }),
    fetchAll(conn, 'InvestorPool', { investor: wallet }),
  ]);
  const expectedVaults = mmPool
    ? Array.from({ length: num(mmPool.vaults_amount) }, (_, n) => pdas.vaultPool(admin, wallet, n).toBase58())
    : [];

  // Recent history, decoded one by one (sequential to stay under public RPC limits).
  const sigs = await conn.getSignaturesForAddress(wallet, { limit: opts.limit });
  const history: Hist[] = [];
  // One jsonParsed call per tx (also handles tx versions web3.js 1.x rejects), paced for public RPCs.
  for (const s of sigs) {
    const h = await rawSummary(conn.rpcEndpoint, s.signature, wallet);
    if (h) history.push(h);
    await new Promise((r) => setTimeout(r, 250));
  }
  const histTokens = await resolveTokens(conn, history.flatMap((h) => h.tokenDeltas.map((d) => new PublicKey(d.mint))));

  const report = {
    wallet, sol, isKeypair: PublicKey.isOnCurve(wallet.toBytes()), tokenAccounts,
    moneyManagerPool: mmPool ? { address: mmPoolKey, vaultsCreated: num(mmPool.vaults_amount) } : null,
    vaults: vaults.map((v) => ({ address: v.pubkey, status: num(v.data.vault_pool_status), investors: num(v.data.investor_count), createdAt: num(v.data.created_at), pdaOk: expectedVaults.includes(v.pubkey.toBase58()) })),
    positions: positions.map((p) => ({ investorPool: p.pubkey, vault: p.data.vault_pool, shares: p.data.shares })),
    history,
  };
  if (opts.json) {
    console.log(toJson(report));
    return report;
  }

  heading(`Wallet ${address}`);
  kv([
    ['SOL balance', `${sol} SOL`],
    ['Type', report.isKeypair ? 'regular keypair wallet' : 'PDA (program-owned address)'],
    ['Token accounts', String(tokenAccounts.length)],
    ['Risky approvals', tokenAccounts.some((t) => t.delegate) ? c.red('YES: see table below') : c.green('none (no token delegates)')],
  ]);
  if (tokenAccounts.length) {
    table(
      ['token', 'balance', 'state', 'delegate', 'close authority'],
      tokenAccounts.map((t) => [
        tokens.get(t.mint.toBase58())?.symbol ?? short(t.mint), t.amount, t.state,
        t.delegate ? c.red(`${short(t.delegate)} (${t.delegatedAmount})`) : c.dim('none'),
        t.closeAuthority && t.closeAuthority !== address ? c.yellow(short(t.closeAuthority)) : c.dim('owner'),
      ]),
    );
  }

  heading('FBYT footprint');
  kv([
    ['Manager pool', mmPool ? `${mmPoolKey.toBase58()} ${c.green('registered')} · ${num(mmPool.vaults_amount)} vault(s) created` : c.dim('not registered')],
    ['Vaults managed', String(vaults.length)],
    ['Investor positions', String(positions.length)],
  ]);
  for (const v of report.vaults) {
    console.log(`  vault ${v.address.toBase58()}  created ${date(v.createdAt)}  investors ${v.investors}  pda ${v.pdaOk ? c.green('✓') : c.red('✗')}`);
  }

  heading(`Recent transactions (${history.length})`);
  table(
    ['time', 'status', 'SOL change', 'tokens', 'programs / FBYT instructions', 'signature'],
    history.map((h) => [
      date(h.time),
      h.ok ? c.green('ok') : c.red('failed'),
      h.solDelta === 0 ? c.dim('0') : h.solDelta > 0 ? c.green(`+${h.solDelta}`) : c.red(String(h.solDelta)),
      h.tokenDeltas.map((d) => `${d.delta > 0n ? '+' : ''}${amount(d.delta, d.decimals)} ${histTokens.get(d.mint)?.symbol ?? short(d.mint)}`).join(', ') || c.dim('—'),
      [...h.fbyt.map((n) => c.cyan(n)), ...h.programs.filter((p) => p !== 'FBYT vault')].join(', ') || c.dim('transfer only'),
      short(h.signature, 6),
    ]),
    ['l', 'l', 'r', 'l', 'l', 'l'],
  );
  console.log();
  return report;
}

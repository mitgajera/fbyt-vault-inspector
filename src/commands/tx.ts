import { Connection, PublicKey } from '@solana/web3.js';
import { tokensForEvents, summarizeEvent } from '../events.js';
import { amount, c, date, heading, short, table, toJson } from '../format.js';
import { resolveTokens } from '../tokens.js';
import { fetchDecodedTx, programLabel } from '../txdecode.js';

const fmtArg = (v: unknown): string => {
  if (v instanceof PublicKey) return v.toBase58();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (v && typeof v === 'object' && v.constructor?.name === 'BN') return v.toString();
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** Annotated breakdown of one transaction: FBYT instructions with named accounts, CPIs, events, token deltas. */
export async function inspectTx(conn: Connection, signature: string, opts: { json: boolean; logs: boolean; accounts: boolean }) {
  const tx = await fetchDecodedTx(conn, signature);
  if (!tx) throw new Error('Transaction not found (needs a mainnet signature; RPC may have pruned very old txs)');

  if (opts.json) {
    console.log(toJson(tx));
    return tx;
  }
  const tokens = await resolveTokens(conn, tx.tokenDeltas.map((d) => new PublicKey(d.mint)));
  const evTokens = await tokensForEvents(conn, tx.events);

  console.log(c.bold(`\nTransaction ${signature}`));
  console.log(c.dim(`https://solscan.io/tx/${signature}`));
  heading('Overview');
  table(
    ['field', 'value'],
    [
      ['time', date(tx.blockTime)],
      ['slot', tx.slot],
      ['status', tx.error ? c.red('FAILED: ' + tx.error) : c.green('success')],
      ['fee payer', tx.feePayer.toBase58()],
      ['signers', tx.signers.map((s) => s.toBase58()).join(', ')],
      ['fee / CU', `${tx.fee} lamports / ${tx.computeUnits ?? '?'} CU`],
      ['programs', tx.programs.map((p) => `${p.label}${p.count > 1 ? ' ×' + p.count : ''}`).join(', ')],
    ],
  );

  for (const ix of tx.instructions) {
    heading(`FBYT instruction #${ix.path}: ${ix.name}${ix.path.includes('.') ? c.dim(' (inner / CPI)') : ''}`);
    const args = Object.entries(ix.args);
    if (args.length) for (const [k, v] of args) console.log(`  ${c.dim(k + ':')} ${fmtArg(v)}`);
    if (ix.layoutMismatch) {
      console.log(
        c.yellow(`  ⚠ account list doesn't match the current IDL (${ix.layoutMismatch.join(', ')}): this tx predates a program upgrade, so account names below may be shifted. Args, events and token changes are still accurate.`),
      );
    }
    if (ix.jupiterRoute) console.log(`  ${c.dim('jupiter entrypoint:')} ${c.yellow(ix.jupiterRoute)} ${c.dim('(decoded from the route bytes the manager passed)')}`);
    // Remaining accounts (Jupiter route accounts, per-mint pricing accounts) are long; annotate the
    // ones that alias a named account or a known program and collapse the rest unless --accounts.
    const named = ix.accounts.filter((a) => !a.name.startsWith('remaining'));
    const remaining = ix.accounts.filter((a) => a.name.startsWith('remaining'));
    const alias = (k: PublicKey) => {
      const n = named.find((a) => a.pubkey.equals(k));
      if (n) return c.cyan(`= ${n.name}`);
      const label = programLabel(k.toBase58());
      return label !== k.toBase58() ? c.dim(label) : '';
    };
    const shown = opts.accounts ? remaining : remaining.filter((a) => alias(a.pubkey) && !programLabel(a.pubkey.toBase58()).startsWith('SPL'));
    table(
      ['#', 'account', 'address', 'flags', 'note'],
      [...named, ...shown].map((a) => [
        ix.accounts.indexOf(a),
        a.name,
        a.pubkey.toBase58(),
        [a.signer && c.yellow('signer'), a.writable && 'mut'].filter(Boolean).join(' '),
        a.name.startsWith('remaining') ? alias(a.pubkey) : '',
      ]),
      ['r', 'l', 'l', 'l', 'l'],
    );
    if (remaining.length > shown.length) {
      console.log(c.dim(`  … ${remaining.length - shown.length} more remaining accounts (route / pricing accounts; --accounts to list all)`));
    }
    const trace = tx.traces.find((t) => String(t.index) === ix.path);
    if (trace) {
      const nameOf = (addr: string) => {
        const a = ix.accounts.find((x) => x.pubkey.toBase58() === addr && !x.name.startsWith('remaining'));
        return a ? c.cyan(a.name) : short(addr);
      };
      console.log(`\n  ${c.dim('CPI trace')}`);
      for (const s of trace.steps) {
        // Collapse Jupiter's internal AMM hops; keep what the vault program itself invokes.
        if (s.depth > 3) continue;
        const detail = (s.detail ?? '').replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, nameOf);
        console.log(`  ${'  '.repeat(Math.max(0, s.depth - 2))}└ ${s.label}${detail ? ': ' + detail : ''}`);
      }
    }
  }
  if (!tx.instructions.length) console.log(c.yellow('\n  This transaction has no FBYT vault instructions.'));

  heading('Events emitted');
  if (!tx.events.length) console.log(c.dim('  (none)'));
  for (const e of tx.events) console.log(`  ${c.bold(e.name)}  ${summarizeEvent(e, evTokens)}`);

  heading('Token balance changes');
  table(
    ['owner', 'token', 'change'],
    tx.tokenDeltas.map((d) => {
      const t = tokens.get(d.mint);
      const s = amount(d.delta, d.decimals);
      return [d.owner, t?.symbol ?? short(d.mint), d.delta > 0n ? c.green('+' + s) : c.red(s)];
    }),
    ['l', 'l', 'r'],
  );

  if (opts.logs) {
    heading('Program logs');
    for (const l of tx.logs) console.log('  ' + c.dim(l));
  }
  console.log();
  return tx;
}

import { createHash } from 'node:crypto';
import { EventParser } from '@coral-xyz/anchor';
import { Connection, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { JUPITER_V6, KAMINO_LEND, PROGRAM_ID } from './config.js';
import { coder, errorFor, ixAccountNames, type Decoded } from './program.js';

export type DecodedIx = {
  path: string; // "2" for a top-level ix, "2.1" for its first inner ix
  name: string;
  args: Decoded;
  accounts: { name: string; pubkey: PublicKey; signer: boolean; writable: boolean }[];
  jupiterRoute?: string;
  /** Set when fixed-address accounts in the IDL don't line up: the tx was built for an older program version. */
  layoutMismatch?: string[];
};

export type TraceStep = { depth: number; program: string; label: string; detail?: string };

export type DecodedTx = {
  signature: string;
  slot: number;
  blockTime: number;
  fee: number;
  computeUnits?: number;
  feePayer: PublicKey;
  signers: PublicKey[];
  error?: string;
  instructions: DecodedIx[];
  /** CPI tree under each top-level FBYT instruction, keyed by top-level index. */
  traces: { index: number; steps: TraceStep[] }[];
  programs: { program: string; label: string; count: number }[];
  events: { name: string; data: Decoded }[];
  tokenDeltas: { owner: string; mint: string; decimals: number; delta: bigint }[];
  logs: string[];
};

const LABELS: Record<string, string> = {
  [PROGRAM_ID.toBase58()]: 'FBYT vault',
  [JUPITER_V6.toBase58()]: 'Jupiter v6',
  [KAMINO_LEND.toBase58()]: 'Kamino Lend',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token',
  '11111111111111111111111111111111': 'System',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT: 'Pyth Push Oracle',
  rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ: 'Pyth Receiver',
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: 'Memo',
};
export const programLabel = (p: string) => LABELS[p] ?? p;

// Jupiter v6 entrypoints, identified by their Anchor discriminators.
const JUP_IXS = [
  'route', 'route_with_token_ledger', 'shared_accounts_route', 'shared_accounts_route_with_token_ledger',
  'exact_out_route', 'shared_accounts_exact_out_route', 'route_v2', 'shared_accounts_route_v2', 'exact_out_route_v2', 'shared_accounts_exact_out_route_v2',
];
const jupDisc = new Map(JUP_IXS.map((n) => [createHash('sha256').update(`global:${n}`).digest().subarray(0, 8).toString('hex'), n]));
const jupiterRouteName = (data: Buffer) => jupDisc.get(data.subarray(0, 8).toString('hex'));

// SPL Token / Token-2022 instruction tags (first data byte). Token CPIs don't log their names, so we decode them.
const TOKEN_IX: Record<number, string> = {
  0: 'InitializeMint', 1: 'InitializeAccount', 3: 'Transfer', 4: 'Approve', 5: 'Revoke', 6: 'SetAuthority', 7: 'MintTo', 8: 'Burn',
  9: 'CloseAccount', 10: 'FreezeAccount', 11: 'ThawAccount', 12: 'TransferChecked', 13: 'ApproveChecked', 14: 'MintToChecked',
  15: 'BurnChecked', 17: 'SyncNative', 18: 'InitializeAccount3',
};
const SYSTEM_IX: Record<number, string> = { 0: 'CreateAccount', 1: 'Assign', 2: 'Transfer', 8: 'Allocate' };

function describeStep(program: PublicKey, data: Buffer, accounts: PublicKey[]): string | undefined {
  const p = program.toBase58();
  if (p === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || p === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
    const name = TOKEN_IX[data[0]] ?? `tag ${data[0]}`;
    const amt = [3, 4, 7, 8, 12, 13, 14, 15].includes(data[0]) && data.length >= 9 ? ` amount=${data.readBigUInt64LE(1)}` : '';
    // Approve: [source, delegate, owner]; Revoke: [source, owner]; Transfer: [source, dest, authority]
    const who = data[0] === 4 ? ` source=${accounts[0]?.toBase58()} delegate=${accounts[1]?.toBase58()}`
      : data[0] === 13 ? ` source=${accounts[0]?.toBase58()} delegate=${accounts[2]?.toBase58()}`
        : data[0] === 5 ? ` source=${accounts[0]?.toBase58()}` : '';
    return name + amt + who;
  }
  if (p === '11111111111111111111111111111111') {
    const tag = data.length >= 4 ? data.readUInt32LE(0) : -1;
    const lamports = tag === 2 && data.length >= 12 ? ` ${Number(data.readBigUInt64LE(4)) / 1e9} SOL ${accounts[0]?.toBase58().slice(0, 6)}… → ${accounts[1]?.toBase58().slice(0, 6)}…` : '';
    return (SYSTEM_IX[tag] ?? `tag ${tag}`) + lamports;
  }
  if (program.equals(JUPITER_V6)) return jupiterRouteName(data);
  if (program.equals(PROGRAM_ID)) return coder.instruction.decode(data)?.name;
  return undefined;
}

const parser = new EventParser(PROGRAM_ID, coder);
export function parseEvents(logs: string[]): { name: string; data: Decoded }[] {
  try {
    return [...parser.parseLogs(logs)].map((e) => ({ name: e.name, data: e.data as Decoded }));
  } catch {
    return [];
  }
}

function decodeFbytIx(path: string, data: Buffer, keys: PublicKey[], isSigner: (k: PublicKey) => boolean, isWritable: (k: PublicKey) => boolean): DecodedIx {
  const decoded = coder.instruction.decode(data);
  const name = decoded?.name ?? `unknown(${data.subarray(0, 8).toString('hex')})`;
  const names = decoded ? ixAccountNames(name) : [];
  const ix: DecodedIx = {
    path,
    name,
    args: (decoded?.data as Decoded) ?? {},
    accounts: keys.map((k, i) => ({ name: names[i]?.name ?? `remaining[${i - names.length}]`, pubkey: k, signer: isSigner(k), writable: isWritable(k) })),
  };
  if (name === 'swap' && ix.args.data) ix.jupiterRoute = jupiterRouteName(Buffer.from(ix.args.data)) ?? 'unrecognised route data';
  // Accounts the IDL pins to a fixed address (programs, sysvars) must appear exactly there. If they
  // don't, this tx used an older account list (the program has been upgraded since) and names drift.
  const drift = names
    .map((n, i) => (n.address && keys[i] && keys[i].toBase58() !== n.address ? `${n.name} (#${i})` : null))
    .filter((x): x is string => !!x);
  if (drift.length || (decoded && keys.length < names.length)) ix.layoutMismatch = drift.length ? drift : ['fewer accounts than the current IDL'];
  return ix;
}

function describeError(err: unknown, keys: PublicKey[], programAt: (ix: number) => PublicKey | undefined): string | undefined {
  if (!err) return undefined;
  const ie = (err as { InstructionError?: [number, unknown] }).InstructionError;
  if (ie) {
    const [index, detail] = ie;
    const custom = (detail as { Custom?: number })?.Custom;
    const program = programAt(index);
    if (custom !== undefined && program?.equals(PROGRAM_ID)) {
      const e = errorFor(custom);
      return `ix #${index}: ${e ? `${e.name} (${custom})${e.msg ? ' — ' + e.msg : ''}` : `custom ${custom}`}`;
    }
    return `ix #${index} (${program ? programLabel(program.toBase58()) : '?'}): ${JSON.stringify(detail)}`;
  }
  return JSON.stringify(err);
}

export function decodeTxResponse(signature: string, tx: VersionedTransactionResponse): DecodedTx {
  const meta = tx.meta!;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses }).keySegments().flat();
  const nSigners = msg.header.numRequiredSignatures;
  const signers = keys.slice(0, nSigners);
  const isSigner = (k: PublicKey) => signers.some((s) => s.equals(k));
  const isWritable = (k: PublicKey) => {
    const i = keys.findIndex((x) => x.equals(k));
    return i >= 0 && msg.isAccountWritable(i);
  };

  const instructions: DecodedIx[] = [];
  const programCount = new Map<string, number>();
  const bump = (p: PublicKey) => programCount.set(p.toBase58(), (programCount.get(p.toBase58()) ?? 0) + 1);
  const inner = new Map((meta.innerInstructions ?? []).map((g) => [g.index, g.instructions]));

  const traces: { index: number; steps: TraceStep[] }[] = [];
  msg.compiledInstructions.forEach((ci, i) => {
    const program = keys[ci.programIdIndex];
    bump(program);
    const isFbyt = program.equals(PROGRAM_ID);
    if (isFbyt) {
      instructions.push(decodeFbytIx(String(i), Buffer.from(ci.data), ci.accountKeyIndexes.map((k) => keys[k]), isSigner, isWritable));
    }
    const steps: TraceStep[] = [];
    (inner.get(i) ?? []).forEach((ii, j) => {
      const p = keys[ii.programIdIndex];
      bump(p);
      const raw = Buffer.from(bs58.decode(ii.data));
      const depth = (ii as { stackHeight?: number }).stackHeight ?? 2;
      steps.push({ depth, program: p.toBase58(), label: programLabel(p.toBase58()), detail: describeStep(p, raw, ii.accounts.map((k) => keys[k])) });
      if (p.equals(PROGRAM_ID)) {
        instructions.push(decodeFbytIx(`${i}.${j + 1}`, raw, ii.accounts.map((k) => keys[k]), isSigner, isWritable));
      }
    });
    if (isFbyt && steps.length) traces.push({ index: i, steps });
  });

  // Token balance changes, keyed by token account.
  const deltas = new Map<number, { owner: string; mint: string; decimals: number; delta: bigint }>();
  for (const b of meta.preTokenBalances ?? []) {
    deltas.set(b.accountIndex, { owner: b.owner ?? '?', mint: b.mint, decimals: b.uiTokenAmount.decimals, delta: -BigInt(b.uiTokenAmount.amount) });
  }
  for (const b of meta.postTokenBalances ?? []) {
    const d = deltas.get(b.accountIndex) ?? { owner: b.owner ?? '?', mint: b.mint, decimals: b.uiTokenAmount.decimals, delta: 0n };
    d.delta += BigInt(b.uiTokenAmount.amount);
    deltas.set(b.accountIndex, d);
  }

  const logs = meta.logMessages ?? [];
  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? 0,
    fee: meta.fee,
    computeUnits: meta.computeUnitsConsumed ?? undefined,
    feePayer: keys[0],
    signers,
    error: describeError(meta.err, keys, (ix) => keys[msg.compiledInstructions[ix]?.programIdIndex]),
    instructions,
    traces,
    programs: [...programCount].map(([program, count]) => ({ program, label: programLabel(program), count })),
    events: parseEvents(logs),
    tokenDeltas: [...deltas.values()].filter((d) => d.delta !== 0n),
    logs,
  };
}

export async function fetchDecodedTx(c: Connection, signature: string): Promise<DecodedTx | null> {
  const tx = await c.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  return tx ? decodeTxResponse(signature, tx) : null;
}

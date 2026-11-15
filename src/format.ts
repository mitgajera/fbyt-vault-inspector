import { PublicKey } from '@solana/web3.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { bold: wrap(1), dim: wrap(2), red: wrap(31), green: wrap(32), yellow: wrap(33), cyan: wrap(36), magenta: wrap(35) };

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v.toString()));
export const big = (v: unknown): bigint => BigInt(v === null || v === undefined ? 0 : v.toString());

export const short = (k: PublicKey | string, n = 4) => {
  const s = typeof k === 'string' ? k : k.toBase58();
  return s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
};

/** An RPC URL safe to print: host only, query string (API keys) and path hidden. */
export function maskRpc(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + (u.pathname.length > 1 || u.search ? '/…' : '');
  } catch {
    return '(custom RPC)';
  }
}

export const isDefaultKey =(k: PublicKey) => k.equals(PublicKey.default);

export const usd = (v: number) =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: v !== 0 && Math.abs(v) < 1 ? 4 : 2 });
/** On-chain USD amounts are stored in micro-USD (6 decimals). */
export const microUsd = (v: unknown) => usd(num(v) / 1e6);
export const bps = (v: unknown) => `${(num(v) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export const amount = (raw: bigint, decimals: number) => {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = decimals ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6) : '';
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
};

export function duration(seconds: number): string {
  if (!seconds) return '0';
  const units: [string, number][] = [['y', 31536000], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  const out: string[] = [];
  let rest = Math.abs(seconds);
  for (const [u, n] of units) {
    if (rest >= n && out.length < 2) {
      out.push(`${Math.floor(rest / n)}${u}`);
      rest %= n;
    }
  }
  return out.join(' ');
}

export const date = (ts: number) => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—');
export function rel(ts: number, now = Date.now() / 1000): string {
  if (!ts) return '—';
  const d = ts - now;
  return d >= 0 ? `in ${duration(d)}` : `${duration(-d)} ago`;
}
export const when = (ts: number) => (ts ? `${date(ts)} ${c.dim('(' + rel(ts) + ')')}` : '—');

export function heading(title: string) {
  console.log('\n' + c.bold(c.cyan(title)));
}

export function kv(rows: [string, string | number | undefined][], indent = 2) {
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(' '.repeat(indent) + c.dim(k.padEnd(w)) + '  ' + (v ?? '—'));
}

export function table(headers: string[], rows: (string | number)[][], align: ('l' | 'r')[] = []) {
  if (!rows.length) {
    console.log('  ' + c.dim('(none)'));
    return;
  }
  const cells = rows.map((r) => r.map(String));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => visible(r[i] ?? '').length)));
  const pad = (s: string, i: number) => {
    const gap = ' '.repeat(Math.max(0, widths[i] - visible(s).length));
    return align[i] === 'r' ? gap + s : s + gap;
  };
  console.log('  ' + headers.map((h, i) => c.dim(pad(h, i))).join('  '));
  for (const r of cells) console.log('  ' + r.map((s, i) => pad(s, i)).join('  '));
}

/**
 * JSON output: PublicKey → base58, BN/bigint → decimal string, Buffer → hex.
 * Normalised before stringify because BN.toJSON() would otherwise emit hex.
 */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (typeof v === 'object' && (v as object).constructor?.name === 'BN') return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)]));
  return v;
}

export const toJson = (value: unknown) => JSON.stringify(plain(value), null, 2);

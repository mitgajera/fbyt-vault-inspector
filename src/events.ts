import { Connection, PublicKey } from '@solana/web3.js';
import { amount, big, bps, microUsd, short } from './format.js';
import type { Decoded } from './program.js';
import { resolveTokens, type TokenInfo } from './tokens.js';

/** Every mint referenced by a list of events, resolved for display. */
export async function tokensForEvents(c: Connection, events: { data: Decoded }[]): Promise<Map<string, TokenInfo>> {
  const mints: PublicKey[] = [];
  for (const e of events) for (const [k, v] of Object.entries(e.data)) if (/mint/.test(k) && v instanceof PublicKey) mints.push(v);
  return mints.length ? resolveTokens(c, mints) : new Map();
}

/** One human-readable line per event; falls back to the event name. */
export function summarizeEvent(e: { name: string; data: Decoded }, tokens: Map<string, TokenInfo>): string {
  const d = e.data;
  const tok = (mint: PublicKey | undefined, raw: unknown, decimals?: number) => {
    const t = mint ? tokens.get(mint.toBase58()) : undefined;
    return `${amount(big(raw), decimals ?? t?.decimals ?? 0)} ${t?.symbol ?? (mint ? short(mint) : '')}`.trim();
  };
  switch (e.name) {
    case 'VaultCreatedEvent':
      return `vault #${d.index} created by ${short(d.money_manager)}: mgmt ${bps(d.money_management_yearly_fee)}/yr, perf ${bps(d.performance_fee)}`;
    case 'DepositTokenFundEvent':
      return `${short(d.investor)} deposited ${tok(d.token_mint, d.amount)} (${microUsd(d.amount_usd)}) → ${big(d.shares)} shares`;
    case 'WithdrawTokenFundEvent':
      return `${short(d.investor)} withdrew ${tok(d.token_mint, d.amount)} (mgr fee ${big(d.money_manager_fee)}, perf ${big(d.performance_fee)}, admin ${big(d.admin_fee)})`;
    case 'TradingEvent':
      return `${short(d.trader)} swapped ${tok(d.input_mint, d.input_amount, d.input_mint_decimals)} → ${tok(d.output_mint, d.output_amount, d.output_mint_decimals)}`;
    case 'TradingFeeChargedEvent': {
      const fields = Object.entries(d).filter(([, v]) => !(v instanceof PublicKey)).map(([k, v]) => `${k}=${v}`);
      return `trading fee: ${fields.join(' ')}`;
    }
    case 'TradingDelegateSetEvent':
      return `trading delegate set → ${short(d.trading_delegate ?? d.delegate ?? PublicKey.default)}`;
    default: {
      const fields = Object.entries(d)
        .filter(([, v]) => v !== null && typeof v !== 'object' || (v && v.constructor?.name === 'BN'))
        .slice(0, 4)
        .map(([k, v]) => `${k}=${v}`);
      return fields.length ? fields.join(' ') : '';
    }
  }
}

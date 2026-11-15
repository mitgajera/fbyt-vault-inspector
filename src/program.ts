import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import { Connection, PublicKey, type GetProgramAccountsFilter } from '@solana/web3.js';
import bs58 from 'bs58';
import { PROGRAM_ID } from './config.js';
import idlJson from './idl/fbyt_vault.json' with { type: 'json' };

type IdlType = string | { defined?: { name: string }; array?: [IdlType, number]; option?: IdlType; vec?: IdlType };
type IdlField = { name: string; type: IdlType; docs?: string[] };
type IdlTypeDef = { name: string; docs?: string[]; type: { kind: string; fields?: IdlField[] } };
type IdlAccountDef = { name: string; discriminator: number[] };
type IdlIxAccount = { name: string; signer?: boolean; writable?: boolean; address?: string; accounts?: IdlIxAccount[] };
type IdlIx = { name: string; discriminator: number[]; accounts: IdlIxAccount[]; args: IdlField[] };
export type FbytIdl = Omit<Idl, 'accounts' | 'types' | 'instructions' | 'errors'> & {
  address: string;
  accounts: IdlAccountDef[];
  types: IdlTypeDef[];
  instructions: IdlIx[];
  errors: { code: number; name: string; msg?: string }[];
};

export const idl = idlJson as unknown as FbytIdl;
export const coder = new BorshCoder(idl as unknown as Idl);

if (idl.address !== PROGRAM_ID.toBase58()) throw new Error('IDL address does not match PROGRAM_ID');

export const connection = (rpc: string) => new Connection(rpc, 'confirmed');

export type AccountName =
  | 'AdminPool' | 'AssetRegistry' | 'Claim' | 'InvestorPool' | 'KaminoPosition' | 'KaminoReserve'
  | 'LendingConfig' | 'MoneyManagerPool' | 'OraclePool' | 'PriceSnapshot' | 'VaultLedger' | 'VaultPool';

export function discriminator(name: AccountName): Buffer {
  const def = idl.accounts.find((a) => a.name === name);
  if (!def) throw new Error(`Unknown account type ${name}`);
  return Buffer.from(def.discriminator);
}

/** Identify which program account type a raw buffer holds, by its 8-byte discriminator. */
export function accountTypeOf(data: Buffer): string | undefined {
  const head = data.subarray(0, 8);
  return idl.accounts.find((a) => Buffer.from(a.discriminator).equals(head))?.name;
}

// The decoded shapes are loose on purpose: we print them, we don't compute on most fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Decoded = Record<string, any>;

export function decode(name: AccountName, data: Buffer): Decoded {
  return coder.accounts.decode(name, data);
}

// ---- Borsh offsets, so getProgramAccounts filters come from the IDL instead of hard-coded numbers ----

function typeSize(t: IdlType): number {
  if (typeof t === 'string') {
    const sizes: Record<string, number> = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
    if (sizes[t] === undefined) throw new Error(`Variable-size type ${t} before filter field`);
    return sizes[t];
  }
  if (t.array) return typeSize(t.array[0]) * t.array[1];
  if (t.defined) {
    const def = idl.types.find((d) => d.name === t.defined!.name);
    if (!def?.type.fields) throw new Error(`Unsupported type ${t.defined.name}`);
    return def.type.fields.reduce((s, f) => s + typeSize(f.type), 0);
  }
  throw new Error(`Variable-size type ${JSON.stringify(t)} before filter field`);
}

/** Byte offset of `field` inside account `name`, including the 8-byte discriminator. */
export function fieldOffset(name: AccountName, field: string): number {
  const def = idl.types.find((d) => d.name === name);
  if (!def?.type.fields) throw new Error(`No layout for ${name}`);
  let off = 8;
  for (const f of def.type.fields) {
    if (f.name === field) return off;
    off += typeSize(f.type);
  }
  throw new Error(`${name} has no field ${field}`);
}

/** All program accounts of one type, optionally filtered by pubkey-valued fields. */
export async function fetchAll(
  c: Connection,
  name: AccountName,
  where: Record<string, PublicKey> = {},
): Promise<{ pubkey: PublicKey; data: Decoded }[]> {
  const filters: GetProgramAccountsFilter[] = [{ memcmp: { offset: 0, bytes: bs58.encode(discriminator(name)) } }];
  for (const [field, key] of Object.entries(where)) {
    filters.push({ memcmp: { offset: fieldOffset(name, field), bytes: key.toBase58() } });
  }
  const res = await c.getProgramAccounts(PROGRAM_ID, { filters });
  return res.map((r) => ({ pubkey: r.pubkey, data: decode(name, r.account.data as Buffer) }));
}

export function errorFor(code: number): { name: string; msg?: string } | undefined {
  return idl.errors.find((e) => e.code === code);
}

/** Flatten nested IDL account groups into the positional list an instruction expects. */
export function ixAccountNames(ixName: string): IdlIxAccount[] {
  const ix = idl.instructions.find((i) => i.name === ixName);
  const flat: IdlIxAccount[] = [];
  const walk = (list: IdlIxAccount[]) => list.forEach((a) => (a.accounts ? walk(a.accounts) : flat.push(a)));
  if (ix) walk(ix.accounts);
  return flat;
}

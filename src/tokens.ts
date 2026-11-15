import { Connection, PublicKey } from '@solana/web3.js';
import { KNOWN_MINTS, METADATA_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './config.js';
import { ata } from './pdas.js';

export type TokenInfo = { mint: PublicKey; symbol: string; decimals: number; program: PublicKey };

const cache = new Map<string, TokenInfo>();

/** getMultipleAccountsInfo in chunks of 100 (the RPC limit). */
export async function getMany(c: Connection, keys: PublicKey[]) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await c.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  return out;
}

function readBorshString(buf: Buffer, off: number): [string, number] {
  const len = buf.readUInt32LE(off);
  return [buf.subarray(off + 4, off + 4 + len).toString('utf8').replace(/\0/g, '').trim(), off + 4 + len];
}

/** Token-2022 mints may carry the TokenMetadata extension (type 19) in their TLV area after byte 166. */
function token2022Symbol(data: Buffer): string | undefined {
  let off = 166; // 82-byte base mint, padded to 165, then 1 account-type byte
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    if (type === 19) {
      const [, afterName] = readBorshString(data, off + 4 + 64); // update_authority(32) + mint(32)
      return readBorshString(data, afterName)[0];
    }
    if (type === 0 && len === 0) break;
    off += 4 + len;
  }
  return undefined;
}

/** Resolve decimals, token program and a display symbol (known list → Token-2022 / Metaplex metadata → short mint). */
export async function resolveTokens(c: Connection, mints: PublicKey[]): Promise<Map<string, TokenInfo>> {
  const todo = [...new Set(mints.map((m) => m.toBase58()))].filter((m) => !cache.has(m)).map((m) => new PublicKey(m));
  if (todo.length) {
    const metaPdas = todo.map(
      (m) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), m.toBuffer()], METADATA_PROGRAM)[0],
    );
    const infos = await getMany(c, [...todo, ...metaPdas]);
    todo.forEach((mint, i) => {
      const acc = infos[i];
      const meta = infos[todo.length + i];
      let symbol = KNOWN_MINTS[mint.toBase58()];
      if (!symbol && acc && acc.owner.equals(TOKEN_2022_PROGRAM)) {
        try {
          symbol = token2022Symbol(acc.data as Buffer) ?? '';
        } catch {
          /* malformed extension: try Metaplex next */
        }
      }
      if (!symbol && meta) {
        try {
          // Metadata: key(1) update_authority(32) mint(32) name(string) symbol(string)
          const [, afterName] = readBorshString(meta.data as Buffer, 65);
          symbol = readBorshString(meta.data as Buffer, afterName)[0];
        } catch {
          /* fall through to short mint */
        }
      }
      cache.set(mint.toBase58(), {
        mint,
        symbol: symbol || mint.toBase58().slice(0, 6),
        decimals: acc ? (acc.data as Buffer)[44] : 0,
        program: acc && acc.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      });
    });
  }
  return new Map(mints.map((m) => [m.toBase58(), cache.get(m.toBase58())!]));
}

/** Balances of `owner`'s ATAs for each mint (0n when the ATA does not exist). */
export async function ataBalances(c: Connection, owner: PublicKey, tokens: TokenInfo[]) {
  const atas = tokens.map((t) => ata(owner, t.mint, t.program));
  const infos = await getMany(c, atas);
  return tokens.map((t, i) => {
    const info = infos[i];
    // SPL token account: mint(32) owner(32) amount(u64)
    const raw = info ? (info.data as Buffer).readBigUInt64LE(64) : 0n;
    return { token: t, ata: atas[i], exists: !!info, raw };
  });
}

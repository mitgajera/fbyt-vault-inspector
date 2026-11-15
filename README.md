# FBYT Vault Inspector

A read-only CLI that decodes [FBYT](https://fbyt.io) vaults straight from Solana mainnet: roles, PDAs, terms, lifecycle, holdings and NAV, investors, protocol config, and annotated transactions (including the Jupiter CPI path).

It never signs or sends a transaction. It needs no FBYT backend and no source access, only the program's Anchor IDL. That IDL ships publicly in the `app.fbyt.io` frontend bundle, and a copy lives in [`src/idl/fbyt_vault.json`](src/idl/fbyt_vault.json).

> Independent, unofficial tool built while evaluating FBYT. Not affiliated with or endorsed by FBYT.

Program: `DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm` (`fbyt_vault` v0.1.0, Anchor)

## Setup

```bash
npm install
```

```bash
npm run fbyt -- vaults
```

Or build once and call the binary:

```bash
npm run build && node dist/cli.js vaults
```

The public RPC works but rate-limits `getProgramAccounts` and history lookups. For heavier use, put a private RPC (Helius, Triton, QuickNode) in a git-ignored `.env`:

```bash
cp .env.example .env
```

Then edit `.env` and set `RPC_URL`. The CLI loads it from the package folder whatever directory you run from. A real `RPC_URL` environment variable, or `--rpc <url>` on one command, takes precedence. The URL is never printed: `--help` shows no default, output shows the host only, and API keys are scrubbed from error messages.

## Commands

| Command | What it shows |
|---|---|
| `vault <address> [--history N] [--no-investors] [--json]` | Roles and permissions, PDA re-derivation (✓/✗), terms, lifecycle phase, holdings × Pyth snapshot price, NAV vs the program's cached `value_usd`, Kamino positions, swap risk-guard usage, every investor's shares/ownership/value, and the last N transactions decoded (with who signed: manager / delegate / operator / investor) |
| `vaults [--manager W] [--sort value\|investors\|recent\|trade] [--phase P] [--limit N]` | Every vault on mainnet with a protocol summary: count by phase, total cached value, how many use bot delegates or Kamino |
| `investor <wallet>` | All of a wallet's InvestorPool positions (shares are program accounting, not SPL tokens) |
| `wallet <address> [--limit N]` | A wallet from FBYT's view: SOL, token accounts and any delegate approvals, manager pool, vaults, positions, and recent transactions summarised (SOL and token changes, programs, FBYT instructions) |
| `tx <signature> [--logs] [--accounts]` | FBYT instructions with IDL account names, decoded args, the Jupiter entrypoint decoded from the route bytes, a **CPI trace** (Approve → Jupiter → Revoke → fee transfer), events, token balance deltas, IDL error names on failure |
| `protocol` | Upgrade authority / admin / operator (and whether each is a single keypair or a PDA), fee caps, vault limits, swap and oracle guards, the tradeable-asset whitelist (OraclePools) and Kamino reserves |
| `pda --manager W [--nonce N] [--vault V --mint M --investor I]` | Offline PDA derivation from the IDL seeds |

Every command takes `--json` for machine-readable output (pubkeys as base58, u64 as decimal strings).

## Examples

Use these on your own vault after creating it:

```bash
npm run fbyt -- vault <your-vault> --history 10
```

```bash
npm run fbyt -- investor <investor-wallet>
```

```bash
npm run fbyt -- tx <signature-from-phantom>
```

A real delegate swap, decoded:

```bash
npm run fbyt -- tx 5xLUgXJUkYLgfbp5FSNTNukPkV2M13fbccpEy2s7g5DHeQFStZVd3xc8fvQEqyRb6JDFf6z2v6s2ofgEe19ko32j
```

```
FBYT instruction #2: swap
  amount_in: 87506170238
  jupiter entrypoint: shared_accounts_route
  …
  CPI trace
  └ SPL Token: Approve amount=87506170238 source=vault_input_token_account delegate=swap_authority
  └ Jupiter v6: shared_accounts_route
    └ SPL Token: Transfer amount=87506170238
    └ …AMM hops…
    └ SPL Token: Transfer amount=71215400
  └ SPL Token: Revoke source=vault_input_token_account
  └ System: Transfer 0.000144648 SOL 6rg9de… → CVXeyw…     (trading fee, trader → admin)

Events emitted
  TradingFeeChargedEvent  fee_lamports=144648 fee_usd_micro=10000 trade_usd_micro=70709485
  TradingEvent  6rg9…4xEB swapped 87.506170 BP → 71.2154 USDC
```

## How it works

- **Account decoding**: `BorshCoder` built from the extracted IDL; account types are recognised by their 8-byte discriminators.
- **getProgramAccounts filters**: `memcmp` offsets are computed from the IDL layout (`fieldOffset('InvestorPool', 'vault_pool')`), not hard-coded, so they stay correct if the layout changes.
- **PDA verification**: every vault PDA is re-derived from its IDL seeds. The VaultPool address itself is matched by searching the manager's vault counter (`["VaultPool", admin_pool, money_manager, n]`).
- **NAV**: for each AssetRegistry mint, the vault ATA balance, minus fees owed and claim reserves recorded in the VaultLedger, times the PriceSnapshot's Pyth price. Kamino positions are valued at principal. This matches the program's cached `value_usd` to within cents on live vaults.
- **Investor value**: `NAV × shares / (total_shares + pending_mm_fee_shares)`, the same divisor the program uses so that pending management-fee shares dilute correctly.
- **Lifecycle phase**: the status byte is only `1` (active) or `2` (closed) on mainnet. *Fundraising* (`now < created_at + raise_period`) and *Dormant* (no trade for `AdminPool.idle_period`) are time-derived, which matches how the app labels vaults.
- **Transactions**: v0 messages with address lookup tables are resolved. FBYT instructions (top-level and CPI) are decoded with account names. SPL Token and System CPIs are decoded by instruction tag, since Token doesn't log instruction names. Jupiter's entrypoint is identified from the route bytes' Anchor discriminator.

## Notes

- **Program upgrades.** FBYT's program is upgradeable. Transactions sent before an upgrade can have a different account list from the current IDL; `tx` detects this and warns, while args, events and token changes stay accurate. If the IDL itself changes, re-extract it from the app bundle with `node scripts/extract-idl.cjs <chunk.js>` and replace `src/idl/fbyt_vault.json`.
- **Transaction versions.** `wallet` reads history through raw `jsonParsed` RPC, so it also handles transaction versions newer than web3.js 1.x supports.
- **Read-only by design.** Nothing in this tool builds, signs or sends a transaction. Simulations aren't used either.

## Limitations

- Kamino positions are valued at principal (accrued interest isn't included).
- `InvestorPool.hight_watermark` (sic) is shown raw; its units aren't documented in the IDL.
- Status byte `0` is assumed to be the pre-activation state; no mainnet vault currently has it.
- History is decoded sequentially to stay under public-RPC limits; use `RPC_URL` for large `--history` values.

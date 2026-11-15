#!/usr/bin/env node
import './env.js';
import './quiet.js';
import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { DEFAULT_RPC } from './config.js';
import { c, kv, heading } from './format.js';
import { ata, pdas } from './pdas.js';
import { connection } from './program.js';
import { inspectVault } from './commands/vault.js';
import { listVaults } from './commands/vaults.js';
import { inspectInvestor } from './commands/investor.js';
import { inspectTx } from './commands/tx.js';
import { inspectProtocol } from './commands/protocol.js';
import { inspectWallet } from './commands/wallet.js';

const program = new Command()
  .name('fbyt')
  .description('Read-only inspector for FBYT vaults on Solana mainnet. Decodes accounts and transactions with the program IDL; never signs anything.')
  // No commander default here: it would print the full URL (API key included) in --help.
  .option('--rpc <url>', 'RPC endpoint (default: RPC_URL from the environment or .env, else public mainnet)');

const conn = () => connection(program.opts().rpc ?? DEFAULT_RPC);
const run = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    // Network errors can echo the request URL; never print an API key.
    const msg = (e as Error).message.replace(/([?&](api[-_]?key|key|token)=)[^&\s"']+/gi, '$1***');
    console.error(c.red(`\nError: ${msg}`));
    if (/429|Too Many/.test(msg)) console.error(c.dim('Public RPC rate limit. Pass --rpc with a Helius/Triton/QuickNode URL.'));
    process.exit(1);
  }
};

program
  .command('vault <address>')
  .description('Full breakdown of one vault: roles, PDAs, terms, lifecycle, holdings/NAV, investors, recent activity')
  .option('--no-investors', 'skip the investor list (saves a getProgramAccounts call)')
  .option('--history <n>', 'decode the last N transactions touching the vault', '0')
  .option('--json', 'machine-readable output')
  .action((address, o) => run(() => inspectVault(conn(), address, { investors: o.investors, history: Number(o.history), json: !!o.json })));

program
  .command('vaults')
  .description('List vaults (all, or one manager\'s) with phase, investors and cached value')
  .option('--manager <wallet>', 'only vaults managed by this wallet')
  .option('--sort <key>', 'value | investors | recent | trade', 'value')
  .option('--phase <phase>', 'filter: active | fundraising | dormant | closed')
  .option('--limit <n>', 'rows to show (0 = all)', '20')
  .option('--json', 'machine-readable output')
  .action((o) => run(() => listVaults(conn(), { manager: o.manager, sort: o.sort, phase: o.phase, limit: Number(o.limit), json: !!o.json })));

program
  .command('investor <wallet>')
  .description('All vault positions held by a wallet')
  .option('--json', 'machine-readable output')
  .action((wallet, o) => run(() => inspectInvestor(conn(), wallet, !!o.json)));

program
  .command('wallet <address>')
  .description('A wallet from FBYT\'s view: SOL, token accounts and approvals, manager pool, vaults, positions, recent txs decoded')
  .option('--limit <n>', 'recent transactions to decode', '30')
  .option('--json', 'machine-readable output')
  .action((address, o) => run(() => inspectWallet(conn(), address, { limit: Number(o.limit), json: !!o.json })));

program
  .command('tx <signature>')
  .description('Annotated transaction: FBYT instructions with named accounts, Jupiter route, events, token deltas')
  .option('--logs', 'print raw program logs too')
  .option('--accounts', 'list every remaining account (Jupiter route accounts etc.)')
  .option('--json', 'machine-readable output')
  .action((sig, o) => run(() => inspectTx(conn(), sig, { json: !!o.json, logs: !!o.logs, accounts: !!o.accounts })));

program
  .command('protocol')
  .description('Protocol config: authorities, fee caps, limits, swap guards, asset whitelist, Kamino reserves')
  .option('--json', 'machine-readable output')
  .action((o) => run(() => inspectProtocol(conn(), !!o.json)));

program
  .command('pda')
  .description('Derive FBYT PDAs offline from their IDL seeds')
  .option('--manager <wallet>', 'money manager wallet')
  .option('--nonce <n>', "manager's vault counter at creation (MoneyManagerPool.vaults_amount)", '0')
  .option('--vault <address>', 'vault (VaultPool) address')
  .option('--investor <wallet>', 'investor wallet (needs --vault and --mint)')
  .option('--mint <mint>', "vault base token mint")
  .action((o) => {
    const admin = pdas.adminPool();
    const rows: [string, string][] = [
      ['AdminPool ["AdminPool"]', admin.toBase58()],
      ['SwapAuthority ["SwapAuthority"]', pdas.swapAuthority().toBase58()],
      ['LendingConfig ["LendingConfig"]', pdas.lendingConfig().toBase58()],
    ];
    if (o.manager) {
      const m = new PublicKey(o.manager);
      rows.push(['MoneyManagerPool [.., admin, manager]', pdas.moneyManagerPool(admin, m).toBase58()]);
      rows.push([`VaultPool [.., admin, manager, ${o.nonce}]`, pdas.vaultPool(admin, m, Number(o.nonce)).toBase58()]);
    }
    if (o.vault) {
      const v = new PublicKey(o.vault);
      rows.push(['AssetRegistry [.., vault]', pdas.assetRegistry(v).toBase58()]);
      rows.push(['VaultLedger [.., vault]', pdas.vaultLedger(v).toBase58()]);
      rows.push(['PriceSnapshot [.., vault]', pdas.priceSnapshot(v).toBase58()]);
      if (o.mint) rows.push(['Vault ATA (base mint)', ata(v, new PublicKey(o.mint)).toBase58()]);
      if (o.investor && o.mint) rows.push(['InvestorPool [.., investor, admin, vault, mint]', pdas.investorPool(new PublicKey(o.investor), admin, v, new PublicKey(o.mint)).toBase58()]);
    }
    heading('FBYT PDAs (program DNgg2Fmw…Digm)');
    kv(rows);
    console.log();
  });

program.parseAsync();

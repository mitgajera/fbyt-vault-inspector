// bigint-buffer (a web3.js dependency) warns on every start when its optional native binding is
// missing; the pure-JS fallback is fine for a CLI, so drop just that one message.
// Imported first in cli.ts so it runs before web3.js loads.
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('bigint: Failed to load bindings')) return;
  warn(...args);
};
export {};

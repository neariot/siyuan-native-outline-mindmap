/**
 * E2E configuration entry point. **No defaults.**
 *
 * The target address and token come from environment variables only: a target you could guess
 * is most likely the instance the user is working in, and this suite really creates and deletes documents. Missing → throw.
 *
 * Normal entry point `npm run test:e2e` (scripts/run-e2e.py injects from .env).
 * Manual run: SIYUAN_URL=... SIYUAN_TOKEN=... npx playwright test
 */

function required(key: string, why: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `Missing environment variable ${key} —— ${why}\n` +
        `  E2E has no defaults: a guessed target may be the instance the user is working in, and this suite really creates and deletes documents.\n` +
        `  Normal entry point: npm run test:e2e (reads config from .env)\n` +
        `  Manual run         : SIYUAN_URL=<test instance URL> SIYUAN_TOKEN=<token> npx playwright test`,
    );
  }
  return v;
}

/**
 * Base URL of the SiYuan under test (no trailing slash).
 *
 * It points at the **isolated test instance**, not the user's instance —— see the file header.
 */
export function siyuanUrl(): string {
  return required('SIYUAN_URL', 'E2E must know which SiYuan instance is under test').replace(/\/+$/, '');
}

/**
 * Chromium binary to launch.
 *
 * Required, with no fallback: the binary decides the rendering engine, so a suite that quietly
 * launched a different build would keep every case green while measuring something else.
 */
export function chromiumPath(): string {
  return required('CHROMIUM_PATH', 'E2E must know which browser to launch');
}

/** API token used to create / delete test documents. */
export function siyuanToken(): string {
  return required('SIYUAN_TOKEN', 'creating and deleting test documents needs a kernel API token');
}

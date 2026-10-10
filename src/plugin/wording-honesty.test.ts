/**
 * UI wording must not be misled by the feature (corresponds to agy's UI-TC-29).
 *
 * ──────────────────────────────────────────────────────────────────
 * Origin
 * ──────────────────────────────────────────────────────────────────
 *
 * The "fit" button at the mind map's bottom-right has an `onClick` that calls `fit()` --
 * it zooms and pans all nodes so they just fit the current canvas. It does **not** go fullscreen:
 * there is not a single `requestFullscreen()` anywhere in the codebase.
 *
 * But its old tooltip misleadingly mentioned fullscreen ("fit fullscreen canvas"), which reads like "clicking it goes fullscreen".
 * A user who clicks it and sees no fullscreen just thinks "this button is broken" -- yet the button is fine,
 * it is the wording that lies.
 *
 * The wording must say what the feature does. Do not put things it cannot do into the tooltip.
 *
 * ──────────────────────────────────────────────────────────────────
 * Criterion
 * ──────────────────────────────────────────────────────────────────
 *
 * Only when **requestFullscreen() is really called** may the wording contain
 * "全屏" / "fullscreen". In other words:
 *
 *     real fullscreen   → write anything
 *     no real fullscreen → the wording must not contain "全屏"
 *
 * This criterion can be derived straight from the source; it does not depend on anyone remembering it.
 */

export {};

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '..');

/** Recursively collect every file in a directory (skipping tests and node_modules) */
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.tmp' || name === 'dist-plugin') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
console.log('First confirm the premise: is there any real fullscreen feature in the code at all');

const allTs = walkFiles(srcRoot);
let usesFullscreen = false;
const fullscreenFiles: string[] = [];
for (const f of allTs) {
  const text = fs.readFileSync(f, 'utf8');
  if (/requestFullscreen\s*\(/.test(text)) {
    usesFullscreen = true;
    fullscreenFiles.push(path.relative(srcRoot, f));
  }
}
console.log(`  files in the source that call requestFullscreen(): ${fullscreenFiles.join(', ') || '(none)'}`);

// ──────────────────────────────────────────────────────────────────
console.log('\nwith no real fullscreen, the wording must not mention 全屏');

{
  const i18nDir = path.join(srcRoot, 'plugin', 'i18n');
  const files = fs.existsSync(i18nDir)
    ? fs.readdirSync(i18nDir).filter((n) => n.endsWith('.json'))
    : [];
  check('i18n wording files found', files.length > 0, `directory ${i18nDir}`);

  for (const name of files) {
    const full = path.join(i18nDir, name);
    const data = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
    const offenders: string[] = [];

    for (const [key, val] of Object.entries(data)) {
      if (typeof val !== 'string') continue;
      const hasZh = val.includes('全屏');
      const hasEn = /full\s*screen|fullscreen/i.test(val);
      if (!hasZh && !hasEn) continue;
      // this is only allowed when fullscreen is really implemented
      if (!usesFullscreen) offenders.push(`${key}=${JSON.stringify(val)}`);
    }

    check(
      `★ ${name} has no misleading 全屏 (fullscreen) wording (there is no real fullscreen feature at the moment)`,
      offenders.length === 0,
      offenders.slice(0, 3).join('; '),
    );
  }
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe wording of the 适应 (fit) button must describe what it really does');

{
  // the real semantics of fit(): zoom and pan all nodes so they just fit the canvas.
  // The wording must not promise 全屏 (fullscreen).
  const zhPath = path.join(srcRoot, 'plugin', 'i18n', 'zh_CN.json');
  const zh = JSON.parse(fs.readFileSync(zhPath, 'utf8')) as Record<string, string>;

  check('a tipFitCanvas wording exists', typeof zh.tipFitCanvas === 'string');
  check('★ the Chinese tooltip does not contain 全屏 (fullscreen)', !(zh.tipFitCanvas || '').includes('全屏'),
    `actual ${JSON.stringify(zh.tipFitCanvas)}`);
  check('the Chinese tooltip mentions 画布 (canvas) or 适应 (fit) -- it says what the button does',
    /画布|适应/.test(zh.tipFitCanvas || ''), `actual ${JSON.stringify(zh.tipFitCanvas)}`);

  const enPath = path.join(srcRoot, 'plugin', 'i18n', 'en_US.json');
  const en = JSON.parse(fs.readFileSync(enPath, 'utf8')) as Record<string, string>;
  check('★ the English tooltip does not contain fullscreen', !/fullscreen|full screen/i.test(en.tipFitCanvas || ''),
    `actual ${JSON.stringify(en.tipFitCanvas)}`);
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe criterion itself is valid (proving it can fail, rather than always being true)');

{
  // Take a fake wording that **really does contain 全屏** and check that the detection logic catches it.
  // If this one is not flagged, the checks above are vacuous.
  const probe = (val: string): boolean => {
    const hasZh = val.includes('全屏');
    const hasEn = /full\s*screen|fullscreen/i.test(val);
    return hasZh || hasEn;
  };
  check('★ the detection logic recognises the bad wording', probe('全屏画布'));
  check('★ the detection logic recognises "Full screen"', probe('Full screen'));
  check('the detection logic does not false-positive on normal wording', !probe('适应画布（缩放至刚好显示全部节点）'));
  check('the detection logic does not false-positive on Fit to canvas', !probe('Fit to canvas'));
}

// ──────────────────────────────────────────────────────────────────
console.log('★ hardcoded fallback wording in the source must be checked too (the real problem this time)');

{
  // ★ The pitfall hit here: the i18n JSON was already fixed, but the build output still held the old wording.
  //
  //   Cause: the call was written as `t('tipFitCanvas')` --
  //   the third argument is a **hardcoded fallback**, used when the i18n lookup fails. The i18n JSON is
  //   loaded separately at runtime, so whenever the lookup fails the old wording in the source shows through.
  //
  //   That is: **changing the i18n JSON is not enough**; the fallback in the source must change too,
  //   and the two must agree. This test also scans the literals in the source.
  const offenders: string[] = [];
  for (const f of allTs) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(srcRoot, f);
    // line by line, find the 全屏 / fullscreen literal (skipping comment lines)
    for (const [i, line] of text.split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (/['"`][^'"`]*全屏[^'"`]*['"`]/.test(line) || /['"`][^'"`]*full\s*screen[^'"`]*['"`]/i.test(line)) {
        offenders.push(`${rel}:${i + 1}`);
      }
    }
  }
  check(
    '★ the source has no hardcoded 全屏 (fullscreen) wording (while there is no real fullscreen feature)',
    !usesFullscreen ? offenders.length === 0 : true,
    offenders.slice(0, 5).join(', '),
  );
}

{
  console.log('  the i18n wording must not contain fullscreen, and source must have no hardcoded fallback');
  const zhPath = path.join(srcRoot, 'plugin', 'i18n', 'zh_CN.json');
  const zh = JSON.parse(fs.readFileSync(zhPath, 'utf8')) as Record<string, string>;

  // verify there is no hardcoded fallback for tipFitCanvas in the source
  let hasFallback = false;
  let where = '';
  for (const f of allTs) {
    const text = fs.readFileSync(f, 'utf8');
    const m = /t\(\s*'tipFitCanvas'\s*,[^,]*,\s*'([^']*)'\s*\)/.exec(text);
    if (m) {
      hasFallback = true;
      where = path.relative(srcRoot, f);
      break;
    }
  }
  check('★ the source has no hardcoded fallback for tipFitCanvas (delegated to i18n)', !hasFallback, where);
  check('★ the i18n JSON does not contain 全屏 (fullscreen)', !zh.tipFitCanvas?.includes('全屏'),
    JSON.stringify(zh.tipFitCanvas));
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe shortcut help panel must advertise keys that are really implemented');

{
  // ★ The panel's own comment states the rule: entries must match the keys the
  //   code implements -- "a help text that looks right but cannot be pressed is
  //   worse than no help text". Nothing enforced it, and the table had drifted:
  //   it advertised `Ctrl+Shift+S` for strikethrough (the handler implements
  //   `Ctrl+Enter`), `Ctrl+↑ / ↓` for collapse (the handler implements
  //   `Ctrl/Alt+.`) and `Ctrl+1 ~ 6` for collapse-by-level (which is
  //   `Ctrl+Alt+1/2/3`).
  //
  //   Compare the advertised key strings against the handler, mechanically.
  const outliner = fs.readFileSync(path.join(srcRoot, 'plugin', 'outline', 'Outliner.tsx'), 'utf8');
  const tableStart = outliner.indexOf('const SHORTCUTS:');
  const tableEnd = outliner.indexOf('const EMOJIS', tableStart);
  const table = outliner.slice(tableStart, tableEnd);
  const handler = outliner.slice(outliner.indexOf('const onKeyDown = ('), outliner.indexOf('const onKeyDown = (') + 60000);

  check('the shortcut table was found', tableStart > 0 && tableEnd > tableStart);
  check('the keydown handler was found', handler.length > 1000);

  // Every `keys: '...'` string in the table, as written for the reader.
  const advertised = [...table.matchAll(/keys: '([^']+)'/g)].map((m) => m[1]);
  check('the table advertises some keys', advertised.length > 15, `${advertised.length}`);

  // ★ A key string is only allowed if the handler really branches on it.
  //   `Ctrl+X` must appear as a modifier-aware branch (e.g. `mod && e.key === 'x'`
  //   or `(e.ctrlKey || e.metaKey) && (e.key === 'x' ...)`), and a bare `X` must
  //   appear as a plain branch -- otherwise the panel is lying.
  const implemented = (keys: string): boolean => {
    if (keys === 'Drag') return /touch-dragging|onBulletTouchStart|dragState/.test(outliner);
    // 'Ctrl+Click' / 'Alt+Click' are pointer gestures, not keydown branches
    if (/Click$/.test(keys)) return /onClick|onPointerDown|mousedown/.test(outliner);
    if (keys === 'Esc') return /e\.key === 'Escape'/.test(handler);
    // 'Ctrl+B / I / U' style: one shortcut written for several letters; every
    // alternative must be implemented, so the caller below checks each of them.
    //   `Ctrl+B / I / U` and `Alt+↑ / ↓` are shorthand: the alternatives after
    //   the first inherit its modifiers, otherwise `I` would be read as a bare
    //   key and a valid row would be reported as a lie.
    const raw = keys.split(' / ');
    if (raw.length > 1) {
      const mods0 = raw[0].includes('+') ? raw[0].slice(0, raw[0].lastIndexOf('+') + 1) : '';
      const full = raw.map((a, i) => (i > 0 && !a.includes('+') ? mods0 + a : a));
      return full.every(implemented);
    }
    const parts = keys.split('+');
    const key = parts.pop() as string;
    const mods = parts;
    // ★ A few keys are handled by the **browser**, not by a branch in this
    //   handler: the node body is a contenteditable and `onInput` -> `syncText`
    //   pushes whatever the browser did into the model, and the browser's
    //   Ctrl+B/I/U run exactly the `execCommand` that `fmt()` calls. So the
    //   absence of an `e.key` branch is not a lie in the help text.
    //   Keep this list minimal and justified -- put a key here only after
    //   checking that the browser really handles it, or the panel starts lying
    //   again (Ctrl+Shift+S had no handler and no native behaviour either).
    if (mods.length === 1 && mods[0] === 'Ctrl' && ['b', 'i', 'u'].includes(key.toLowerCase())) return true;
    // Normalise the key as it appears in source (arrows keep their name, letters lower-case)
    const ARROWS: Record<string, string> = { '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight' };
    const srcKey = ARROWS[key] ?? (key.length === 1 ? key.toLowerCase() : key);
    const named = new RegExp(`(e\\.key === '${srcKey}'|e\\.key === '${srcKey.toUpperCase()}'|isKey\\([^)]*'${srcKey}')`);
    if (!named.test(handler)) return false;
    for (const mod of mods) {
      const re = mod === 'Ctrl' ? /mod|ctrlKey|metaKey/ : mod === 'Alt' ? /altKey/ : mod === 'Shift' ? /shiftKey/ : null;
      if (re && !re.test(handler)) return false;
    }
    return true;
  };

  const missing = advertised.filter((k) => !implemented(k));
  check(
    '★ every advertised shortcut exists in the keydown handler',
    missing.length === 0,
    `not implemented: ${missing.map((k) => JSON.stringify(k)).join(', ')}`,
  );

  // ★ And the control: the criterion must be able to say "no". A key that is
  //   definitely not implemented must be rejected, or the loop above is vacuous.
  check('★ the criterion rejects a key that is not implemented (Ctrl+Shift+S is not bound)',
    !implemented('Ctrl+Shift+S'), 'the criterion accepted Cmd+Shift+S, so it proves nothing');
  check('★ the criterion accepts a key that is implemented (Ctrl+Enter = strikethrough)',
    implemented('Ctrl+Enter'));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}

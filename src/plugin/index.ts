// SiYuan plugin entry point.
//
// Contract source: siyuan-src/app/src/plugin/index.ts (verified against local source, not guessed)
//   - onload(options) / onLayoutReady() / onunload()
//   - addTab({ type, init, destroy?, resize? })
//   - addCommand({ langKey, hotkey, callback })
//   - eventBus.on(...)
//
// Build note: `siyuan` is a CommonJS module injected by SiYuan at runtime, so it must be
// marked external; otherwise the SDK ends up in the bundle and cannot be resolved at runtime.

import { Plugin, showMessage } from 'siyuan';
import { openTab } from 'siyuan';
import type { Custom } from 'siyuan';
import { mountMindmap, unmountMindmap } from './mount';
import { setI18nLookup, t } from './i18n';
import { getActiveDocId } from './active-doc';
import { SiYuanClient } from '../siyuan/api';
import { SiYuanStore } from '../siyuan/store';

/** Runtime context shared inside the plugin */
export interface PluginContext {
  client: SiYuanClient;
  store: SiYuanStore | null;
  /** Current notebook ID (injected by SiYuan or chosen by the user) */
  notebook: string;
}

export const TAB_TYPE = 'omMindmap';

export default class NativeOutlineMindmapPlugin extends Plugin {
  /** Runtime context shared across tabs */
  public ctx!: PluginContext;
  /** Stop function of the mirror-block decorator (called on onunload) */

  async onload(): Promise<void> {
    // Inside addTab's init callback `this` is the Custom instance (no eventBus),
    // so capture the plugin instance first for the callback to use.
    const plugin = this;
    // * First wire up the word lookup bridge: the UI layers (mind map canvas, outline
    //   editor) cannot reach the plugin instance, so they look things up through this
    setI18nLookup((key) => (this.i18n as unknown as Record<string, string>)[key]);

    // Same-origin call: the plugin runs inside the SiYuan page, so no explicit token is needed
    this.ctx = {
      client: new SiYuanClient({ baseUrl: '', token: '' }),
      store: null,
      notebook: '',
    };

    // Register the custom tab type. Note that SiYuan prefixes the type with the plugin name,
    // so what is passed here is the "suffix"; the real type is `${this.name}${TAB_TYPE}`.
    //
    // Contract (layout/dock/Custom.ts:43): SiYuan calls this as `this.init(this)`,
    // i.e. `this` and the first parameter are **both** the Custom instance.
    this.addTab({
      type: TAB_TYPE,
      init(this: Custom, custom: Custom) {
        // eventBus lives on the **Plugin**, not on Custom (measured: Custom has no such field).
        // Use an arrow function to capture the outer `this` (= plugin instance) and pass it
        mountMindmap(custom, { eventBus: plugin.eventBus, plugin });
      },
      destroy(this: Custom) {
        // SiYuan only binds `this` and passes no arguments (see Custom.ts's `destroy: (this: Custom) => void`)
        unmountMindmap(this);
      },
    });

    // -- Mobile entry point ------------------------------------------------
    //
    // * Key fact: SiYuan **disables openTab entirely on mobile**.
    //   app/src/plugin/API.ts says:
    //
    //     /// #if MOBILE
    //     openTab = () => { /* TODO: Mobile */ };
    //
    //   So a custom tab page (addTab + openTab) **cannot be opened by any plugin** on mobile --
    //   this is not this plugin's problem, the kernel simply has not implemented it.
    //
    // Conclusion: mobile must carry the UI with a **Dock** (the content renders directly in the
    // sidebar instead of opening a new tab). Desktop can use this Dock just the same.
    this.addDock({
      id: 'mindmapDock',
      type: 'mindmapDock',
      config: {
        icon: 'iconMindmap',
        title: t('mindmapTitle'),
        index: 100,
        position: 'RightBottom',
        size: { width: 420, height: 620 },
      },
      // followActive: the Dock is not bound to a fixed document, it follows the currently active document (required on mobile)
      data: { followActive: true },
      init(this: Custom, custom: Custom) {
        // Mount the mind map directly in the Dock -- reusing the same mounting logic as the tab.
        // `custom.element` is the container SiYuan provides; React renders into it.
        mountMindmap(custom ?? this, { eventBus: plugin.eventBus, plugin });
      },
      destroy(this: Custom) {
        unmountMindmap(this);
      },
    });

    // Slash menu (typing `/`) -- the handiest entry point on mobile.
    //
    // * It inserts a "mirror block", it does not open a tab (fix)
    //
    //   The original implementation called openMindmapTab() -- opening a new tab and not touching a single character of the body.
    //   But its comments, `docs/GETTING-STARTED.md`, the "insert mind map" label,
    //   and acceptance item UI-TC-24 **all say "insert a mirror block into the body"**.
    //
    //   Measured (comparing before and after the callback fires):
    //     tabs 11 -> 12   (a new tab was opened)
    //     body kramdown length 762 -> 762   (nothing was inserted)
    //
    //   On mobile this difference is a **missing feature** rather than a UX issue: phones have no
    //   command palette and no ⌥⌘I, so the slash menu is the only insertion entry point.
    //   If it opens a tab, the user has no way to embed the mind map into the body at all.
    //
    //   Now both entry points share insertMirrorIntoActiveDoc(), so the behaviour is identical.
    this.protyleSlash = [
      {
        filter: ['mindmap', '\u5bfc\u56fe', 'outline', 'naotu', 'map'],
        id: 'omMindmap',
        html:
          '<div class="b3-list-item__first">' +
          '<svg class="b3-list-item__graphic"><use xlink:href="#iconMindmap"></use></svg>' +
          `<span class="b3-list-item__text">${this.i18n.insertMindmap}</span></div>`,
        callback: () => {
          void plugin.insertMirrorIntoActiveDoc();
        },
      },
    ];

    // * Give it a default hotkey: previously `hotkey: ''` meant no key was bound,
    //   yet the UI text said "open it with the 'mind map' button or a hotkey", and the user could neither press it nor find it.
    //   The SiYuan plugin convention is `⌥⌘X` (macOS notation; other platforms map it to Ctrl+Alt+X automatically).
    //
    // ** Must avoid keys already taken by SiYuan itself (fix)
    //
    //   It used to be `⌥⌘M`, and above it still said "not taken by SiYuan itself" -- that sentence was wrong.
    //   Measured: `⌥⌘M` is already taken by SiYuan: `/editor/insert/memo` (insert memo).
    //
    //   With two commands bound to the same key, the result depends on who grabs the event first -- that is not
    //   "works", it is luck: pressing it may insert a memo or open the mind map, and it varies by version.
    //   The right fix for this class of problem is not "find a way to win the race" but **never collide at all**.
    //
    //   It now uses `⌥⌘O` (Open). Verified: it is not in SiYuan's built-in ⌥⌘ table,
    //   and no other installed plugin uses it either.
    this.addCommand({
      langKey: 'openMindmap',
      hotkey: '⌥⌘O',
      callback: () => this.openMindmapTab(),
    });

    // Insert a "mirror block" at the end of the current document -- embedding the current document's mind map into the body.
    // Give it a default key too; see the notes on openMindmap for the rule (avoid SiYuan's built-in bindings).
    // `⌥⌘I` (Insert): verified that this key is free in SiYuan itself and in other plugins.
    this.addCommand({
      langKey: 'insertMirror',
      hotkey: '⌥⌘I',
      callback: async () => {
        await this.insertMirrorIntoActiveDoc();
      },
    });

    console.log('[native-outline-mindmap] plugin loaded');
  }

  /**
   * * : the mirror block now uses **SiYuan's native document embed** `{{((docId))}}`,
   * rendered by SiYuan itself, so the plugin **needs no decorator at all**.
   *
   * The approach of replacing a paragraph carrying private attributes with a view through a decorator,
   * and the map view replacing the hidden paragraph with the attribute -- that both made the embedded content invisible
   * to the user and fought with the editor's own re-rendering, has been removed entirely.
   */
  onLayoutReady(): void {
    /* Native embed needs no plugin involvement */
  }

  async onunload(): Promise<void> {
    // The old language's closure must not be retained after unload
    setI18nLookup(null);
    console.log('[native-outline-mindmap] plugin unloaded');
  }

  /**
   * Insert a "mind map mirror block" into the current document body.
   *
   * The slash menu and the command palette (`⌥⌘I`) share this one implementation -- both entry points must do the same thing,
   * otherwise the old problem of "the text says A but it actually does B" comes back (the slash menu already tripped on it:
   * the docs said it inserts a mirror block while the code opened a tab).
   *
   * When no document is open, show a clear message and return; do not fail silently --
   * the slash menu is the only insertion entry point on mobile, and failing silently makes the user think the feature does not exist.
   */
  async insertMirrorIntoActiveDoc(): Promise<void> {
    const docId = getActiveDocId();
    if (!docId) {
      showMessage(t('msgOpenDocFirst'), 4000, 'error');
      return;
    }
    try {
      const store = new SiYuanStore({
        client: this.ctx.client,
        notebook: '',
        basePath: '/',
      });
      await store.appendMirrorBlock(docId, docId, {
        height: 420,
      });
      showMessage(t('msgMirrorInserted'), 3000, 'info');
    } catch (e) {
      showMessage(
        t('errInsertMirror', { msg: e instanceof Error ? e.message : String(e) }),
        5000,
        'error',
      );
    }
  }

  /**
   * Open a mind map tab.
   *
   * When docId is empty, try to use "the document the current editor is in", so that running the command from any document shows its outline mind map.
   *
   * ★ `openTab` is the **static import** at the top of this file, like `mount.ts` uses. It used to be
   *   re-imported here with `await import('siyuan')`, which shadowed the static import and left it dead
   *   —— two patterns for one call, and a top-level import that read as if it were in use.
   */
  async openMindmapTab(docId = ''): Promise<void> {
    const target = docId || getActiveDocId();
    openTab({
      app: this.app,
      custom: {
        id: `${this.name}${TAB_TYPE}`,
        title: target ? t('mindmapTitle') : t('newMindmap'),
        icon: 'iconMindmap',
        data: { docId: target },
      },
    });
  }
}

/**
 * Get the root document ID of the currently active editor.
 *
 * Implementation lives in `active-doc.ts` (re-exported here for the tab entry point).
 */
// Get the currently active document ID -- implementation in `active-doc.ts`.
export { getActiveDocId };

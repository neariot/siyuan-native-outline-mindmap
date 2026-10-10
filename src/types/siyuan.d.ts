// Type declarations for the `siyuan` module.
//
// SiYuan injects this module at runtime (plugins get it via require("siyuan")),
// but does not ship types for it as an npm package. Here is a minimal hand-written declaration set:
//   - Plugin class: siyuan-src/app/src/plugin/index.ts
//   - Custom class: siyuan-src/app/src/protyle/... (custom tab container)
//   - ICommand: siyuan-src/app/src/types/index.d.ts:774
//
// Only the members we actually use are declared, to avoid over-promising unverified APIs.

declare module 'siyuan' {
  /** Command context (official types/index.d.ts:764) */
  export interface ICommandContext {
    source:
      | 'commandPanel'
      | 'shortcut'
      | 'editorShortcut'
      | 'fileTreeShortcut'
      | 'dockShortcut'
      | 'globalShortcut'
      | 'keymap'
      | 'menu'
      | 'api';
    focus: 'global' | 'editor' | 'fileTree' | 'dock';
    range?: Range;
    dock?: HTMLElement;
  }

  /** Command definition (official types/index.d.ts:774) */
  export interface ICommand {
    /** Key that distinguishes shortcuts; also used as the i18n field name */
    langKey: string;
    langText?: string;
    hotkey?: string;
    customHotkey?: string;
    hotkeys?: string[];
    when?: (context: ICommandContext) => boolean;
    enabled?: (context: ICommandContext) => boolean;
    execute?: (context: ICommandContext) => void | Promise<void>;
    /** Not called when the other callbacks are present */
    callback?: (context?: ICommandContext) => void;
  }

  /**
   * Custom tab container (the type of `this` in addTab's init callback).
   *
   * Contract: `app/src/layout/dock/Custom.ts:11-15`:
   *   · `init(this)` —— **only it** is passed to Custom as both `this` and the first argument
   *   · `destroy()` / `resize()` / `update()` —— bound to `this` only, with no arguments
   */
  export interface Custom {
    element: HTMLElement;
    data: unknown;
    type: string;
    tab: unknown;
    init: (this: Custom, custom: Custom) => void;
    destroy: (this: Custom) => void;
    resize: (this: Custom) => void;
    update: (this: Custom) => void;
  }

  /** Arguments for opening a tab (openTab) */
  export interface IOpenTab {
    app: unknown;
    custom?: {
      id: string;
      title: string;
      icon?: string;
      data?: unknown;
    };
    /**
     * Open a document.
     *
     * ★★ `action` is not optional (confirmed by reverse-engineering the kernel build).
     *   The kernel's `openTab` `doc` branch passes it through to `openFileById`:
     *     openTab({app, doc:{id, action, zoomIn}})
     *       → openFileById({app, id, action, zoomIn, scrollPosition:'start'})
     *
     *   Without `action`, initProtyle throws
     *     TypeError: Cannot read properties of undefined (reading 'forEach')
     *
     *   Common values: 'cb-get-focus' (focus), 'cb-get-scroll' (scroll to position).
     *   SiYuan itself passes both when a block reference is clicked.
     */
    doc?: {
      id: string;
      zoomIn?: boolean;
      action?: string[];
      mode?: string;
    };
    position?: 'right' | 'bottom';
    keepAlive?: boolean;
  }

  /** Event bus */
  export interface IEventBus {
    on(type: string, listener: (...args: unknown[]) => void): void;
    off(type: string, listener: (...args: unknown[]) => void): void;
  }

  /** Plugin base class (official app/src/plugin/index.ts) */
  export class Plugin {
    constructor(options: { app: unknown; name: string; i18n: Record<string, unknown>; data: unknown });

    readonly name: string;
    readonly displayName: string;
    app: unknown;
    eventBus: IEventBus;
    i18n: Record<string, string>;
    data: unknown;

    onload(): Promise<void> | void;
    onunload(): Promise<void> | void;
    onLayoutReady(): Promise<void> | void;
    uninstall(): Promise<void> | void;

    /**
     * Register a custom tab type; the actual type is `${this.name}${options.type}`.
     * The callback contract matches Custom: `init` receives `this` + the custom argument,
     * while `destroy` / `resize` / `update` are bound to `this` only.
     */
    addTab(options: {
      type: string;
      init: (this: Custom, custom: Custom) => void;
      destroy?: (this: Custom) => void;
      resize?: (this: Custom) => void;
      update?: (this: Custom) => void;
    }): unknown;

    /**
     * Slash menu item shown when `/` is typed.
     *
     * This is **the most natural entry point on mobile** —— typing `/` on a phone is easier than finding an icon,
     * and it matches desktop behaviour (`Dialog` / `Dock` are both less handy on a phone).
     */
    protyleSlash?: Array<{
      filter: string[];
      id: string;
      html: string;
      callback: (protyle: unknown, nodeElement: HTMLElement) => void;
    }>;

    /** Register a command (command palette / shortcuts) */
    addCommand(command: ICommand): void;

    /** Register an icon SVG */
    addIcons(svg: string): void;

    /** Register a top bar button */
    addTopBar(options: {
      icon: string;
      title: string;
      callback?: () => void;
      position?: 'left' | 'right';
      class?: string;
    }): HTMLElement;

    /** Register a bottom bar button */
    addStatusBar(options: { element: HTMLElement; position?: 'left' | 'right' }): void;

    /** Register a sidebar dock */
    /**
     * Register a sidebar Dock.
     *
     * ⚠️ Mobile **only understands Dock**: `addTopBar` does not render on mobile at all
     * (nothing in the mobile directory consumes topBarIcons),
     * while the mobile bottom bar's selectable items support DockKeys of the form `plugin:<name>:<id>`.
     * So to make it reachable for mobile users, a Dock must be registered.
     *
     * `id` may be omitted (at runtime `const id = options.id || options.type`),
     * but giving it explicitly is safer —— the bottom bar stores this id.
     */
    addDock(options: {
      id?: string;
      config: {
        position: 'LeftTop' | 'LeftBottom' | 'RightTop' | 'RightBottom' | 'BottomLeft' | 'BottomRight';
        size: { width: number; height: number };
        icon: string;
        title: string;
        hotkey?: string;
        index?: number;
        show?: boolean;
      };
      data: unknown;
      type: string;
      init: (this: Custom, custom: Custom) => void;
      destroy?: (this: Custom) => void;
      update?: (this: Custom) => void;
    }): void;

    /** Read/write plugin persisted data (stored under data/storage/petal/<name>/) */
    loadData(storageName: string): Promise<unknown>;
    saveData(storageName: string, data: unknown): Promise<unknown>;
    removeData(storageName: string): Promise<unknown>;
  }

  /** Open a tab */
  export function openTab(options: IOpenTab): void;

  /** Show a message */
  export function showMessage(msg: string, timeout?: number, type?: 'info' | 'error'): void;

  /** Global fetch wrapper (adds the token automatically) */
  export function fetchSyncPost(url: string, data?: unknown): Promise<{ code: number; msg: string; data: unknown }>;

  /** Get the currently focused editor */
  export function getActiveEditor(): unknown;
}

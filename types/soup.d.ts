// Type declarations for the `soup` module, the API an extension builds against.
// (The public repository's types/soup.d.ts is this file plus the data types it names, written out by
// `pnpm extension-api:build`. Do not edit the copy in the public repository.)
//
//   import { Plugin } from "soup";
//   export default class MyExtension extends Plugin {
//     async onload() { this.addCommand({ id: "hi", name: "Say hi", callback: () => new Notice("hi") }); }
//   }
//
// Everything below is full-trust: SOUP does not stop an extension from using any of it. See docs/17-responsibility.md.

declare module "soup" {
  import type { ComponentType } from "react";

  /** The extension API version of this SOUP (a manifest's `apiVersion` range must contain it). */
  export const apiVersion: string;
  export const Platform: { isWindows: boolean };

  /** A function that waits for calls to stop before running (see `debounce`). */
  export interface Debounced<A extends unknown[]> {
    (...a: A): void;
    /** Drop the pending call. */
    cancel(): void;
    /** Run the pending call now (nothing happens if none is pending). */
    flush(): void;
  }
  /**
   * Run `fn` once calls stop for `ms` (default 250). It keeps running after the extension unloads unless you cancel it:
   * pass it to `this.registerDebounce(...)`, and call `flush()` in `onunload` when the pending call must still happen (a save).
   */
  export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms?: number): Debounced<A>;
  /** Forward slashes, no doubled or trailing slashes. */
  export function normalizePath(p: string): string;

  /** Something that can be switched off again (an event subscription, a watcher). */
  export interface EventRef {
    off(): void;
  }
  export interface Stoppable {
    off(): void;
  }
  /** Something you added and can remove again. */
  export interface Handle {
    remove(): void;
  }

  // ---------------------------------------------------------------- the UI classes

  /** A toast. `tone` is "success" when left out. */
  export class Notice {
    constructor(message: string, durationMs?: number, tone?: "info" | "success" | "error");
  }

  /**
   * A dialog: fill `contentEl` in `onOpen`, call `close()` to end it. Pass `this.app` to the constructor and SOUP closes it when
   * the extension unloads. Escape closes the top-most dialog only; an error in `onOpen` / `onClose` is logged.
   */
  export class Modal {
    app: unknown;
    titleEl: HTMLElement;
    contentEl: HTMLElement;
    constructor(app?: unknown);
    setTitle(title: string): this;
    open(): void;
    close(): void;
    onOpen(): void | Promise<void>;
    onClose(): void | Promise<void>;
  }

  export interface ToggleComponent {
    readonly el: HTMLButtonElement;
    setValue(v: boolean): this;
    getValue(): boolean;
    onChange(cb: (v: boolean) => void): this;
    setDisabled(d: boolean): this;
  }
  export interface TextComponent {
    readonly inputEl: HTMLInputElement | HTMLTextAreaElement;
    setValue(v: string): this;
    getValue(): string;
    setPlaceholder(p: string): this;
    onChange(cb: (v: string) => void): this;
    setDisabled(d: boolean): this;
  }
  export interface DropdownComponent {
    readonly selectEl: HTMLSelectElement;
    addOption(value: string, label: string): this;
    addOptions(options: Record<string, string>): this;
    setValue(v: string): this;
    getValue(): string;
    onChange(cb: (v: string) => void): this;
  }
  export interface ButtonComponent {
    readonly buttonEl: HTMLButtonElement;
    setButtonText(t: string): this;
    setCta(): this;
    setWarning(): this;
    setDisabled(d: boolean): this;
    onClick(cb: () => void): this;
  }
  export interface SliderComponent {
    readonly sliderEl: HTMLInputElement;
    setLimits(min: number, max: number, step: number): this;
    setValue(v: number): this;
    getValue(): number;
    onChange(cb: (v: number) => void): this;
  }
  export interface ColorComponent {
    readonly colorEl: HTMLInputElement;
    /** `#rrggbb`. */
    setValue(v: string): this;
    getValue(): string;
    onChange(cb: (v: string) => void): this;
    setDisabled(d: boolean): this;
  }
  /** A small square button beside the other controls: a symbol or a short word, and a tooltip. */
  export interface ExtraButtonComponent {
    readonly extraSettingsEl: HTMLButtonElement;
    setIcon(text: string): this;
    setTooltip(t: string): this;
    setDisabled(d: boolean): this;
    onClick(cb: () => void): this;
  }

  /** One settings row: `new Setting(el).setName("x").setDesc("y").addToggle((t) => t.setValue(true).onChange(save))`. */
  export class Setting {
    readonly settingEl: HTMLElement;
    readonly infoEl: HTMLElement;
    readonly nameEl: HTMLElement;
    readonly descEl: HTMLElement;
    readonly controlEl: HTMLElement;
    constructor(containerEl: HTMLElement);
    setName(name: string | DocumentFragment): this;
    /** Text, or a fragment you built (a link, a line break). */
    setDesc(desc: string | DocumentFragment): this;
    /** Make this row a heading that starts a group (`new Setting(el).setName("Discord").setHeading()`). */
    setHeading(): this;
    /** Add a CSS class to the row (your styles.css can style it). */
    setClass(cls: string): this;
    /** Grey the row out and turn its controls off (or on again). */
    setDisabled(d: boolean): this;
    /** Hide the row (or show it again), for settings that only matter when another one is on. */
    setVisible(v: boolean): this;
    addColorPicker(cb: (c: ColorComponent) => void): this;
    addExtraButton(cb: (c: ExtraButtonComponent) => void): this;
    addToggle(cb: (c: ToggleComponent) => void): this;
    addText(cb: (c: TextComponent) => void): this;
    addTextArea(cb: (c: TextComponent) => void): this;
    addDropdown(cb: (c: DropdownComponent) => void): this;
    addButton(cb: (c: ButtonComponent) => void): this;
    addSlider(cb: (c: SliderComponent) => void): this;
  }

  /**
   * An extension's settings page, opened from the cog on its row in Settings > Extensions (or `plugin.openSettings()`).
   * SOUP empties `containerEl` and calls `display()` each time the page opens, and `hide()` when it closes. Save with
   * `plugin.saveData`: the settings then belong to the active profile, and each profile has its own.
   */
  export class SettingTab {
    app: unknown;
    containerEl: HTMLElement;
    /** The page title (default: the extension's name). */
    name?: string;
    constructor(app?: unknown);
    display(): void;
    hide(): void;
    /** Empty the page and call `display()` again (after a change that shows or hides rows). */
    redraw(): void;
  }

  // ---------------------------------------------------------------- placing things in SOUP

  /** UI is either `mount(el)` (any framework; return a cleanup or give `unmount`) or a React `component`. */
  export interface Mountable {
    mount?: (el: HTMLElement) => void | (() => void);
    unmount?: (el: HTMLElement) => void;
    component?: ComponentType<Record<string, unknown>>;
  }
  export interface Placement {
    /** Unique within the extension. */
    id: string;
    /** Lower first; ties by id. */
    order?: number;
  }
  export interface TabOptions extends Placement, Mountable {
    label: string;
    /** A lucide icon name (docs/05-ui.md lists them); default a puzzle piece. */
    icon?: string;
    keepMounted?: boolean;
  }
  export interface PanelOptions extends Placement, Mountable {
    title?: string;
  }
  export interface ReplayActionOptions extends Placement {
    label: string;
    icon?: string;
    slot?: "chip" | "primary" | "secondary";
    when?: (replay: LibraryReplay) => boolean;
    run: (replay: LibraryReplay) => void | Promise<void>;
  }
  export interface ReplayBadgeOptions extends Placement {
    /** Short text for a chip on the tile, or null for none. */
    render: (replay: LibraryReplay) => string | null;
  }
  export interface FolderActionOptions extends Placement {
    label: string;
    icon?: string;
    when?: (folder: LibraryFolder) => boolean;
    run: (folder: LibraryFolder) => void | Promise<void>;
  }
  export interface ToolbarActionOptions extends Placement {
    label: string;
    icon?: string;
    run: () => void | Promise<void>;
  }
  export interface MatchRowActionOptions extends Placement {
    label: string;
    icon?: string;
    when?: (matchId: string) => boolean;
    run: (matchId: string) => void | Promise<void>;
  }
  export interface CommandSpec {
    /** Unique within the extension. */
    id: string;
    name: string;
    /** `Ctrl+Shift+N`, `Alt+F2`. A shortcut needs Ctrl or Alt; Ctrl+K belongs to the command palette. */
    hotkey?: string;
    callback: () => void | Promise<void>;
  }

  /** What `manifest.json` said, as the loader read it. */
  export interface ExtensionManifestInfo {
    id: string;
    name: string;
    version: string;
    minAppVersion?: string;
    apiVersion?: string;
    description?: string;
    author?: string;
    [key: string]: unknown;
  }

  // ---------------------------------------------------------------- Plugin

  /**
   * The base class of an extension: `export default class X extends Plugin`. Everything registered through `register*` and `add*`
   * is removed when the extension unloads, in reverse order, after `onunload()`.
   */
  export class Plugin {
    app: App;
    manifest: ExtensionManifestInfo;
    constructor(app: App, manifest: ExtensionManifestInfo);

    /** Called once when the extension loads. A throw marks it "Error" and removes what it added; SOUP and other extensions carry on. */
    onload(): void | Promise<void>;
    /** Called when it unloads (turned off, removed, updated, Restricted mode, a profile switch), before the registered cleanups. */
    onunload(): void | Promise<void>;

    /** Per-profile settings (at most 1 MB of JSON); `{}` when nothing was saved. */
    loadData<T = Record<string, unknown>>(): Promise<T>;
    saveData(data: unknown): Promise<void>;
    /** The folder for this extension's files in the active profile (created). */
    readonly dataDir: string;
    /** The folder for files that are the same under every profile (created). */
    readonly machineDir: string;

    /** Run `fn` when the extension unloads (after `onunload`, in reverse order of registration). */
    register(fn: () => void | Promise<void>): void;
    /** `this.registerEvent(this.app.events.on(...))`: the subscription ends when the extension unloads. */
    registerEvent(ref: { off: () => void }): void;
    registerInterval(id: number): number;
    /** Cancel a `debounce`d function when the extension unloads. */
    registerDebounce(d: { cancel(): void }): void;
    registerDomEvent<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void;
    registerDomEvent<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void;
    registerDomEvent(target: HTMLElement, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void;

    addTab(o: TabOptions): Handle;
    /** A small item in the header, beside the connection pill. */
    addHeaderItem(o: Placement & Mountable): Handle;
    /** A strip under the navigation, shown on every tab. */
    addActivityBar(o: Placement & Mountable): Handle;
    addMatchesSidebarPanel(o: PanelOptions): Handle;
    addViewer3dPanel(o: PanelOptions): Handle;
    /**
     * This extension's settings page, titled by the tab's `name` (default: the extension's name). A cog on the extension's row in
     * Settings > Extensions opens it. One per extension: a second call replaces the first.
     */
    addSettingTab(tab: SettingTab): Handle;
    /** Open this extension's settings page (for a "Settings" button in your own tab). */
    openSettings(): void;
    addLibraryReplayAction(o: ReplayActionOptions): Handle;
    /** A chip next to the replay's name on its Library tile. Call the returned `refresh()` when what `render` answers has changed (a note was added). */
    addLibraryReplayBadge(o: ReplayBadgeOptions): Handle & { refresh(): void };
    addLibraryFolderAction(o: FolderActionOptions): Handle;
    addLibraryToolbarAction(o: ToolbarActionOptions): Handle;
    /** A button on each row of the Matches tab (match history). */
    addMatchRowAction(o: MatchRowActionOptions): Handle;
    /** A command in the palette (Ctrl+K) and an optional keyboard shortcut. */
    addCommand(spec: CommandSpec): Handle;
    /** Small text on this extension's row in Settings > Extensions ("Synced 2 min ago"). */
    addStatusText(text: string): void;
  }

  // ---------------------------------------------------------------- app.fs, app.process, requestUrl

  export interface ExtensionSummary {
    id: string;
    name: string;
    version: string;
    /** The other extension's own `api` property, if it exposes one. */
    api: unknown;
  }

  /** A stream of lines from a program. Lines that arrived before `on` was called are replayed first. */
  export interface LineStream {
    on(cb: (line: string) => void): Stoppable;
    /** Everything received so far (the last 5000 lines), joined by newlines. */
    text(): string;
  }
  export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** No console window (default true). */
    hidden?: boolean;
    /** Keep running when the extension unloads or SOUP exits (default false). */
    detached?: boolean;
  }
  export interface ProcessHandle {
    readonly id: number;
    readonly stdout: LineStream;
    readonly stderr: LineStream;
    /** The exit code once it ended, otherwise undefined. */
    exitCode: number | null | undefined;
    readonly exited: boolean;
    /** Text for the program's standard input (add "\n" yourself). */
    write(text: string): Promise<void>;
    /** The program sees end of input. */
    closeStdin(): Promise<void>;
    kill(): Promise<boolean>;
    /** Resolves with the exit code after the last output line was delivered. */
    wait(): Promise<number | null>;
  }

  export interface RequestUrlOptions {
    url: string;
    /** Default GET. */
    method?: string;
    headers?: Record<string, string>;
    /** A string, bytes, or any JSON value (sent as JSON with a Content-Type unless you set one). */
    body?: string | ArrayBuffer | Uint8Array | Record<string, unknown> | unknown[] | null;
    timeoutMs?: number;
    /** Only for 127.0.0.1, localhost and ::1. */
    allowSelfSigned?: boolean;
    /** Throw on a status of 400 or more (default true, like Obsidian). */
    throw?: boolean;
  }
  export interface RequestUrlResponse {
    status: number;
    /** Lower-case names. */
    headers: Record<string, string>;
    text: string;
    /** The text parsed as JSON (throws if it is not JSON). */
    readonly json: any;
    readonly bytes: Uint8Array;
    /** The final address after redirects, without its query string. */
    url: string;
  }
  export class RequestError extends Error {
    status: number;
    response: RequestUrlResponse;
  }

  export interface RiotResponse {
    status: number;
    text: string;
    /** The body parsed as JSON (null when empty; throws when it is not JSON). */
    readonly json: any;
  }

  export interface OAuthOptions {
    /** The service's authorization address (https only). */
    authorizeUrl: string;
    /** The service's token address (https only). */
    tokenUrl: string;
    clientId: string;
    /** A desktop client's "secret" (public by design for most services; PKCE is the protection). */
    clientSecret?: string;
    scopes: string[];
    /** More query parameters for the authorization address (`access_type`, `prompt`, `trigger_onepick`, ...). `state`, `scope`, `redirect_uri`, `client_id`, `response_type` and the `code_challenge` ones are set by SOUP and cannot be given. */
    extraParams?: Record<string, string>;
    /** How long to wait for the person to finish in the browser (default and longest: 5 minutes). */
    timeoutMs?: number;
    /** Abort a sign-in that is still waiting for the browser (the call then rejects with `auth_cancelled`). */
    signal?: AbortSignal;
  }
  export interface RefreshOptions {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scopes?: string[];
  }
  export interface UploadOptions {
    url: string;
    /** Default PUT. */
    method?: string;
    headers?: Record<string, string>;
    /** The file to send. A relative path starts in `dataDir`. */
    file: string;
    /** Where in the file to start (default 0). */
    offset?: number;
    /** How many bytes to send (default: to the end of the file). */
    length?: number;
    /** The whole request may take this long (default 30 minutes, at most 6 hours). */
    timeoutMs?: number;
    onProgress?: (p: TransferProgress) => void;
  }
  export interface DownloadOptions {
    url: string;
    /** Default GET. */
    method?: string;
    headers?: Record<string, string>;
    /** Where to write. A relative path starts in `dataDir`; parent folders are created. */
    to: string;
    /** Refuse an answer larger than this many bytes (default 4 GiB, at most 100 GiB). */
    maxBytes?: number;
    timeoutMs?: number;
    onProgress?: (p: TransferProgress) => void;
  }

  export interface DialogInput {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }

  // ---------------------------------------------------------------- app

  /** What an extension reaches SOUP through: `this.app`. */
  export interface App {
    /** This extension's id. */
    id: string;

    /** The built-in modules (their frontend APIs) and whether they are on. */
    modules: {
      isEnabled(module: string): boolean;
      /** The module's frontend API object (the one SOUP's own screens use), or undefined when the module is off. */
      get<T = unknown>(module: string): T | undefined;
    };
    library: {
      list(): Promise<unknown>;
      root(): Promise<string>;
      onChanged(cb: (c: unknown) => void): EventRef;
      /**
       * Add replay (.vrf) and match (.json) files to the Library, paired the way Library > Import pairs them (a .vrf with its
       * .json, attached to the card of the same match when there is one), into the folder `folderId` (the root when left out).
       * `skipped` lists files that could not be read.
       */
      importFiles(paths: string[], folderId?: string | null): Promise<{ imported: number; skipped: Array<{ path: string; error: string }> }>;
      createFolder(name: string, parentId?: string | null, color?: string | null): Promise<LibraryFolder>;
      renameReplay(replayId: string, name: string): Promise<void>;
      /** Move a replay or a folder into a folder (`null`: the root). */
      moveItem(kind: "replay" | "folder", id: string, folderId: string | null): Promise<void>;
      /** To the Library's trash (the files go to `.trash`; nothing is erased). */
      deleteReplay(replayId: string): Promise<void>;
    };
    matches: {
      history(): Promise<unknown>;
      details(matchId: string): Promise<unknown>;
      liveState(): Promise<unknown>;
    };

    /** The Riot account and the Riot Client. Everything here is full trust: see docs/09-riot.md before using it. */
    riot: {
      /** The signed-in account, or null (no Riot Client, or nobody signed in). */
      identity(): Promise<Identity | null>;
      /** The Riot tokens and client headers (connects to the Riot Client first if needed). Treat them like the account's password. */
      tokens(): Promise<RawSession>;
      /** A call to the Riot Client's local API (any method, a path starting with /). Returns the status even when it is not 2xx. */
      local(method: string, path: string, body?: unknown): Promise<RiotResponse>;
      /** A call to a remote Riot service with the session's headers, through SOUP's shared limiter. `url` must be https. */
      remote(method: string, target: { service: "pd" | "glz" | "shared"; path: string } | { url: string }, body?: unknown, headers?: Record<string, string>): Promise<RiotResponse>;
      /** Events of the Riot Client's socket whose URI contains `uri` (empty: every event), with their payloads. */
      onLocalEvent(uri: string, cb: (e: ClientEvent) => void): Promise<Stoppable>;
      connection(): Promise<ConnectionState>;
      onConnectionChanged(cb: (c: ConnectionState) => void): EventRef;
    };

    events: {
      /** A SOUP event (`library/changed`, `core/profile-changed`, ...) or another extension's (`<id>/<name>`). */
      on(name: string, cb: (payload: any) => void): EventRef;
      /** Tell other extensions: the name must start with this extension's id and a slash. */
      emit(name: string, payload?: unknown): void;
    };

    /** The file system. Any path; a relative path starts in `dataDir`. */
    fs: {
      read(path: string): Promise<Uint8Array>;
      readText(path: string): Promise<string>;
      write(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void>;
      append(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void>;
      /** Folders first, then by name. */
      list(path: string): Promise<FsEntry[]>;
      stat(path: string): Promise<FsStat>;
      exists(path: string): Promise<boolean>;
      mkdir(path: string): Promise<void>;
      remove(path: string, o?: { recursive?: boolean }): Promise<void>;
      rename(from: string, to: string): Promise<void>;
      copy(from: string, to: string): Promise<void>;
      /** Call `cb` when something under `path` is created, changed or removed (checked twice a second). */
      watch(path: string, cb: (e: WatchEvent) => void): Promise<Stoppable>;
    };

    /** Programs. Children that are not `detached` are stopped when the extension unloads or SOUP exits. */
    process: {
      spawn(cmd: string, args?: string[], o?: SpawnOptions): Promise<ProcessHandle>;
      /** Run a program to the end and return what it printed. */
      exec(cmd: string, args?: string[], o?: SpawnOptions & { input?: string }): Promise<{ code: number | null; stdout: string; stderr: string }>;
      /** Open a file or folder with Windows' default program. */
      openPath(path: string): Promise<void>;
      /** Open an address (a website, a mail link, ...) in its default program. */
      openUrl(url: string): Promise<void>;
    };

    dialog: {
      openFile(o?: DialogInput): Promise<string | null>;
      openFiles(o?: DialogInput): Promise<string[]>;
      openFolder(o?: DialogInput): Promise<string | null>;
      save(o?: DialogInput): Promise<string | null>;
    };
    clipboard: {
      readText(): Promise<string | null>;
      writeText(text: string): Promise<void>;
    };

    /** Any URL from SOUP's side of the app: no CORS, any method. */
    requestUrl(opts: RequestUrlOptions | string): Promise<RequestUrlResponse>;

    /** Sign in to a service the way a desktop app should. Declare `"accounts"` in your manifest's `uses`. */
    auth: {
      /**
       * Open the system browser on `authorizeUrl`, wait for the redirect on a one-shot listener on 127.0.0.1, check `state`, and
       * exchange the code (PKCE, S256) at `tokenUrl`. `extra` holds every other query parameter of the redirect (Google Picker's
       * `picked_file_ids`). Rejects with `auth_denied`, `auth_timeout`, `auth_cancelled` or `auth_failed`. No token is logged.
       */
      oauthPkce(o: OAuthOptions): Promise<OAuthTokens>;
      /** Renew an access token. The answer usually has no `refreshToken`: keep the one you have. */
      refresh(o: RefreshOptions): Promise<OAuthTokens>;
    };
    /** Small secrets (a refresh token, up to 8 KB each) in Windows Credential Manager, private to this extension; deleted with its data. Keys are 1 to 128 letters, digits, `.`, `-` and `_`. */
    secrets: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<void>;
      /** True when there was a secret to delete. */
      delete(key: string): Promise<boolean>;
    };
    /** Files to and from a server, streamed by SOUP (nothing is held whole in memory, no size cap of `requestUrl`). */
    net: {
      /** Send a file or a slice of it. The status is a value, not an error (a resumable upload answers 308 until it is complete). */
      upload(o: UploadOptions): Promise<UploadResponse>;
      /** Write the answer to a file. A status that is not 2xx writes nothing and gives `errorText`. */
      download(o: DownloadOptions): Promise<DownloadResponse>;
    };

    profiles: {
      active(): Promise<ProfileInfo | undefined>;
      list(): Promise<ProfileInfo[]>;
      /** Fires before the window reloads for the new profile. */
      onChange(cb: (p: ProfileInfo) => void): EventRef;
      /** Write the ACTIVE profile (settings, theme, which extensions it uses; this PC's paths left out) as a `.soupprofile` file. Returns the path written. */
      exportTo(path: string): Promise<string>;
      /** What importing the file would do. Nothing is created. */
      previewImport(path: string): Promise<ImportPreview>;
      /** Make a NEW profile from the file: nothing is overwritten and no extension is installed. `choices.name` overrides the file's name. */
      importFrom(path: string, choices?: { name?: string }): Promise<ProfileInfo>;
    };

    /** Other extensions. */
    extensions: {
      /** The loaded instance of another extension (its public `api` property is what it offers). */
      get(other: string): Plugin | undefined;
      isEnabled(other: string): boolean;
      list(): ExtensionSummary[];
    };

    ui: {
      /** An awaited yes/no dialog. */
      confirm(o: { title: string; message: string; confirmLabel?: string; destructive?: boolean }): Promise<boolean>;
      /** Switch to a tab by its id (`<extension id>.<tab id>` for an extension's tab). */
      navigate(tabId: string): void;
      /** A separate window for the extension's own page (a file of the extension, or an https address). */
      openWindow(o: { url: string; title?: string; width?: number; height?: number; alwaysOnTop?: boolean }): Promise<{ label: string; url: string; close(): Promise<boolean> }>;
      /** SOUP's React and its UI kit, so an extension looks native. */
      react: {
        React: typeof import("react");
        ReactDOM: typeof import("react-dom") & typeof import("react-dom/client");
        jsxRuntime: typeof import("react/jsx-runtime");
        createElement: typeof import("react").createElement;
        Fragment: typeof import("react").Fragment;
        kit: {
          Button: ComponentType<any>;
          Switch: ComponentType<any>;
          Progress: ComponentType<any>;
          StatusPill: ComponentType<any>;
          EmptyState: ComponentType<any>;
          ErrorCard: ComponentType<any>;
          SettingsSection: ComponentType<any>;
          inputCls: string;
        };
      };
      /** The theme tokens (CSS variables on <html>) and a way to hear when they change. */
      theme: {
        tokens(): Record<string, string>;
        onChange(cb: (tokens: Record<string, string>) => void): EventRef;
      };
    };

    paths: {
      dataDir: string;
      machineDir: string;
      saveDir: string;
      libraryRoot: string;
      valorantDemos: string;
      vr3dDir: string;
      tempDir: string;
      /** The extension's own folder (where main.js is): a helper program shipped with the extension lives here. */
      codeDir: string;
    };

    /** Lines into SOUP's log under `[ext-<id>]` (visible in the debug console). */
    log: {
      debug(message: string, data?: unknown): void;
      info(message: string, data?: unknown): void;
      warn(message: string, data?: unknown): void;
      error(message: string, data?: unknown): void;
    };
  }

  // ---------------------------------------------------------------- data types (generated from SOUP's Rust types)
  /**
   * A frame from the client's event socket: `[8, "OnJsonApiEvent", { "uri", "eventType", "data" }]`.
   */
  export type ClientEvent = { uri: string, eventType: string | null, data: unknown, };

  /**
   * What the UI shows in the header and what `get_connection` returns.
   */
  export type ConnectionState = { connected: boolean, playerName: string | null, region: string | null, 
  /**
   * The signed-in account's PUUID: what a profile is bound to (Settings > Profiles). Never logged.
   */
  puuid: string | null, 
  /**
   * True when the region came from the running client (for example Tournament Realm), not from
   * the user's choice.
   */
  autoDetected: boolean, };

  export type DownloadResponse = { status: number, headers: { [key in string]?: string }, 
  /**
   * Bytes written (0 when the status is not 2xx: nothing is written then).
   */
  size: number, 
  /**
   * The file written, or null when the status is not 2xx.
   */
  path: string | null, 
  /**
   * The start of the answer's text when the status is not 2xx (up to 16 KB), to see why.
   */
  errorText: string | null, };

  export type FsEntry = { name: string, path: string, isDir: boolean, size: number, 
  /**
   * Milliseconds since 1970 (0 when unknown).
   */
  modifiedMs: number, };

  export type FsStat = { exists: boolean, isDir: boolean, isFile: boolean, size: number, modifiedMs: number, };

  /**
   * The signed-in account, from what the connection watcher already knows.
   */
  export type Identity = { name: string, tag: string | null, puuid: string, region: string, shard: string, };

  export type ImportExtension = { id: string, version: string | null, repo: string | null, installed: boolean, };

  /**
   * What the import dialog shows before anything is created.
   */
  export type ImportPreview = { name: string, kind: ProfileKind, color: string, soupVersion: string, 
  /**
   * Built-in modules the profile turns on / off (by id; `None` entries use the module's default and are not listed).
   */
  modulesOn: Array<string>, modulesOff: Array<string>, 
  /**
   * Extensions it needs, and whether each is installed here. They are never installed automatically.
   */
  extensions: Array<ImportExtension>, 
  /**
   * Module ids in the file that this SOUP does not know (kept as they are).
   */
  unknownModules: Array<string>, 
  /**
   * Settings that will not be imported because they name a folder of the PC it came from.
   */
  dropped: Array<string>, customThemes: number, hasLogo: boolean, };

  /**
   * One agent on a replay's roster, cached on the tile so the grid never opens a
   * file. `characterId` keys the valorant-api icon on the frontend.
   */
  export type LibraryAgent = { 
  /**
   * Riot content GUID; keys the valorant-api icon.
   */
  characterId: string, 
  /**
   * `Blue`, `Red` or empty.
   */
  team: string, 
  /**
   * The player's Riot ID game name.
   */
  name: string | null, };

  export type LibraryFolder = { id: string, name: string, parentId: string | null, 
  /**
   * Hex tint for the card swatch; `None` is the default accent.
   */
  color: string | null, pinned: boolean, 
  /**
   * Manual drag-reorder position (used by the "custom" sort).
   */
  sortIndex: number, 
  /**
   * Epoch ms.
   */
  createdAt: number, };

  /**
   * A replay card as the UI sees it: the catalog row with absolute file paths and derived flags.
   */
  export type LibraryReplay = { id: string, folderId: string | null, name: string, matchId: string | null, mode: string | null, 
  /**
   * Display name.
   */
  map: string | null, 
  /**
   * `/Game/Maps/Ascent/Ascent`; keys valorant-api art.
   */
  mapUrl: string | null, 
  /**
   * Client patch; drives the injection compatibility check.
   */
  gameVersion: string | null, 
  /**
   * `13 - 7`.
   */
  score: string | null, agents: Array<LibraryAgent>, hasVrf: boolean, hasJson: boolean, 
  /**
   * Absolute path to the `.vrf` on disk (`None` until added).
   */
  vrfPath: string | null, 
  /**
   * Absolute path to the match `.json` on disk.
   */
  jsonPath: string | null, sizeBytes: number, 
  /**
   * Epoch ms when it was added to the library.
   */
  importedAt: number, 
  /**
   * Epoch ms when the match was played.
   */
  startedAt: number | null, 
  /**
   * Epoch ms; `None` until the first "View in Client".
   */
  lastPlayedAt: number | null, pinned: boolean, sortIndex: number, };

  export type OAuthTokens = { accessToken: string, 
  /**
   * A refresh token comes only on the first sign-in with most services; keep the old one when a refresh gives none.
   */
  refreshToken: string | null, 
  /**
   * Epoch milliseconds when the access token stops working.
   */
  expiresAt: number, scope: string, idToken: string | null, 
  /**
   * Every other query parameter of the redirect (for example Google Picker's `picked_file_ids`).
   */
  extra: { [key in string]?: string }, };

  /**
   * One profile as the UI sees it.
   */
  export type ProfileInfo = { id: string, name: string, kind: ProfileKind, color: string, icon: string | null, createdAt: string, updatedAt: string, riotBinding: RiotBinding | null, active: boolean, 
  /**
   * `profile.json` could not be read: listed so it can be seen and removed, never used.
   */
  damaged: boolean, 
  /**
   * Where this profile's replays are saved (its library is `<this>\Library`).
   */
  saveDirectory: string, };

  export type ProfileKind = "personal" | "team";

  /**
   * The session as Riot's remote services want it. Handing this to an extension is the point of the call; it is never logged
   * (the tokens are registered with the log redactor when the session is made, and no line here carries them).
   */
  export type RawSession = { accessToken: string, entitlementsToken: string, puuid: string, clientVersion: string, clientPlatform: string, region: string, shard: string, };

  /**
   * A profile bound to a Riot account (PROFILES_PLAN section 7).
   */
  export type RiotBinding = { puuid: string, 
  /**
   * `Name#TAG` as it was shown when the binding was made.
   */
  name: string, 
  /**
   * Switch to this profile when that account signs in, without asking.
   */
  autoSwitch: boolean, };

  export type TransferProgress = { done: number, 
  /**
   * The size when it is known.
   */
  total: number | null, };

  export type UploadResponse = { status: number, 
  /**
   * Lower-case names; repeated headers joined with ", ".
   */
  headers: { [key in string]?: string }, text: string, };

  export type WatchEvent = { "kind": "created", path: string, } | { "kind": "modified", path: string, } | { "kind": "removed", path: string, };
}

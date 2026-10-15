// Navigation memory for the app shell and the Database. Pure (no React, no DOM): the rules live here so they can be tested; App.tsx and
// Database.tsx only apply them.
//
//   * Which sidebar screen is showing, and a per-screen "go home" signal bumped when the ACTIVE sidebar icon is clicked again.
//   * Where the Database was left (tab, open product, Library folder, search, category, sort, scroll), saved in localStorage under
//     clynx.nav.* and validated before it is trusted, so a deleted product or folder falls back to home instead of a broken page.

export const SCREEN_IDS = ["dashboard", "activity", "feed", "watch", "database", "config"] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

export const DATABASE_TABS = ["discovery", "library", "review", "blacklist"] as const;
export type DatabaseTabId = (typeof DATABASE_TABS)[number];

export const LIBRARY_SORTS = ["recent", "priceDesc", "priceAsc", "az"] as const;
export type LibrarySortId = (typeof LIBRARY_SORTS)[number];

export const NAV_SCREEN_KEY = "clynx.nav.screen";
export const NAV_DATABASE_KEY = "clynx.nav.database";

export function isScreenId(value: unknown): value is ScreenId {
  return typeof value === "string" && (SCREEN_IDS as readonly string[]).includes(value);
}

// ---------- the sidebar screen

export interface NavState {
  screen: ScreenId;
  /** Bumped when the already-active screen's icon is clicked again. Screens watch their own counter. */
  homeSignals: Record<ScreenId, number>;
}

export type NavAction =
  /** A sidebar click, a notification click, or a "go to the Feed" button. */
  | { type: "select"; screen: ScreenId }
  /** Open a product's page in the Database (the Feed's Research button, a log line's product link). Not blocked by Config. */
  | { type: "goToProduct" }
  /** Back to the Dashboard (signed out). */
  | { type: "reset" };

export interface NavResult {
  state: NavState;
  /** True when leaving was refused because Config has unsaved changes (the caller shakes Config's Save button). */
  denied: boolean;
}

export function initialNavState(screen: ScreenId = "dashboard"): NavState {
  return { screen, homeSignals: Object.fromEntries(SCREEN_IDS.map((s) => [s, 0])) as Record<ScreenId, number> };
}

export function reduceNav(state: NavState, action: NavAction, ctx: { configDirty: boolean }): NavResult {
  if (action.type === "goToProduct") {
    return { state: state.screen === "database" ? state : { ...state, screen: "database" }, denied: false };
  }
  if (action.type === "reset") {
    return { state: state.screen === "dashboard" ? state : { ...state, screen: "dashboard" }, denied: false };
  }
  const next = action.screen;
  if (!isScreenId(next)) return { state, denied: false };
  if (next === state.screen) {
    // Clicking the screen you are on takes you to its home, except in a Config with unsaved changes, where nothing may move.
    if (state.screen === "config" && ctx.configDirty) return { state, denied: false };
    return { state: { ...state, homeSignals: { ...state.homeSignals, [next]: state.homeSignals[next] + 1 } }, denied: false };
  }
  if (state.screen === "config" && ctx.configDirty) return { state, denied: true };
  return { state: { ...state, screen: next }, denied: false };
}

/** A saved screen name, or the Dashboard when it is missing or unknown. Config is never restored into: it opens from a click. */
export function parseScreen(raw: unknown): ScreenId {
  return isScreenId(raw) && raw !== "config" ? raw : "dashboard";
}

// ---------- the Database

export interface LibraryPath {
  category: string;
  segments: string[];
}

export interface DatabaseNav {
  tab: DatabaseTabId;
  selectedProductId: string | null;
  searchQuery: string;
  activeCategory: string | null;
  sortBy: LibrarySortId;
  viewingPath: LibraryPath | null;
  /** The Library grid's scrollTop. */
  scrollTop: number;
}

/** The Database as it opens for the first time (and where a second click on its sidebar icon returns). */
export function homeDatabaseNav(keepSort: LibrarySortId = "recent"): DatabaseNav {
  return { tab: "discovery", selectedProductId: null, searchQuery: "", activeCategory: null, sortBy: keepSort, viewingPath: null, scrollTop: 0 };
}

/** The Library's root: no folder, category, search or scroll (and no open product). Sorting is a preference and stays. */
export function libraryRootNav(nav: DatabaseNav): DatabaseNav {
  return { ...nav, tab: "library", selectedProductId: null, searchQuery: "", activeCategory: null, viewingPath: null, scrollTop: 0 };
}

const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * Reads what serializeDatabaseNav wrote. Never throws: null, corrupt JSON, the wrong shape, unknown tab names and bad field types all fall
 * back, field by field, to home values. Existence of the product or folder is checked later by validateDatabaseNav, once the data is loaded.
 */
export function parseDatabaseNav(raw: string | null | undefined): DatabaseNav {
  const home = homeDatabaseNav();
  if (!raw) return home;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return home;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return home;
  const d = data as Record<string, unknown>;
  const tab = (DATABASE_TABS as readonly unknown[]).includes(d.tab) ? (d.tab as DatabaseTabId) : home.tab;
  const sortBy = (LIBRARY_SORTS as readonly unknown[]).includes(d.sortBy) ? (d.sortBy as LibrarySortId) : home.sortBy;
  const vp = d.viewingPath as Partial<LibraryPath> | null | undefined;
  const viewingPath =
    vp && typeof vp === "object" && isStr(vp.category) && Array.isArray(vp.segments) && vp.segments.length > 0 && vp.segments.every(isStr)
      ? { category: vp.category, segments: [...vp.segments] }
      : null;
  const scrollTop = typeof d.scrollTop === "number" && Number.isFinite(d.scrollTop) && d.scrollTop > 0 ? Math.min(d.scrollTop, 1e7) : 0;
  return {
    tab,
    selectedProductId: isStr(d.selectedProductId) && d.selectedProductId ? d.selectedProductId : null,
    searchQuery: isStr(d.searchQuery) ? d.searchQuery.slice(0, 200) : "",
    activeCategory: isStr(d.activeCategory) && d.activeCategory ? d.activeCategory : null,
    sortBy,
    viewingPath,
    scrollTop,
  };
}

export function serializeDatabaseNav(nav: DatabaseNav): string {
  return JSON.stringify({ ...nav, scrollTop: Math.max(0, Math.round(nav.scrollTop)) });
}

/** What exists right now, supplied by the Database once its products are loaded. */
export interface NavCatalog {
  productIds: ReadonlySet<string>;
  categories: ReadonlySet<string>;
  /** Whether the folder at this path (category + segments) still exists. */
  hasFolder: (category: string, segments: string[]) => boolean;
}

/**
 * Drops whatever no longer exists, so a restored (or long-open) Database never sits on a deleted product, a vanished category or a missing
 * folder. Returns the same object when nothing needed fixing, so callers can skip a state update.
 */
export function validateDatabaseNav(nav: DatabaseNav, catalog: NavCatalog): DatabaseNav {
  let next = nav;
  if (next.selectedProductId && !catalog.productIds.has(next.selectedProductId)) next = { ...next, selectedProductId: null };
  // An open product always lives under the Library tab (that is where Back returns to).
  if (next.selectedProductId && next.tab !== "library") next = { ...next, tab: "library" };
  if (next.activeCategory && !catalog.categories.has(next.activeCategory)) next = { ...next, activeCategory: null };
  if (next.viewingPath && (!catalog.categories.has(next.viewingPath.category) || !catalog.hasFolder(next.viewingPath.category, next.viewingPath.segments))) {
    next = { ...next, viewingPath: null };
  }
  return next;
}

// ---------- localStorage (every access guarded: it can throw or be empty in a private window or with site data blocked)

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readSavedScreen(store: KeyValueStore | null = defaultStore()): ScreenId {
  try {
    return parseScreen(store?.getItem(NAV_SCREEN_KEY));
  } catch {
    return "dashboard";
  }
}

export function writeSavedScreen(screen: ScreenId, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(NAV_SCREEN_KEY, screen);
  } catch {
    // not persisted: fine
  }
}

export function readSavedDatabaseNav(store: KeyValueStore | null = defaultStore()): DatabaseNav {
  try {
    return parseDatabaseNav(store?.getItem(NAV_DATABASE_KEY));
  } catch {
    return homeDatabaseNav();
  }
}

export function writeSavedDatabaseNav(nav: DatabaseNav, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(NAV_DATABASE_KEY, serializeDatabaseNav(nav));
  } catch {
    // not persisted: fine
  }
}

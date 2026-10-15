// Navigation memory: a second click on the active sidebar icon goes home, Config's unsaved-changes guard holds, the Database's place is saved
// and restored only if it still exists, and corrupt or unknown saved data falls back to home.
import {
  NAV_DATABASE_KEY,
  NAV_SCREEN_KEY,
  homeDatabaseNav,
  initialNavState,
  libraryRootNav,
  parseDatabaseNav,
  parseScreen,
  readSavedDatabaseNav,
  readSavedScreen,
  reduceNav,
  serializeDatabaseNav,
  validateDatabaseNav,
  writeSavedDatabaseNav,
  writeSavedScreen,
  type DatabaseNav,
  type KeyValueStore,
  type NavCatalog,
  type NavState,
} from "../../renderer/src/lib/navState.js";
import { check, run, section } from "./_testkit.js";

const clean = { configDirty: false };
const dirty = { configDirty: true };
const at = (screen: NavState["screen"]): NavState => initialNavState(screen);
const memory = (initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v) };
};
const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};
const catalog = (over: Partial<NavCatalog> = {}): NavCatalog => ({
  productIds: new Set(["p1", "p2"]),
  categories: new Set(["Consoles", "Phones"]),
  hasFolder: (c, segs) => c === "Consoles" && segs.join(">") === "Xbox>Games",
  ...over,
});
const deep: DatabaseNav = {
  tab: "library",
  selectedProductId: null,
  searchQuery: "box",
  activeCategory: "Consoles",
  sortBy: "az",
  viewingPath: { category: "Consoles", segments: ["Xbox", "Games"] },
  scrollTop: 640,
};

run(() => {
  section("sidebar clicks");
  {
    const r = reduceNav(at("dashboard"), { type: "select", screen: "feed" }, clean);
    check("clicking another screen switches to it", r.state.screen === "feed" && !r.denied);
    check("a switch does not bump any home signal", Object.values(r.state.homeSignals).every((n) => n === 0));
    const again = reduceNav(r.state, { type: "select", screen: "feed" }, clean);
    check("clicking the active screen again bumps ITS home signal", again.state.homeSignals.feed === 1 && again.state.screen === "feed");
    check("other screens' signals are untouched", again.state.homeSignals.database === 0 && again.state.homeSignals.dashboard === 0);
    const thrice = reduceNav(again.state, { type: "select", screen: "feed" }, clean);
    check("each re-click bumps again", thrice.state.homeSignals.feed === 2);
    const db = reduceNav(at("database"), { type: "select", screen: "database" }, clean);
    check("Database re-click: home signal, still on Database", db.state.homeSignals.database === 1 && db.state.screen === "database");
  }

  section("Config's unsaved-changes guard");
  {
    const denied = reduceNav(at("config"), { type: "select", screen: "feed" }, dirty);
    check("leaving a dirty Config is denied and the screen stays", denied.denied && denied.state.screen === "config");
    const same = reduceNav(at("config"), { type: "select", screen: "config" }, dirty);
    check("re-clicking a dirty Config is a no-op (no home, no shake)", !same.denied && same.state.screen === "config" && same.state.homeSignals.config === 0);
    const cleanLeave = reduceNav(at("config"), { type: "select", screen: "feed" }, clean);
    check("a clean Config can be left", cleanLeave.state.screen === "feed" && !cleanLeave.denied);
    const cleanSame = reduceNav(at("config"), { type: "select", screen: "config" }, clean);
    check("re-clicking a clean Config goes home", cleanSame.state.homeSignals.config === 1);
    const intoConfig = reduceNav(at("feed"), { type: "select", screen: "config" }, dirty);
    check("going TO Config is never blocked", intoConfig.state.screen === "config" && !intoConfig.denied);
    const bogus = reduceNav(at("feed"), { type: "select", screen: "nope" as never }, clean);
    check("an unknown screen name changes nothing", bogus.state.screen === "feed" && !bogus.denied);
  }

  section("goToProduct and reset");
  {
    check("goToProduct opens the Database", reduceNav(at("feed"), { type: "goToProduct" }, clean).state.screen === "database");
    const fromConfig = reduceNav(at("config"), { type: "goToProduct" }, dirty);
    check("goToProduct keeps its existing behaviour (not blocked by Config)", fromConfig.state.screen === "database" && !fromConfig.denied);
    const already = at("database");
    check("goToProduct while on the Database does not bump the home signal", reduceNav(already, { type: "goToProduct" }, clean).state.homeSignals.database === 0);
    check("reset returns to the Dashboard", reduceNav(at("watch"), { type: "reset" }, clean).state.screen === "dashboard");
  }

  section("saved sidebar screen");
  {
    check("a valid name restores", parseScreen("watch") === "watch" && parseScreen("database") === "database");
    check("an unknown name falls back to the Dashboard", parseScreen("settings") === "dashboard");
    check("garbage types fall back", parseScreen(null) === "dashboard" && parseScreen(42) === "dashboard" && parseScreen({}) === "dashboard");
    check("Config is never restored into", parseScreen("config") === "dashboard");
    const store = memory();
    check("nothing saved: Dashboard", readSavedScreen(store) === "dashboard");
    writeSavedScreen("feed", store);
    check("writes under clynx.nav.screen and reads back", store.data[NAV_SCREEN_KEY] === "feed" && readSavedScreen(store) === "feed");
    check("a throwing store reads as Dashboard and a write does not throw", readSavedScreen(throwing) === "dashboard" && (writeSavedScreen("feed", throwing), true));
    check("no store at all is fine", readSavedScreen(null) === "dashboard" && (writeSavedScreen("feed", null), true));
  }

  section("saving and restoring the Database's place");
  {
    check("round trip keeps every field", JSON.stringify(parseDatabaseNav(serializeDatabaseNav(deep))) === JSON.stringify(deep));
    const store = memory();
    writeSavedDatabaseNav(deep, store);
    check("stored under clynx.nav.database", NAV_DATABASE_KEY in store.data && JSON.stringify(readSavedDatabaseNav(store)) === JSON.stringify(deep));
    check("a throwing store reads as home", JSON.stringify(readSavedDatabaseNav(throwing)) === JSON.stringify(homeDatabaseNav()));
    check("fractional scroll is rounded when saved", parseDatabaseNav(serializeDatabaseNav({ ...deep, scrollTop: 100.7 })).scrollTop === 101);
  }

  section("corrupt or hostile saved data");
  {
    const home = JSON.stringify(homeDatabaseNav());
    for (const [name, raw] of [
      ["null", null],
      ["empty string", ""],
      ["not JSON", "{oops"],
      ["JSON null", "null"],
      ["a JSON array", "[1,2]"],
      ["a JSON number", "7"],
    ] as const) {
      check(`${name}: home`, JSON.stringify(parseDatabaseNav(raw)) === home);
    }
    const bad = parseDatabaseNav(JSON.stringify({ tab: "hacker", selectedProductId: 5, searchQuery: {}, activeCategory: [], sortBy: "x", viewingPath: { category: 1, segments: "a" }, scrollTop: "far" }));
    check("each bad field falls back on its own", JSON.stringify(bad) === home, bad);
    const partial = parseDatabaseNav(JSON.stringify({ tab: "blacklist", searchQuery: "ok", scrollTop: -20 }));
    check("good fields survive next to bad ones; negative scroll becomes 0", partial.tab === "blacklist" && partial.searchQuery === "ok" && partial.scrollTop === 0);
    check("an empty segment list is not a folder", parseDatabaseNav(JSON.stringify({ viewingPath: { category: "A", segments: [] } })).viewingPath === null);
    check("segments of the wrong type are rejected", parseDatabaseNav(JSON.stringify({ viewingPath: { category: "A", segments: ["x", 2] } })).viewingPath === null);
    check("an absurd scroll offset is capped", parseDatabaseNav(JSON.stringify({ scrollTop: 1e30 })).scrollTop <= 1e7);
    check("Infinity-like scroll is rejected", parseDatabaseNav('{"scrollTop":1e999}').scrollTop === 0);
  }

  section("validating against what exists");
  {
    check("an intact nav is returned as the same object", validateDatabaseNav(deep, catalog()) === deep);
    const gone = validateDatabaseNav({ ...deep, selectedProductId: "deleted" }, catalog());
    check("a deleted product falls back to no product", gone.selectedProductId === null && gone.tab === "library");
    const open = validateDatabaseNav({ ...deep, tab: "blacklist", selectedProductId: "p1" }, catalog());
    check("an open product pulls the tab to Library (where Back returns)", open.selectedProductId === "p1" && open.tab === "library");
    const folder = validateDatabaseNav({ ...deep, viewingPath: { category: "Consoles", segments: ["Sega"] } }, catalog());
    check("a missing folder falls back to the Library root", folder.viewingPath === null && folder.searchQuery === "box");
    const cat = validateDatabaseNav({ ...deep, activeCategory: "Toys", viewingPath: { category: "Toys", segments: ["Xbox", "Games"] } }, catalog());
    check("a missing category clears the category and its folder", cat.activeCategory === null && cat.viewingPath === null);
    const empty = validateDatabaseNav(deep, catalog({ productIds: new Set(), categories: new Set() }));
    check("an empty library clears everything that points into it", empty.activeCategory === null && empty.viewingPath === null && empty.selectedProductId === null);
    check("validation does not change search or sort", empty.searchQuery === "box" && empty.sortBy === "az");
  }

  section("home and Library root");
  {
    const home = homeDatabaseNav();
    check("home is the Discovery tab with nothing selected", home.tab === "discovery" && !home.selectedProductId && !home.viewingPath && !home.activeCategory && home.scrollTop === 0 && home.searchQuery === "");
    check("home can keep the sort preference", homeDatabaseNav("az").sortBy === "az");
    const root = libraryRootNav({ ...deep, selectedProductId: "p1" });
    check("Library root: still Library, no folder/category/search/scroll/product", root.tab === "library" && !root.viewingPath && !root.activeCategory && root.searchQuery === "" && root.scrollTop === 0 && !root.selectedProductId);
    check("Library root keeps the sort", root.sortBy === "az");
  }

  section("the four scenarios, end to end on the pure model");
  {
    // A) Database -> product -> other screen -> Database: restores the same product.
    let nav: NavState = at("database");
    let db: DatabaseNav = { ...homeDatabaseNav(), tab: "library", selectedProductId: "p1" };
    nav = reduceNav(nav, { type: "select", screen: "dashboard" }, clean).state;
    nav = reduceNav(nav, { type: "select", screen: "database" }, clean).state;
    check("A: returning from another screen leaves the Database's own state alone", nav.screen === "database" && nav.homeSignals.database === 0 && db.selectedProductId === "p1");
    // B) click the active Database icon -> home.
    const before = nav.homeSignals.database;
    nav = reduceNav(nav, { type: "select", screen: "database" }, clean).state;
    db = nav.homeSignals.database !== before ? homeDatabaseNav(db.sortBy) : db;
    check("B: the active-icon click sends the Database home", db.selectedProductId === null && db.tab === "discovery");
    // C/D) nested folder survives a screen change but a Library re-click returns to its root.
    let lib = deep;
    nav = reduceNav(reduceNav(nav, { type: "select", screen: "feed" }, clean).state, { type: "select", screen: "database" }, clean).state;
    check("C: the nested folder is still there after leaving and returning", validateDatabaseNav(lib, catalog()).viewingPath?.segments.join(">") === "Xbox>Games");
    lib = libraryRootNav(lib);
    check("D: re-clicking Library returns it to the root", lib.viewingPath === null && lib.tab === "library");
  }
});

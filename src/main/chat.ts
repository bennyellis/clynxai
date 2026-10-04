import type { BlacklistTerm, Config, ListingRecord, LogLine, ProductProfile, Watch } from "./types.js";
import { OPENAI_MODEL, callOpenAI, ensureOpenAIAccess } from "./openai.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// A photo attached to the CURRENT chat turn only — per explicit
// instruction, so a user who doesn't know a product's name can attach a
// picture of it and have the assistant identify it. Deliberately NOT part
// of ChatMessage/history: re-sending a data: URI's full base64 bytes on
// every subsequent turn forever would bloat every future request for no
// reason once the model has already looked at it once and responded.
export interface ChatAttachment {
  dataUri: string; // already a full data: URI — ready to use as an image_url part
  name: string; // original filename, for context/logging only
}

// Full admin access: anything settable from Config, starting/stopping the
// scanner, managing the Search For list, and clearing the Feed, on top of
// the existing deal-finding tools. Still can't touch your OpenAI API key
// (that lives in plaintext .env — out of scope for a chat tool to read or
// write) and can't do anything Config itself couldn't already do.
export interface ToolCall {
  name:
    | "add_search_item"
    | "remove_search_item"
    | "add_custom_instruction"
    | "research_product"
    | "add_product_watch_note"
    | "add_blacklist_term"
    | "remove_blacklist_term"
    | "set_general_deal_detection"
    | "update_config"
    | "start_scanner"
    | "stop_scanner"
    | "clear_feed"
    | "create_watch"
    | "pause_watch"
    | "resume_watch"
    | "delete_watch"
    | "list_watch_matches";
  args: Record<string, unknown>;
}

export type ToolExecutor = (call: ToolCall) => Promise<string>;

// Four genuinely separate assistants sharing one implementation: the
// Dashboard chat can control the scanner/config/Search For list, the
// Database chat can research and save NEW product profiles, a specific
// product's own page (see buildProductSystemPrompt) is scoped to just that
// one product — refresh its research or log a watch-for note, nothing else
// — and "global" (see GlobalAssistantBar.tsx, the persistent bar at the
// bottom of every screen except Dashboard, which already has its own full-
// page assistant) gets the UNION of Dashboard's admin tools AND Database's
// research_product, per explicit instruction ("admin privileges... able to
// edit anything within the app") — it's the one context that's genuinely
// meant to reach everything else can do, not another wall between them.
// None of the other three can reach another's tools, so nothing typed into
// one of THOSE can ever affect another's behavior. Enforced twice: the tool
// list actually sent to OpenAI for a given context (so the model can't even
// attempt another context's actions), and again server-side in index.ts's
// executor (in case a model ever hallucinates a tool call outside what it
// was offered).
export type ChatContext = "dashboard" | "database" | "product" | "global";

const DASHBOARD_TOOL_NAMES = new Set<ToolCall["name"]>([
  "add_search_item",
  "remove_search_item",
  "add_custom_instruction",
  "set_general_deal_detection",
  "update_config",
  "start_scanner",
  "stop_scanner",
  "clear_feed",
  // Per explicit instruction ("admin privileges" over the whole app) —
  // blacklist management used to be Database-chat-only, but it's really an
  // app-wide control like everything else in this list, and a user talking
  // to the Dashboard assistant shouldn't have to switch tabs just to say
  // "stop showing me rentals."
  "add_blacklist_term",
  "remove_blacklist_term",
  // Per the Watch plan's own phase 4 — persistent, condition-based
  // monitoring, genuinely different from add_search_item's session-scoped
  // Search For list (see create_watch's own description below).
  "create_watch",
  "pause_watch",
  "resume_watch",
  "delete_watch",
  "list_watch_matches",
]);

const DATABASE_TOOL_NAMES = new Set<ToolCall["name"]>(["research_product", "add_blacklist_term", "remove_blacklist_term"]);

const PRODUCT_TOOL_NAMES = new Set<ToolCall["name"]>(["research_product", "add_product_watch_note"]);

// Per explicit instruction — everything Dashboard can do, plus
// research_product (Database's own product-research tool). Deliberately
// NOT add_product_watch_note — that tool only makes sense already scoped
// to one specific product's own page, which this bar never is.
const GLOBAL_TOOL_NAMES = new Set<ToolCall["name"]>([...DASHBOARD_TOOL_NAMES, "research_product"]);

export function allowedToolNames(context: ChatContext): Set<ToolCall["name"]> {
  if (context === "dashboard") return DASHBOARD_TOOL_NAMES;
  if (context === "product") return PRODUCT_TOOL_NAMES;
  if (context === "global") return GLOBAL_TOOL_NAMES;
  return DATABASE_TOOL_NAMES;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "add_search_item",
      description:
        "Add a specific product to the Search For list, so the scraper actively searches for it at every location and precisely flags it with discount-percent math. Use this as soon as the user asks you to find/track/watch/search for a specific, well-defined product — don't hold off to ask about budget or price range first; only set minPriceUsd/maxPriceUsd below if the user actually states one in the same request (e.g. 'search for PS5s between $200 and $400'), otherwise leave them out and it searches with no price range at all.",
      parameters: {
        type: "object",
        properties: {
          item: {
            type: "string",
            description:
              "Display name, e.g. 'PS5 Slim Digital 1TB' — this is ALSO the literal text typed into Facebook Marketplace's own search bar, so it must be an accurate, specific phrase for exactly the product the user asked for, not a loose paraphrase or a more generic category name.",
          },
          matchKeywords: {
            type: "array",
            items: { type: "string" },
            description:
              "Lowercase keywords/phrases likely to appear in a matching listing title, e.g. ['ps5 slim', 'playstation 5 slim'] — used only to recognize a match once a listing's already been found, NOT what gets searched for (that's `item`, above).",
          },
          typicalResaleUsd: {
            type: "number",
            description:
              "Typical USD resale value in decent used condition, ONLY if you're genuinely confident of a current real price. Use 0 if you're not sure — the user will need to fill in a real number before this item can trigger deal alerts, same as any manually-added item.",
          },
          minPriceUsd: {
            type: ["number", "null"],
            description: "This product's own price floor — listings below it are skipped. Only set if the user actually stated one for this product; otherwise omit (no floor).",
          },
          maxPriceUsd: {
            type: ["number", "null"],
            description: "This product's own price ceiling — listings above it are skipped. Only set if the user actually stated one for this product; otherwise omit (no ceiling).",
          },
        },
        required: ["item", "matchKeywords"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_custom_instruction",
      description:
        "Append a deal-finding instruction applied to every future listing screened, for loose criteria that aren't one specific trackable product — e.g. 'keep an eye out for vintage film cameras' or 'prefer sealed/unopened items.'",
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "One clear sentence of guidance." },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "research_product",
      description:
        "Build (or refresh) a persistent Database profile for a product — an AI-written writeup from a real live web search, plus a reference photo, saved so it's there for next time instead of re-researched from scratch. Use this whenever the user asks you to learn about, research, or build a profile for a product, or when a conversation makes clear they're seriously interested in one you don't already have solid info on. A broad, family-level request (\"research iPhones\", \"look into Nintendo Switch\") is normal and should NOT be refused or narrowed down — call this once with the general family name, and the writeup itself is expected to cover the real variants within it (storage sizes, generations, OLED vs base, etc.), same as one product having multiple sub-models in real life. Only ask a clarifying question if the request could mean genuinely different, unrelated products (not just \"which variant of the same thing\"). This is separate from add_search_item (which starts actively searching Facebook Marketplace for it) — call both if the user wants both.",
      parameters: {
        type: "object",
        properties: {
          product: {
            type: "string",
            description:
              "The general, canonical product name ONLY, e.g. 'Xbox Series X', 'iPhone', 'Nintendo Switch'. Never append a parenthetical qualifier or a variant/bundle/accessory list — NOT \"Xbox Series X (console, all variants/bundles/accessories)\". A broad family name is fine and expected when that's what the user asked about — this is the Database entry's title, not a place to hedge about which SKU it covers.",
          },
        },
        required: ["product"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_product_watch_note",
      description:
        "Log a practical thing to actively check for in real listings of the CURRENT product — only usable on a specific product's own page, where \"current product\" is unambiguous. Typical uses: a commonly bundled extra that adds real resale value and that sellers often photograph but forget to mention in the title/description (games with a console, a lens with a camera, cables/accessories), or a condition red flag worth checking photos for. Call this whenever the user describes something like that. This takes effect on live scanning immediately — the very next matching listing evaluated will have it checked for, not just future research.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "One clear, concrete instruction, e.g. 'Check photos for included games — they add real resale value.'",
          },
        },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_blacklist_term",
      description:
        "Add a term/phrase to the scanning blacklist — any listing whose title contains it gets skipped automatically, before it's ever opened or scored, with no further AI call spent on it. Only for things categorically unrelated to a mail-order resale business — real estate (a house/apartment for sale OR rent), job postings, service offerings, event tickets, personals — NOT for resalable items that are just uninteresting (that's a different, separate mechanism). Call this whenever the user says to blacklist/ignore/stop showing something like that. Keep the term general enough to catch the whole category, not just one exact listing's wording.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "A short term or phrase, e.g. 'for rent', 'job opening', 'timeshare'." },
        },
        required: ["term"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_blacklist_term",
      description: "Remove a term from the scanning blacklist by name, as it appears in the Blacklist list.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "The exact term to remove, as it appears in the Blacklist." },
        },
        required: ["term"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_general_deal_detection",
      description:
        "Turn general (unverified) deal flagging on or off — the AI's own broad guessing at whether ANY listing looks underpriced, independent of the Search For list. Turn this OFF when the user expresses they want the scraper focused only on specific item(s) they're tracking and nothing else — e.g. 'I only want PS5s, don't show me anything unrelated', 'just focus on what I asked for', 'stop flagging random stuff'. Turn it back ON if they later say they want to see other possible deals again.",
      parameters: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "false to restrict to only the Search For list; true to also flag other possible deals" },
        },
        required: ["enabled"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_search_item",
      description: "Remove an item from the Search For list by name — stop tracking/searching for it.",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "Name of the item to remove, as it appears on the Search For list." },
        },
        required: ["item"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_config",
      description:
        "Change any app setting directly — deal threshold %, how many listings to check per location before rotating, poll interval, headless (invisible) browsing, the photo-analysis auto-check toggle, the general-deal confidence bar, seller-risk filters, the ntfy notification server/topic, the light/dark theme, the freshness window, the max-price cap, the ignore-blacklist toggle, the auto-research toggle, or the full custom-instructions text (this REPLACES it — use add_custom_instruction instead to append one instruction without erasing the rest). Use this for any settings request not already covered by a more specific tool — including things that sound like they'd need a separate app-level preference (dark/light mode is a Config setting in this app, not an OS/window-manager preference, so handle it here, don't send the user looking for a 'Preferences' menu that doesn't exist). Only include the field(s) the user actually asked to change.",
      parameters: {
        type: "object",
        properties: {
          dealThresholdPercent: { type: "number", description: "% under reference price to count as a deal" },
          listingsPerLocation: { type: "number", description: "How many listings to evaluate at one location before rotating to the next" },
          pollIntervalMinutesMin: { type: "number" },
          pollIntervalMinutesMax: { type: "number" },
          headless: { type: "boolean", description: "true = browser runs invisibly, false = visible window" },
          customInstructions: { type: "string", description: "Replaces the ENTIRE custom-instructions text" },
          photoAnalysisEnabled: { type: "boolean" },
          generalDealMinConfidence: { type: "string", enum: ["medium", "high"] },
          sellerRiskEnabled: { type: "boolean" },
          sellerRiskMinAccountAgeYears: { type: "number" },
          sellerRiskMinRating: {
            type: ["number", "null"],
            description: "1-5, e.g. 4.0. Pass null to remove the minimum entirely (any rating, including no rating at all, passes).",
          },
          sellerRiskMinRatingCount: { type: ["number", "null"], description: "Minimum number of ratings required. Pass null to remove." },
          sellerRiskMaxRatingCount: {
            type: ["number", "null"],
            description: "Flag likely high-volume resellers above this many ratings. Pass null to remove.",
          },
          sellerRiskRequireProfilePhoto: { type: "boolean" },
          ntfyTopic: { type: "string" },
          ntfyServer: { type: "string", description: "The ntfy server URL, e.g. https://ntfy.sh" },
          theme: { type: "string", enum: ["dark", "light"], description: "The Clynx app's own light/dark appearance." },
          maxListingAgeHours: {
            type: ["number", "null"],
            description: "How old a listing can be (in hours) before it's skipped. Pass null for no freshness cap at all (any age).",
          },
          ignoreBlacklist: { type: "boolean", description: "true = temporarily stop auto-skipping blacklisted terms/images without clearing the list." },
          autoResearchListings: {
            type: "boolean",
            description: "false = only reinforce Database products that already exist, never auto-create new ones from scanning.",
          },
          rotateSearchItems: {
            type: "boolean",
            description:
              "Only matters with 2+ Search For items (Facebook can only actively search one at a time). true = dedicate the active search to ONE item at a time, switching to the next after rotateSearchItemsCount listings evaluated, independent of location rotation. false = no dedicated per-item search at all — browse generally and only evaluate listings relevant to the Search For list.",
          },
          rotateSearchItemsCount: {
            type: "number",
            description: "How many listings to evaluate for the current active Search For item before rotating to the next one. Only used when rotateSearchItems is true.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_scanner",
      description: "Start continuous scanning, same as clicking \"Start Scanner\" on the Dashboard.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_scanner",
      description: "Stop continuous scanning and close the browser, same as clicking \"Stop\" on the Dashboard.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_feed",
      description:
        "Permanently delete every listing from the Feed. Irreversible — only call this when the user has clearly and specifically asked to clear/wipe/empty the feed, not as a side effect of some other request. If there's any ambiguity about whether they mean it, ask them to confirm in plain text instead of calling this.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_watch",
      description:
        "Create a persistent Watch — unlike the Search For list (add_search_item, which resets every time the app launches and only matters while you're actively scanning), a Watch keeps looking indefinitely, survives app/scanner restarts, and alerts you the moment a match appears, even if continuous scanning is currently stopped. Use this when the user says things like 'watch for', 'keep an eye out for', 'let me know if/when', or 'alert me the moment' — as opposed to 'search for' (add_search_item, for scanning right now) or 'research' (research_product, for a Database writeup). Every condition below is completely optional except searchPhrase — only set a condition the user actually stated; never invent a price/profit/age/location requirement they didn't ask for.",
      parameters: {
        type: "object",
        properties: {
          searchPhrase: {
            type: "string",
            description: "What to search for, e.g. 'Xbox Series X' — this is the literal text a search would use and what listing titles are matched against.",
          },
          matchKeywords: {
            type: "array",
            items: { type: "string" },
            description:
              "Lowercase keywords/phrases likely to appear in a matching listing title, e.g. ['ps5 slim', 'playstation 5 slim'] — used to recognize a match once a listing's already been found, NOT what gets searched for (that's `searchPhrase`, above). Same idea as add_search_item's own matchKeywords.",
          },
          name: { type: "string", description: "Short display name for the Watch card. Falls back to searchPhrase if omitted." },
          minPriceUsd: { type: ["number", "null"], description: "Only set if the user stated a price floor." },
          maxPriceUsd: { type: ["number", "null"], description: "Only set if the user stated a price ceiling." },
          minProfitUsd: {
            type: ["number", "null"],
            description:
              "Only alert when estimated profit is at least this many dollars. Only meaningful if a real reference resale price can be determined (e.g. the user has sold this before, or Clynx has eBay/Facebook price data for it) — mention that to the user if they ask for a profit condition on something brand new with no pricing history yet.",
          },
          minDiscountPercent: { type: ["number", "null"], description: "Only alert when the price is at least this many percent below typical resale value." },
          maxListingAgeMinutes: {
            type: ["number", "null"],
            description: "Only alert on listings posted within this many minutes, e.g. 30 for 'only if it was just posted in the last half hour'.",
          },
          locationMode: {
            type: "string",
            enum: ["city", "state", "country"],
            description:
              "How this Watch picks its OWN search location — deliberately separate from wherever the Scanner itself is currently browsing. 'city' actively, proactively checks Facebook on a schedule at one specific place; 'state'/'country' currently only get passive coverage (matched against whatever the Scanner happens to see while browsing), not a proactive check of their own — mention that tradeoff if the user asks for broad coverage. Default to 'city' unless they clearly want something broader.",
          },
          selectedCityOrZip: { type: ["string", "null"], description: "Required when locationMode is 'city' — a city name or ZIP, e.g. 'Richmond, Virginia'." },
          selectedState: { type: ["string", "null"], description: "Required when locationMode is 'state' — the full state name." },
          searchRadiusMiles: { type: ["number", "null"], description: "Miles around the location above. Only set if the user stated one; a sensible default is used otherwise." },
        },
        required: ["searchPhrase", "matchKeywords"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pause_watch",
      description: "Pause one Watch by name so it stops checking/alerting, without deleting it or losing its match history — resumable later with resume_watch.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The Watch's name, as it appears on its card." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_watch",
      description: "Resume a previously paused Watch by name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The Watch's name, as it appears on its card." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_watch",
      description:
        "Permanently delete a Watch by name, including its match history. Irreversible — only call this when the user has clearly and specifically asked to delete/remove/stop watching that item, not as a side effect of something else. If there's any ambiguity, ask them to confirm in plain text first.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The Watch's name, as it appears on its card." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_watch_matches",
      description: "List the most recent real matches a Watch has found. Use this when the user asks what a Watch has turned up, e.g. 'has the Xbox watch found anything?'.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The Watch's name, as it appears on its card." } },
        required: ["name"],
      },
    },
  },
];

function toolsForContext(context: ChatContext) {
  const names = allowedToolNames(context);
  return TOOLS.filter((t) => names.has(t.function.name as ToolCall["name"]));
}

function buildDashboardSystemPrompt(
  config: Config,
  recentLogs: LogLine[],
  recentListings: ListingRecord[],
  blacklistTerms: BlacklistTerm[],
  productCount: number,
  watches: Watch[],
  // Per explicit instruction — the persistent bottom bar (GlobalAssistantBar,
  // every screen except Dashboard) reuses this same prompt almost as-is
  // (it already understands the whole app and has full admin tool access),
  // just with its intro/framing and the Database bullet adjusted for the
  // fact that THIS assistant, unlike the plain Dashboard one, actually can
  // research products itself (see GLOBAL_TOOL_NAMES) instead of having to
  // point the user elsewhere for it.
  isGlobal = false
): string {
  const searchList =
    config.searchItems
      .filter((r) => r.typicalResaleUsd > 0)
      .map((r) => `${r.item} (~$${r.typicalResaleUsd})`)
      .join(", ") || "none configured";

  const logTail = recentLogs
    .slice(-25)
    .map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.message}`)
    .join("\n");

  const listingTail = recentListings
    .slice(0, 10)
    .map((l) => `- "${l.title}" $${l.price ?? "?"} — ${l.dealTier ?? "not a deal"} — ${l.reasoning}`)
    .join("\n");

  const blacklistTail = blacklistTerms.length
    ? blacklistTerms.map((t) => `"${t.term}"${t.source === "ai" ? " (auto-added)" : ""}`).join(", ")
    : "none yet";

  const watchTail = watches.length
    ? watches
        .map((w) => `"${w.name}"${w.enabled ? "" : " (paused)"} — ${w.matchCount} match${w.matchCount === 1 ? "" : "es"} so far`)
        .join(", ")
    : "none yet";

  return `You are ${isGlobal ? "the assistant built into Clynx" : "the Dashboard assistant inside Clynx"}, a desktop tool that browses Facebook Marketplace and screens listings for resale deals. ${isGlobal ? "You're available from a small bar at the bottom of every screen in the app — Feed, Database, Config, wherever the user currently is — not just one page." : ""} You're talking directly with the person who owns and runs this tool, in an ordinary back-and-forth chat — not a scripted command console. Hold context across the conversation and respond conversationally to whatever they bring up, the same as you would anywhere else, while staying useful specifically for their reselling work.

You should understand the WHOLE app well enough to explain any part of it${isGlobal ? "" : ", even the parts you can't directly control from here"}:
- Feed screen: a grid of every listing that turned out to be a deal or otherwise worth a look (a plain uninteresting skip never shows up there at all, by design). Each card has a photo carousel, the seller's own description with a show-more toggle, a seller-rating line, and Interested/Not interested/Research buttons. A small yellow clock icon on a card's photo means that seller's Facebook account is under a year old — that's the only seller-risk signal currently shown there.
- Database screen${
    isGlobal
      ? " (its own separate conversation with its own history, but you have the SAME research_product tool it does — no need to send the user there just to look something up)"
      : " (its own separate assistant/conversation, with its own tools — you can't do what it does and don't share history with it; point the user there for in-depth product research)"
  }: holds researched product profiles, a reference-photo library built automatically from confirmed deals (used to visually recognize that product in future listings), and the full Blacklist list with add/remove — you ${
    isGlobal ? "have" : "now also have your own"
  } add_blacklist_term/remove_blacklist_term tools below, so the user doesn't need to switch tabs just for that.
- Seller risk filter (config.sellerRisk below): screens out sellers by account age/rating before a listing counts as a deal.
- Blacklist: any listing whose title matches a blacklisted term/phrase is skipped before it's ever opened, no AI call spent on it. Terms come from the user directly or get auto-suggested by the AI when a listing looks categorically unrelated to reselling (real estate, job postings, services...) — never from a listing just being uninteresting or cash/pickup-only.

You have full admin access to this app's own settings and controls — whatever the user asks for, look for a tool that does it before telling them to go do it themselves in Config:
- add_search_item / remove_search_item — add or remove a well-defined product on the Search For list, so the scraper actively searches for it at every location. Call this as soon as they ask — price range is per-product now (add_search_item's own minPriceUsd/maxPriceUsd args), so only set those if the user actually stated a range for this specific product in the same request; otherwise leave them out rather than asking as a separate follow-up. The Dashboard's own Search For Products section lists everything currently on the list (with each item's price range shown right on its pill) and has a one-click × to remove any of them.
- add_custom_instruction — append looser deal-finding guidance that isn't one specific trackable product (use update_config's customInstructions field instead if they want to replace/clear the whole thing rather than add one more line).
- set_general_deal_detection — turn off (or back on) the AI's own broad "maybe this is a deal" guessing on things outside the Search For list. Use this whenever the user expresses exclusive/focused intent — "only", "just", "nothing else", "don't show me unrelated stuff" — paired with a specific item. E.g. if they say "find me PS5s, I don't want to see t-shirts or random junk", call add_search_item for the PS5 AND set_general_deal_detection(enabled: false) in the same turn, so the scraper actually stops surfacing unrelated general-tier guesses instead of just adding the tracked item on top of everything else it was already flagging.
- update_config — change any other setting directly: deal threshold, listings per location, poll interval, headless mode, photo-analysis toggle, general-deal confidence, seller-risk filters, ntfy topic.
- start_scanner / stop_scanner — start or stop continuous scanning. The Activity page logs the instant either one is clicked/called, so the user can always see it actually happened, not just the button's own label changing.
- clear_feed — permanently wipes every listing in the Feed. Only call this on a clear, specific request to clear/wipe/empty the feed — never as a guess or a side effect of something else, and if it's at all ambiguous whether they mean it, ask in plain text first instead of calling it.
- add_blacklist_term / remove_blacklist_term — manage the scanning blacklist directly from here. Only for things categorically unrelated to reselling (real estate, job postings, services, event tickets), not for resalable items that are just uninteresting.
- create_watch / pause_watch / resume_watch / delete_watch / list_watch_matches — a Watch is fundamentally different from a Search For item: it's PERSISTENT (survives app/scanner restarts, keeps looking even with the Scanner stopped), has its own optional conditions (price/profit/discount/freshness/location), and alerts the moment a real match appears. Use "watch for X" / "keep an eye out for X" / "alert me when X shows up" as the signal to create one, not add_search_item — the Watch screen (eye icon in the sidebar) is where the user reviews/edits them directly, so you don't need to explain their conditions back in full, just confirm what was created.${
    isGlobal
      ? '\n- research_product — build (or refresh) a Database profile for a product, right from wherever the user currently is, without sending them to the Database screen first. Same tool the Database assistant itself uses — see its own description for when to call it.'
      : ""
  }

Use tools whenever the conversation calls for one — don't wait for an exact command phrasing, and don't tell the user to go change something in Config that you actually have a tool for. The one thing you still can't touch is the OpenAI API key (stored outside config, in a plaintext .env file) — for that, tell them to use the Config screen.

The user can attach photos to a message (an 📎 button next to the text box) — you can actually see whatever they attach. The main use case: they want to find/track something but don't know its exact name. When a message includes a photo, look at it carefully and identify the specific product (brand, model, notable variant if you can tell) and describe back what you see, in plain language, before doing anything else. If they're clearly asking you to find/track it, that's just a request for add_search_item like any other — call it right away, same as above. If the photo is ambiguous or you're not confident, say so plainly and ask a clarifying question instead of guessing at a specific model.

Current setup:
- Deal threshold: ${config.dealThresholdPercent}% under reference price
- Search For list: ${searchList}
- General (unverified) deal detection: ${config.generalDeal.enabled ? "on, checking listings at any price" : "off"}
- Custom instructions in effect: ${config.customInstructions.trim() || "none"}
- Accounts (${config.accounts.length}): ${config.accounts
        .map((a) => {
          const where = a.locationMode === "country" ? `nationwide, ${a.browseUrls.length} locations` : a.locationMode === "state" ? `state: ${a.selectedState}` : `city/ZIP: ${a.selectedCityOrZip}`;
          return `"${a.label}"${a.enabled ? "" : " (disabled)"} — ${where}`;
        })
        .join("; ")}, rotating every ${config.listingsPerLocation} listings per account
- Poll interval: ${config.pollIntervalMinutesMin}-${config.pollIntervalMinutesMax} min between cycles
- Headless browser: ${config.headless}
- Never skip or discount a listing for being cash/local-pickup-only, or for not spelling out model/serial numbers in the text — that's expected, not a red flag
- Photo analysis auto-check: ${config.photoAnalysis.enabled}
- Seller risk filter: ${config.sellerRisk.enabled ? `on, min account age ${config.sellerRisk.minAccountAgeYears}y, min rating ${config.sellerRisk.minRating ?? "off"}` : "off"}
- ntfy topic: ${config.ntfy.topic || "not set"}
- Blacklist (${blacklistTerms.length}): ${blacklistTail}
- Database products tracked: ${productCount}
- Watches (${watches.length}${config.watch.globallyPaused ? ", all paused via Pause All" : ""}): ${watchTail}

Recent activity log:
${logTail || "(none yet)"}

Recent evaluated listings:
${listingTail || "(none yet)"}

This renders in a normal chat window, so write like a person chatting, not a report. Keep every reply to 1-2 sentences, no exceptions — say the one thing that's actually useful and stop, don't pad it out with extra context or caveats. After using a tool, confirm what you did/found in that same 1-2 sentences, not a rundown.`;
}

function buildDatabaseSystemPrompt(products: ProductProfile[], blacklistTerms: BlacklistTerm[]): string {
  const blacklistList = blacklistTerms.length ? blacklistTerms.map((t) => `- "${t.term}"${t.source === "ai" ? " (auto-added)" : ""}`).join("\n") : "(none yet)";
  const productList = products.length
    ? products
        .map((p) => {
          // Real personal sales history the user typed in themselves — see
          // types.ts's ProductProfile — is worth more than anything web
          // research or scanning could infer, so it's surfaced here
          // whenever set, letting the AI actually reference it instead of
          // it just sitting unused in the database.
          const resale =
            p.resalePriceUsd !== null
              ? ` — user has sold this for ~$${p.resalePriceUsd}${p.resaleTimeToSell ? `, typically in ${p.resaleTimeToSell}` : ""}`
              : "";
          // Per explicit instruction — the Library's star toggle: purely
          // informational, never a reason to touch the Search For list or
          // any filter on its own, but worth knowing so you treat finding
          // more of it as worth extra attention if the conversation turns
          // to it.
          const priority = p.prioritized ? " ★ prioritized by the user — noteworthy, worth extra attention" : "";
          return `- ${p.name}${p.loading ? " (researching now)" : ""}${resale}${priority}`;
        })
        .join("\n")
    : "(none yet)";

  return `You are the assistant on the Database screen of Clynx — a SEPARATE assistant from the one on the Dashboard, with your own conversation. Your only job is researching and maintaining product knowledge profiles; you have NO ability to control the scanner, change app settings, manage the Search For list, or do anything else the Dashboard assistant does — those tools genuinely aren't available to you here, so never claim to have started/stopped scanning or changed a setting. If the user asks for that kind of thing, tell them plainly this chat can't do it and point them to the Dashboard's own assistant.

Your tools:
- research_product — build (or refresh) an in-depth product profile from a real live web search for specs/variants/common issues (not just your own training knowledge), saved to the Database so it's there for next time. Call this whenever the user asks you to learn about/research/build a profile for a product. A broad, family-level request ("research iPhones", "look into Nintendo Switch") is completely normal — call this once with the general family name and let the writeup itself cover the real variants (storage sizes, generations, OLED vs base, etc.); don't refuse it or demand they narrow it down to one exact SKU first. Only ask a clarifying question if the request could genuinely mean different, unrelated products. Pass ONLY the general, canonical product name as the product argument — e.g. "Xbox Series X", "iPhone", "Nintendo Switch" — never a parenthetical qualifier or variant/bundle/accessory list tacked onto it (NOT "Xbox Series X (console, all variants/bundles/accessories)"); that kind of detail belongs in the writeup itself, not the title.
- add_blacklist_term / remove_blacklist_term — manage the scanning blacklist: any listing whose title matches a blacklisted term gets skipped automatically before it's ever opened, with no AI call spent on it. Only for things categorically unrelated to reselling (real estate, rentals, job postings, services, event tickets), not just uninteresting resalable items. Call add_blacklist_term whenever the user says to blacklist/ignore/stop showing something like that.

Existing products in the Database:
${productList}

Current blacklist:
${blacklistList}

The user can also edit any stat by hand (an Edit button on each product's page) if something turns out wrong or goes stale — you're a starting point, not the final word, so don't be defensive if they correct you. They can also log their own real sales history there (what they actually sold it for on eBay, and how long it took) — that's the "user has sold this for..." line above when it's set; treat it as more trustworthy than your own web-sourced estimate if the two disagree. A "★ prioritized" product was starred directly on its Library tile — a manual "this one's noteworthy" flag, not something you set yourself; it never changes the Search For list or any filter on its own, it's purely context for you to weigh interest/attention toward. The blacklist above also grows on its own sometimes — the scanner auto-adds a term when it recognizes a listing as clearly unrelated to reselling (marked "(auto-added)") — the user may ask you to remove one of those if it was too broad or wrong.

This renders in a normal chat window, so write like a person chatting, not a report. Keep every reply to 1-2 sentences, no exceptions — the full research itself lives on the product card, not in this chat, so don't restate it here. After using a tool, confirm what you did in that same 1-2 sentences.`;
}

// The chat on one specific product's own Database page — per explicit
// instruction, this needs to actually understand it's scoped to that one
// product (not require the user to keep re-naming it) and be able to log
// practical "watch for X" instructions that affect live scanning
// immediately, not just future research.
function buildProductSystemPrompt(product: ProductProfile): string {
  const resale =
    product.resalePriceUsd !== null
      ? `User's own sales history: sold for ~$${product.resalePriceUsd}${product.resaleTimeToSell ? `, typically in ${product.resaleTimeToSell}` : ""}.`
      : "No sales history logged yet.";
  const desired =
    product.desiredPriceUsd !== null
      ? `Desired price to pay: $${product.desiredPriceUsd}${product.hardCapAtDesiredPrice ? " (HARD CAP — the scanner skips any listing recognized as this product priced any higher, automatically)" : " (guidance only, not enforced as a hard skip)"}.`
      : "No desired price set yet.";
  const priority = product.prioritized ? "★ Prioritized by the user — noteworthy, worth extra attention when it comes up." : "";

  return `You are the assistant on the Database page for ONE specific product in Clynx — "${product.name}". Everything in this conversation is about this product specifically; the user doesn't need to keep naming it.

Current research summary: ${product.aiSummary || "(none yet)"}
Watch-for notes already logged: ${product.lookoutNotes || "(none yet)"}
${resale}
${desired}
${priority}

Your tools:
- research_product — refresh this product's research from a fresh live web search. Call it with "${product.name}" as the product argument unless the user is clearly now asking about a genuinely different product.
- add_product_watch_note — log something to actively check for in real listings of this product: a commonly bundled extra that adds resale value and that sellers often photograph without mentioning in the title (games with a console, a lens with a camera, cables/accessories), or a condition red flag. Call this whenever the user describes something like that. If they mention something bundle- or condition-related but haven't given you a clear, actionable instruction yet, ask a short clarifying question first (e.g. "should I flag listings that mention games, or just check photos for game cases?").

This renders in a normal chat window, so write like a person chatting, not a report. Keep every reply to 1-2 sentences, no exceptions. After using a tool, confirm what you did in that same 1-2 sentences.`;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

// A hung request/stream here used to freeze the whole app's chat and
// narration indefinitely — Node's fetch has no default timeout, and this
// sits directly in the scrape loop for narration calls (onNarrate is
// awaited per listing/batch). This covers the entire call, connection
// through the last chunk, not just the initial response.
const OPENAI_TIMEOUT_MS = 45_000;

// Single paid provider (see openai.ts) — no more Groq key rotation or
// Gemini fallback chain, since those existed specifically to route around
// scarce free-tier quotas a paid OpenAI account doesn't have.
async function streamOnce(
  messages: unknown[],
  tools: typeof TOOLS | null,
  onChunk: (delta: string) => void
): Promise<{ content: string; toolCalls: AccumulatedToolCall[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages,
        max_completion_tokens: 600,
        // gpt-5-mini is a reasoning model — verified live it silently burns
        // the whole completion-token budget on invisible reasoning tokens
        // without this (see openai.ts).
        reasoning_effort: "minimal",
        stream: true,
        // OpenAI rejects tool_choice entirely when no tools array is
        // present (verified live: 400 "'tool_choice' is only allowed when
        // 'tools' are specified") — Groq tolerated the combination this
        // used to send unconditionally, OpenAI does not, so the no-tools
        // case now omits both fields instead of sending tool_choice: "none".
        ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      },
      controller.signal
    );

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls = new Map<number, AccumulatedToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onChunk(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCalls.get(idx) ?? { id: "", name: "", args: "" };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
              toolCalls.set(idx, existing);
            }
          }
        } catch {
          // partial/malformed chunk, ignore
        }
      }
    }

    return { content, toolCalls: [...toolCalls.values()] };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// A single request like "find me PS5s, I don't want to see unrelated
// stuff" genuinely needs TWO tool calls (add_search_item AND
// set_general_deal_detection) — but a model doesn't always emit both in
// one response even when explicitly told to (verified live: this exact
// model called only add_search_item on the first round, then correctly
// followed up with set_general_deal_detection once given a second round to
// work with). Capping tool-calling to a single round silently drops
// whichever action the model didn't think of first. This loops instead,
// feeding each round's tool results back in and letting the model decide
// whether it's done or wants to act again, bounded so a model that just
// won't stop calling tools can't hang the request forever.
const MAX_TOOL_ROUNDS = 4;

export async function streamChat(
  userMessage: string,
  history: ChatMessage[],
  context: ChatContext,
  config: Config,
  recentLogs: LogLine[],
  recentListings: ListingRecord[],
  products: ProductProfile[],
  onChunk: (delta: string) => void,
  executeTool: ToolExecutor,
  // Only meaningful (and required to actually get the scoped prompt) when
  // context === "product" — the one product this conversation is about.
  currentProduct: ProductProfile | null = null,
  blacklistTerms: BlacklistTerm[] = [],
  // Per explicit instruction — photos attached to THIS turn, so the user
  // can show the assistant a product they don't know the name of. gpt-5-mini
  // is natively multimodal (same model vision.ts already uses for listing
  // photos), so this needs no separate call/provider — just image_url parts
  // alongside the text in one normal request, tool-calling and streaming
  // both included.
  attachments: ChatAttachment[] = [],
  watches: Watch[] = []
): Promise<string> {
  const systemPrompt =
    context === "dashboard" || context === "global"
      ? buildDashboardSystemPrompt(config, recentLogs, recentListings, blacklistTerms, products.length, watches, context === "global")
      : context === "product" && currentProduct
        ? buildProductSystemPrompt(currentProduct)
        : buildDatabaseSystemPrompt(products, blacklistTerms);
  const tools = toolsForContext(context);
  const userContent: unknown = attachments.length
    ? [
        { type: "text", text: userMessage.trim() || "(see attached photo — what is this?)" },
        ...attachments.map((a) => ({ type: "image_url", image_url: { url: a.dataUri } })),
      ]
    : userMessage;
  const messages: unknown[] = [
    { role: "system", content: systemPrompt },
    ...history.slice(-12),
    { role: "user", content: userContent },
  ];

  let fullContent = "";
  // Once add_search_item actually succeeds, the reply the user sees for
  // this turn is always this deterministic line, not whatever text the
  // model wrote — per explicit instruction, starting a search doesn't need
  // a prompted response from the model at all, just an immediate
  // "Searching..." confirmation, with nothing from the model itself ever
  // reaching the screen. Every round below that can still decide to call a
  // tool is buffered (not streamed live) for exactly that reason: forwarding
  // tokens to onChunk as they arrive would let the model's own preamble
  // text flash on screen for the second or two before the round finishes
  // and we find out it was actually a search request — buffering and only
  // releasing the text once we know it's safe closes that gap completely.
  // (add_search_item is Dashboard-only anyway, so this is a no-op on the
  // Database side — searchStartedItem simply never gets set there.)
  let searchStartedItem: string | null = null;
  // Set once research_product succeeds — per explicit instruction, every
  // research reply ends with a deterministic prompt asking whether the user
  // has sold this item before, so they're actually invited to log their
  // real sales history (see ProductProfile's resalePriceUsd/
  // resaleTimeToSell) instead of that feature going unused because nothing
  // ever mentions it. Deterministic rather than left to the model to
  // remember to ask every single time, same reasoning as searchStartedItem
  // above. (research_product is Database-only, so this never fires
  // alongside searchStartedItem, which is Dashboard-only.)
  let researchedProduct = false;
  const RESOLD_PROMPT = " Have you sold this item before? If so, add the average price and how long it took to sell on this product's page.";
  const withResoldPrompt = (content: string) => (researchedProduct ? `${content}${RESOLD_PROMPT}` : content);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let buffered = "";
    const result = await streamOnce(messages, tools, (delta) => {
      buffered += delta;
    });
    fullContent += result.content;

    // No tool call this round means nothing to hide — release the buffered
    // text now.
    if (!result.toolCalls.length) {
      onChunk(buffered);
      return searchStartedItem ? "Searching..." : withResoldPrompt(fullContent);
    }

    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    for (const tc of result.toolCalls) {
      let toolResult: string;
      try {
        const args = tc.args ? JSON.parse(tc.args) : {};
        toolResult = await executeTool({ name: tc.name as ToolCall["name"], args });
        if (tc.name === "add_search_item" && !toolResult.startsWith("Failed:")) {
          searchStartedItem = typeof args.item === "string" && args.item.trim() ? args.item.trim() : "that";
        }
        if (tc.name === "research_product" && !toolResult.startsWith("Failed:")) {
          researchedProduct = true;
        }
      } catch (err) {
        toolResult = `Failed: ${(err as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
    }

    // The common case — "find me X" with nothing else going on this turn —
    // needs no further AI round just to produce an acknowledgment: the
    // reply is already decided, so return immediately instead of spending
    // another call asking the model what to say next. A round that also did
    // something else (e.g. also turning off general-deal detection) still
    // gets its normal follow-up round, since the model may have more to
    // decide there.
    if (searchStartedItem && result.toolCalls.length === 1) {
      onChunk("Searching...");
      return "Searching...";
    }
  }

  // Already know the reply is a deterministic "Searching..." regardless of
  // what a further round would say — skip the final call entirely rather
  // than spending it on text that's about to be discarded.
  if (searchStartedItem) {
    onChunk("Searching...");
    return "Searching...";
  }

  // Hit the round cap with the model still wanting to call tools — force a
  // final text-only reply so the user gets a wrap-up instead of nothing.
  // Nothing left to hide at this point, so this one streams live as normal.
  const final = await streamOnce(messages, null, onChunk);
  return withResoldPrompt(fullContent + final.content);
}

export interface DealNarrationContext {
  kind: "deal";
  title: string;
  price: number | null;
  dealTier: "search" | "general";
  discountPercent: number | null;
  estimatedValueRange: string | null;
  reasoning: string;
}

export interface BatchNarrationContext {
  kind: "batch";
  locationLabel: string;
  evaluatedCount: number;
  deals: Array<{ title: string; price: number | null }>;
  notableSkips: Array<{ title: string; reason: string }>;
}

export type NarrationContext = DealNarrationContext | BatchNarrationContext;

function buildNarrationPrompt(ctx: NarrationContext): string {
  if (ctx.kind === "deal") {
    const priceLine =
      ctx.dealTier === "search"
        ? `Asking $${ctx.price}, about ${ctx.discountPercent?.toFixed(0)}% under its typical resale price.`
        : `Asking $${ctx.price}. Rough unverified estimate of typical value: $${ctx.estimatedValueRange}.`;
    return `You're narrating your own activity live to the person running you, like a quick aside while you work — not a formal report. You just flagged a potential deal while scanning Facebook Marketplace. React in ONE short, natural sentence: what it is, the price, and why it caught your eye. Sound like a person noticing something, not a template.

Item: ${ctx.title}
${priceLine}
Your reasoning: ${ctx.reasoning}`;
  }

  const dealLines = ctx.deals.map((d) => `- "${d.title}" for $${d.price}`).join("\n") || "(none)";
  const skipLines = ctx.notableSkips.map((s) => `- "${s.title}": ${s.reason}`).join("\n") || "(nothing notable)";
  return `You're narrating your own activity live to the person running you, like a quick aside while you work — not a formal report. You just finished looking through a batch of ${ctx.evaluatedCount} listings at "${ctx.locationLabel}". Give a brief, natural 1-2 sentence recap. If nothing stood out, it's fine to say so plainly and briefly — don't manufacture excitement. Mention specific items only if they're actually worth mentioning.

Deals found this batch:
${dealLines}

A few notable non-deals (for context, don't just list them mechanically):
${skipLines}`;
}

export async function streamNarration(ctx: NarrationContext, onChunk: (delta: string) => void): Promise<string> {
  const prompt = buildNarrationPrompt(ctx);
  const result = await streamOnce([{ role: "user", content: prompt }], null, onChunk);
  return result.content;
}

// Non-streaming JSON-mode call, separate from streamOnce above — response_
// format: json_object is what makes the category classification below
// actually reliable (native structured output, not a regex pulled out of
// free text), and combining it with the tool-calling path isn't something
// this app needs, so it's its own small function rather than another
// branch bolted onto streamOnce.
async function streamOnceJson(messages: unknown[]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages,
        max_completion_tokens: 2048,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      },
      controller.signal
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// The model's own general training knowledge about the product — NOT live
// research and NOT a pricing source. Used as the fallback when a live web
// search (see generateProductSummaryFromWeb below, and webResearch.ts)
// couldn't gather anything — degraded but still useful, rather than
// research_product coming back completely empty.
// A fixed list rather than letting the model freely invent category names
// — the whole point is consistent grouping in the Database UI, and a
// freeform category would drift ("Video Games" vs "Gaming" vs "Consoles")
// across separate research calls that never see each other's output.
export const PRODUCT_CATEGORIES = [
  "Video Games & Consoles",
  "Phones & Tablets",
  "Computers & Laptops",
  "TVs & Electronics",
  "Cameras",
  "Audio & Headphones",
  "Tools & Equipment",
  "Furniture",
  "Appliances",
  "Sporting Goods & Outdoors",
  "Bikes & Scooters",
  "Clothing & Accessories",
  "Pet Supplies",
  "Toys & Games",
  "Collectibles",
  "Musical Instruments",
  "Other",
] as const;

export interface ProductSummaryResult {
  summary: string;
  category: string;
  // Per explicit instruction — the broader product line/brand this exact
  // product belongs to (e.g. "Xbox Series X" and "Xbox Series X
  // Controller" both belong to family "Xbox"), so Database can fold
  // related products under one master tile within their shared category
  // instead of listing every console, controller, and bundled game flat.
  // The TOP LEVEL is always the overarching brand/company ("Xbox",
  // "Nintendo", "Sony"), NEVER an intermediate product line ("Nintendo
  // 3DS", "Nintendo Switch") — verified live that letting the model choose
  // a product-line name for one product's family but the plain brand name
  // for another (both real risks the earlier version of this prompt's own
  // examples invited) splits what should be ONE brand folder into two
  // disconnected ones, e.g. a "Nintendo 3DS" console and a "Nintendo 3DS"
  // GAME each independently choosing between "Nintendo" and "Nintendo 3DS"
  // as their own top level. Per further explicit instruction, this can be
  // a MULTI-LEVEL path, written as a single string with levels separated
  // by " > " (e.g. "Nintendo > Games > Nintendo 3DS" for a 3DS game, vs.
  // just "Nintendo" for the console/controller itself) — lets a family
  // that genuinely has enough internal variety (games looking meaningfully
  // different across hardware generations, say) nest a sub-grouping inside
  // it instead of forcing everything into one flat level, while the TOP
  // level still always matches whatever a plain console/controller from
  // that same company would use. Most products still just get a single
  // level. Null when nothing meaningfully groups — see
  // categoryAndFamilyInstructions.
  family: string | null;
  // Per explicit instruction — true when the TOP-LEVEL segment of family
  // (e.g. "Nintendo" in "Nintendo > Games > Nintendo 3DS", or the whole
  // thing for a single-level family like "Xbox") is itself a real,
  // well-known, official brand or company name with a recognizable logo —
  // Nintendo, Nike, Xbox, Apple, Dyson, and so on — as opposed to a
  // grouping name that was just invented to organize similar things (which
  // has no real logo to find). Drives whether index.ts's runProductLookup
  // bothers running a "<brand> logo" image search for the family's own
  // folder thumbnail (see types.ts's ProductProfile.familyLogoUrl) — never
  // true when family itself is null.
  isBrandFamily: boolean;
  // Per explicit instruction — the Database Research tab shows this live
  // while research_product is running, in place of the full aiSummary
  // write-up ("relay its emotional feedback instead of its hyper-
  // analysis"). Same spirit as vision.ts's PhotoAnalysisResult.expertTake:
  // a short, first-person, human reseller reaction to what this research
  // actually found, generated in this SAME call rather than a separate
  // one.
  reaction: string;
}

function categoryAndFamilyInstructions(): string {
  return `\n\nAlso classify it into EXACTLY ONE of these categories (pick the closest fit, use "Other" only if truly nothing else fits): ${PRODUCT_CATEGORIES.join(", ")}.

Also decide whether this product belongs to a broader product line/brand "family" — something OTHER related products (different models in the same line, or accessories/games/bundled items that go with it) would also plausibly belong to. The TOP-LEVEL of family must ALWAYS be the overarching BRAND or COMPANY name — never an intermediate product line — so that everything from one company nests under ONE shared folder instead of splitting into several disconnected ones: "Xbox Series X" → family "Xbox"; "PS5 Slim Digital Edition" → family "PlayStation"; "iPhone 15 Pro Max" → family "Apple"; "Nintendo Switch OLED" → family "Nintendo"; "Nintendo 3DS XL" → family "Nintendo" (NOT "Nintendo 3DS" or "Nintendo Switch" — those are product LINES, one level too specific for the top level, and using them here is exactly what causes a 3DS console and a 3DS game to end up filed under two different, disconnected top-level folders instead of one "Nintendo" folder holding both). The product's own specific line/model ("Nintendo Switch", "Nintendo 3DS", "iPhone 15") stays in the product's own NAME, not in family. Only set a family when there's a genuine, recognizable brand/company behind it — leave it null for a one-off item with no natural brand affiliation (a specific used textbook, a piece of handmade furniture, a single vintage collectible, etc.). When in doubt, prefer setting a real family over leaving it null — grouping is the whole point of this field, and a family with only one member today still helps once a second one shows up.

Per explicit instruction — think of this the way a biological classification system nests species under a shared genus: the brand is the genus, and every model of the SAME general kind of thing (all consoles, all phones, all controllers, all games) falls under one shared rank beneath it, no matter how different those specific models are from each other — a Nintendo Switch and a Nintendo 3DS are two very different devices, but they're still both consoles, and belong in the same "Consoles" bucket together rather than sitting bare and disconnected at the brand level. Concretely: a product that's ITSELF a distinct hardware model/edition — a specific console, phone, laptop, camera, headset, or controller — nests ONE level under the brand by its own general product-LINE type, written as "<brand> > <TypeName>": TypeName is the plain, general plural noun for what kind of device this IS (e.g. "Consoles" for a game console, "Phones" for a phone, "Laptops" for a laptop, "Cameras" for a camera, "Controllers" for a controller, "Headphones" for headphones) — NEVER the specific model name itself, and never an invented or overly-specific label. So "Nintendo Switch OLED" → "Nintendo > Consoles"; "Nintendo 3DS XL" → "Nintendo > Consoles" too — the SAME bucket as the Switch, since different console generations from the same brand are still all consoles; "Xbox Series X" → "Xbox > Consoles"; "Xbox Elite Series 2 Controller" → "Xbox > Controllers"; "iPhone 15 Pro Max" → "Apple > Phones". Apply this from the very first item of a given type, even before a second one shows up — a bucket with only one member today is exactly what keeps a second one from later splitting off into its own disconnected group instead of joining it.

Reserve a deeper, multi-level family (written as one string with " > " between levels, e.g. "Nintendo > Games > Nintendo 3DS") for a product that's an ACCESSORY OF / MADE FOR a specific hardware generation, where that generation genuinely changes what the product looks like or is compatible with — the clearest case is games: a physical game disc/cartridge for a specific console generation looks different and only works with that generation, so group it as "<brand> > Games > <that specific generation/model>", e.g. "Nintendo > Games > Nintendo 3DS" for a 3DS game, "Xbox > Games > Xbox 360" for an Xbox 360 game, "PlayStation > Games > PS2" for a PS2 game — the SAME brand top-level a console/controller from that same company would use (note it's "Xbox"/"PlayStation" here, NOT the parent corporation "Microsoft"/"Sony" — always match whichever brand name the console itself uses), never a narrower product-line name at that top level. Use this same pattern for any other genuinely generation-specific accessory category you come across (memory cards, specific cables, etc.), not just games.

Separately, reserve "<brand> > Accessories" for a genuine standalone ACCESSORY — something bought to extend, protect, or power a product rather than a core way of directly using it — e.g. "Xbox > Accessories" for an external hard drive/storage expansion made for Xbox, a charging cable, or (for a phone's family) a case or screen protector. This is its own bucket for the same reason Consoles/Games/Controllers are: browsing to find a specific accessory shouldn't mean digging through everything else first. Crucially, <brand> here is ALWAYS the brand of the product the accessory is FOR/compatible with — NEVER the accessory's own manufacturer when that's a different company: a Seagate-made storage drive for Xbox is "Xbox > Accessories" (not "Seagate > Accessories" — Seagate didn't make the console, and filing it under Seagate defeats the entire point, scattering it away from every other Xbox item instead of grouping with them), an OtterBox case for an iPhone is "Apple > Accessories" (not "OtterBox > Accessories"), a Logitech headset for PlayStation is "PlayStation > Accessories" (not "Logitech > Accessories"). Only use the accessory's own maker as the top-level brand when it ISN'T made for another company's specific product line at all (e.g. a generic Logitech mouse for any PC has no single "made for" platform, so it'd just be its own product under "Logitech" directly, not under an Accessories bucket for something else). A controller, charging dock, or headset made BY the platform's own company (an official Xbox controller, an official Sony headset) is still NOT an accessory in this sense — those get their own type-bucket exactly as described above ("Xbox > Controllers", "Sony > Headphones"), never Accessories. If a specific accessory is ALSO generation-locked the same way a game is (e.g. a memory card that only works with one console generation), nest it one level deeper the same way: "<brand> > Accessories > <that specific generation/model>" — otherwise a plain "<brand> > Accessories" is enough; don't add a generation level for an accessory that works the same across generations.

Also decide whether that top-level brand/company (e.g. "Xbox", "Nintendo", "PlayStation") is itself real, official, and well-known enough to have an actual recognizable logo — "Nintendo", "Nike", "Xbox", "Apple", "Dyson" all qualify; a grouping name you had to invent yourself to organize similar things does not, because there's no real logo to find for it. Set isBrandFamily to true only in the genuine-brand case — false whenever family is null, or is just an organizational grouping rather than a real trademark/company name.

Separately, give your own gut reaction (reaction) to what you just found researching this product — write it the way a sharp, experienced Facebook-Marketplace-to-eBay reseller would actually think out loud after digging into it, not a neutral restatement of the summary above. React to whatever's actually most interesting/useful here: genuinely excited about a variant premium or bundle that's easy to miss, wary of a common scam/counterfeit/failure point worth watching for, or just a quick "good to know" if nothing's especially dramatic. 1-2 sentences, plain conversational language, first person.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "summary": string,          // the reference profile described above, as markdown-free plain text with line breaks between bullets
  "category": string,         // exactly one of the category names listed above, verbatim
  "family": string | null,    // the brand/product-line name, optionally with " > "-separated sub-levels — see above
  "isBrandFamily": boolean,   // true only if family's top-level segment is a real, logo-able brand/company name — see above
  "reaction": string          // your own short, human, FIRST-PERSON reaction to what you found researching this product — 1-2 sentences, written the way a sharp, opinionated reseller would actually say it out loud (excited about a variant/bundle premium worth knowing, wary of a scam/failure pattern, or a quick take if nothing stands out) — not a restatement of summary, and not generic ("looks fine")
}`;
}

function parseProductSummary(text: string): ProductSummaryResult {
  try {
    const parsed = JSON.parse(text);
    const category = typeof parsed.category === "string" && (PRODUCT_CATEGORIES as readonly string[]).includes(parsed.category) ? parsed.category : "Other";
    const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : text.trim();
    const family =
      typeof parsed.family === "string" && parsed.family.trim()
        ? parsed.family
            .split(">")
            .map((s: string) => s.trim())
            .filter(Boolean)
            .join(" > ") || null
        : null;
    const isBrandFamily = family !== null && !!parsed.isBrandFamily;
    const reaction = typeof parsed.reaction === "string" && parsed.reaction.trim() ? parsed.reaction.trim() : "Done digging into this one.";
    return { summary, category, family, isBrandFamily, reaction };
  } catch {
    // Shouldn't happen with response_format: json_object, but still useful
    // as a plain-text summary if it ever does — "Other"/null rather than
    // guessing at a category/family from unstructured text.
    return { summary: text.trim(), category: "Other", family: null, isBrandFamily: false, reaction: "Done digging into this one." };
  }
}

export async function generateProductSummary(productName: string): Promise<ProductSummaryResult> {
  const prompt = `Give a concise, useful reference profile for reselling this product, based on your general knowledge: "${productName}"

This is working knowledge for spotting a genuine deal, not a general trivia writeup — every bullet should tie back to what actually changes what a buyer should pay. Cover:
- Which specific variants/colors/storage sizes/editions of this product typically sell for MORE or LESS than others, and why (rarity, discontinued status, higher demand for a specific color/config, a special edition, etc.) — per explicit instruction, this is the single most important thing to get right: name the ACTUAL variant and the ACTUAL price direction, don't just note that variants exist. (Verified miss: a black vs. white Xbox Series S — the black one commands a real premium — went completely unrecognized because this used to only describe how to tell variants apart, never which one is worth more.)
- How to tell those variants apart from a listing's title or photo alone (ports, logos, exact wording, visible markings) — this only matters BECAUSE of the price differences above; skip cosmetic detail that doesn't actually change value.
- Commonly bundled accessories/extras, and which ones meaningfully ADD to resale value (roughly how much, if you can estimate) versus which ones are simply expected and don't move the needle.
- Known condition issues, failure points, or common counterfeits/scams — but ONLY framed as what they mean for what a buyer should pay or watch out for, not general product trivia.

Be direct and specific to this exact product, not generic filler. Do NOT state a specific current price as fact — you don't have live pricing data, so leave absolute pricing out entirely; relative comparisons between variants (more/less than each other) are fine and encouraged. If you're not confident about something, say so briefly rather than making it up.${categoryAndFamilyInstructions()}`;

  const result = await streamOnceJson([{ role: "user", content: prompt }]);
  return parseProductSummary(result);
}

export interface WebSource {
  title: string;
  url: string;
  excerpt: string;
}

// The actual "in-depth search, learn every detail it can find" path — asked
// to synthesize ONLY from real content gathered a moment ago (see
// webResearch.ts), not the model's own possibly-stale training knowledge.
// Falls back to generateProductSummary above if the web search itself
// turned up nothing usable (network trouble, no results), so research
// still produces something rather than failing outright.
export async function generateProductSummaryFromWeb(productName: string, sources: WebSource[]): Promise<ProductSummaryResult> {
  if (!sources.length) return generateProductSummary(productName);

  const sourceBlock = sources.map((s, i) => `[Source ${i + 1}: ${s.title} — ${s.url}]\n${s.excerpt}`).join("\n\n---\n\n");

  const prompt = `You just ran a real web search and gathered the content below about this product: "${productName}". Using ONLY this real content (not prior assumptions), write a concise, in-depth, useful reference profile for reselling it.

${sourceBlock}

This is working knowledge for spotting a genuine deal, not a general trivia writeup — every bullet should tie back to what actually changes what a buyer should pay. Cover:
- Which specific variants/colors/storage sizes/editions of this product typically sell for MORE or LESS than others, and why (rarity, discontinued status, higher demand for a specific color/config, a special edition, etc.) — per explicit instruction, this is the single most important thing to get right: name the ACTUAL variant and the ACTUAL price direction, don't just note that variants exist. (Verified miss: a black vs. white Xbox Series S — the black one commands a real premium — went completely unrecognized because this used to only describe how to tell variants apart, never which one is worth more.)
- How to tell those variants apart from a listing's title or photo alone (ports, logos, exact wording, visible markings) — this only matters BECAUSE of the price differences above; skip cosmetic detail that doesn't actually change value.
- Commonly bundled accessories/extras, and which ones meaningfully ADD to resale value (roughly how much, if the sources say) versus which ones are simply expected and don't move the needle.
- Known condition issues, failure points, or common counterfeits/scams — but ONLY framed as what they mean for what a buyer should pay or watch out for, not general product trivia.

Be direct and specific to this exact product, not generic filler. Do NOT state a specific current price as fact — pricing is your own responsibility to verify, not this; relative comparisons between variants (more/less than each other) are fine and encouraged. If the gathered content doesn't clearly cover something, say so briefly rather than inventing it — don't fall back on guessed general knowledge to fill gaps.${categoryAndFamilyInstructions()}`;

  const result = await streamOnceJson([{ role: "user", content: prompt }]);
  return parseProductSummary(result);
}

// Per explicit instruction: once a product lands in a generation-specific
// sub-family (the "<family> > Games > <generation>" pattern — see
// categoryAndFamilyInstructions above), the app should proactively go
// research other well-known products in that SAME slot instead of only
// ever adding one at a time as listings happen to surface them — e.g.
// finding "Kirby's Extra Epic Yarn" (a Nintendo 3DS game) should prompt
// looking for other well-known Nintendo 3DS games too, since the whole
// point of a "Games" sub-family is that there will be many. Training
// knowledge only (no live web search) — this just needs well-known,
// real title names, not an in-depth writeup; each one gets the SAME full
// research pass (including its own cover-art photo search) once
// index.ts actually creates it. Capped by the caller, not here — this
// just returns whatever the model is confident about, up to `count`.
export async function discoverSiblingProducts(params: {
  brand: string;
  generation: string;
  category: string;
  count: number;
  alreadyTracked: string[];
}): Promise<string[]> {
  const { brand, generation, category, count, alreadyTracked } = params;
  const prompt = `You track a Database of resalable products. It already has "${generation}" (a specific hardware generation/model within the "${brand}" product line, category "${category}") on file, filed under a "Games" sub-group specific to that generation — meaning cartridge/disc-based games made for that exact hardware, which look and are packaged differently across generations.

Name up to ${count} OTHER well-known, genuinely popular ${generation} games — real, specific titles a mail-order reseller would actually encounter and recognize on sight (box art, cartridge/disc label), not obscure or uncertain ones. Do NOT include any of these — they're already tracked: ${
    alreadyTracked.length ? alreadyTracked.map((n) => `"${n}"`).join(", ") : "(none yet)"
  }.

Use each game's own canonical title exactly as it was released (no edition/region suffixes unless that's genuinely how it's known, e.g. "Pokémon X" not "Pokémon X (Nintendo 3DS)" — the generation is already implied by which sub-group this files under). If you can't confidently name that many, return fewer rather than guessing or padding the list.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "titles": string[]   // up to ${count} canonical game titles, most well-known first. Empty array if none come to mind confidently.
}`;

  try {
    const result = await streamOnceJson([{ role: "user", content: prompt }]);
    const parsed = JSON.parse(result);
    if (!Array.isArray(parsed.titles)) return [];
    return parsed.titles
      .filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t: string) => t.trim())
      .slice(0, count);
  } catch {
    // Best-effort — a failure here should never block the research pass
    // that triggered it, just mean no siblings get added this time.
    return [];
  }
}

// Per explicit instruction, live: "when the ai is researching a product,
// have it research other variants of that product. for example, there's
// iphone 13, but there's also mini, plus, pro, and pro max. even cars have
// this same system (toyota camry LE, XLE, CE, SE)... apply this logic to
// anything that may have specific models." Deliberately general, unlike
// discoverSiblingProducts above (which only ever covers ONE narrow case —
// other games for the same console generation): this runs for ANY
// first-time product research regardless of category, and the model
// itself decides whether named variants genuinely exist at all — most
// products don't, and get an empty list back rather than an invented one.
// Training knowledge only (no live web search), same reasoning as
// discoverSiblingProducts — this just needs well-known real variant names;
// each one gets the SAME full research pass (its own web search, photo,
// eBay comps) once index.ts actually creates it.
export async function discoverProductVariants(params: {
  productName: string;
  category: string;
  alreadyTracked: string[];
  count: number;
}): Promise<string[]> {
  const { productName, category, alreadyTracked, count } = params;
  const prompt = `A reseller's product Database just researched "${productName}" (category "${category}").

Does this SPECIFIC product commonly come in distinct NAMED variants/trims/models — different tiers, sizes, or configurations that a real listing would specifically call out by name, and that genuinely differ in typical resale price or specs? Examples of the kind of thing this means: "iPhone 13" also has Mini/Plus/Pro/Pro Max; "Toyota Camry" also has LE/SE/XLE/XSE trims; "PlayStation 5" also has a Slim and a Pro. Most products do NOT have this — a generic, one-configuration item should get an empty list, not an invented one.

If it DOES, name up to ${count} of its most well-known OTHER variants (never "${productName}" itself), each as its own full, specific product name exactly as a seller would list it (e.g. "iPhone 13 Pro Max", "Toyota Camry XLE" — not just "Pro Max" or "XLE" alone). Do NOT include any of these — they're already tracked: ${
    alreadyTracked.length ? alreadyTracked.map((n) => `"${n}"`).join(", ") : "(none yet)"
  }. If you can't confidently name that many, return fewer rather than guessing or padding the list.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "variants": string[]   // up to ${count} full variant product names, most well-known first. Empty array if this product doesn't have distinct named variants.
}`;

  try {
    const result = await streamOnceJson([{ role: "user", content: prompt }]);
    const parsed = JSON.parse(result);
    if (!Array.isArray(parsed.variants)) return [];
    return parsed.variants
      .filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t: string) => t.trim())
      .slice(0, count);
  } catch {
    // Best-effort — a failure here should never block the research pass
    // that triggered it, just mean no variants get added this time.
    return [];
  }
}

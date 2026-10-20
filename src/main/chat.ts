import type { BlacklistTerm, Config, ListingRecord, LogLine, ProductProfile, Watch } from "./types.js";
import { withWebActivity } from "./webEvidence.js";
import { REPLY_STYLE, CHAT_TOKENS_LONG, CHAT_TOKENS_SHORT, tightenReply, toolStatusLabel, wantsDetail, type ChatStatusEvent } from "./chatSupport.js";
import { CLYNX_PERSONA, whereYouAre } from "./clynxPersona.js";
import { CLYNX_VOICE } from "./voice.js";
import { isLowAiMode } from "./aiMode.js";
import { OPENAI_MODEL, callOpenAI, ensureOpenAIAccess } from "./openai.js";
import { describeVerdictForAi, type VariantVerdict } from "./variantEvidence.js";
import { ThinkingBudget, thoughtForFailure, thoughtForTool, thoughtFromWebLine, type ThinkingItem } from "./thinking.js";
import { actionNotRunMessage, extractCorrectionSentence, markCorrectionShown, followUpHint, isInformationalOnly, plainToolNames, promisesAction, relevantProducts, SIDE_EFFECT_TOOLS, wantsProductPicture } from "./chatIntent.js";

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
    | "add_reference_photos"
    | "find_products"
    | "web_research"
    | "research_variants"
    | "identify_from_photo"
    | "check_model_name"
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
    | "list_watch_matches"
    | "ask_choice"
    | "library_op"
    | "library_list";
  args: Record<string, unknown>;
  // What the user actually typed this turn. The model sometimes shortens a product name when it fills in a tool's arguments; tools that need the
  // user's own wording (research_product) read it from here.
  userMessage?: string;
  /** The photos attached to this turn (data URIs), for tools that look at them. */
  images?: string[];
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
  // Clynx looking something up on its own, like a person googling: every chat has it.
  "web_research",
  // Beta 13: a question with buttons, available everywhere.
  "ask_choice",
]);

const DATABASE_TOOL_NAMES = new Set<ToolCall["name"]>(["research_product", "add_reference_photos", "find_products", "web_research", "research_variants", "identify_from_photo", "check_model_name", "add_blacklist_term", "remove_blacklist_term", "ask_choice", "library_op", "library_list"]);

const PRODUCT_TOOL_NAMES = new Set<ToolCall["name"]>(["research_product", "add_reference_photos", "find_products", "web_research", "research_variants", "identify_from_photo", "check_model_name", "add_product_watch_note", "ask_choice", "library_op", "library_list"]);

// Per explicit instruction — everything Dashboard can do, plus
// research_product (Database's own product-research tool). Deliberately
// NOT add_product_watch_note — that tool only makes sense already scoped
// to one specific product's own page, which this bar never is.
const GLOBAL_TOOL_NAMES = new Set<ToolCall["name"]>([...DASHBOARD_TOOL_NAMES, "research_product", "add_reference_photos", "find_products", "research_variants", "identify_from_photo", "check_model_name", "library_op", "library_list"]);

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
      name: "ask_choice",
      description:
        "Ask the user a question with BUTTONS instead of a typed menu. Use it whenever you would otherwise write 'A) ... B) ...' or 'Which one: 1) ... 2) ...' or ask them to pick between a few concrete options. 2 to 6 short options; the user can still type their own answer. After calling it, STOP: do not write more and do not call other tools; the answer arrives as their next message. Do not use it for yes/no questions you can simply act on, and never when the user is frustrated or has already answered.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, one short sentence." },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short button text, under 40 characters." },
                detail: { type: "string", description: "Optional one-line explanation." },
                kind: { type: "string", enum: ["default", "destructive", "cancel"] },
              },
              required: ["label"],
            },
          },
          multi: { type: "boolean", description: "true only if several options may be picked together." },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "library_list",
      description: "Read the user's Library organisation: their own folders (with ids), Clynx's automatic folders (with the `key` path the folder operations take), what is in the Trash, and the recent Library actions (with ids, for undo). Use it to find an id or key before changing something. Reads only; changes nothing.",
      parameters: { type: "object", properties: { what: { type: "string", enum: ["folders", "autoFolders", "trash", "history"], description: "folders (default), autoFolders, trash or history" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "library_op",
      description:
        "Organise the user's Library: create / rename / move / delete (to the Trash) folders (the user's own folders by id, and Clynx's automatic folders by `key` with renameAutoFolder / deleteAutoFolder; setFolderThumbnail picks an existing photo as a folder picture, restoreFolderThumbnail goes back to automatic pictures, generateFolderThumbnail makes a new decorative generated picture for a folder at the user's request), move a product into a folder or back to Clynx's own filing (folderId empty), rename a product, move a product or photo to the Trash or back, set a product's first photo or thumbnail from one of its photos, or move a wrong photo to another product. Deleting always goes to the Trash for 30 days and everything can be undone from the Library. Moving or renaming NEVER changes what a product is or what it is worth. Use ids from find_products / library_list; never invent ids. Anything bulk or consequential makes the app ask the user to confirm with buttons - you do not confirm for them; just report that it is waiting. Put the fields the operation needs next to `op`.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["createFolder", "renameFolder", "moveFolder", "deleteFolder", "moveProduct", "renameProduct", "trashProduct", "restoreProduct", "removeImage", "restoreImage", "setPrimaryImage", "setThumbnail", "reassignImage", "renameAutoFolder", "deleteAutoFolder", "setFolderThumbnail", "restoreFolderThumbnail", "generateFolderThumbnail", "undo"] },
          name: { type: "string", description: "createFolder / renameFolder / renameProduct: the name." },
          id: { type: "string", description: "renameFolder / moveFolder / deleteFolder: the folder id; renameProduct / trashProduct / restoreProduct: the product id." },
          parentId: { type: "string", description: "createFolder: the parent folder id (empty = top level). moveFolder: the new parent id (empty = top level)." },
          productId: { type: "string", description: "moveProduct / setPrimaryImage / setThumbnail: the product id." },
          folderId: { type: "string", description: "moveProduct: the destination folder id (empty = back to where Clynx files it)." },
          imageId: { type: "string", description: "removeImage / restoreImage / setPrimaryImage / setThumbnail / reassignImage: the photo id (setThumbnail: empty clears it)." },
          toProductId: { type: "string", description: "reassignImage: the product the photo really belongs to." },
          deleteContents: { type: "boolean", description: "deleteFolder / deleteAutoFolder: true sends everything inside to the Trash too (asks the user first); default moves it up a level." },
          key: { type: "string", description: "renameAutoFolder / deleteAutoFolder / setFolderThumbnail / restoreFolderThumbnail / generateFolderThumbnail: the path of one of Clynx's own automatic folders exactly as library_list(what=autoFolders) gives it, e.g. 'Video Games & Consoles > Nintendo > Consoles'." },
          opId: { type: "string", description: "undo: the id of the action to undo (library_list what=history)." },
        },
        required: ["op"],
      },
    },
  },
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
          includeBroken: {
            type: "boolean",
            description: "true = ALSO look for broken / for-parts / not-working copies of this product and price them as their own Database variant (they often resell well). Only set it when the user asks for broken or for-parts items.",
          },
          acceptVariants: {
            type: "boolean",
            description: "true = also accept the product family's own variants among the listings Facebook returns for this search (iPhone 15 -> 15 Plus / Pro / Pro Max). It adds no extra searches. Only set it when the user asks to include variants of the product.",
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
      name: "web_research",
      description:
        "Look something up on the web yourself, the way a person would with a search engine: you get back the text of the top few pages to read and then explain in your own words. Use it whenever facts matter and you're not sure or they may have changed: specs and model differences, common faults and what to check before buying, rough going rates and what sells, scam patterns, how an eBay or Marketplace rule works, whether something is worth flipping. You can call it more than once (e.g. one search per product you're comparing). It does NOT save anything to the Database and doesn't touch any app setting; use research_product when the user wants a profile saved. Don't use it for questions about the app itself (you already know how it works) or for chit-chat.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to search for, worded like a search-engine query, e.g. 'Xbox Series S common problems buying used', 'PS5 Slim disc vs digital resale value', 'iPhone 13 battery health what to check before buying'. For a specific edition, color, capacity or bundle, give the full product name as the user said it: the tool goes on to search the product line, the manufacturer's site and alternate spellings by itself, and reports VERIFIED / SUPPORTED / UNVERIFIED / DISPROVEN. Never treat an empty exact-title search as proof a product does not exist.",
          },
          url: {
            type: "string",
            description: "A web page the user gave you (a product or retailer link): it is opened and read first. Always pass a link the user pasted instead of saying you cannot open it.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "research_product",
      description:
        "Build (or refresh) a persistent Database profile for a product — a writeup Clynx writes from a real live web search, plus a reference photo, saved so it's there for next time instead of re-researched from scratch. Use this whenever the user asks you to learn about, research, or build a profile for a product, or when a conversation makes clear they're seriously interested in one you don't already have solid info on. A broad, family-level request (\"research iPhones\", \"look into Nintendo Switch\") is normal and should NOT be refused or narrowed down — call this once with the general family name, and the writeup itself is expected to cover the real variants within it (storage sizes, generations, OLED vs base, etc.), same as one product having multiple sub-models in real life. Only ask a clarifying question if the request could mean genuinely different, unrelated products (not just \"which variant of the same thing\"). This is separate from add_search_item (which starts actively searching Facebook Marketplace for it) — call both if the user wants both.",
      parameters: {
        type: "object",
        properties: {
          product: {
            type: "string",
            description:
              "The product name, e.g. 'Xbox Series X', 'iPhone', 'Nintendo Switch'. For ONE specific edition, color, capacity or bundle the user named, give its full name exactly as they said it ('Xbox Series X 2TB Galaxy Black Special Edition'): it is checked against manufacturer and retailer evidence first and filed as its own entry linked to the general product, never merged into it. Never append a parenthetical qualifier or a variant/bundle/accessory list — NOT \"Xbox Series X (console, all variants/bundles/accessories)\". A broad family name is fine and expected when that's what the user asked about — this is the Database entry's title, not a place to hedge about which SKU it covers.",
          },
          url: {
            type: "string",
            description: "A web page the user gave about this product (a manufacturer or retailer link): it is read as evidence. Pass any link the user pasted.",
          },
        },
        required: ["product"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_reference_photos",
      description:
        "Find more reference photos of a product already in the Database and save them to it, right now. It searches official/retailer shots AND real-world photos of actual units, downloads each candidate, drops duplicates and checks every photo is really this product before saving it, so only verified, new photos are kept. Use it whenever the user asks for more photos, pictures, images or references of a product (\"find more reference photos\", \"get more pictures of this\", \"similar to the thumbnail\"). Call it immediately with defaults: do not ask which kind of photos, how many, or from where. It never replaces a thumbnail the user chose and never exceeds the gallery limit. The result says how many photos were really saved: relay that number exactly.",
      parameters: {
        type: "object",
        properties: {
          product: { type: "string", description: "The Database product's name. Omit to use the product the user currently has open (the right choice whenever they say \"this\", \"it\" or \"the thumbnail\")." },
          count: { type: "number", description: "How many more photos to look for. Omit for the default (8); only set it if the user gave a number." },
          searchPhrase: { type: "string", description: "Extra words to search images for, only if the user gave them (for example the query inside a Google Images link they pasted)." },
          url: { type: "string", description: "A search-results link the user pasted (Google Images, Bing...): its search words are used as the image search." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_model_name",
      description:
        "Check whether a product name a seller used is a real model by reading the maker's own lineup (for example 'NVIDIA GeForce RTX 4080 Ti' or 'iPhone 15 Pro Plus'). Only a lineup actually read can say a name is NOT in it, and the real models it lists are offered as alternatives. When no official page can be read the answer is 'unverified', which is not 'fake'. Use it when a listing or the user names a model that may not exist, before pricing it.",
      parameters: { type: "object", properties: { name: { type: "string", description: "The model name as the seller wrote it." } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "identify_from_photo",
      description:
        "Work out exactly which product, model and special edition is in the photo(s) the user attached to THIS message. It describes what is visible (colours, artwork, shape, features), searches the web for editions that match, and rules candidates out only on what the photos show. Use it when the user attaches a picture and asks what it is, which edition or version it is, or wants it researched from the picture. The result says what is established, what is not, and how confident it is. When it says it is UNSURE, do not guess: ask the user with ask_choice (the candidates it names as options) or ask for a clearer photo (back, label, serial number, the side with the model text). Photos cannot prove a unit is a genuine factory edition; never claim that.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "What the user called it, if they did (e.g. 'new 3ds xl'). Optional." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "research_variants",
      description:
        "Research a product line's variants on the web the way a person would: which storage sizes it really comes in, which look-alike models are a DIFFERENT product (e.g. Meta Quest 3 vs Quest 3S, 128GB vs 512GB), and every SPECIAL EDITION the sources name (e.g. the Pikachu, Hyrule or Galaxy editions of a New Nintendo 3DS XL), each labelled confirmed or reported with where it was found. Pass `edition` to check one the user names ('SNES', 'Galaxy'). If nothing is found it says why (search blocked, not mentioned in the pages read); relay that exactly. Use this when the user asks about variants, editions, special editions, colours or versions. The answer is remembered, so later price checks and photo filing use it. Use it when you or the user are unsure whether two listings or Database entries are the same product, or when a product has several sizes or editions. It saves nothing to the product's profile; research_product does that.",
      parameters: {
        type: "object",
        properties: {
          product: { type: "string", description: "The product line, e.g. 'Meta Quest 3 128GB'." },
          edition: { type: "string", description: "A specific special edition or variant the user named, e.g. 'SNES' or 'Galaxy'. It is looked for by name in the sources." },
          refresh: { type: "boolean", description: "True to look again even if it was researched recently." },
        },
        required: ["product"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_products",
      description:
        "Look up products in the user's Database by name: returns the best matches with their status and value. The chat only lists the open product and a few related ones, so use this whenever you need to know whether the Database has some other product, or which entries exist for a family or edition.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Words from the product's name, e.g. 'galaxy black xbox'." } },
        required: ["query"],
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
        "Add a term/phrase to the scanning blacklist — any listing whose title contains it gets skipped automatically, before it's ever opened or scored, with no further credits spent on it. Only for things categorically unrelated to a mail-order resale business — real estate (a house/apartment for sale OR rent), job postings, service offerings, event tickets, personals — NOT for resalable items that are just uninteresting (that's a different, separate mechanism). Call this whenever the user says to blacklist/ignore/stop showing something like that. Keep the term general enough to catch the whole category, not just one exact listing's wording.",
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
        "Turn general (unverified) deal flagging on or off — Clynx's own broad guessing at whether ANY listing looks underpriced, independent of the Search For list. Never call it merely because the user added or asked to search for a product: general discovery and the Search For list work side by side by default. Turn this OFF only when the user explicitly says they want the scraper focused only on specific item(s) they're tracking and nothing else — e.g. 'I only want PS5s, don't show me anything unrelated', 'just focus on what I asked for', 'stop flagging random stuff'. Turn it back ON if they later say they want to see other possible deals again.",
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
          ebayNetPercent: { type: "number", description: "What the user keeps of an eBay sale, as a % of the sold price (default 84, after eBay's ~13.75% cut)" },
          minProfitMarginPercent: { type: "number", description: "How much of the money kept from reselling a purchase must be profit for it to count as a deal (default 20)" },
          listingsPerLocation: { type: "number", description: "How many listings to evaluate at one location before rotating to the next" },
          pollIntervalMinutesMin: { type: "number", description: "Shortest wait between scanner passes, in minutes (0 = no wait)" },
          pollIntervalMinutesMax: { type: "number", description: "Longest wait between scanner passes, in minutes" },
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
          alsoWatchFor: {
            type: "array",
            items: { type: "string" },
            description:
              "Facebook Watches only: other products the SAME Watch should also look out for (each a short product name, e.g. ['PS5', 'Nintendo Switch']). A Facebook Watch waits for any of its products to turn up; only list ones the user actually named.",
          },
          checkIntervalMinutes: {
            type: ["number", "null"],
            description: "Facebook Watches only: how often to check, in minutes (5, 10, 15, 30, 60, 120 or 240; other numbers are rounded to the nearest). Only set if the user said how often; 15 is used otherwise.",
          },
          platform: {
            type: "string",
            enum: ["facebook", "ebay"],
            description:
              "Which marketplace this Watch looks on. Default to 'facebook' unless the user says eBay. An 'ebay' Watch has no location (eBay is searched nationwide) — leave locationMode, selectedCityOrZip, selectedState and searchRadiusMiles out for it.",
          },
          minSellerRatingPercent: {
            type: ["number", "null"],
            description: "eBay Watches only: skip sellers whose positive-feedback rating is below this percent (0-100), e.g. 98. Only set if the user stated one.",
          },
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
              "How this Watch picks its OWN search location — deliberately separate from wherever the Scanner itself is currently browsing. 'city' (a ZIP code or city) searches Facebook around one specific place; 'state' searches the state's biggest cities; 'country' searches a spread of cities across the US. All three are actively checked on a schedule. Default to 'city' unless they clearly want something broader.",
          },
          selectedCityOrZip: { type: ["string", "null"], description: "Required when locationMode is 'city' — a city name or ZIP, e.g. 'Richmond, Virginia'." },
          selectedState: { type: ["string", "null"], description: "Required when locationMode is 'state' — the full state name." },
          searchRadiusMiles: { type: ["number", "null"], description: "Miles around the ZIP/city (locationMode 'city' only; state and country Watches use a fixed radius). Facebook only offers 1, 2, 5, 10, 20, 40, 60, 80, 100, 250 or 500 miles, so any other number is rounded to the nearest of those. Only set if the user stated one; 20 is used otherwise." },
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

export function toolsForContext(context: ChatContext) {
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
        .map((w) => `"${w.name}" (${w.platform === "ebay" ? "eBay" : "Facebook"})${w.enabled ? "" : " (paused)"} — ${w.matchCount} match${w.matchCount === 1 ? "" : "es"} so far`)
        .join(", ")
    : "none yet";

  return `${CLYNX_PERSONA}

${whereYouAre(isGlobal ? "global" : "dashboard")} It's an ordinary back-and-forth chat with the person who owns and runs you, not a command console: keep the thread of the conversation and respond to whatever they bring up, whether that's a reselling question, a listing they found, or a setting they want changed.

Two extra things about the app that matter when you act:
- The Database has its own separate conversation (the Discovery tab) with its own history${
    isGlobal
      ? ", but you have the same research_product tool it does, so there's no need to send the user there just to save a product"
      : "; you can't do what it does and don't share its history, so point the user there when they want a product researched and saved"
  }. You also have add_blacklist_term/remove_blacklist_term here, so they don't need to switch tabs for that.
- The seller risk filter (shown in the setup below) screens sellers by account age/rating before a listing counts as a deal; the Blacklist skips any listing whose title matches a term before it's even opened (terms come from the user, or are auto-added when a listing is clearly unrelated to reselling: real estate, jobs, services; never just because a listing is uninteresting or cash/pickup-only).

You have full admin access to this app's own settings and controls. Whatever the user asks you to change, look for a tool that does it before telling them to go do it themselves in Config. When they ask you something instead (what should I flip, is this a good price, how does X work), just answer like the expert you are, and use web_research when you'd otherwise be guessing at facts that matter. Your tools:
- add_search_item / remove_search_item — add or remove a well-defined product on the Search For list, so the scraper actively searches for it at every location. Call this as soon as they ask — price range is per-product now (add_search_item's own minPriceUsd/maxPriceUsd args), so only set those if the user actually stated a range for this specific product in the same request; otherwise leave them out rather than asking as a separate follow-up. The Dashboard's own Search For Products section lists everything currently on the list (with each item's price range shown right on its pill) and has a one-click × to remove any of them.
- add_custom_instruction — append looser deal-finding guidance that isn't one specific trackable product (use update_config's customInstructions field instead if they want to replace/clear the whole thing rather than add one more line).
- set_general_deal_detection — turn off (or back on) Clynx's own broad "maybe this is a deal" guessing on things outside the Search For list. Use this ONLY when the user explicitly asks to turn general/other-deal detection off or back on, or says in so many words that they want ONLY the Search For items. Adding or searching for a product is NOT such a request: leave it on, general discovery and the Search For list work side by side. When they do say it, use it whenever the user expresses exclusive/focused intent — "only", "just", "nothing else", "don't show me unrelated stuff" — paired with a specific item. E.g. if they say "find me PS5s, I don't want to see t-shirts or random junk", call add_search_item for the PS5 AND set_general_deal_detection(enabled: false) in the same turn, so the scraper actually stops surfacing unrelated general-tier guesses instead of just adding the tracked item on top of everything else it was already flagging.
- update_config — change any other setting directly: deal threshold, listings per location, poll interval, headless mode, photo-analysis toggle, general-deal confidence, seller-risk filters, ntfy topic.
- start_scanner / stop_scanner — start or stop continuous scanning. The Activity page logs the instant either one is clicked/called, so the user can always see it actually happened, not just the button's own label changing.
- clear_feed — permanently wipes every listing in the Feed. Only call this on a clear, specific request to clear/wipe/empty the feed — never as a guess or a side effect of something else, and if it's at all ambiguous whether they mean it, ask in plain text first instead of calling it.
- add_blacklist_term / remove_blacklist_term — manage the scanning blacklist directly from here. Only for things categorically unrelated to reselling (real estate, job postings, services, event tickets), not for resalable items that are just uninteresting.
- create_watch / pause_watch / resume_watch / delete_watch / list_watch_matches — a Watch is fundamentally different from a Search For item: it's PERSISTENT (survives app/scanner restarts, keeps looking even with the Scanner stopped), has its own optional conditions (price/profit/discount/freshness/location), and alerts the moment a real match appears. Use "watch for X" / "keep an eye out for X" / "alert me when X shows up" as the signal to create one, not add_search_item — the Watch screen (eye icon in the sidebar) is where the user reviews/edits them directly, so you don't need to explain their conditions back in full, just confirm what was created.${
    isGlobal
      ? '\n- research_product — build (or refresh) a Database profile for a product, right from wherever the user currently is, without sending them to the Database screen first. Same tool the Database assistant itself uses — see its own description for when to call it.\n- add_reference_photos / find_products — find and save more verified reference photos for a Database product (call it at once when asked, no questions), and look products up by name. Same tools as the Database assistant.'
      : ""
  }

Use tools whenever the conversation calls for one — don't wait for an exact command phrasing, and don't tell the user to go change something in Config that you actually have a tool for. The one thing you still can't touch is the OpenAI API key (stored outside config, in a plaintext .env file) — for that, tell them to use the Config screen.

The user can attach photos to a message (an 📎 button next to the text box) — you can actually see whatever they attach. The main use case: they want to find/track something but don't know its exact name. When a message includes a photo, look at it carefully and identify the specific product (brand, model, notable variant if you can tell) and describe back what you see, in plain language, before doing anything else. If they're clearly asking you to find/track it, that's just a request for add_search_item like any other — call it right away, same as above. If they want to know exactly which model or special edition it is, call identify_from_photo. If the photo is ambiguous or you're not confident, say so plainly and ask with ask_choice (or for a clearer photo) instead of guessing at a specific model. This applies to anything you are very unsure about, not only photos: never present a guess as fact.

Current setup:
- Deal threshold: ${config.dealThresholdPercent}% under reference price
- Resale math: the user keeps ${config.ebayNetPercent}% of what an eBay buyer pays in total (item + shipping); a listing is a deal when buying it leaves at least ${config.minProfitMarginPercent}% of that as profit, and listings that would need more than ${config.maxNegotiationPercent ?? 15}% off the asking price to get there are skipped
- Linked eBay store: ${config.ebayStoreUsername?.trim() ? config.ebayStoreUsername.trim() : "not linked"}
- Search For list: ${searchList}
- General (unverified) deal detection: ${config.generalDeal.enabled ? "on, checking listings at any price" : "off"}
- Custom instructions in effect: ${config.customInstructions.trim() || "none"}
- Accounts (${config.accounts.length}): ${config.accounts
        .map((a) => {
          const where = a.locationMode === "country" ? `nationwide, ${a.browseUrls.length} locations` : a.locationMode === "state" ? `state: ${a.selectedState}` : `city/ZIP: ${a.selectedCityOrZip}`;
          return `"${a.label}"${a.enabled ? "" : " (disabled)"} — ${where}`;
        })
        .join("; ")}, rotating every ${config.listingsPerLocation} listings per account
- The scanner has no wait between cycles: it starts the next pass as soon as one finishes
- Wait between scanner passes: ${config.pollIntervalMinutesMin}-${config.pollIntervalMinutesMax} min (0 = no wait; the Dashboard has a Skip wait button)
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

This renders in a normal chat window, so write like a person chatting, not a report, and stay in character as Clynx. After you use a tool, say what you did in a line or two in your own words (e.g. "Got it, I'll hunt for Series S under $250 next time I scan" beats "Added to Search For list"; only after a tool result says it happened, and never after a greeting or a plain question), and mention anything the tool result says they still need to do (like starting the scanner).`;
}

function buildDatabaseSystemPrompt(
  products: ProductProfile[],
  blacklistTerms: BlacklistTerm[],
  focus: ProductProfile | null = null,
  // lean: list only the products relevant to this message (the open product with its parent/variants, starred ones, name matches) instead of the whole Database
  lean: { message: string; history: ChatMessage[] } | null = null
): string {
  const shown = lean ? relevantProducts(products, lean.message, lean.history, focus) : products;
  const blacklistList = blacklistTerms.length ? blacklistTerms.map((t) => `- "${t.term}"${t.source === "ai" ? " (auto-added)" : ""}`).join("\n") : "(none yet)";
  const productList = shown.length
    ? shown
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
          const status = p.variantEvidence ? ` [variant ${p.variantEvidence.status}${p.parentProductId ? `, a version of "${products.find((x) => x.id === p.parentProductId)?.name ?? "another entry"}"` : ""}]` : p.parentProductId ? ` [a version of "${products.find((x) => x.id === p.parentProductId)?.name ?? "another entry"}"]` : "";
          const claims = p.variantClaims.length ? ` [claims checked, not added: ${p.variantClaims.slice(0, 3).map((c) => `"${c.claim}" ${c.status}`).join("; ")}]` : "";
          return `- ${p.name}${p.loading ? " (researching now)" : ""}${status}${claims}${resale}${priority}`;
        })
        .join("\n")
    : "(none yet)";

  const attachNote = "They may attach photos or the text of files (receipts, spec sheets, notes) to learn about a product, even one that isn't in the Database yet: read them carefully, say what you can tell from them, and use research_product when they want it looked into.";
  const focusSection = focus
    ? `The user has "${focus.name}" selected in the feed, so unless they clearly mean something else, their questions are about it. What the Database knows about it:
${productFactLines(focus)}
If they name a more specific version of it (an edition, color, capacity, bundle or regional model, like "xbox series x galaxy"), they mean that version, which is a separate product: research it by its full name instead of refreshing "${focus.name}".
${attachNote}

`
    : `${attachNote}

`;

  return `${CLYNX_PERSONA}

${whereYouAre("database")} This chat has its own conversation and its own tools, separate from the Clynx chat on the Activity screen and the bubble on other screens. From here your job is product knowledge: talking products through with the user, researching them, saving profiles and maintaining the blacklist. You genuinely can't start or stop the scanner, change settings or manage the Search For list from this chat (those tools aren't available here), so never claim you did. If they ask for that kind of thing, say so plainly and point them to the Clynx bubble or the Activity chat.

Your tools:
- web_research — look something up on the web yourself, like a person with a search engine, and explain what you found in your own words. Use it for questions and opinions ("is the Series S worth flipping?", "what breaks on these?"); it doesn't save anything.
- research_product — build (or refresh) an in-depth product profile from a real live web search for specs/variants/common issues (not just your own training knowledge), saved to the Database so it's there for next time. Call this whenever the user asks you to learn about/research/build a profile for a product. A broad, family-level request ("research iPhones", "look into Nintendo Switch") is completely normal — call this once with the general family name and let the writeup itself cover the real variants (storage sizes, generations, OLED vs base, etc.); don't refuse it or demand they narrow it down to one exact SKU first. Only ask a clarifying question if the request could genuinely mean different, unrelated products. Pass the product the user asked about, in their words. A family-level request gets the general name ("Xbox Series X", "iPhone", "Nintendo Switch"). A request for ONE specific edition, color, capacity, bundle or regional model gets its FULL name exactly as they said it ("Xbox Series X Galaxy", "Xbox Series X 2TB Galaxy Black Special Edition", "iPhone 15 Pro 256GB Natural Titanium"): that is a different product from the general one, and the app checks it against manufacturer and retailer evidence and files it as its own entry linked to the general one. So NEVER shorten a named version to its parent, NEVER ask whether to "keep it under the main entry" or "flag it as a separate variant" (the app does that itself), and NEVER ask whether it is "official" or an aftermarket custom first: call the tool right away and report what it says. NEVER ask the user what to focus on or how to write the profile up first: the profile covers everything, so call the tool with their exact words and offer follow-ups afterwards. If the tool says it needs their choice or could not place the phrase, ask them exactly that. A parenthetical qualifier or a list tacked onto a general name is still wrong (NOT "Xbox Series X (console, all variants/bundles/accessories)").
- add_reference_photos — find more reference photos of a product and save them to it right now (official/retailer shots and real-world photos of actual units, each verified as this product, no duplicates, never replacing a thumbnail the user chose). Call it the moment the user asks for more photos, pictures or references, with no questions: it defaults to the product they have open. Relay the number of photos it says it saved, exactly.
- find_products — look up products in the Database by name when you need one that is not in the short list below.
- add_blacklist_term / remove_blacklist_term — manage the scanning blacklist: any listing whose title matches a blacklisted term gets skipped automatically before it's ever opened, with no credits spent on it. Only for things categorically unrelated to reselling (real estate, rentals, job postings, services, event tickets), not just uninteresting resalable items. Call add_blacklist_term whenever the user says to blacklist/ignore/stop showing something like that.

${focusSection}${lean ? `The Database has ${products.length} products. The ones relevant to this conversation (look up any other with find_products):` : "Existing products in the Database:"}
${productList}

Current blacklist:
${blacklistList}

The user can also edit any stat by hand (an Edit button on each product's page) if something turns out wrong or goes stale — you're a starting point, not the final word, so don't be defensive if they correct you. They can also log their own real sales history there (what they actually sold it for on eBay, and how long it took) — that's the "user has sold this for..." line above when it's set; treat it as more trustworthy than your own web-sourced estimate if the two disagree. A "★ prioritized" product was starred directly on its Library tile — a manual "this one's noteworthy" flag, not something you set yourself; it never changes the Search For list or any filter on its own, it's purely context for you to weigh interest/attention toward. The blacklist above also grows on its own sometimes — the scanner auto-adds a term when it recognizes a listing as clearly unrelated to reselling (marked "(auto-added)") — the user may ask you to remove one of those if it was too broad or wrong.

This renders in a normal chat window, so write like a person chatting, not a report, and stay in character as Clynx. When you've researched and saved a product the full writeup lives on its card, so don't paste it here: tell them what stood out in a couple of lines. After using a tool, say what you did in your own words.`;
}

// What the Database knows about one product, as prompt lines: shared by the product page's chat and the Discovery tab's
// chat when a product is open there.
function productFactLines(product: ProductProfile): string {
  const resale =
    product.resalePriceUsd !== null
      ? `User's own sales history: sold for ~$${product.resalePriceUsd}${product.resaleTimeToSell ? `, typically in ${product.resaleTimeToSell}` : ""}.`
      : "No sales history logged yet.";
  const desired =
    product.desiredPriceUsd !== null
      ? `Desired price to pay: $${product.desiredPriceUsd}${product.hardCapAtDesiredPrice ? " (HARD CAP — the scanner skips any listing recognized as this product priced any higher, automatically)" : " (guidance only, not enforced as a hard skip)"}.`
      : "No desired price set yet.";
  const priority = product.prioritized ? "★ Prioritized by the user — noteworthy, worth extra attention when it comes up." : "";

  // What the Database already knows about its eBay value (what the buyer pays in total: sold item price + shipping).
  const money = (n: number) => `$${Math.round(n)}`;
  const shipping = Math.max(0, product.ebayAvgShippingUsd ?? 0);
  const soldTotal = product.ebayAvgSoldPriceUsd !== null && (product.ebayCompsSampleSize ?? 0) > 0 ? product.ebayAvgSoldPriceUsd + shipping : null;
  const ebayValue =
    product.ebayEstimatedValueUsd !== null || soldTotal !== null
      ? `eBay value in the Database: about ${money(product.ebayEstimatedValueUsd ?? (soldTotal as number))} (what a buyer pays in total)${soldTotal !== null ? `; sold average ${money(soldTotal)} from ${product.ebayCompsSampleSize} sale${product.ebayCompsSampleSize === 1 ? "" : "s"}` : ""}${
          product.ebayActiveMedianUsd !== null ? `; asking median ${money(product.ebayActiveMedianUsd)} from ${product.ebayActiveSampleSize ?? 0} listing${product.ebayActiveSampleSize === 1 ? "" : "s"}` : ""
        }${product.ebayAvgRunTimeDays !== null ? `; sells in about ${product.ebayAvgRunTimeDays < 1 ? "under a day" : `${product.ebayAvgRunTimeDays.toFixed(1)} days`}` : ""}.`
      : "No eBay value researched for it yet.";
  const store = product.myStore ? `The user's own eBay store (${product.myStore.seller}) lists it for about ${money(product.myStore.medianUsd)}.` : "";
  const evidence = product.variantEvidence ? `Variant evidence on file (earlier research; keep consistent with it unless new evidence): ${product.variantEvidence.status.toUpperCase()}, ${product.variantEvidence.basis}` : "";
  const claims = product.variantClaims.length
    ? `Variant claims checked earlier that were NOT added as products:\n${product.variantClaims.map((c) => `- "${c.claim}": ${c.status.toUpperCase()}. ${c.basis}`).join("\n")}`
    : "";
  return `Current research summary: ${product.aiSummary || "(none yet)"}
${evidence}
${claims}
Watch-for notes already logged: ${product.lookoutNotes || "(none yet)"}
${ebayValue}
${store}
${resale}
${desired}
${priority}`;
}

// The chat on one specific product's own Database page — per explicit
// instruction, this needs to actually understand it's scoped to that one
// product (not require the user to keep re-naming it) and be able to log
// practical "watch for X" instructions that affect live scanning
// immediately, not just future research.
function buildProductSystemPrompt(product: ProductProfile): string {
  const facts = productFactLines(product);

  return `${CLYNX_PERSONA}

${whereYouAre("product", product.name)} This chat has its own conversation and tools: from here you can talk about this product, look things up, refresh its research and log watch-for notes. You can't start/stop the scanner or change settings from this chat; if they ask, say so and point them to the Clynx bubble or the Activity chat.

${facts}

Your tools:
- web_research — look something up on the web yourself, like a person with a search engine, and explain what you found in your own words (specs, faults, what it really sells for, what to check). It doesn't save anything.
- research_product — refresh this product's research from a fresh live web search. Call it with "${product.name}" as the product argument to refresh this product. If the user names a more specific version of it (an edition, color, capacity, bundle or regional model) or a different product, pass THAT full name exactly as they said it: a specific version is its own product (checked against evidence and filed under this one), so never shorten it back to "${product.name}".
- add_reference_photos — find more reference photos of THIS product and save them to it right now (verified, no duplicates, never replacing a thumbnail the user chose). Call it the moment they ask for more photos or pictures, with no questions; relay the number it says was saved.
- find_products — look up other products in the Database by name.
- add_product_watch_note — log something to actively check for in real listings of this product: a commonly bundled extra that adds resale value and that sellers often photograph without mentioning in the title (games with a console, a lens with a camera, cables/accessories), or a condition red flag. Call this whenever the user describes something like that. If they mention something bundle- or condition-related but haven't given you a clear, actionable instruction yet, ask a short clarifying question first (e.g. "should I flag listings that mention games, or just check photos for game cases?").

This renders in a normal chat window, so write like a person chatting, not a report, and stay in character as Clynx. After using a tool, say what you did in your own words.`;
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
  onChunk: (delta: string) => void,
  effort: "minimal" | "low" | "medium" | "high" = "minimal",
  opts: { signal?: AbortSignal; maxTokens?: number } = {}
): Promise<{ content: string; toolCalls: AccumulatedToolCall[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  // "Stop" from the person aborts the same request; it is reported as a stop, not as a timeout.
  const onStop = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onStop, { once: true });
  }

  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages,
        max_completion_tokens: opts.maxTokens ?? 900,
        // gpt-5-mini is a reasoning model — verified live it silently burns
        // the whole completion-token budget on invisible reasoning tokens
        // without this (see openai.ts).
        reasoning_effort: effort,
        stream: true,
        // OpenAI rejects tool_choice entirely when no tools array is
        // present (verified live: 400 "'tool_choice' is only allowed when
        // 'tools' are specified") — Groq tolerated the combination this
        // used to send unconditionally, OpenAI does not, so the no-tools
        // case now omits both fields instead of sending tool_choice: "none".
        ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      },
      controller.signal, "chat");

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
      if (opts.signal?.aborted) throw new ChatStopped();
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onStop);
  }
}

/** Thrown inside a chat turn when the person pressed Stop. */
export class ChatStopped extends Error {
  constructor() {
    super("Stopped.");
    this.name = "ChatStopped";
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

/** What the window needs from a chat turn besides the text: real progress, a way to stop it, and the style switches (Beta 13). */
export interface ChatHooks {
  signal?: AbortSignal;
  onStatus?: (e: Omit<ChatStatusEvent, "requestId">) => void;
  replyStyle?: boolean;
  /** Said to the model so it tells the user about attachments that could not be used (never silently dropped). */
  notice?: string;
  /** Shrinks an attached photo to a small thumbnail for the thinking block (null when it cannot). Injected so this file stays free of the image library. */
  thumbnail?: (dataUri: string) => Promise<string | null>;
}

/** Timing and decisions of one chat turn: what each model round and each tool cost, and which safeguards stepped in. Filled in by streamChat when given one. */
export interface ChatTrace {
  rounds: Array<{ round: number; ms: number; firstWordMs: number | null; promptChars: number; toolCalls: number }>;
  tools: Array<{ name: string; ms: number; parallel: boolean }>;
  totalMs: number;
  aiCalls: number;
  /** Safeguards that acted: "follow-up-hint", "frustration", "thumbnail", "promise-guard". */
  guards: string[];
}

// Tools that only read, or that touch one product's photos: several of them in one round run at the same time instead of one after another.
/** Whether the person is asking about versions of a product: its special or limited editions, variants, colours. */
export function asksAboutVariants(message: string): boolean {
  return /\b(variants?|special editions?|limited editions?|editions?|versions? of)\b/i.test(message || "");
}

const PARALLEL_SAFE_TOOLS = new Set<string>(["web_research", "find_products", "add_reference_photos"]);

type EffortSetting = "minimal" | "low" | "medium" | "high";
function chatEffort(config: Config): EffortSetting {
  const v = (config as { chatFlags?: { reasoningEffort?: string } }).chatFlags?.reasoningEffort ?? process.env.CLYNX_CHAT_REASONING ?? "minimal";
  return v === "low" || v === "medium" || v === "high" ? v : "minimal";
}

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
  watches: Watch[] = [],
  trace?: ChatTrace,
  hooks: ChatHooks = {}
): Promise<string> {
  const turnStart = Date.now();
  // Feature flags (config.json "chatFlags"): every improvement below is on unless explicitly set to false, so any one can be switched off without a new build.
  const flagsRaw = (config as { chatFlags?: { followUpHints?: boolean; promiseGuard?: boolean; leanContext?: boolean; thumbnail?: boolean; parallelTools?: boolean } }).chatFlags ?? {};
  const flags = {
    followUpHints: flagsRaw.followUpHints !== false,
    promiseGuard: flagsRaw.promiseGuard !== false,
    leanContext: flagsRaw.leanContext !== false,
    thumbnail: flagsRaw.thumbnail !== false,
    parallelTools: flagsRaw.parallelTools !== false,
  };
  const guards: string[] = [];
  const systemPrompt =
    context === "dashboard" || context === "global"
      ? buildDashboardSystemPrompt(config, recentLogs, recentListings, blacklistTerms, products.length, watches, context === "global")
      : context === "product" && currentProduct
        ? buildProductSystemPrompt(currentProduct)
        : buildDatabaseSystemPrompt(products, blacklistTerms, currentProduct, flags.leanContext ? { message: userMessage, history } : null);
  const tools = toolsForContext(context);
  const shortStyle = hooks.replyStyle === true && !wantsDetail(userMessage);
  const styledSystemPrompt = shortStyle ? `${systemPrompt}\n\n${REPLY_STYLE}` : systemPrompt;
  const stopCheck = () => {
    if (hooks.signal?.aborted) throw new ChatStopped();
  };

  // Short answers ("both", "yes", "do it", "the first one") and repeated or frustrated instructions are read in code, not left to the model to infer.
  const hint = flags.followUpHints ? followUpHint(userMessage, history) : null;
  if (hint) guards.push(/repeating|frustrated/.test(hint) ? "frustration" : "follow-up-hint");

  // The open product's picture goes along only when the message is about how it looks (one small image, low detail), so the model can see "the thumbnail".
  const thumb = currentProduct?.imageUrl && currentProduct.imageUrl.startsWith("data:image") ? currentProduct.imageUrl : null;
  const sendThumb = flags.thumbnail && !!thumb && attachments.length === 0 && wantsProductPicture(userMessage);
  if (sendThumb) guards.push("thumbnail");
  const userContent: unknown =
    attachments.length || sendThumb
      ? [
          { type: "text", text: userMessage.trim() || "(see attached photo — what is this?)" },
          ...(sendThumb ? [{ type: "text", text: `(The attached picture is the thumbnail of "${currentProduct!.name}", the product the user has open.)` }, { type: "image_url", image_url: { url: thumb, detail: "low" } }] : []),
          ...attachments.map((a) => ({ type: "image_url", image_url: { url: a.dataUri } })),
        ]
      : userMessage;
  const messages: unknown[] = [
    { role: "system", content: styledSystemPrompt },
    ...(hooks.notice ? [{ role: "system", content: hooks.notice }] : []),
    ...history.slice(-12),
    ...(hint ? [{ role: "system", content: hint }] : []),
    { role: "user", content: userContent },
  ];

  let fullContent = "";
  // add_search_item used to be answered with a fixed "Searching..." line, from when adding an item started a search right away.
  // Adding only queues it now (the scanner picks it up on its next pass), and Clynx confirms in its own words using what the
  // tool result says. Everything the model says is streamed live, including a lead-in before a tool call ("Let me dig into
  // that."), so it reads like a person thinking out loud; text from separate rounds is separated by a blank line.
  let roundNo = 0;
  const streamRound = async (roundTools: typeof tools | null) => {
    stopCheck();
    const needsGap = fullContent.length > 0;
    let started = false;
    const roundStart = Date.now();
    let firstWordMs: number | null = null;
    // "Thinking" is a real step: it lasts from the request until the first word (or the tool call) arrives. No reasoning text is ever shown.
    const thinkId = `think-${roundNo + 1}`;
    let thinkOpen = true;
    hooks.onStatus?.({ stepId: thinkId, kind: "model", label: roundNo === 0 ? "Thinking" : "Working it out", state: "start", startedAt: roundStart });
    const closeThink = (ok: boolean, detail?: string) => {
      if (!thinkOpen) return;
      thinkOpen = false;
      hooks.onStatus?.({ stepId: thinkId, kind: "model", label: roundNo === 0 ? "Thinking" : "Working it out", state: "end", startedAt: roundStart, ok, detail });
    };
    let result: Awaited<ReturnType<typeof streamOnce>>;
    try {
      result = await streamOnce(
        messages,
        roundTools,
        (delta) => {
          if (!started) {
            if (!delta.trim()) return;
            started = true;
            firstWordMs = Date.now() - roundStart;
            closeThink(true);
            if (needsGap) onChunk("\n\n");
          }
          onChunk(delta);
        },
        chatEffort(config),
        { signal: hooks.signal, maxTokens: shortStyle ? CHAT_TOKENS_SHORT : CHAT_TOKENS_LONG }
      );
    } catch (err) {
      closeThink(false, (err as Error).message);
      throw err;
    }
    closeThink(true);
    trace?.rounds.push({ round: ++roundNo, ms: Date.now() - roundStart, firstWordMs, promptChars: JSON.stringify(messages).length, toolCalls: result.toolCalls.length });
    const text = result.content.trim();
    if (text) fullContent += (fullContent ? "\n\n" : "") + text;
    return result;
  };
  // After a NEW product is researched, the reply ends by inviting the user to log their own sales history (see ProductProfile's resalePriceUsd/resaleTimeToSell).
  // It is asked once per conversation, never mid-task (a follow-up answer, a repeated or frustrated instruction), never for a product whose sales are already
  // logged, and never after other tools: otherwise it is noise on every reply.
  let researchedNewProduct = false;
  let toolsRunThisTurn = 0;
  const RESOLD_PROMPT = " By the way, have you sold one of these before? If you add what it went for and how long it took on this product's page, I'll use it to judge deals better.";
  const alreadyAskedResold = history.some((m) => m.role === "assistant" && /have you sold one of these before/i.test(m.content));
  const withResoldPrompt = (content: string) =>
    researchedNewProduct && !alreadyAskedResold && !hint && currentProduct?.resalePriceUsd == null ? `${content}${RESOLD_PROMPT}` : content;
  const finish = (content: string) => {
    if (trace) {
      trace.totalMs = Date.now() - turnStart;
      trace.aiCalls = trace.rounds.length;
      trace.guards = guards;
    }
    // "Done" with nothing done: no tool ran this turn, so the opener is a false claim (Beta 28 live test: "Done — I started a quick general scan..." after a hello)
    const honest = toolsRunThisTurn === 0 ? content.replace(/^\s*Done\b[\s,.:—–-]*/i, "") : content;
    return withResoldPrompt(plainToolNames(shortStyle ? tightenReply(honest) : honest));
  };
  // A greeting or a pure question must not run anything that changes the app (Beta 28 live test: a hello started the scanner, a question wrote a watch note).
  const informationalTurn = isInformationalOnly(userMessage);
  // Clynx's narrated thinking: code-authored facts (a tool started, a page was read, a photo was attached), at most a few per turn, small and without anything personal (thinking.ts).
  const thinking = new ThinkingBudget();
  let thinkingNo = 0;
  const emitThinking = (item: ThinkingItem | null) => {
    const clean = thinking.admit(item);
    if (!clean) return;
    hooks.onStatus?.({ stepId: `think-item-${++thinkingNo}`, kind: "thinking", label: clean.text ?? clean.title ?? "", state: "end", startedAt: Date.now(), ok: true, item: clean });
  };
  let promiseGuardUsed = false;
  let variantsGuardUsed = false;
  const toolNamesRun = new Set<string>();

  // The photos the person attached are the first things Clynx looks at: a small thumbnail of each (never the full picture), so the thinking block shows what it is going on.
  if (attachments.length > 0 && hooks.thumbnail) {
    emitThinking({ type: "thought", text: attachments.length === 1 ? "I'm looking at the photo you sent." : `I'm looking at the ${attachments.length} photos you sent.` });
    for (const a of attachments.slice(0, 6)) {
      const thumbnail = await hooks.thumbnail(a.dataUri).catch(() => null);
      if (thumbnail) emitThinking({ type: "image", thumbnail, text: String(a.name ?? "").slice(0, 60) });
    }
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const lenBefore = fullContent.length;
    const result = await streamRound(tools);

    // No tool call this round: that was the answer, unless it PROMISED an action that no tool performed. A promise with nothing behind it is the failure
    // this guards against: one more round, told to call the tool now or say plainly that it cannot.
    if (!result.toolCalls.length) {
      // Asked about editions or variants but nothing was searched: the answer would come from memory or an old saved profile, and a model will even claim it "refreshed" it.
      if (!variantsGuardUsed && !toolNamesRun.has("research_variants") && asksAboutVariants(userMessage) && tools.some((t: any) => t?.function?.name === "research_variants")) {
        variantsGuardUsed = true;
        guards.push("variants-guard");
        fullContent = fullContent.slice(0, lenBefore);
        messages.push({ role: "assistant", content: result.content });
        messages.push({
          role: "system",
          content: "The user asked about variants or special editions, and the variants research has not been run this turn (a product refresh is not that), so do not answer from memory or from an older saved profile. Call research_variants NOW with the product being discussed (use the product from the conversation or the open product; pass `edition` if they named one). Do not ask first. Report only what the tool returns.",
        });
        continue;
      }
      if (flags.promiseGuard && !promiseGuardUsed && tools.length > 0 && toolsRunThisTurn === 0 && promisesAction(result.content)) {
        promiseGuardUsed = true;
        guards.push("promise-guard");
        fullContent = fullContent.slice(0, lenBefore);
        messages.push({ role: "assistant", content: result.content });
        messages.push({
          role: "system",
          content:
            "You just said you would do something but called no tool, so nothing happened. Call the right tool NOW with sensible defaults, without asking the user anything. If no tool can do it, say so in one plain sentence and say what you can do instead. Do not promise again.",
        });
        continue;
      }
      if (promiseGuardUsed && toolsRunThisTurn === 0 && promisesAction(result.content)) fullContent += " (I haven't actually run anything yet.)";
      return finish(fullContent);
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

    const runOne = async (tc: { id: string; name: string; args: string }, parallel: boolean): Promise<{ id: string; content: string }> => {
      stopCheck();
      const started = Date.now();
      let toolResult: string;
      let label = toolStatusLabel(tc.name, {});
      try {
        const args = tc.args ? JSON.parse(tc.args) : {};
        label = toolStatusLabel(tc.name, args);
        if (informationalTurn && SIDE_EFFECT_TOOLS.has(tc.name)) {
          guards.push("question-not-action");
          trace?.tools.push({ name: `${tc.name} (refused: question)`, ms: 0, parallel });
          return { id: tc.id, content: actionNotRunMessage(tc.name) };
        }
        hooks.onStatus?.({ stepId: tc.id || `${tc.name}-${started}`, kind: "tool", label, state: "start", startedAt: started });
        const stepBase = tc.id || `${tc.name}-${started}`;
        let activityNo = 0;
        const startThought = thoughtForTool(tc.name, args);
        if (startThought) emitThinking({ type: "thought", text: startThought });
        toolResult = await withWebActivity(
          (line, ok, item) => {
            hooks.onStatus?.({ stepId: `${stepBase}:a${++activityNo}`, kind: "notice", label: line, state: "end", startedAt: Date.now(), ok });
            // a page that was really read becomes a page item; every other line (a search, a refusal) is a thought
            emitThinking(item ?? thoughtFromWebLine(line, ok));
          },
          () => executeTool({ name: tc.name as ToolCall["name"], args, userMessage, images: attachments.map((a) => a.dataUri) })
        );
        if (tc.name === "research_product" && /^Started researching|^Added|new entry/.test(toolResult) && !toolResult.startsWith("Failed:")) researchedNewProduct = true;
        // "I read X as Y": the app says it itself, right away, so it is shown whatever the model writes next
        const understood = tc.name === "research_product" ? extractCorrectionSentence(toolResult) : null;
        if (understood && !fullContent.includes(understood)) {
          onChunk(`${fullContent ? "\n\n" : ""}${understood}`);
          fullContent += `${fullContent ? "\n\n" : ""}${understood}`;
          toolResult = markCorrectionShown(toolResult);
        }
      } catch (err) {
        toolResult = `Failed: ${(err as Error).message}`;
      }
      if (toolResult.startsWith("Failed:")) emitThinking({ type: "thought", text: thoughtForFailure(tc.name) });
      hooks.onStatus?.({ stepId: tc.id || `${tc.name}-${started}`, kind: "tool", label, state: "end", startedAt: started, ok: !toolResult.startsWith("Failed:"), detail: toolResult.startsWith("Failed:") ? toolResult.slice(0, 160) : undefined });
      toolsRunThisTurn++;
      toolNamesRun.add(tc.name);
      trace?.tools.push({ name: tc.name, ms: Date.now() - started, parallel });
      return { id: tc.id, content: toolResult };
    };
    // Independent tools in one round run at the same time (a web search and a Database lookup need not wait for each other); everything that changes settings,
    // the scanner or the Search For list keeps its order.
    const safe = flags.parallelTools ? result.toolCalls.filter((tc) => PARALLEL_SAFE_TOOLS.has(tc.name)) : [];
    const parallelRun = safe.length > 1 ? Promise.all(safe.map((tc) => runOne(tc, true))) : null;
    const answers = new Map<string, string>();
    for (const tc of result.toolCalls) {
      if (parallelRun && safe.includes(tc)) continue;
      const r = await runOne(tc, false);
      answers.set(r.id, r.content);
    }
    if (parallelRun) for (const r of await parallelRun) answers.set(r.id, r.content);
    for (const tc of result.toolCalls) messages.push({ role: "tool", tool_call_id: tc.id, content: answers.get(tc.id) ?? "Failed: no result" });
    // A question with buttons ends the turn: the answer arrives as the person's next message, so the model must not keep talking or acting.
    if (result.toolCalls.some((tc) => (tc.name === "ask_choice" || tc.name === "library_op") && /^(Presented|Waiting)/.test(answers.get(tc.id) ?? ""))) return finish(fullContent);
  }

  // Hit the round cap with the model still wanting to call tools — force a
  // final text-only reply so the user gets a wrap-up instead of nothing.
  await streamRound(null);
  return finish(fullContent);
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
    return `${CLYNX_VOICE}

You're narrating your own activity live to the person running you, like a quick aside while you work — not a formal report. You just flagged a potential deal while scanning Facebook Marketplace. React in ONE short, natural sentence: what it is, the price, and why it caught your eye. Sound like a person noticing something, not a template.

Item: ${ctx.title}
${priceLine}
Your reasoning: ${ctx.reasoning}`;
  }

  const dealLines = ctx.deals.map((d) => `- "${d.title}" for $${d.price}`).join("\n") || "(none)";
  const skipLines = ctx.notableSkips.map((s) => `- "${s.title}": ${s.reason}`).join("\n") || "(nothing notable)";
  return `${CLYNX_VOICE}

You're narrating your own activity live to the person running you, like a quick aside while you work — not a formal report. You just finished looking through a batch of ${ctx.evaluatedCount} listings at "${ctx.locationLabel}". Give a brief, natural 1-2 sentence recap. If nothing stood out, it's fine to say so plainly and briefly — don't manufacture excitement. Mention specific items only if they're actually worth mentioning.

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
      controller.signal, "chat");
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

/** What the writeup may and may not say about a specific edition / configuration, given what the evidence check found. */
export function variantEvidenceInstructions(verdict: VariantVerdict): string {
  return `${describeVerdictForAi(verdict)}
Start the summary with one plain line, "Variant status: ${verdict.status}" followed by where the evidence came from (or that none was found). Never describe an unverified product as fake, custom or seller-invented. Keep this product's facts (capacity, color, edition, what is included) separate from the standard model's: do not give the standard model's price or specs as this product's. If the sources do not state something about this exact version, say it is not confirmed.`;
}

export async function generateProductSummary(productName: string, verdict: VariantVerdict | null = null): Promise<ProductSummaryResult> {
  const prompt = `Give a concise, useful reference profile for reselling this product, based on your general knowledge: "${productName}"

This is working knowledge for spotting a genuine deal, not a general trivia writeup — every bullet should tie back to what actually changes what a buyer should pay. Cover:
- Which specific variants/colors/storage sizes/editions of this product typically sell for MORE or LESS than others, and why (rarity, discontinued status, higher demand for a specific color/config, a special edition, etc.) — per explicit instruction, this is the single most important thing to get right: name the ACTUAL variant and the ACTUAL price direction, don't just note that variants exist. (Verified miss: a black vs. white Xbox Series S — the black one commands a real premium — went completely unrecognized because this used to only describe how to tell variants apart, never which one is worth more.)
- How to tell those variants apart from a listing's title or photo alone (ports, logos, exact wording, visible markings) — this only matters BECAUSE of the price differences above; skip cosmetic detail that doesn't actually change value.
- Commonly bundled accessories/extras, and which ones meaningfully ADD to resale value (roughly how much, if you can estimate) versus which ones are simply expected and don't move the needle.
- Known condition issues, failure points, or common counterfeits/scams — but ONLY framed as what they mean for what a buyer should pay or watch out for, not general product trivia.

Be direct and specific to this exact product, not generic filler. Do NOT state a specific current price as fact — you don't have live pricing data, so leave absolute pricing out entirely; relative comparisons between variants (more/less than each other) are fine and encouraged. If you're not confident about something, say so briefly rather than making it up. Not recognizing a product name is not evidence it does not exist: editions, colors and capacities you have not heard of are common, so never call a product fake or non-existent from your own memory.${verdict ? `\n\n${variantEvidenceInstructions(verdict)}` : ""}${categoryAndFamilyInstructions()}`;

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
export async function generateProductSummaryFromWeb(productName: string, sources: WebSource[], verdict: VariantVerdict | null = null): Promise<ProductSummaryResult> {
  if (!sources.length) return generateProductSummary(productName, verdict);

  const sourceBlock = sources.map((s, i) => `[Source ${i + 1}: ${s.title} — ${s.url}]\n${s.excerpt}`).join("\n\n---\n\n");
  const evidenceBlock = verdict ? `\n\n${variantEvidenceInstructions(verdict)}` : "";

  const prompt = `You just ran a real web search and gathered the content below about this product: "${productName}". Using ONLY this real content (not prior assumptions), write a concise, in-depth, useful reference profile for reselling it.

${sourceBlock}${evidenceBlock}

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
  if (isLowAiMode()) return []; // auto-creating five more researched products per product: not worth credits
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
  if (isLowAiMode()) return [];
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

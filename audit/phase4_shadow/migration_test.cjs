var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// audit/phase4_shadow/migration_test.ts
var import_node_crypto4 = require("node:crypto");
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");
var import_node_sqlite2 = require("node:sqlite");

// src/main/identity/foundationStore.ts
var import_node_crypto2 = require("node:crypto");

// src/main/identity/words.ts
var NOISE_WORDS = new Set(
  "a an the and or with for of in on to at by from is it its this that these those used like works working work great good excellent condition open box boxed original genuine authentic official oem free shipping ship fast tested clean mint barely very nice lightly gently only no not as are was be you your our sale sold lot bundle set pack usa us fully functional functioning perfect edition gen generation".split(" ")
);

// src/main/identity/resolver.ts
var CAPACITY = /\b(\d+(?:\.\d+)?)\s*-?\s*(tb|gb|mb)\b/g;
function identityTokens(text, optional) {
  let s = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]s\b/g, "");
  const capacities = /* @__PURE__ */ new Set();
  s = s.replace(CAPACITY, (_m, n, unit) => {
    capacities.add(`${n.replace(".", "p")}${unit}`);
    return " ";
  });
  s = s.replace(/(\d)\.(\d)/g, "$1p$2").replace(/(\w)\s*\+(?![a-z0-9])/g, "$1 plus ").replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1");
  const words = /* @__PURE__ */ new Set();
  for (const whole of s.split(/[^a-z0-9]+/)) {
    if (!whole || NOISE_WORDS.has(whole)) continue;
    for (const w of whole.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2").split(" ")) {
      if (w && !optional?.has(w)) words.add(w);
    }
  }
  return { words, capacities };
}
function looksLikeAbbreviation(short, long) {
  if (short === long || short.length < 2 || long.length < short.length + 2) return false;
  if (!/^[a-z]+$/.test(short) || !/^[a-z]+$/.test(long)) return false;
  if (short[0] !== long[0]) return false;
  let at = 0;
  for (const ch of short) {
    at = long.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}
function compareIdentity(a, b, optional) {
  const A = identityTokens(a, optional);
  const B = identityTokens(b, optional);
  const reasons = [];
  const onlyInA = [...A.words].filter((w) => !B.words.has(w));
  const onlyInB = [...B.words].filter((w) => !A.words.has(w));
  const capA = [...A.capacities];
  const capB = [...B.capacities];
  let capacity = "none";
  if (capA.length && capB.length) capacity = capA.some((c) => B.capacities.has(c)) ? "equal" : "conflict";
  else if (capA.length) capacity = "a-only";
  else if (capB.length) capacity = "b-only";
  const aliasPairs = [];
  const restA = [...onlyInA];
  const restB = [...onlyInB];
  for (const x of [...restA]) {
    const j = restB.findIndex((y) => looksLikeAbbreviation(x, y) || looksLikeAbbreviation(y, x));
    if (j >= 0) {
      aliasPairs.push([x, restB[j]]);
      restA.splice(restA.indexOf(x), 1);
      restB.splice(j, 1);
    }
  }
  if (aliasPairs.length > 0 && (restA.length > 0 || restB.length > 0)) {
    aliasPairs.length = 0;
    restA.splice(0, restA.length, ...onlyInA);
    restB.splice(0, restB.length, ...onlyInB);
  }
  if (capacity === "conflict") reasons.push(`capacity differs (${capA.join("/")} vs ${capB.join("/")})`);
  if (restA.length && restB.length) {
    reasons.push(`each states something the other does not (${restA.join(" ")} | ${restB.join(" ")})`);
    return { level: "different", moreSpecific: null, aliasPairs, onlyInA: restA, onlyInB: restB, capacity, reasons };
  }
  if (capacity === "conflict") return { level: "different", moreSpecific: null, aliasPairs, onlyInA: restA, onlyInB: restB, capacity, reasons };
  const aExtra = restA.length > 0 || capacity === "a-only";
  const bExtra = restB.length > 0 || capacity === "b-only";
  if (aExtra && bExtra) {
    reasons.push("each is more specific than the other in a different way");
    return { level: "different", moreSpecific: null, aliasPairs, onlyInA: restA, onlyInB: restB, capacity, reasons };
  }
  if (aExtra || bExtra) {
    const side = aExtra ? "a" : "b";
    reasons.push(`${side === "a" ? "first" : "second"} also states: ${[...aExtra ? restA : restB, ...capacity === `${side}-only` ? [side === "a" ? capA[0] : capB[0]] : []].join(" ")}`);
    return { level: "line", moreSpecific: side, aliasPairs, onlyInA: restA, onlyInB: restB, capacity, reasons };
  }
  if (aliasPairs.length) {
    reasons.push(`equal only if ${aliasPairs.map(([x, y]) => `"${x}" means "${y}"`).join(", ")}`);
    return { level: "possible-alias", moreSpecific: null, aliasPairs, onlyInA: [], onlyInB: [], capacity, reasons };
  }
  return { level: "exact", moreSpecific: null, aliasPairs, onlyInA: [], onlyInB: [], capacity, reasons };
}

// src/main/identity/codes.ts
var CAPACITY2 = /^\d+(?:p\d+)?(?:tb|gb|mb)$/;
var YEAR = /^(?:19|20)\d\d$/;
function normalize(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/(\d)\.(\d)/g, "$1p$2").replace(/(\d)\s*[-]?\s*(tb|gb|mb|hz|mah|mm|ah|v)\b/g, "$1$2");
}
function rawTokens(text) {
  return normalize(text).split(/[^a-z0-9]+/).filter(Boolean);
}
var NOT_AN_IDENTIFIER = /^(?:\d+(?:st|nd|rd|th)|\d{1,2}(?:am|pm)|\d+x|\d{8,})$/;
function withoutAmounts(text) {
  return text.replace(/\$\s*\d[\d,.]*/g, " ").replace(/\d[\d,.]*\s*(?:dollars?|usd|bucks|%|percent)/gi, " ");
}
function definingCodes(text) {
  const out = [];
  for (const t of rawTokens(withoutAmounts(text))) {
    if (!/\d/.test(t)) continue;
    if (CAPACITY2.test(t) || YEAR.test(t) || NOT_AN_IDENTIFIER.test(t)) continue;
    const mixed = /[a-z]/.test(t);
    if (!mixed && t.length < 3) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
function presentIn(tokens2, wanted) {
  return tokens2.some((tok) => {
    for (let at = tok.indexOf(wanted); at !== -1; at = tok.indexOf(wanted, at + 1)) {
      if (!/\d/.test(tok[at - 1] ?? "") && !/\d/.test(tok[at + wanted.length] ?? "")) return true;
    }
    return false;
  });
}
function sameCode(a, b) {
  if (a === b) return true;
  const runs = (c) => c.match(/\d+/g) ?? [];
  const ra = runs(a);
  const rb = runs(b);
  const longestA = ra.sort((x, y) => y.length - x.length)[0];
  const longestB = rb.sort((x, y) => y.length - x.length)[0];
  return !!longestA && longestA === longestB && longestA.length >= 3;
}
function codesMissingFrom(reference, candidate) {
  const refTokens = rawTokens(reference);
  return definingCodes(candidate).filter((c) => !presentIn(refTokens, c) && !definingCodes(reference).some((r) => sameCode(r, c)));
}
function aliasCovered(code, entryName) {
  const m = /^([a-z]{2,4})(\d+)$/.exec(code);
  if (!m) return false;
  const tokens2 = rawTokens(entryName);
  return tokens2.includes(m[2]) && tokens2.some((t) => /^[a-z]+$/.test(t) && looksLikeAbbreviation(m[1], t));
}

// src/main/identity/credibility.ts
var key = (c) => c;
var runKey = (c) => {
  const runs = (c.match(/\d+/g) ?? []).sort((a, b) => b.length - a.length);
  return runs[0] && runs[0].length >= 3 ? `#${runs[0]}` : null;
};
var CodeIndex = class {
  byCode = /* @__PURE__ */ new Map();
  docs;
  constructor(docs) {
    this.docs = docs;
    docs.forEach((d, i) => {
      for (const c of definingCodes(d.text)) {
        for (const k of [key(c), runKey(c)]) {
          if (!k) continue;
          const list = this.byCode.get(k);
          if (list) {
            if (list[list.length - 1] !== i) list.push(i);
          } else this.byCode.set(k, [i]);
        }
      }
    });
  }
  docsWith(code) {
    const ids = /* @__PURE__ */ new Set([...this.byCode.get(key(code)) ?? [], ...runKey(code) ? this.byCode.get(runKey(code)) ?? [] : []]);
    return [...ids].map((i) => this.docs[i]);
  }
};
var NO_CODES = { credible: [], unverified: [], dismissed: [] };
var norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function mentionsProductOnly(doc, productWords, code) {
  const lower = doc.toLowerCase();
  const segments = [];
  for (const m of lower.matchAll(/[(\[]([^)\]]*)[)\]]/g)) segments.push(m[1]);
  const after = /\b(?:for|with|compatible with|fits?|includes?|plus)\b(.*)$/.exec(lower);
  if (after) segments.push(after[1]);
  for (const seg of segments) {
    const words = identityTokens(seg).words;
    const holdsProduct = [...productWords].some((w) => !/^\d+$/.test(w) && words.has(w)) || productWords.size > 0 && [...productWords].every((w) => words.has(w));
    const codeInside = definingCodes(seg).some((c) => c === code);
    if (holdsProduct && !codeInside) return true;
  }
  return false;
}
function assessCodes(args) {
  const raw = codesMissingFrom(args.entryName, args.title);
  if (raw.length === 0) return NO_CODES;
  const out = { credible: [], unverified: [], dismissed: [] };
  const productWords = identityTokens(args.entryName).words;
  const distinctive = [...productWords].filter((w) => !/^\d+$/.test(w));
  const ownTitle = norm(args.title);
  const ownOrigins = /* @__PURE__ */ new Set([`title:${ownTitle}`, ...args.seller ? [`seller:${args.seller.toLowerCase()}`] : [], ...args.entryId ? [`product:${args.entryId}`] : []]);
  for (const code of raw) {
    if (aliasCovered(code, args.entryName)) {
      out.dismissed.push({ code, reason: "short-form-of-the-name" });
      continue;
    }
    const vouched = (args.independentTexts ?? []).filter((t) => definingCodes(t).some((c) => c === code || c.length >= 4 && c.includes(code)) && (distinctive.length === 0 || distinctive.some((w) => identityTokens(t).words.has(w))));
    if (vouched.length > 0) {
      out.credible.push({ code, reason: "photo-analysis", support: vouched.slice(0, 2) });
      continue;
    }
    const docs = args.index.docsWith(code).filter((d) => {
      if (d.kind !== "product" && norm(d.text) === ownTitle || ownOrigins.has(d.origin)) return false;
      const words = identityTokens(d.text).words;
      if (distinctive.length > 0 && !distinctive.some((w) => words.has(w))) return false;
      return !mentionsProductOnly(d.text, productWords, code);
    });
    const known = docs.filter((d) => d.kind === "product");
    const sibling = known.find((d) => {
      const words = identityTokens(d.text).words;
      return [...productWords].every((w) => words.has(w));
    });
    if (sibling) {
      out.credible.push({ code, reason: "narrower-sibling", support: [sibling.text], siblingName: sibling.text });
      continue;
    }
    if (known.length > 0) {
      out.credible.push({ code, reason: "related-product", support: [known[0].text] });
      continue;
    }
    const origins = new Set(docs.map((d) => d.origin));
    if (origins.size >= 2) {
      out.credible.push({ code, reason: "seen-in-multiple-sources", support: docs.slice(0, 3).map((d) => d.text) });
      continue;
    }
    const anyDoc = args.index.docsWith(code).some((d) => (d.kind === "product" || norm(d.text) !== ownTitle) && !ownOrigins.has(d.origin));
    out.unverified.push({ code, reason: docs.length === 1 ? "single-sighting" : anyDoc ? "only-mentions-the-product" : "no-evidence" });
  }
  return out;
}

// src/main/identity/foundation.ts
var import_node_crypto = require("node:crypto");
var IDENTITY_VERSION = 1;
var sha = (s) => (0, import_node_crypto.createHash)("sha1").update(s).digest("hex").slice(0, 16);
function splitHost(name) {
  const m = /[(\[]([^)\]]+)[)\]]/.exec(name);
  if (!m) return { subject: name, host: null };
  return { subject: (name.slice(0, m.index) + " " + name.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(), host: m[1].trim() };
}
function hashInputs(name, filedTitles) {
  return sha(`${IDENTITY_VERSION}|${name}|${[...filedTitles].sort().join("|")}`);
}
function buildProductIdentity(args) {
  const { subject, host } = splitHost(args.name);
  const tokens2 = identityTokens(subject);
  const codes = definingCodes(subject);
  const corroborated = args.corroborated ?? [];
  const attributes = [];
  for (const c of codes) {
    const proven = corroborated.some((x) => x.code === c);
    attributes.push({ kind: "code", value: c, source: "name", confidence: proven ? 0.9 : 0.7, weight: "likely-defining" });
  }
  for (const w of tokens2.words) {
    if (codes.includes(w) || NOISE_WORDS.has(w)) continue;
    if (/^\d+$/.test(w)) attributes.push({ kind: "number", value: w, source: "name", confidence: 0.55, weight: "likely-defining" });
    else attributes.push({ kind: "word", value: w, source: "name", confidence: 0.6, weight: "unknown" });
  }
  for (const cap of tokens2.capacities) attributes.push({ kind: "capacity", value: cap, source: "name", confidence: 0.8, weight: "likely-defining" });
  if (host) attributes.push({ kind: "host", value: host.toLowerCase(), source: "name", confidence: 0.6, weight: "unknown" });
  const hasCode = codes.length > 0 || tokens2.capacities.size > 0 || attributes.some((a) => a.kind === "number");
  const wordCount = attributes.filter((a) => a.kind === "word").length;
  const level = hasCode ? "exact" : wordCount >= 2 ? "line" : "unknown";
  const unresolved = [];
  if (!hasCode) unresolved.push("the name states no model, version, size or capacity identifier");
  if (wordCount < 2 && !hasCode) unresolved.push("the name is a single word");
  const confidence = Math.min(0.9, 0.3 + (codes.length ? 0.25 : 0) + (tokens2.capacities.size ? 0.1 : 0) + (wordCount >= 3 ? 0.1 : 0) + (corroborated.length ? 0.1 : 0));
  const keyParts = [...attributes.filter((a) => a.kind !== "host").map((a) => `${a.kind}:${a.value}`)].sort();
  return {
    productId: args.productId,
    version: IDENTITY_VERSION,
    level,
    identityKey: level === "unknown" ? null : sha(keyParts.join("|")),
    confidence: Number(confidence.toFixed(2)),
    attributes,
    unresolved,
    evidence: { method: "name-attributes/v1", inputs: { name: args.name, filedTitles: (args.filedTitles ?? []).length }, corroboratedCodes: corroborated },
    sourceHash: hashInputs(args.name, args.filedTitles ?? [])
  };
}
function identityTermsOf(name) {
  const { subject, host } = splitHost(name);
  const out = /* @__PURE__ */ new Map();
  const t = identityTokens(subject);
  const codes = new Set(definingCodes(subject));
  for (const w of t.words) if (!NOISE_WORDS.has(w)) out.set(`${codes.has(w) ? "code" : "word"}:${w}`, { term: w, kind: codes.has(w) ? "code" : "word" });
  for (const c of t.capacities) out.set(`capacity:${c}`, { term: c, kind: "capacity" });
  for (const c of codes) out.set(`code:${c}`, { term: c, kind: "code" });
  if (host) {
    for (const w of identityTokens(host).words) if (!NOISE_WORDS.has(w)) out.set(`word:${w}`, { term: w, kind: "word" });
  }
  return [...out.values()];
}
var CONNECTORS = [
  [/\b(?:for|fits?|compatible with|designed for)\s+/i, "for"],
  [/\bwith\s+/i, "with"],
  [/\b(?:includes?|including|plus)\s+/i, "includes"]
];
function referenceRole(narrowerName, baseName) {
  const base = [...identityTokens(baseName).words].filter((w) => !NOISE_WORDS.has(w));
  if (base.length === 0) return null;
  const holds = (text) => {
    const w = identityTokens(text).words;
    return base.every((b) => w.has(b));
  };
  const { host } = splitHost(narrowerName);
  if (host && holds(host)) return "for";
  for (const [re, role] of CONNECTORS) {
    const m = re.exec(narrowerName);
    if (m && holds(narrowerName.slice(m.index + m[0].length))) return role;
  }
  return null;
}
function classifyRelation(a, b) {
  const cmp = compareIdentity(a.name, b.name);
  if (cmp.level === "different") return null;
  if (cmp.level === "exact" || cmp.level === "possible-alias") {
    const [from, to] = a.id < b.id ? [a, b] : [b, a];
    return {
      fromProductId: from.id,
      toProductId: to.id,
      relation: "same-as",
      role: null,
      confidence: cmp.level === "exact" ? 0.5 : 0.3,
      evidence: { method: "identity-compare/v1", level: cmp.level, aliasPairs: cmp.aliasPairs, names: [a.name, b.name] },
      ambiguity: cmp.level === "exact" ? ["identical by stated words; the products may still differ in something neither name states"] : ["equal only if a short form means the longer word; unreliable on its own"]
    };
  }
  const narrower = cmp.moreSpecific === "a" ? a : b;
  const base = cmp.moreSpecific === "a" ? b : a;
  const extras = cmp.moreSpecific === "a" ? cmp.onlyInA : cmp.onlyInB;
  const role = referenceRole(narrower.name, base.name);
  if (role) {
    return {
      fromProductId: narrower.id,
      toProductId: base.id,
      relation: "references",
      role,
      confidence: 0.6,
      evidence: { method: "identity-compare/v1", extras, names: [narrower.name, base.name] },
      ambiguity: ["the first names the second as what it goes with or runs on; it is not the second product", "it could be an accessory, a component, a game or software, or a bundle that includes it"]
    };
  }
  return {
    fromProductId: narrower.id,
    toProductId: base.id,
    relation: "narrower-than",
    role: null,
    confidence: 0.5,
    evidence: { method: "identity-compare/v1", extras, names: [narrower.name, base.name] },
    ambiguity: ["the first states more than the second", "it could be a more specific version of it, or an accessory, component or bundle related to it: not decided"]
  };
}
function aliasCandidatesFor(args) {
  const found = /* @__PURE__ */ new Map();
  for (const t of args.titles) {
    for (const c of definingCodes(t)) {
      if (!args.isCovered(c, args.name)) continue;
      const row = found.get(c) ?? { support: 0, examples: [] };
      row.support++;
      if (row.examples.length < 3) row.examples.push(t);
      found.set(c, row);
    }
  }
  return [...found].map(([alias, v]) => ({ alias, ...v }));
}

// src/main/identity/foundationStore.ts
var IDENTITY_TABLES = ["identity_meta", "product_identity", "identity_terms", "product_relations", "product_aliases", "listing_identity", "identity_audit"];
var SCHEMA = `
  CREATE TABLE IF NOT EXISTS identity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS product_identity (
    product_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    level TEXT NOT NULL,
    identity_key TEXT,
    confidence REAL NOT NULL,
    attributes_json TEXT NOT NULL,
    unresolved_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    computed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_product_identity_key ON product_identity(identity_key);
  CREATE TABLE IF NOT EXISTS identity_terms (
    product_id TEXT NOT NULL,
    term TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (product_id, term, kind)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_identity_terms_term ON identity_terms(term, kind);
  CREATE TABLE IF NOT EXISTS product_relations (
    id TEXT PRIMARY KEY,
    from_product_id TEXT NOT NULL,
    to_product_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    role TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    confidence REAL NOT NULL,
    evidence_json TEXT NOT NULL,
    ambiguity_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    decision_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_product_relations ON product_relations(from_product_id, to_product_id, relation);
  CREATE INDEX IF NOT EXISTS idx_product_relations_to ON product_relations(to_product_id);
  CREATE INDEX IF NOT EXISTS idx_product_relations_status ON product_relations(status);
  CREATE TABLE IF NOT EXISTS product_aliases (
    id TEXT PRIMARY KEY,
    alias_norm TEXT NOT NULL,
    alias_text TEXT NOT NULL,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    source TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    decision_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_product_aliases ON product_aliases(alias_norm, product_id);
  CREATE INDEX IF NOT EXISTS idx_product_aliases_norm ON product_aliases(alias_norm);
  CREATE TABLE IF NOT EXISTS listing_identity (
    listing_id TEXT PRIMARY KEY,
    best_product_id TEXT,
    stored_product_id TEXT,
    level TEXT NOT NULL,
    confidence REAL NOT NULL,
    extras_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    unresolved_json TEXT NOT NULL,
    computed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS identity_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_identity_audit_entity ON identity_audit(entity, entity_id);
`;
var now = () => Date.now();
var normAlias = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
var IdentityFoundation = class {
  constructor(db) {
    this.db = db;
  }
  index = null;
  names = /* @__PURE__ */ new Map();
  // Prepared statements are kept and reused (preparing the same SQL thousands of times during a backfill churns native memory).
  statements = /* @__PURE__ */ new Map();
  p(sql) {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }
  // ---------- schema
  /** Creates the tables (idempotent). Touches no existing table. */
  init() {
    this.db.exec(SCHEMA);
    this.p("INSERT OR IGNORE INTO identity_meta (key, value) VALUES ('schema_version', ?)").run(String(IDENTITY_VERSION));
  }
  /** Removes every identity table. Nothing else is touched; the decisions can be exported first (exportDecisions). */
  drop() {
    this.statements.clear();
    this.db.exec("BEGIN");
    try {
      for (const t of IDENTITY_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  // ---------- audit
  audit(actor, action, entity, entityId, before, after, note) {
    const r = this.db.prepare("INSERT INTO identity_audit (at, actor, action, entity, entity_id, before_json, after_json, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(now(), actor, action, entity, entityId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note ?? null);
    return Number(r.lastInsertRowid);
  }
  // ---------- backfill (resumable, idempotent, time-boxed)
  meta(key2) {
    return this.p("SELECT value FROM identity_meta WHERE key = ?").get(key2)?.value ?? null;
  }
  setMeta(key2, value) {
    this.p("INSERT INTO identity_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key2, value);
  }
  backfillStatus() {
    const phase = this.meta("backfill_phase") ?? "products";
    return { phase, cursor: this.meta("backfill_cursor") ?? "", startedAt: Number(this.meta("backfill_started_at")) || null, completedAt: Number(this.meta("backfill_completed_at")) || null };
  }
  /** Starts the backfill over (derived data is rebuilt; decisions already recorded are kept). */
  resetBackfill() {
    for (const k of ["backfill_phase", "backfill_cursor", "backfill_started_at", "backfill_completed_at"]) this.p("DELETE FROM identity_meta WHERE key = ?").run(k);
    this.index = null;
  }
  loadNames() {
    if (this.names.size > 0) return;
    for (const p of this.p("SELECT id, name FROM products").all()) this.names.set(p.id, p.name);
  }
  // Evidence for the backfill's corroboration checks: entry names and listing titles. Reference-photo titles are deliberately NOT read here: they sit in
  // rows that also hold the photos, so reading all of them is a long synchronous read on a big library (each product's own photo titles are read one product
  // at a time in filedTitles instead).
  buildIndex() {
    if (this.index) return this.index;
    const docs = [];
    for (const p of this.p("SELECT id, name FROM products").all()) docs.push({ text: p.name, origin: `product:${p.id}`, kind: "product" });
    for (const l of this.p("SELECT title, seller_name FROM listings").all()) {
      docs.push({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" });
    }
    this.index = new CodeIndex(docs);
    return this.index;
  }
  filedTitles(productId) {
    const photos = this.p("SELECT source_title FROM product_images WHERE product_id = ? AND source_title IS NOT NULL").all(productId).map((r) => r.source_title);
    const listings = this.p("SELECT title FROM listings WHERE product_id = ?").all(productId).map((r) => r.title);
    return [...photos, ...listings];
  }
  /**
   * Does a bounded amount of work (about `budgetMs`) and returns. Call it again later until `done`. Safe to stop at any point (a crash included): the
   * cursor is saved with each batch and every write is an upsert, so resuming repeats nothing harmful.
   */
  backfillStep(budgetMs = 10) {
    const status = this.backfillStatus();
    if (status.phase === "done") return { done: true, phase: "done", processed: 0 };
    if (!status.startedAt) this.setMeta("backfill_started_at", String(now()));
    const t0 = performance.now();
    let processed = 0;
    let phase = status.phase;
    let cursor = status.cursor;
    this.db.exec("BEGIN");
    try {
      let first = true;
      while ((first || performance.now() - t0 < budgetMs) && phase !== "done") {
        first = false;
        const r = this.stepPhase(phase, cursor, t0 + budgetMs);
        processed += r.processed;
        if (r.finished) {
          phase = { products: "relations", relations: "aliases", aliases: "listings", listings: "done" }[phase];
          cursor = "";
        } else cursor = r.cursor;
      }
      this.setMeta("backfill_phase", phase);
      this.setMeta("backfill_cursor", cursor);
      if (phase === "done") this.setMeta("backfill_completed_at", String(now()));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (phase === "done") {
      this.index = null;
      this.names.clear();
    }
    return { done: phase === "done", phase, processed };
  }
  // Processes the rows of one phase one at a time until the deadline (always at least one) and reports where it got to. A phase is finished when a
  // batch comes back short; running out of time mid-batch just means the next call resumes after the last row done.
  stepPhase(phase, cursor, deadline) {
    const BATCH = 10;
    let processed = 0;
    let last = cursor;
    const run = (rows, work) => {
      for (const r of rows) {
        if (processed > 0 && performance.now() > deadline) return false;
        work(r);
        processed++;
        last = r.id;
      }
      return rows.length < BATCH;
    };
    const products = () => this.p("SELECT id, name FROM products WHERE id > ? ORDER BY id LIMIT ?").all(cursor, BATCH);
    let finished;
    if (phase === "products") {
      finished = run(products(), (p) => this.computeProduct(p.id, p.name));
    } else if (phase === "relations") {
      this.loadNames();
      finished = run(products(), (p) => {
        for (const q of this.candidates(p.name, 40, p.id)) this.proposeRelation({ id: p.id, name: p.name }, { id: q.productId, name: q.name });
      });
    } else if (phase === "aliases") {
      finished = run(products(), (p) => this.proposeAliases(p.id, p.name));
    } else {
      this.loadNames();
      const rows = this.p("SELECT id, title, product_id, seller_name FROM listings WHERE id > ? ORDER BY id LIMIT ?").all(cursor, BATCH);
      finished = run(rows, (l) => this.computeListing(l));
    }
    return { finished, cursor: last, processed };
  }
  computeProduct(id, name) {
    const titles = this.filedTitles(id);
    const hash = hashInputs(name, titles);
    const existing = this.p("SELECT source_hash, version FROM product_identity WHERE product_id = ?").get(id);
    if (existing && existing.source_hash === hash && existing.version === IDENTITY_VERSION) return;
    const index = this.buildIndex();
    const corroborated = [];
    for (const code of definingCodes(name)) {
      const origins = new Set(index.docsWith(code).filter((d) => d.origin !== `product:${id}`).map((d) => d.origin));
      if (origins.size >= 2) corroborated.push({ code, reason: "seen-in-multiple-sources" });
    }
    const row = buildProductIdentity({ productId: id, name, filedTitles: titles, corroborated });
    this.db.prepare(
      `INSERT INTO product_identity (product_id, version, level, identity_key, confidence, attributes_json, unresolved_json, evidence_json, source_hash, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET version = excluded.version, level = excluded.level, identity_key = excluded.identity_key, confidence = excluded.confidence,
           attributes_json = excluded.attributes_json, unresolved_json = excluded.unresolved_json, evidence_json = excluded.evidence_json, source_hash = excluded.source_hash, computed_at = excluded.computed_at`
    ).run(id, row.version, row.level, row.identityKey, row.confidence, JSON.stringify(row.attributes), JSON.stringify(row.unresolved), JSON.stringify(row.evidence), row.sourceHash, now());
    this.p("DELETE FROM identity_terms WHERE product_id = ?").run(id);
    const ins = this.p("INSERT OR IGNORE INTO identity_terms (product_id, term, kind) VALUES (?, ?, ?)");
    for (const t of identityTermsOf(name)) ins.run(id, t.term, t.kind);
  }
  proposeRelation(a, b) {
    const rel = classifyRelation(a, b);
    if (!rel) return;
    this.upsertRelation(rel);
  }
  upsertRelation(rel) {
    const existing = this.p("SELECT id, status FROM product_relations WHERE from_product_id = ? AND to_product_id = ? AND relation = ?").get(rel.fromProductId, rel.toProductId, rel.relation);
    if (existing) {
      if (existing.status === "candidate") {
        this.p("UPDATE product_relations SET confidence = ?, evidence_json = ?, ambiguity_json = ?, updated_at = ? WHERE id = ?").run(rel.confidence, JSON.stringify(rel.evidence), JSON.stringify(rel.ambiguity), now(), existing.id);
      }
      return;
    }
    const id = (0, import_node_crypto2.randomUUID)();
    const t = now();
    this.db.prepare("INSERT INTO product_relations (id, from_product_id, to_product_id, relation, role, status, confidence, evidence_json, ambiguity_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?)").run(id, rel.fromProductId, rel.toProductId, rel.relation, rel.role, rel.confidence, JSON.stringify(rel.evidence), JSON.stringify(rel.ambiguity), t, t);
    this.audit("backfill", "propose", "relation", id, null, { ...rel, status: "candidate" });
  }
  proposeAliases(productId, name) {
    const titles = this.filedTitles(productId);
    for (const c of aliasCandidatesFor({ name, titles, isCovered: aliasCovered })) {
      const norm2 = normAlias(c.alias);
      const existing = this.p("SELECT id, status FROM product_aliases WHERE alias_norm = ? AND product_id = ?").get(norm2, productId);
      const confidence = Math.min(0.7, 0.3 + 0.1 * c.support);
      const evidence = JSON.stringify({ method: "short-form-in-filed-titles/v1", support: c.support, examples: c.examples, name });
      if (existing) {
        if (existing.status === "candidate") this.p("UPDATE product_aliases SET confidence = ?, evidence_json = ?, updated_at = ? WHERE id = ?").run(confidence, evidence, now(), existing.id);
        continue;
      }
      const id = (0, import_node_crypto2.randomUUID)();
      const t = now();
      this.db.prepare("INSERT INTO product_aliases (id, alias_norm, alias_text, product_id, status, source, confidence, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'candidate', 'short-form', ?, ?, ?, ?)").run(id, norm2, c.alias, productId, confidence, evidence, t, t);
      this.audit("backfill", "propose", "alias", id, null, { alias: c.alias, productId, status: "candidate", confidence });
    }
  }
  computeListing(l) {
    const tokens2 = identityTokens(l.title);
    const cands = this.candidates(l.title, 25);
    const fits = cands.map((c) => ({ c, n: identityTokens(c.name) })).filter(({ n }) => n.words.size >= 2 && [...n.words].every((w) => tokens2.words.has(w)) && (n.capacities.size === 0 || [...n.capacities].some((x) => tokens2.capacities.has(x)))).map(({ c, n }) => ({ id: c.productId, name: c.name, covered: n.words.size + n.capacities.size, extra: codesMissingFrom(c.name, l.title) }));
    fits.sort((x, y) => x.extra.length - y.extra.length || y.covered - x.covered);
    const best = fits[0] ?? null;
    const tie = best ? fits.filter((f) => f.extra.length === best.extra.length && f.covered === best.covered).length > 1 : false;
    let extras = { credible: [], unverified: [], dismissed: [] };
    if (best && best.extra.length > 0) {
      const a = assessCodes({ entryId: best.id, entryName: best.name, title: l.title, index: this.buildIndex(), seller: l.seller_name });
      extras = { credible: a.credible, unverified: a.unverified, dismissed: a.dismissed };
    }
    const unresolved = [];
    if (!best) unresolved.push("no Database product's stated words are all in the title");
    if (tie) unresolved.push("more than one product fits equally well");
    if (best && extras.credible.length > 0) unresolved.push("the title states a model or version marker the product's name lacks");
    const level = !best ? "unknown" : extras.credible.length > 0 ? "line" : tie ? "line" : "exact";
    const confidence = !best ? 0.1 : Math.max(0.2, (level === "exact" ? 0.7 : 0.45) - (tie ? 0.15 : 0));
    this.db.prepare(
      `INSERT INTO listing_identity (listing_id, best_product_id, stored_product_id, level, confidence, extras_json, evidence_json, unresolved_json, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET best_product_id = excluded.best_product_id, stored_product_id = excluded.stored_product_id, level = excluded.level, confidence = excluded.confidence,
           extras_json = excluded.extras_json, evidence_json = excluded.evidence_json, unresolved_json = excluded.unresolved_json, computed_at = excluded.computed_at`
    ).run(l.id, best?.id ?? null, l.product_id, level, Number(confidence.toFixed(2)), JSON.stringify(extras), JSON.stringify({ method: "title-fit/v1", considered: fits.slice(0, 3).map((f) => ({ productId: f.id, name: f.name, extraCodes: f.extra })) }), JSON.stringify(unresolved), now());
  }
  // ---------- candidate retrieval (indexed)
  /**
   * The products that share the most distinctive terms with `text`, found through the term index (never a scan of the products). A term that
   * almost every product has says little and is skipped unless it is all there is.
   */
  candidates(text, limit = 20, excludeProductId) {
    this.loadNames();
    const t = identityTokens(text);
    const terms = [.../* @__PURE__ */ new Set([...t.words, ...t.capacities, ...definingCodes(text)])].filter((w) => !NOISE_WORDS.has(w));
    if (terms.length === 0) return [];
    const POSTING_CAP = 400;
    const postings = [];
    const select = this.p("SELECT product_id FROM identity_terms WHERE term = ? LIMIT ?");
    for (const term of terms) {
      const ids = select.all(term, POSTING_CAP + 1).map((r) => r.product_id);
      if (ids.length > 0) postings.push({ term, ids });
    }
    const usable = postings.filter((p) => p.ids.length <= POSTING_CAP);
    const lists = usable.length > 0 ? usable : postings;
    const score = /* @__PURE__ */ new Map();
    for (const p of lists) {
      const weight = 1 / Math.log2(2 + p.ids.length);
      for (const id of p.ids) {
        if (id === excludeProductId) continue;
        const row = score.get(id) ?? { s: 0, terms: [] };
        row.s += weight;
        row.terms.push(p.term);
        score.set(id, row);
      }
    }
    return [...score].sort((a, b) => b[1].s - a[1].s).slice(0, limit).map(([id, v]) => ({ productId: id, name: this.names.get(id) ?? this.p("SELECT name FROM products WHERE id = ?").get(id)?.name ?? "", score: Number(v.s.toFixed(3)), sharedTerms: v.terms })).filter((c) => c.name !== "");
  }
  // ---------- reading
  getProductIdentity(productId) {
    return this.p("SELECT * FROM product_identity WHERE product_id = ?").get(productId) ?? null;
  }
  listRelations(filter = {}) {
    const where = [];
    const args = [];
    if (filter.status) where.push("status = ?"), args.push(filter.status);
    if (filter.relation) where.push("relation = ?"), args.push(filter.relation);
    if (filter.productId) where.push("(from_product_id = ? OR to_product_id = ?)"), args.push(filter.productId, filter.productId);
    return this.p(`SELECT * FROM product_relations ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id`).all(...args);
  }
  listAliases(filter = {}) {
    const where = [];
    const args = [];
    if (filter.status) where.push("status = ?"), args.push(filter.status);
    if (filter.productId) where.push("product_id = ?"), args.push(filter.productId);
    return this.p(`SELECT * FROM product_aliases ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id`).all(...args);
  }
  stats() {
    const n = (sql) => Number(this.p(sql).get().n);
    return {
      identities: n("SELECT COUNT(*) AS n FROM product_identity"),
      terms: n("SELECT COUNT(*) AS n FROM identity_terms"),
      relations: n("SELECT COUNT(*) AS n FROM product_relations"),
      relationsCandidate: n("SELECT COUNT(*) AS n FROM product_relations WHERE status = 'candidate'"),
      aliases: n("SELECT COUNT(*) AS n FROM product_aliases"),
      aliasesCandidate: n("SELECT COUNT(*) AS n FROM product_aliases WHERE status = 'candidate'"),
      listings: n("SELECT COUNT(*) AS n FROM listing_identity"),
      audit: n("SELECT COUNT(*) AS n FROM identity_audit")
    };
  }
  // ---------- decisions (explicit, recorded, reversible)
  decideRelation(id, status, by, note) {
    const before = this.p("SELECT * FROM product_relations WHERE id = ?").get(id);
    if (!before) throw new Error("no such relation");
    const t = now();
    this.p("UPDATE product_relations SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ? WHERE id = ?").run(status, status === "candidate" ? null : t, status === "candidate" ? null : by, note ?? null, t, id);
    const after = this.p("SELECT * FROM product_relations WHERE id = ?").get(id);
    this.audit(by, `decide:${status}`, "relation", id, before, after, note);
  }
  decideAlias(id, status, by, note) {
    const before = this.p("SELECT * FROM product_aliases WHERE id = ?").get(id);
    if (!before) throw new Error("no such alias");
    const t = now();
    this.p("UPDATE product_aliases SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ? WHERE id = ?").run(status, status === "candidate" ? null : t, status === "candidate" ? null : by, note ?? null, t, id);
    const after = this.p("SELECT * FROM product_aliases WHERE id = ?").get(id);
    this.audit(by, `decide:${status}`, "alias", id, before, after, note);
  }
  /** Undoes one audited change (a proposal or a decision) if it is the most recent change to that entity. */
  revertAudit(auditId) {
    const a = this.p("SELECT * FROM identity_audit WHERE id = ?").get(auditId);
    if (!a) throw new Error("no such audit entry");
    const latest = this.p("SELECT MAX(id) AS m FROM identity_audit WHERE entity = ? AND entity_id = ?").get(a.entity, a.entity_id);
    if (latest.m !== auditId) throw new Error("a newer change exists for this item: revert that one first");
    const table = a.entity === "relation" ? "product_relations" : a.entity === "alias" ? "product_aliases" : null;
    if (!table) throw new Error("this kind of entry cannot be reverted");
    const before = a.before_json ? JSON.parse(a.before_json) : null;
    this.db.exec("BEGIN");
    try {
      if (before === null) this.p(`DELETE FROM ${table} WHERE id = ?`).run(a.entity_id);
      else {
        const cols = Object.keys(before).filter((k) => k !== "id");
        this.p(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => before[c] ?? null), a.entity_id);
      }
      this.audit("system", `revert:${a.action}`, a.entity, a.entity_id, a.after_json ? JSON.parse(a.after_json) : null, before, `reverts audit ${auditId}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  // ---------- maintenance
  /** Called when a product is deleted by the app: its identity rows go with it (the audit log keeps what they were). */
  forgetProduct(productId) {
    const rels = this.p("SELECT * FROM product_relations WHERE from_product_id = ? OR to_product_id = ?").all(productId, productId);
    for (const r of rels) this.audit("system", "forget", "relation", r.id, r, null, `product ${productId} deleted`);
    this.p("DELETE FROM product_relations WHERE from_product_id = ? OR to_product_id = ?").run(productId, productId);
    this.p("DELETE FROM product_aliases WHERE product_id = ?").run(productId);
    this.p("DELETE FROM identity_terms WHERE product_id = ?").run(productId);
    this.p("DELETE FROM product_identity WHERE product_id = ?").run(productId);
    this.p("DELETE FROM listing_identity WHERE best_product_id = ? OR stored_product_id = ?").run(productId, productId);
    this.names.delete(productId);
  }
  forgetAllProducts() {
    for (const t of ["product_relations", "product_aliases", "identity_terms", "product_identity", "listing_identity"]) this.db.exec(`DELETE FROM ${t}`);
    this.names.clear();
  }
  /** Every relation and alias a person decided on, as plain data (keep this before dropping the tables). */
  exportDecisions() {
    return {
      relations: this.p("SELECT * FROM product_relations WHERE status != 'candidate'").all(),
      aliases: this.p("SELECT * FROM product_aliases WHERE status != 'candidate'").all()
    };
  }
};

// src/main/store.ts
var import_node_sqlite = require("node:sqlite");

// src/main/colors.ts
var COLOR_WORDS = /* @__PURE__ */ new Set([
  "black",
  "white",
  "blue",
  "red",
  "green",
  "pink",
  "purple",
  "gray",
  "grey",
  "silver",
  "gold",
  "yellow",
  "orange",
  "brown",
  "beige",
  "cream",
  "teal",
  "navy",
  "graphite",
  "midnight",
  "starlight"
]);
function colorTokens(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
}
function colorsIn(text) {
  const found = /* @__PURE__ */ new Set();
  for (const t of colorTokens(text)) if (COLOR_WORDS.has(t)) found.add(t === "grey" ? "gray" : t);
  return found;
}
function isColorWord(word) {
  return COLOR_WORDS.has(word.toLowerCase());
}
function sameColors(a, b) {
  return a.size === b.size && [...a].every((c) => b.has(c));
}
function colorsConflict(a, b) {
  const ca = colorsIn(a);
  const cb = colorsIn(b);
  return ca.size > 0 && cb.size > 0 && ![...ca].some((c) => cb.has(c));
}

// src/main/compFilter.ts
var TIER_WORDS = ["ti", "super", "xt", "xtx", "pro", "max", "plus", "slim", "oled", "lite", "mini", "se", "xl", "air", "ultra", "fe"];
var CAPACITY_TOKEN = /^\d+(?:p\d+)?(?:tb|gb|mb)$/;
function normalize2(text) {
  return text.toLowerCase().replace(/(\d)\.(\d)/g, "$1p$2").replace(/(\d)\s*[-]?\s*(tb|gb|mb|hz|mah|mm)\b/g, "$1$2");
}
function tokens(text) {
  return normalize2(text).split(/[^a-z0-9]+/).filter(Boolean);
}
function specTokens(text) {
  return [...new Set(tokens(text).filter((t) => /\d/.test(t)))];
}
function capacityTokens(text) {
  return specTokens(text).filter((t) => CAPACITY_TOKEN.test(t));
}
function hasSpecToken(titleTokens, wanted) {
  return titleTokens.some((tok) => {
    for (let at = tok.indexOf(wanted); at !== -1; at = tok.indexOf(wanted, at + 1)) {
      if (!/\d/.test(tok[at - 1] ?? "") && !/\d/.test(tok[at + wanted.length] ?? "")) return true;
    }
    return false;
  });
}
function hasTierWord(text, word) {
  return new RegExp(`(?<![a-z])${word}(?![a-z])`).test(normalize2(text));
}
function modelLetters(text) {
  const toks = tokens(text);
  const map = /* @__PURE__ */ new Map();
  for (let i = 0; i < toks.length; i++) {
    const word = toks[i];
    if (word.length < 3 || /\d/.test(word)) continue;
    const letters = /* @__PURE__ */ new Set();
    for (let j = i + 1; j <= i + 2 && j < toks.length && toks[j].length === 1 && /[b-hj-z]/.test(toks[j]); j++) letters.add(toks[j]);
    if (letters.size === 0) continue;
    const have = map.get(word) ?? /* @__PURE__ */ new Set();
    letters.forEach((l) => have.add(l));
    map.set(word, have);
  }
  return map;
}
function hasSingleModelLetter(text) {
  return [...modelLetters(text).values()].some((letters) => letters.size === 1);
}
function modelLettersConflict(reference, title) {
  const wanted = modelLetters(reference);
  const found = modelLetters(title);
  for (const [word, letters] of wanted) {
    const there = found.get(word);
    if (there && ![...letters].some((l) => there.has(l))) return true;
  }
  return false;
}
function compMatchesSpecs(reference, title) {
  const titleTokens = tokens(title);
  const wanted = specTokens(reference);
  for (const spec of wanted) if (!hasSpecToken(titleTokens, spec)) return false;
  const wantedCapacities = capacityTokens(reference);
  if (wantedCapacities.length > 0) {
    for (const cap of capacityTokens(title)) if (!wantedCapacities.includes(cap)) return false;
  }
  for (const word of TIER_WORDS) {
    if (hasTierWord(reference, word) !== hasTierWord(title, word)) return false;
  }
  if (colorsConflict(reference, title)) return false;
  if (modelLettersConflict(reference, title)) return false;
  return true;
}

// src/main/store.ts
var import_node_path = __toESM(require("node:path"));
var import_node_fs = require("node:fs");
var import_node_crypto3 = require("node:crypto");

// src/main/metrics.ts
var STAGE_SAMPLE_CAP = 500;
var stages = /* @__PURE__ */ new Map();
function stageFor(name) {
  let s = stages.get(name);
  if (!s) {
    s = { count: 0, totalMs: 0, errors: 0, recent: [] };
    stages.set(name, s);
  }
  return s;
}
function recordStage(name, durationMs, ok) {
  const s = stageFor(name);
  s.count++;
  s.totalMs += durationMs;
  if (!ok) s.errors++;
  s.recent.push(durationMs);
  if (s.recent.length > STAGE_SAMPLE_CAP) s.recent.shift();
}
function timedSync(name, fn) {
  const start = Date.now();
  try {
    const result = fn();
    recordStage(name, Date.now() - start, true);
    return result;
  } catch (err) {
    recordStage(name, Date.now() - start, false);
    throw err;
  }
}
var EVENT_WINDOW_MS = 6e4;
var RollingCounter = class {
  timestamps = [];
  total = 0;
  add() {
    this.total++;
    this.timestamps.push(Date.now());
    this.prune();
  }
  prune() {
    const cutoff = Date.now() - EVENT_WINDOW_MS;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }
  ratePerSec() {
    this.prune();
    return this.timestamps.length / (EVENT_WINDOW_MS / 1e3);
  }
};
var globalCounters = /* @__PURE__ */ new Map();
var perAccountCounters = /* @__PURE__ */ new Map();
function counterFor(map, name) {
  let c = map.get(name);
  if (!c) {
    c = new RollingCounter();
    map.set(name, c);
  }
  return c;
}
function recordEvent(name, accountId) {
  counterFor(globalCounters, name).add();
  if (accountId) {
    let acctMap = perAccountCounters.get(accountId);
    if (!acctMap) {
      acctMap = /* @__PURE__ */ new Map();
      perAccountCounters.set(accountId, acctMap);
    }
    counterFor(acctMap, name).add();
  }
}
var windowStartedAt = Date.now();

// src/main/brokenVariant.ts
var BROKEN_SUFFIX = "(For Parts / Broken)";
function brokenVariantName(productName) {
  const base = baseNameOfBrokenVariant(productName);
  return `${base} ${BROKEN_SUFFIX}`;
}
function isBrokenVariantName(name) {
  return /\(\s*for parts\s*\/\s*broken\s*\)\s*$/i.test(name.trim());
}
function baseNameOfBrokenVariant(name) {
  return name.replace(/\s*\(\s*for parts\s*\/\s*broken\s*\)\s*$/i, "").trim();
}

// src/main/listingAge.ts
var HOURS_PER_UNIT = {
  second: 1 / 3600,
  sec: 1 / 3600,
  minute: 1 / 60,
  min: 1 / 60,
  hour: 1,
  hr: 1,
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
  year: 24 * 365
};
var WORD_NUMBERS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  few: 3,
  several: 4
};
var QUALIFIER = "(?:about|around|over|almost|nearly|roughly|approximately|more than|less than|under|just over|just under)";
var AGE_RE = new RegExp(
  `^(?:${QUALIFIER}\\s+)?(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+(second|sec|minute|min|hour|hr|day|week|month|year)s?\\b`
);
function estimateListingAgeHours(ageText) {
  const text = ageText.trim().toLowerCase().replace(/^listed\s+/, "");
  if (!text) return null;
  if (/^(just now|moments? ago|a moment ago|a few seconds ago)$/.test(text)) return 0;
  if (/^today$/.test(text)) return 1;
  if (/^yesterday$/.test(text)) return 30;
  const vague = text.match(new RegExp(`^(?:${QUALIFIER}\\s+)?(?:a\\s+(couple|few)(?:\\s+of)?|(several))\\s+(second|sec|minute|min|hour|hr|day|week|month|year)s?\\b`));
  if (vague) {
    const n2 = WORD_NUMBERS[vague[1] ?? vague[2]];
    return n2 * HOURS_PER_UNIT[vague[3]];
  }
  const match = text.match(AGE_RE);
  if (!match) return null;
  const raw = match[1];
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : WORD_NUMBERS[raw];
  if (n === void 0 || !Number.isFinite(n)) return null;
  return n * HOURS_PER_UNIT[match[2]];
}
function assessListingAge(ageText, maxHours = 24) {
  const text = ageText?.trim() ? ageText.trim() : null;
  const hours = text ? estimateListingAgeHours(text) : null;
  if (hours === null) return { state: "unknown", hours: null, text };
  if (maxHours !== null && hours >= maxHours) return { state: "stale", hours, text };
  return { state: "fresh", hours, text };
}

// src/main/store.ts
var EBAY_VALUE_SQL = "COALESCE(ebay_est_value_usd, ebay_avg_sold_price_usd + COALESCE(ebay_avg_shipping_usd, 0))";
var Store = class _Store {
  db;
  // The Database identity foundation (identity/foundationStore.ts): extra tables of candidate relations and evidence, created only when switched on in the
  // config. Null when off: no table exists and nothing reads or writes any.
  identity = null;
  // Per explicit instruction — an in-memory accelerator in front of the
  // hasSeen() SQLite lookup below, benchmarked (not assumed) against the
  // plain DB-only path via metrics.ts's db_dedup_lookup/dedup_cache_check
  // stages. Deliberately POSITIVE-ONLY: an id is added here only once the
  // DB has confirmed it's genuinely already seen, and it's never removed or
  // treated as authoritative for a "not seen" answer. That asymmetry is
  // what keeps this safe to add without touching correctness — a stale
  // cache could only ever cause an unnecessary extra DB check (a false
  // miss), never a wrong "already seen" (there's no way for a real id to be
  // wrongly present), which matters here because MULTIPLE accounts share
  // this one Store and rely on the DB's hasSeen() as the actual source of
  // truth for "which account found this first" (see index.ts's
  // setListingFoundBy) — a cache that could go stale in the other direction
  // would risk two accounts both thinking they found the same listing
  // first.
  seenCache = /* @__PURE__ */ new Set();
  static SEEN_CACHE_MAX = 2e4;
  constructor(dbPath, options = {}) {
    (0, import_node_fs.mkdirSync)(import_node_path.default.dirname(dbPath), { recursive: true });
    this.db = new import_node_sqlite.DatabaseSync(dbPath);
    try {
      this.initialize();
      if (options.identityFoundation === true) {
        this.identity = new IdentityFoundation(this.db);
        this.identity.init();
      }
    } catch (err) {
      try {
        this.db.close();
      } catch {
      }
      throw err;
    }
  }
  // Creates the tables and runs the migrations (split out of the constructor so a failure can close the database, see above).
  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        price INTEGER,
        url TEXT NOT NULL,
        thumbnail_url TEXT,
        image_urls TEXT,
        matched_item TEXT,
        reference_price_usd INTEGER,
        discount_percent REAL,
        condition_impact TEXT,
        confidence TEXT,
        reasoning TEXT,
        extracted_attributes TEXT,
        shipping_mentioned INTEGER NOT NULL DEFAULT 0,
        is_deal INTEGER NOT NULL DEFAULT 0,
        deal_tier TEXT,
        estimated_value_range TEXT,
        notified INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        seller_joined_year INTEGER,
        seller_rating REAL,
        seller_rating_count INTEGER,
        seller_has_profile_photo INTEGER,
        seller_risk_passed INTEGER NOT NULL DEFAULT 1,
        seller_risk_reasons TEXT,
        photo_analysis TEXT,
        photo_analysis_checked_at INTEGER,
        location_text TEXT,
        listing_age TEXT,
        seller_name TEXT,
        description TEXT
      );
      CREATE TABLE IF NOT EXISTS feedback (
        listing_id TEXT PRIMARY KEY REFERENCES listings(id),
        verdict TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      );
      -- Condition-awareness \u2014 one confirm/deny per flagged photo, own id
      -- (not listing_id) as the PK since a single listing can have multiple
      -- flagged photos, unlike feedback above (one verdict per listing).
      -- listing_title is denormalized on purpose so
      -- getFlawFeedbackExamples never needs a join against listings.
      CREATE TABLE IF NOT EXISTS flaw_feedback (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL REFERENCES listings(id),
        photo_number INTEGER NOT NULL,
        description TEXT NOT NULL,
        confidence TEXT NOT NULL,
        confirmed INTEGER NOT NULL,
        listing_title TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      -- Clynx Cloud Phase 5 \u2014 updated_at is added via the ALTER TABLE
      -- migration block below (existing installs already have this table
      -- without the column); a fresh CREATE TABLE here still only needs
      -- created_at, since the migration block runs unconditionally right
      -- after and backfills it for both cases identically.
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ai_summary TEXT,
        ai_summary_generated_at INTEGER,
        image_url TEXT,
        category TEXT NOT NULL DEFAULT 'Other',
        family TEXT,
        family_logo_url TEXT,
        loading INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        observed_notes TEXT,
        resale_price_usd REAL,
        resale_time_to_sell TEXT,
        lookout_notes TEXT,
        keep_thumbnail INTEGER NOT NULL DEFAULT 0,
        desired_price_usd REAL,
        hard_cap_at_desired_price INTEGER NOT NULL DEFAULT 0,
        prioritized INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS category_dismissals (
        category TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        last_dismissed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS product_images (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        image_data TEXT NOT NULL,
        source_title TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blacklist_terms (
        term TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blacklisted_images (
        id TEXT PRIMARY KEY,
        image_data TEXT NOT NULL,
        source_title TEXT,
        category TEXT,
        reason TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_thumbnails (
        path_key TEXT PRIMARY KEY,
        image_data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        search_phrase TEXT NOT NULL,
        match_keywords TEXT NOT NULL,
        linked_product_id TEXT REFERENCES products(id),
        min_price_usd INTEGER,
        max_price_usd INTEGER,
        min_profit_usd INTEGER,
        min_discount_percent REAL,
        max_listing_age_minutes INTEGER,
        location_mode TEXT NOT NULL DEFAULT 'city',
        selected_state TEXT,
        selected_city_or_zip TEXT,
        search_radius_miles INTEGER,
        resolved_location_url TEXT,
        resolved_location_label TEXT,
        resolved_location_checked_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        listings_seen_count INTEGER NOT NULL DEFAULT 0,
        match_count INTEGER NOT NULL DEFAULT 0,
        last_checked_at INTEGER,
        last_active_check_at INTEGER,
        next_check_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_matches (
        id TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL REFERENCES watches(id),
        listing_id TEXT NOT NULL REFERENCES listings(id),
        matched_at INTEGER NOT NULL,
        found_by_account_id TEXT,
        found_by_account_label TEXT,
        discovery_mode TEXT NOT NULL,
        price_at_match INTEGER,
        discount_percent_at_match REAL,
        profit_usd_at_match INTEGER,
        notified INTEGER NOT NULL DEFAULT 0,
        notified_at INTEGER,
        UNIQUE(watch_id, listing_id)
      );
      CREATE INDEX IF NOT EXISTS idx_watches_due ON watches(next_check_at);
      CREATE INDEX IF NOT EXISTS idx_watch_matches_watch ON watch_matches(watch_id);
      CREATE INDEX IF NOT EXISTS idx_watch_matches_listing ON watch_matches(listing_id);
      -- Batch 2 Fix B \u2014 a local record of a delete that happened here but
      -- hasn't been confirmed propagated to the cloud mirror yet. Without
      -- this, a delete was purely local: the next pull would simply see the
      -- cloud's still-there row and resurrect it locally. watchSync.ts/
      -- feedbackSync.ts/productSync.ts each drain their own resource_type's
      -- rows every tick (see their pushPendingDeletes) and also skip
      -- re-applying a pulled remote row whose id is still pending here, so a
      -- delete that hasn't flushed yet doesn't get resurrected by the very
      -- same tick's pull. See deleteWatch/clearFeedback/deleteProduct below
      -- for where rows get added; see Store.addPendingCloudDelete's own
      -- comment for the one remaining residual race this doesn't close.
      CREATE TABLE IF NOT EXISTS pending_cloud_deletes (
        resource_type TEXT NOT NULL,
        local_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (resource_type, local_id)
      );
    `);
    const cols = this.db.prepare("PRAGMA table_info(listings)").all().map((c) => c.name);
    const migrations = [
      ["seller_joined_year", "INTEGER"],
      ["seller_rating", "REAL"],
      ["seller_rating_count", "INTEGER"],
      ["ebay_seller_feedback_percent", "REAL"],
      ["ebay_shipping_usd", "REAL"],
      ["seller_has_profile_photo", "INTEGER"],
      ["seller_risk_passed", "INTEGER NOT NULL DEFAULT 1"],
      ["seller_risk_reasons", "TEXT"],
      ["deal_tier", "TEXT"],
      ["estimated_value_range", "TEXT"],
      ["thumbnail_url", "TEXT"],
      ["image_urls", "TEXT"],
      ["photo_analysis", "TEXT"],
      ["photo_analysis_checked_at", "INTEGER"],
      ["location_text", "TEXT"],
      ["listing_age", "TEXT"],
      // The Deal Quality Gate's persisted verdict (see types.ts DealStatus) and the parsed listing age.
      ["deal_status", "TEXT"],
      ["gate_confidence", "TEXT"],
      ["gate_stars", "REAL"],
      ["gate_headline", "TEXT"],
      ["gate_reasons", "TEXT"],
      ["required_discount_percent", "REAL"],
      ["target_price_usd", "REAL"],
      ["gate_facts", "TEXT"],
      ["listing_age_hours", "REAL"],
      ["seller_name", "TEXT"],
      ["description", "TEXT"],
      // Per explicit instruction — multi-account scanning: which account's
      // browser session found this listing (see types.ts's ListingRecord).
      ["found_by_account_id", "TEXT"],
      ["found_by_account_label", "TEXT"],
      // Per explicit instruction — "avg. Facebook Marketplace price...
      // only available after the ai has come across the same product
      // multiple times." Resolved and stamped in saveScored below
      // (fuzzy-matched from extraction.matchedItem, same findMatchingProduct
      // lookup used everywhere else in this app) so this column stays
      // correct across every re-save of a listing as its own evaluation
      // gets refined, with no extra plumbing needed at any of saveScored's
      // several call sites. Null whenever a listing was never confidently
      // identified as a specific tracked product. See getFacebookPriceStats
      // below for what actually reads this.
      ["product_id", "TEXT"],
      // Clynx Cloud Phase 3 — high-water mark for listingIngestSync.ts's
      // downstream mirror push (see cloudClient.ts's ingestListings). Null
      // means "never pushed yet." Set to the sync tick's own Date.now() the
      // moment a listing is successfully included in a push — not the
      // cloud's own response timestamp — so a listing that fails to push
      // (network hiccup, cloud down) simply stays null and gets retried on
      // the next tick, same retry posture as watchSync.ts's push().
      ["cloud_synced_at", "INTEGER"],
      // Batch 2 Fix E — counts consecutive cloud-rejected (validation
      // failure, not network error) ingest attempts for this listing, so a
      // permanently-malformed row doesn't retry forever every tick — see
      // recordListingCloudSyncFailures below and listingIngestSync.ts's own
      // use of it. 0 means "never rejected" (including "never attempted").
      ["cloud_sync_attempts", "INTEGER DEFAULT 0"],
      // eBay Browse API integration — which marketplace this listing came
      // from. SQLite backfills the DEFAULT onto every existing row the
      // moment this column is added, so every pre-existing row is correctly
      // 'facebook' with no explicit backfill query needed. See
      // getFacebookPriceStats below, the one place this is actually read.
      ["source", "TEXT NOT NULL DEFAULT 'facebook'"],
      // Condition-awareness — vision.ts's structured PhotoFlaw[] for this
      // listing, JSON-encoded (same convention as image_urls/
      // extracted_attributes above). Always '[]'-equivalent (NULL, read
      // back as []) unless Config.researchCondition was on when this
      // listing was last analyzed.
      ["photo_flaws", "TEXT"],
      // Facebook's "Just listed" badge on the search-results card.
      ["just_listed", "INTEGER"]
    ];
    for (const [name, ddl] of migrations) {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${ddl}`);
    }
    const watchCols = this.db.prepare("PRAGMA table_info(watches)").all().map((c) => c.name);
    if (!watchCols.includes("platform")) this.db.exec("ALTER TABLE watches ADD COLUMN platform TEXT NOT NULL DEFAULT 'facebook'");
    if (!watchCols.includes("min_seller_rating_percent")) this.db.exec("ALTER TABLE watches ADD COLUMN min_seller_rating_percent REAL");
    if (!watchCols.includes("ntfy_topic")) this.db.exec("ALTER TABLE watches ADD COLUMN ntfy_topic TEXT");
    if (!watchCols.includes("terms_json")) this.db.exec("ALTER TABLE watches ADD COLUMN terms_json TEXT");
    if (!watchCols.includes("check_interval_minutes")) this.db.exec("ALTER TABLE watches ADD COLUMN check_interval_minutes INTEGER NOT NULL DEFAULT 15");
    if (!watchCols.includes("account_ids")) this.db.exec("ALTER TABLE watches ADD COLUMN account_ids TEXT");
    this.db.exec(`
      -- Every listing a Watch has already come across, so it is never looked at twice.
      CREATE TABLE IF NOT EXISTS watch_seen_listings (
        watch_id TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (watch_id, listing_id)
      );
      -- The exact Facebook search each Watch ran for each term at each place.
      CREATE TABLE IF NOT EXISTS watch_searches (
        watch_id TEXT NOT NULL,
        term TEXT NOT NULL,
        place_key TEXT NOT NULL,
        place_label TEXT NOT NULL,
        url TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        PRIMARY KEY (watch_id, term, place_key)
      );
      -- Where a place name or ZIP is (for the radius check). found = 0 means
      -- "looked it up and there was no such place", remembered so it isn't asked again.
      CREATE TABLE IF NOT EXISTS geocode_cache (
        query TEXT PRIMARY KEY,
        lat REAL,
        lon REAL,
        label TEXT,
        found INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);
    if (!watchCols.includes("resolved_location_urls")) this.db.exec("ALTER TABLE watches ADD COLUMN resolved_location_urls TEXT");
    const feedbackCols = this.db.prepare("PRAGMA table_info(feedback)").all().map((c) => c.name);
    if (!feedbackCols.includes("updated_at")) {
      this.db.exec("ALTER TABLE feedback ADD COLUMN updated_at INTEGER");
      this.db.exec("UPDATE feedback SET updated_at = created_at WHERE updated_at IS NULL");
    }
    const productImageCols = this.db.prepare("PRAGMA table_info(product_images)").all().map((c) => c.name);
    if (!productImageCols.includes("kind")) {
      this.db.exec("ALTER TABLE product_images ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_product_images_kind ON product_images(product_id, kind)");
    const productCols = this.db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
    if (!productCols.includes("observed_notes")) {
      this.db.exec("ALTER TABLE products ADD COLUMN observed_notes TEXT");
    }
    if (!productCols.includes("image_url")) {
      this.db.exec("ALTER TABLE products ADD COLUMN image_url TEXT");
    }
    if (!productCols.includes("category")) {
      this.db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'Other'");
    }
    if (!productCols.includes("resale_price_usd")) {
      this.db.exec("ALTER TABLE products ADD COLUMN resale_price_usd REAL");
    }
    if (!productCols.includes("resale_time_to_sell")) {
      this.db.exec("ALTER TABLE products ADD COLUMN resale_time_to_sell TEXT");
    }
    if (!productCols.includes("lookout_notes")) {
      this.db.exec("ALTER TABLE products ADD COLUMN lookout_notes TEXT");
    }
    if (!productCols.includes("keep_thumbnail")) {
      this.db.exec("ALTER TABLE products ADD COLUMN keep_thumbnail INTEGER NOT NULL DEFAULT 0");
    }
    if (!productCols.includes("family")) {
      this.db.exec("ALTER TABLE products ADD COLUMN family TEXT");
    }
    if (!productCols.includes("family_logo_url")) {
      this.db.exec("ALTER TABLE products ADD COLUMN family_logo_url TEXT");
    }
    if (!productCols.includes("desired_price_usd")) {
      this.db.exec("ALTER TABLE products ADD COLUMN desired_price_usd REAL");
    }
    if (!productCols.includes("hard_cap_at_desired_price")) {
      this.db.exec("ALTER TABLE products ADD COLUMN hard_cap_at_desired_price INTEGER NOT NULL DEFAULT 0");
    }
    if (!productCols.includes("prioritized")) {
      this.db.exec("ALTER TABLE products ADD COLUMN prioritized INTEGER NOT NULL DEFAULT 0");
    }
    if (!productCols.includes("ebay_avg_sold_price_usd")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_avg_sold_price_usd REAL");
    }
    if (!productCols.includes("ebay_avg_run_time_days")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_avg_run_time_days REAL");
    }
    if (!productCols.includes("ebay_comps_sample_size")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_comps_sample_size INTEGER");
    }
    if (!productCols.includes("ebay_comps_checked_at")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_comps_checked_at INTEGER");
    }
    if (!productCols.includes("ebay_avg_shipping_usd")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_avg_shipping_usd REAL");
    }
    for (const [column, type] of [
      ["ebay_active_median_usd", "REAL"],
      ["ebay_active_sample_size", "INTEGER"],
      ["ebay_est_value_usd", "REAL"],
      ["ebay_est_basis", "TEXT"],
      ["ebay_comps_identity", "TEXT"],
      ["parent_product_id", "TEXT"],
      ["my_store_ref", "TEXT"]
    ]) {
      if (!productCols.includes(column)) this.db.exec(`ALTER TABLE products ADD COLUMN ${column} ${type}`);
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(created_at DESC, name, id, family, ebay_est_value_usd, ebay_avg_sold_price_usd, ebay_avg_shipping_usd, ebay_avg_run_time_days)"
    );
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_flags (name TEXT PRIMARY KEY)");
    const lettersFlag = "comps-model-letters-2026-10-06";
    if (!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = ?").get(lettersFlag)) {
      const checked = this.db.prepare("SELECT id, name FROM products WHERE ebay_comps_checked_at IS NOT NULL").all();
      for (const r of checked) {
        if (!hasSingleModelLetter(r.name)) continue;
        this.db.prepare(
          `UPDATE products SET ebay_avg_sold_price_usd = NULL, ebay_avg_run_time_days = NULL, ebay_avg_shipping_usd = NULL, ebay_comps_sample_size = NULL,
               ebay_comps_checked_at = NULL, ebay_active_median_usd = NULL, ebay_active_sample_size = NULL, ebay_est_value_usd = NULL, ebay_est_basis = NULL WHERE id = ?`
        ).run(r.id);
      }
      this.db.prepare("INSERT INTO schema_flags (name) VALUES (?)").run(lettersFlag);
    }
    const conflictFlag = "comps-conflict-2026-10-07";
    if (!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = ?").get(conflictFlag)) {
      const clearComps = (id) => this.db.prepare(
        `UPDATE products SET ebay_avg_sold_price_usd = NULL, ebay_avg_run_time_days = NULL, ebay_avg_shipping_usd = NULL, ebay_comps_sample_size = NULL,
               ebay_comps_checked_at = NULL, ebay_active_median_usd = NULL, ebay_active_sample_size = NULL, ebay_est_value_usd = NULL, ebay_est_basis = NULL WHERE id = ?`
      ).run(id);
      const researched = this.db.prepare(
        "SELECT id, ebay_avg_sold_price_usd AS sold, ebay_comps_sample_size AS sn, ebay_active_median_usd AS act, ebay_active_sample_size AS an FROM products WHERE ebay_comps_checked_at IS NOT NULL"
      ).all();
      for (const r of researched) {
        if (!(r.sold && r.sold > 0) || !(r.act && r.act > 0) || (r.an ?? 0) < 3) continue;
        const ratio = r.act * 0.92 / r.sold;
        if (ratio >= 0.6 && ratio <= 1.6) continue;
        if ((r.sn ?? 0) >= 2) this.db.prepare("UPDATE products SET ebay_est_value_usd = ?, ebay_est_basis = 'sold' WHERE id = ?").run(r.sold, r.id);
        else clearComps(r.id);
      }
      const consoles = this.db.prepare(`SELECT id, name, family, ${EBAY_VALUE_SQL} AS v FROM products WHERE ebay_comps_checked_at IS NOT NULL AND family IS NOT NULL`).all();
      const byBrand = /* @__PURE__ */ new Map();
      for (const c of consoles) {
        if (!/>\s*consoles?\s*$/i.test(c.family) || !(c.v && c.v > 0)) continue;
        const brand = c.family.split(">")[0].trim().toLowerCase();
        byBrand.set(brand, [...byBrand.get(brand) ?? [], { id: c.id, v: c.v, generic: c.name.trim().split(/\s+/).length <= 2 }]);
      }
      for (const group of byBrand.values()) {
        if (group.length < 3) continue;
        const sorted = group.map((g) => g.v).sort((a, b) => a - b);
        const middle = sorted[Math.floor(sorted.length / 2)];
        for (const g of group) if (g.generic && g.v < middle * 0.4) clearComps(g.id);
      }
      this.db.prepare("INSERT INTO schema_flags (name) VALUES (?)").run(conflictFlag);
    }
    const shippingFlag = "comps-shipping-2026-10-07";
    if (!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = ?").get(shippingFlag)) {
      this.db.exec(
        "UPDATE products SET ebay_est_value_usd = ebay_est_value_usd + ebay_avg_shipping_usd WHERE ebay_est_value_usd IS NOT NULL AND ebay_avg_shipping_usd > 0 AND ebay_comps_checked_at IS NOT NULL"
      );
      this.db.prepare("INSERT INTO schema_flags (name) VALUES (?)").run(shippingFlag);
    }
    const stateCitiesFlag = "state-top-cities-2026-10-07";
    if (!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = ?").get(stateCitiesFlag)) {
      this.db.exec("UPDATE watches SET resolved_location_urls = NULL, resolved_location_checked_at = NULL WHERE location_mode = 'state'");
      this.db.prepare("INSERT INTO schema_flags (name) VALUES (?)").run(stateCitiesFlag);
    }
    if (!productCols.includes("updated_at")) {
      this.db.exec("ALTER TABLE products ADD COLUMN updated_at INTEGER");
      this.db.exec("UPDATE products SET updated_at = created_at WHERE updated_at IS NULL");
    }
    const blacklistedImageCols = this.db.prepare("PRAGMA table_info(blacklisted_images)").all().map((c) => c.name);
    if (!blacklistedImageCols.includes("linked_term")) {
      this.db.exec("ALTER TABLE blacklisted_images ADD COLUMN linked_term TEXT");
      this.db.exec(`
        UPDATE blacklisted_images
        SET linked_term = SUBSTR(reason, INSTR(reason, '"') + 1, LENGTH(reason) - INSTR(reason, '"') - 1)
        WHERE linked_term IS NULL AND reason LIKE 'Blacklisted alongside the term "%"'
      `);
    }
  }
  hasSeen(id) {
    return timedSync("db_dedup_lookup", () => {
      const row = this.db.prepare("SELECT 1 FROM listings WHERE id = ?").get(id);
      return row !== void 0;
    });
  }
  // Per explicit instruction — the in-memory-cache-first version of
  // hasSeen(), for scrapeEngine.ts's per-listing dedup check specifically
  // (the hot path this cache is meant to speed up). See seenCache's own doc
  // comment above for why this only ever caches a CONFIRMED-seen id, never
  // a "not seen" result.
  hasSeenCached(id) {
    const hit = timedSync("dedup_cache_check", () => this.seenCache.has(id));
    if (hit) {
      recordEvent("dedup_cache_hit");
      return true;
    }
    recordEvent("dedup_cache_miss");
    const seen = this.hasSeen(id);
    if (seen) this.rememberSeen(id);
    return seen;
  }
  rememberSeen(id) {
    if (this.seenCache.size >= _Store.SEEN_CACHE_MAX) {
      const oldest = this.seenCache.values().next().value;
      if (oldest !== void 0) this.seenCache.delete(oldest);
    }
    this.seenCache.add(id);
  }
  saveScored(scored, sellerRisk) {
    const { listing, extraction, referencePriceUsd, discountPercent, isDeal } = scored;
    const risk = sellerRisk ?? { passed: true, reasons: [] };
    const productId = extraction.matchedItem ? this.findMatchingProduct(extraction.matchedItem)?.id ?? null : null;
    this.db.prepare(
      `INSERT OR REPLACE INTO listings
          (id, title, price, url, thumbnail_url, image_urls, matched_item, reference_price_usd, discount_percent,
           condition_impact, confidence, reasoning, extracted_attributes, shipping_mentioned,
           is_deal, deal_tier, estimated_value_range, notified, first_seen_at,
           seller_joined_year, seller_rating, seller_rating_count, seller_has_profile_photo,
           seller_risk_passed, seller_risk_reasons, location_text, listing_age, seller_name, description, product_id, source, just_listed,
           ebay_seller_feedback_percent, ebay_shipping_usd,
           deal_status, gate_confidence, gate_stars, gate_headline, gate_reasons, required_discount_percent, target_price_usd, listing_age_hours, gate_facts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           COALESCE((SELECT notified FROM listings WHERE id = ?), 0),
           COALESCE((SELECT first_seen_at FROM listings WHERE id = ?), ?),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      listing.id,
      listing.title,
      listing.price,
      listing.url,
      listing.thumbnailUrl,
      JSON.stringify(listing.imageUrls ?? []),
      extraction.matchedItem,
      referencePriceUsd,
      discountPercent,
      extraction.conditionImpact,
      extraction.confidence,
      extraction.reasoning,
      extraction.extractedAttributes,
      listing.shippingMentioned ? 1 : 0,
      isDeal ? 1 : 0,
      scored.dealTier,
      scored.estimatedValueRange,
      listing.id,
      listing.id,
      Date.now(),
      listing.seller?.joinedFacebookYear ?? null,
      listing.seller?.rating ?? null,
      listing.seller?.ratingCount ?? null,
      listing.seller?.hasProfilePhoto === null || listing.seller?.hasProfilePhoto === void 0 ? null : listing.seller.hasProfilePhoto ? 1 : 0,
      risk.passed ? 1 : 0,
      risk.reasons.length ? JSON.stringify(risk.reasons) : null,
      listing.locationText ?? null,
      listing.listingAge ?? null,
      listing.seller?.name ?? null,
      listing.description ?? null,
      productId,
      listing.source ?? "facebook",
      listing.justListed ? 1 : 0,
      listing.seller?.ebayFeedbackPercentage ?? null,
      listing.ebayShippingUsd ?? null,
      scored.gate?.status ?? null,
      scored.gate?.confidence ?? null,
      scored.gate?.stars ?? null,
      scored.gate?.headline ?? null,
      scored.gate ? JSON.stringify(scored.gate.reasons) : null,
      scored.gate?.requiredDiscountPercent ?? null,
      scored.gate?.targetPriceUsd ?? null,
      assessListingAge(listing.listingAge, null).hours,
      scored.gate?.facts ? JSON.stringify(scored.gate.facts) : null
    );
    this.rememberSeen(listing.id);
    this.lastSavedId = listing.id;
  }
  // Per explicit instruction — "avg. Facebook Marketplace price... this
  // will only be available after the ai has come across the same product
  // multiple times on facebook marketplace... place this right above eBay
  // sold comps." Deliberately a LIVE aggregation over the listings table
  // (via product_id, stamped in saveScored above) rather than a cached
  // field on the product row the way eBay comps are — this should just
  // organically appear/grow as more real listings get recognized as this
  // product, with no separate "Research now" trigger needed the way eBay's
  // comps do. MIN_SAMPLES gates it off until there's genuinely more than
  // one or two data points — "multiple times," not "the one listing that
  // happened to create this product in the first place."
  // Per explicit instruction, live: "it's saying it has an average fbm
  // sales price of $200 — which is insane. it shouldn't be factoring in
  // all the scammy $65 xbox series x consoles, it should only be taking
  // the more legit looking ones seriously." Two filters, both against
  // signals the pipeline already computes for every listing (not a new
  // classifier): seller_risk_passed (this app's own existing legitimacy
  // check — account age/rating/profile photo) and condition_impact != a
  // major/broken flag (a "for parts"/"doesn't turn on" listing's low price
  // reflects being broken, not the market rate for a working one). A
  // seller-risk-failed listing already gets product_id left null in
  // saveScored above (its own matchedItem is cleared), so this is mostly
  // belt-and-suspenders there — condition is the one that actually needed
  // adding. Even with both, a real scam/bait listing can still slip
  // through with a clean-looking seller and no condition red flags in the
  // text — so ALSO drops anything priced under half the median of what's
  // left, a "less than half of everyone else's asking price" listing being
  // far more likely bait than a genuine steal worth averaging in.
  getFacebookPriceStats(productId) {
    const MIN_SAMPLES = 3;
    const rows = this.db.prepare(
      `SELECT price FROM listings
         WHERE product_id = ? AND price IS NOT NULL AND price > 0
           AND seller_risk_passed = 1
           AND (condition_impact IS NULL OR condition_impact != 'major')
           AND source = 'facebook'`
    ).all(productId);
    if (rows.length < MIN_SAMPLES) return null;
    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
    const legitPrices = prices.filter((p) => p >= median * 0.5);
    if (legitPrices.length < MIN_SAMPLES) return null;
    const avgPriceUsd = legitPrices.reduce((sum, p) => sum + p, 0) / legitPrices.length;
    return { avgPriceUsd, sampleSize: legitPrices.length };
  }
  markNotified(id) {
    this.db.prepare("UPDATE listings SET notified = 1 WHERE id = ?").run(id);
  }
  // Whether a push has already gone out for this listing (a deal alert or a Watch match): the other kind must not repeat it.
  isListingNotified(id) {
    const row = this.db.prepare("SELECT notified FROM listings WHERE id = ?").get(id);
    return !!row?.notified;
  }
  // Per explicit instruction — multi-account scanning: which account's
  // browser session found this listing, so the user knows which login to
  // act from. A separate call rather than a saveScored() parameter,
  // deliberately: saveScored is called from many places inside
  // scrapeEngine.ts (every skip reason, every re-save on enrichment), and
  // hasSeen() already guarantees only the FIRST account to encounter a
  // given listing id ever reaches any of those call sites at all — every
  // later account re-scanning the same real listing bails out on hasSeen
  // before saveScored ever runs. So index.ts's onListing callback (which
  // fires once per save, already knows which account's engine it's
  // wired to) is the natural, ENGINE-code-untouched place to attach this,
  // rather than threading an account identity through scrapeEngine.ts's
  // save call sites.
  setListingFoundBy(id, accountId, accountLabel) {
    this.db.prepare("UPDATE listings SET found_by_account_id = ?, found_by_account_label = ? WHERE id = ?").run(accountId, accountLabel, id);
  }
  deleteListing(id) {
    this.db.prepare("DELETE FROM feedback WHERE listing_id = ?").run(id);
    this.db.prepare("DELETE FROM listings WHERE id = ?").run(id);
  }
  clearAllListings() {
    this.db.exec("DELETE FROM feedback; DELETE FROM listings;");
  }
  updatePhotoAnalysis(id, summary, flaws = []) {
    this.db.prepare("UPDATE listings SET photo_analysis = ?, photo_analysis_checked_at = ?, photo_flaws = ? WHERE id = ?").run(summary, Date.now(), JSON.stringify(flaws), id);
  }
  getById(id) {
    const row = this.db.prepare(
      `SELECT l.*, f.verdict as feedback_verdict, f.note as feedback_note,
           (SELECT group_concat(w.name, char(31)) FROM watch_matches wm2 JOIN watches w ON w.id = wm2.watch_id WHERE wm2.listing_id = l.id) as watch_names
         FROM listings l LEFT JOIN feedback f ON f.listing_id = l.id WHERE l.id = ?`
    ).get(id);
    return row ? this.enrichWithMatchedProductPricing(rowToRecord(row)) : null;
  }
  // Per explicit instruction — Feed's "est. value" should only ever reflect
  // real data (a matched product's own average watchcount/eBay sold price),
  // never the general pathway's own unverified guess. Looked up fresh here
  // (not stored on the listing row itself) via the SAME fuzzy
  // findMatchingProduct every other feature in this app uses to connect a
  // listing to its Database entry, so this stays correct even as products
  // get renamed/merged/re-researched after a listing was first saved.
  enrichWithMatchedProductPricing(record) {
    return this.enrichManyWithMatchedProductPricing([record])[0];
  }
  // The same lookup for a whole page of listings at once. Feed's list used to run
  // findMatchingProduct once PER LISTING, and a fuzzy miss loads every product row
  // (each with its photo as a data: URI) — hundreds of those per refresh, ~600ms of
  // blocked main thread for 266 listings. Here each distinct matched name is looked
  // up once, and only the few columns needed (name + the two prices) are read, in
  // the same order and with the same exact-then-fuzzy rule as findMatchingProduct.
  enrichManyWithMatchedProductPricing(records) {
    const byName = /* @__PURE__ */ new Map();
    let candidates = null;
    const columns = `name, ${EBAY_VALUE_SQL} AS sold, ebay_avg_run_time_days AS run`;
    const lookup = (name) => {
      if (byName.has(name)) return byName.get(name);
      let found = null;
      const exact = this.db.prepare(`SELECT ${columns} FROM products WHERE LOWER(name) = LOWER(?)`).get(name);
      if (exact) found = { sold: exact.sold ?? null, run: exact.run ?? null };
      else {
        candidates ??= this.db.prepare(`SELECT ${columns} FROM products ORDER BY created_at DESC`).all();
        const similar = candidates.find((p) => isSimilarProductName(name, p.name));
        if (similar) found = { sold: similar.sold ?? null, run: similar.run ?? null };
      }
      byName.set(name, found);
      return found;
    };
    return records.map((record) => {
      if (!record.matchedItem) return record;
      if (modelLettersConflict(record.matchedItem, record.title)) return { ...record, matchedProductAvgSoldPriceUsd: null, matchedProductAvgRunTimeDays: null };
      const product = lookup(record.matchedItem);
      return { ...record, matchedProductAvgSoldPriceUsd: product?.sold ?? null, matchedProductAvgRunTimeDays: product?.run ?? null };
    });
  }
  // What eBay says a product is worth (the estimate, else the sold average), looked up by a product's name for the
  // deal scoring that runs on every listing. Same exact-then-fuzzy rule as findMatchingProduct, but over just a name
  // and a number (not whole product rows with their photos), kept for a few seconds between lookups.
  ebayValueCache = null;
  getEbayValueForProductName(name, title) {
    const now2 = Date.now();
    if (!this.ebayValueCache || now2 - this.ebayValueCache.at > 1e4) {
      const rows2 = this.db.prepare(`SELECT name, ${EBAY_VALUE_SQL} AS value FROM products`).all();
      this.ebayValueCache = { at: now2, rows: rows2 };
    }
    const rows = this.ebayValueCache.rows;
    const lower = name.toLowerCase();
    const found = rows.find((r) => r.name.toLowerCase() === lower) ?? rows.find((r) => isSimilarProductName(name, r.name));
    if (title && found) {
      const specific = this.moreSpecificProductForTitle(rows, found.name, title);
      if (specific) return specific.value !== null && specific.value > 0 ? specific.value : null;
    }
    return found && found.value !== null && found.value > 0 ? found.value : null;
  }
  // The Database product (value or not) whose whole name appears in the title and that has more words than `genericName`
  // (the most words wins), or null.
  moreSpecificProductForTitle(rows, genericName, title) {
    const wordsOf = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "and", "for", "with", "of"].includes(w));
    const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    const genericCount = wordsOf(genericName).length;
    let best = null;
    for (const r of rows) {
      const words = wordsOf(r.name);
      if (words.length < 2 || words.length <= genericCount || !words.every((w) => haystack.includes(w)) || !compMatchesSpecs(r.name, title)) continue;
      if (!best || words.length > best.words) best = { row: r, words: words.length };
    }
    return best ? best.row : null;
  }
  // What the Database knows about the product a listing is (by its tracked/matched name, else by its title): its name, what
  // it sells for on eBay, how fast, and from how many sales. Feeds the star rating in ntfy alerts (dealSummary.ts).
  // Evidence for deciding whether a code in a listing title is a real model / version marker (identity/credibility.ts): entry names, other
  // sellers' listing titles and reference-photo titles. Built the first time a listing states a code its entry lacks (most never do), kept for ten
  // minutes, and rebuilt when the number of entries changes.
  codeIndexCache = null;
  codeIndex() {
    const now2 = Date.now();
    const products = this.db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
    if (this.codeIndexCache && now2 - this.codeIndexCache.at < 6e5 && this.codeIndexCache.products === products) return this.codeIndexCache.index;
    const docs = [];
    for (const p of this.db.prepare("SELECT id, name FROM products").all()) docs.push({ text: p.name, origin: `product:${p.id}`, kind: "product" });
    for (const l of this.db.prepare("SELECT title, seller_name FROM listings").all()) {
      docs.push({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" });
    }
    for (const i of this.db.prepare("SELECT source_title FROM product_images WHERE source_title IS NOT NULL").all()) {
      docs.push({ text: i.source_title, origin: `title:${i.source_title.toLowerCase()}`, kind: "photo" });
    }
    const index = new CodeIndex(docs);
    this.codeIndexCache = { at: now2, products, index };
    return index;
  }
  /** Which codes a listing title states beyond the entry's name are backed by evidence (credible), which are not (unverified), and which are just a short form of the name. */
  assessListingCodes(entryId, entryName, title, independentTexts, seller) {
    if (codesMissingFrom(entryName, title).length === 0) return NO_CODES;
    return assessCodes({ entryId, entryName, title, index: this.codeIndex(), independentTexts, seller });
  }
  /** The credible extra codes only (what the identity second look and the market check need). */
  credibleCodes(entryId, entryName, title) {
    return this.assessListingCodes(entryId, entryName, title).credible.map((c) => c.code);
  }
  getProductSignals(matchedItem, title, independentTexts) {
    const rows = this.db.prepare(`SELECT id, name, ${EBAY_VALUE_SQL} AS value, ebay_avg_run_time_days AS run, ebay_comps_sample_size AS n, ebay_comps_checked_at AS at, my_store_ref AS store, ebay_est_basis AS basis, ebay_comps_identity AS ident FROM products`).all();
    const toSignals = (r) => {
      const assessment = this.assessListingCodes(r.id, r.name, title, independentTexts);
      return {
        id: r.id,
        name: r.name,
        valueUsd: r.value !== null && r.value > 0 ? r.value : null,
        runTimeDays: r.run ?? null,
        compSample: r.n ?? null,
        checkedAt: r.at ?? null,
        storeValueUsd: parseMyStore(r.store)?.medianUsd ?? null,
        basis: r.basis === "sold" || r.basis === "blend" || r.basis === "active" ? r.basis : null,
        identity: r.ident === "exact" || r.ident === "approximate" || r.ident === "unresolved" ? r.ident : null,
        // Codes the listing states that this product's name does not, split by evidence (see identity/credibility.ts): the credible ones mean
        // the listing may be a more specific product than the entry it matched, so the entry's value is not known to apply to it.
        unconfirmedCodes: assessment.credible.map((c) => c.code),
        unverifiedCodes: assessment.unverified.map((u) => u.code),
        codeAssessment: assessment
      };
    };
    if (matchedItem) {
      const lower = matchedItem.toLowerCase();
      const hit = rows.find((r) => r.name.toLowerCase() === lower) ?? rows.find((r) => isSimilarProductName(matchedItem, r.name));
      if (hit) return toSignals(this.moreSpecificProductForTitle(rows, hit.name, title) ?? hit);
    }
    const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    let best = null;
    for (const r of rows) {
      const words = r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "and", "for", "with", "of"].includes(w));
      if (words.length < 2 || !words.every((w) => haystack.includes(w)) || !compMatchesSpecs(r.name, title)) continue;
      if (!best || words.length > best.words) best = { row: r, words: words.length };
    }
    return best ? toSignals(best.row) : null;
  }
  // A Database product the TITLE of a listing names (all of the product's words appear in it; the longest name wins) and
  // what eBay says it is worth: lets the deal check use real numbers with no AI call. Null when nothing matches or
  // the product has no eBay value yet. Hard facts and colors must agree, so a "White" listing isn't priced as the Black one.
  getEbayValueForTitle(title) {
    this.getEbayValueForProductName("");
    const rows = this.ebayValueCache?.rows ?? [];
    const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    let best = null;
    for (const r of rows) {
      if (r.value === null || r.value <= 0) continue;
      const words = r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "and", "for", "with", "of"].includes(w));
      if (words.length < 2 || !words.every((w) => haystack.includes(w))) continue;
      if (!compMatchesSpecs(r.name, title)) continue;
      if (!best || words.length > best.words) best = { name: r.name, value: r.value, words: words.length };
    }
    return best ? { name: best.name, value: best.value } : null;
  }
  // What BROKEN / for-parts copies of a product sell for: the value of its "(For Parts / Broken)" variant in the Database (see
  // brokenVariant.ts), found by the product's name. Null when there is no such variant yet or it has no eBay value.
  getBrokenVariantValue(itemName) {
    this.getEbayValueForProductName("");
    const rows = this.ebayValueCache?.rows ?? [];
    const lower = itemName.toLowerCase();
    const parent = rows.find((r) => r.name.toLowerCase() === lower) ?? rows.find((r) => !isBrokenVariantName(r.name) && isSimilarProductName(itemName, r.name));
    const wanted = brokenVariantName(parent?.name ?? itemName).toLowerCase();
    const variant = rows.find((r) => r.name.toLowerCase() === wanted);
    return variant && variant.value !== null && variant.value > 0 ? { name: variant.name, value: variant.value } : null;
  }
  // The listing most recently written by saveScored. The engines announce a change to the
  // Feed right after saving, and used to send "the newest listing by first-seen time",
  // which is a different listing whenever another account saved one in between or an older
  // listing was re-saved (so its card never updated until a full refetch).
  lastSavedId = null;
  /**
   * Listings whose stored photo list is heavy (a whole-size photo kept as a data: URI),
   * a few at a time, for the one-off shrinking pass (see index.ts's shrinkStoredListingPhotos).
   */
  listHeavyListingPhotos(limit) {
    const rows = this.db.prepare("SELECT id, image_urls FROM listings WHERE length(image_urls) > 60000 AND image_urls LIKE '%data:image%' LIMIT ?").all(limit);
    return rows.map((r) => ({ id: r.id, imageUrls: JSON.parse(r.image_urls) }));
  }
  setListingImageUrls(id, imageUrls) {
    this.db.prepare("UPDATE listings SET image_urls = ? WHERE id = ?").run(JSON.stringify(imageUrls), id);
  }
  getLastSavedListing() {
    return this.lastSavedId ? this.getById(this.lastSavedId) : null;
  }
  // --- Product database (Config-adjacent knowledge profiles) ------------
  // Two entries are the same product when their names reduce to the same words (case, punctuation and filler words
  // like "new"/"edition" aside). Colors count as words, so the black and the white one stay apart.
  productDuplicateKey(name) {
    const words = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !["the", "a", "an", "and", "or", "with", "for", "of"].includes(w));
    return [...new Set(words)].sort().join(" ");
  }
  // Creates the entry, unless the Database already has one for this product: then nothing is inserted and the
  // EXISTING entry's id is returned, so callers carry on with that one. (Two scans, accounts or lookups finding the same
  // new product at nearly the same moment used to each make their own: two "Xbox Series X" entries.) The check and
  // the insert are one synchronous step, so they can't interleave.
  addProductStub(id, name) {
    const key2 = this.productDuplicateKey(name);
    if (key2) {
      const rows = this.db.prepare("SELECT id, name FROM products").all();
      const existing = rows.find((r) => this.productDuplicateKey(r.name) === key2);
      if (existing) return existing.id;
    }
    const now2 = Date.now();
    this.db.prepare("INSERT INTO products (id, name, loading, created_at, updated_at) VALUES (?, ?, 1, ?, ?)").run(id, name, now2, now2);
    return id;
  }
  // Folds together entries that are already duplicates of each other (made before the check above existed, or
  // arrived from another device through cloud sync): the fullest entry is kept, and everything that pointed at the
  // others (reference photos, listings, Watches, specific models) is repointed to it. Returns removedId -> keptId
  // so callers can repoint anything stored outside the database (the Search For list in config). Cheap when there
  // are no duplicates: one query over names.
  mergeDuplicateProducts() {
    const merged = /* @__PURE__ */ new Map();
    const names = this.db.prepare("SELECT id, name FROM products").all();
    const groups = /* @__PURE__ */ new Map();
    for (const row of names) {
      const key2 = this.productDuplicateKey(row.name);
      if (!key2) continue;
      const list = groups.get(key2);
      if (list) list.push(row.id);
      else groups.set(key2, [row.id]);
    }
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const rows = ids.map((id) => this.db.prepare("SELECT * FROM products WHERE id = ?").get(id));
      const imageCounts = this.countNormalImagesByProduct();
      const score = (r) => (r.ebay_comps_checked_at ? 4 : 0) + (r.ebay_est_value_usd != null || r.ebay_avg_sold_price_usd != null ? 4 : 0) + (r.ai_summary ? 2 : 0) + (r.image_url ? 1 : 0) + Math.min(imageCounts.get(r.id) ?? 0, 10) * 0.2;
      rows.sort((a, b) => score(b) - score(a) || a.created_at - b.created_at);
      const winner = rows[0];
      for (const loser of rows.slice(1)) {
        const fill = [
          ["ai_summary", !winner.ai_summary],
          ["ai_summary_generated_at", winner.ai_summary_generated_at == null],
          ["image_url", !winner.image_url],
          ["family", !winner.family],
          ["resale_price_usd", winner.resale_price_usd == null],
          ["resale_time_to_sell", winner.resale_time_to_sell == null],
          ["desired_price_usd", winner.desired_price_usd == null],
          ["ebay_avg_sold_price_usd", winner.ebay_avg_sold_price_usd == null],
          ["ebay_avg_run_time_days", winner.ebay_avg_run_time_days == null],
          ["ebay_avg_shipping_usd", winner.ebay_avg_shipping_usd == null],
          ["ebay_comps_sample_size", winner.ebay_comps_sample_size == null],
          ["ebay_comps_checked_at", winner.ebay_comps_checked_at == null],
          ["ebay_active_median_usd", winner.ebay_active_median_usd == null],
          ["ebay_active_sample_size", winner.ebay_active_sample_size == null],
          ["ebay_est_value_usd", winner.ebay_est_value_usd == null],
          ["ebay_est_basis", winner.ebay_est_basis == null]
        ];
        for (const [column, empty] of fill) {
          if (empty && loser[column] != null && loser[column] !== "") {
            this.db.prepare(`UPDATE products SET ${column} = ? WHERE id = ?`).run(loser[column], winner.id);
            winner[column] = loser[column];
          }
        }
        if ((!winner.category || winner.category === "Other") && loser.category && loser.category !== "Other") {
          this.db.prepare("UPDATE products SET category = ? WHERE id = ?").run(loser.category, winner.id);
        }
        if (loser.prioritized && !winner.prioritized) this.db.prepare("UPDATE products SET prioritized = 1 WHERE id = ?").run(winner.id);
        const notes = [...winner.observed_notes ? String(winner.observed_notes).split("\n---\n") : [], ...loser.observed_notes ? String(loser.observed_notes).split("\n---\n") : []];
        if (notes.length) {
          winner.observed_notes = notes.slice(-15).join("\n---\n");
          this.db.prepare("UPDATE products SET observed_notes = ? WHERE id = ?").run(winner.observed_notes, winner.id);
        }
        const lookouts = [...new Set([...String(winner.lookout_notes ?? "").split("\n---\n"), ...String(loser.lookout_notes ?? "").split("\n---\n")].map((l) => l.trim()).filter(Boolean))];
        if (lookouts.length) {
          winner.lookout_notes = lookouts.slice(-15).join("\n---\n");
          this.db.prepare("UPDATE products SET lookout_notes = ? WHERE id = ?").run(winner.lookout_notes, winner.id);
        }
        this.db.prepare("UPDATE product_images SET product_id = ? WHERE product_id = ?").run(winner.id, loser.id);
        this.db.prepare("UPDATE listings SET product_id = ? WHERE product_id = ?").run(winner.id, loser.id);
        this.db.prepare("UPDATE products SET parent_product_id = ? WHERE parent_product_id = ?").run(winner.id, loser.id);
        this.db.prepare("UPDATE watches SET linked_product_id = ? WHERE linked_product_id = ?").run(winner.id, loser.id);
        const watchRows = this.db.prepare("SELECT id, terms_json FROM watches WHERE terms_json LIKE ?").all(`%${loser.id}%`);
        for (const w of watchRows) this.db.prepare("UPDATE watches SET terms_json = ? WHERE id = ?").run(w.terms_json.split(loser.id).join(winner.id), w.id);
        this.deleteProduct(loser.id);
        merged.set(loser.id, winner.id);
      }
      this.touchProduct(winner.id);
    }
    if (merged.size) this.ebayValueCache = null;
    return merged;
  }
  // Per explicit instruction — the Library's own "+" button, for a product
  // the user already has their own photo/info for and doesn't want/need AI
  // research run on. Inserted already "finished" (loading = 0) rather than
  // going through addProductStub's loading=1 + a later updateProductProfile
  // call, since there's no research pass coming to ever clear it.
  createManualProduct(id, name, category, imageUrl) {
    const now2 = Date.now();
    this.db.prepare("INSERT INTO products (id, name, category, image_url, keep_thumbnail, loading, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)").run(id, name, category, imageUrl, imageUrl ? 1 : 0, now2, now2);
  }
  updateProductProfile(id, data) {
    const now2 = Date.now();
    this.db.prepare(
      "UPDATE products SET ai_summary = ?, ai_summary_generated_at = ?, category = ?, family = ?, family_logo_url = ?, image_url = ?, loading = 0, updated_at = ? WHERE id = ?"
    ).run(data.aiSummary, now2, data.category, this.resolveFamilyName(data.family), data.familyLogoUrl ?? null, data.imageUrl, now2, id);
  }
  // Per explicit instruction — separate from updateProductProfile above
  // (which always overwrites the AI-summary/category/family/image fields
  // as a full set) since eBay comps research runs as its OWN follow-up
  // step in index.ts's runProductLookup, on its own success/failure path —
  // a comps lookup failing shouldn't touch (or blank out) the summary/
  // image fields that already succeeded moments earlier, and vice versa.
  updateProductEbayComps(id, data) {
    const now2 = Date.now();
    this.ebayValueCache = null;
    this.db.prepare(
      `UPDATE products SET ebay_avg_sold_price_usd = ?, ebay_avg_run_time_days = ?, ebay_avg_shipping_usd = ?, ebay_comps_sample_size = ?, ebay_comps_checked_at = ?,
           ebay_active_median_usd = ?, ebay_active_sample_size = ?, ebay_est_value_usd = ?, ebay_est_basis = ?, ebay_comps_identity = ?, updated_at = ? WHERE id = ?`
    ).run(
      data.avgSoldPriceUsd,
      data.avgRunTimeDays,
      data.avgShippingUsd,
      data.sampleSize,
      now2,
      data.activeMedianUsd ?? null,
      data.activeSampleSize ?? null,
      data.estimatedValueUsd ?? null,
      data.estimateBasis ?? null,
      data.identity ?? null,
      now2,
      id
    );
  }
  // The user's own store's price for a product (see myStore.ts); null clears it.
  setProductMyStore(id, ref) {
    this.db.prepare("UPDATE products SET my_store_ref = ? WHERE id = ?").run(ref ? JSON.stringify(ref) : null, id);
  }
  clearAllMyStoreRefs() {
    this.db.exec("UPDATE products SET my_store_ref = NULL WHERE my_store_ref IS NOT NULL");
  }
  // --- Specific models filed under a more generic product -----------------
  // Products that are the same thing as `name` apart from color: the black and the white Xbox Series S. Used to find
  // the entry a differently-colored listing or photo belongs to.
  listProductsSharingBase(name, excludeId) {
    const base = colorlessProductTokens(name);
    if (!base.size) return [];
    return this.listProductIndex().filter((p) => {
      if (p.id === excludeId) return false;
      const other = colorlessProductTokens(p.name);
      return other.size === base.size && [...base].every((t) => other.has(t));
    }).map((p) => this.getProductById(p.id)).filter((p) => p !== null);
  }
  // The entry that is exactly this product in exactly this color, if there is one.
  findColorVariant(name) {
    const wanted = colorsIn(name);
    return this.listProductsSharingBase(name).find((p) => sameColors(colorsIn(p.name), wanted)) ?? null;
  }
  // A "child" product is a more specific model of a generic entry (an EVGA XC card under the plain
  // "RTX 3060 Ti" entry). Local-only: it isn't part of the cloud product sync, which leaves the column alone.
  setProductParent(id, parentId) {
    this.db.prepare("UPDATE products SET parent_product_id = ?, updated_at = ? WHERE id = ?").run(parentId, Date.now(), id);
  }
  listProductChildren(parentId) {
    const rows = this.db.prepare("SELECT * FROM products WHERE parent_product_id = ? ORDER BY name").all(parentId);
    return rows.map(rowToProduct);
  }
  // Just the listing titles that photos in a product's gallery came from (no image data), newest first. Tells the
  // identity check what kinds of listing have already been filed under a product.
  listProductPhotoTitles(productId, limit) {
    const rows = this.db.prepare("SELECT source_title FROM product_images WHERE product_id = ? AND source_title IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(productId, limit * 3);
    return [...new Set(rows.map((r) => r.source_title))].slice(0, limit);
  }
  // Per explicit instruction — lets a SECOND product landing in the same
  // top-level brand family (e.g. the next Xbox product researched after
  // the first) reuse whatever logo image the first one already found,
  // instead of running its own "<brand> logo" web image search from
  // scratch (see index.ts's runProductLookup, which calls this BEFORE
  // deciding whether to search). Matched against the family column's own
  // top-level segment (everything before the first " > ", or the whole
  // string for a single-level family) so a search under "Xbox > Games >
  // Xbox 360" still finds the logo already stored against plain "Xbox".
  // Gives every product in a top-level family (and its sub-families) that has no logo yet this one.
  setFamilyLogo(topLevelFamily, logo) {
    this.db.prepare(
      `UPDATE products SET family_logo_url = ?, updated_at = ?
         WHERE (family_logo_url IS NULL OR family_logo_url = '') AND (LOWER(family) = LOWER(?) OR LOWER(family) LIKE LOWER(?) || ' >%')`
    ).run(logo, Date.now(), topLevelFamily, topLevelFamily);
  }
  getFamilyLogoUrl(topLevelFamily) {
    const row = this.db.prepare(
      `SELECT family_logo_url FROM products
         WHERE family_logo_url IS NOT NULL AND family_logo_url != ''
           AND (LOWER(family) = LOWER(?) OR LOWER(family) LIKE LOWER(?) || ' >%')
         LIMIT 1`
    ).get(topLevelFamily, topLevelFamily);
    return row?.family_logo_url ?? null;
  }
  // Per explicit instruction — a FOLDER-level thumbnail for a sub-grouping
  // within a family (e.g. "Xbox > Games" or "Xbox > Accessories") that
  // represents the BUCKET itself, not any one member product — see
  // index.ts's runProductLookup (which fetches and caches this once per
  // path, the same "fetch once, reuse forever" shape as familyLogoUrl
  // above) and Database.tsx's FamilyTile (which prefers this over an
  // arbitrary member's own photo for a non-top-level folder tile). Keyed
  // by the full path (lowercased for a case-insensitive match, same
  // normalization the family column itself gets via resolveFamilyName) —
  // "Xbox > Games" and "Xbox > Accessories" are cached separately, unlike
  // the brand logo which is shared by the whole top-level family.
  getGroupThumbnail(path3) {
    const row = this.db.prepare("SELECT image_data FROM group_thumbnails WHERE path_key = LOWER(?)").get(path3);
    return row?.image_data ?? null;
  }
  setGroupThumbnail(path3, imageData) {
    this.db.prepare("INSERT INTO group_thumbnails (path_key, image_data, created_at) VALUES (LOWER(?), ?, ?) ON CONFLICT(path_key) DO UPDATE SET image_data = excluded.image_data").run(path3, imageData, Date.now());
  }
  // The whole map at once (path -> image), for Database.tsx to prime its
  // client-side cache in one round trip rather than one IPC call per
  // folder tile — this dataset stays small (one row per distinct
  // sub-grouping actually seen, not per product), so there's no pagination
  // concern here the way there would be for, say, listings.
  listGroupThumbnails() {
    const rows = this.db.prepare("SELECT path_key, image_data FROM group_thumbnails").all();
    const map = {};
    for (const row of rows) map[row.path_key] = row.image_data;
    return map;
  }
  // Per explicit instruction — normalizes a freshly-AI-generated family
  // name (e.g. "Xbox", or a multi-level path like "Xbox > Games > Xbox
  // 360" — see types.ts's ProductProfile.family) against whatever family
  // paths are ALREADY in use in the Database before storing it, the same
  // drift problem category's fixed enum exists to avoid but without a
  // bounded list to pick from: left unchecked, "Xbox Series X Controller"
  // researched today and "Xbox Series X" researched next week could easily
  // end up filed under "Xbox" and "Microsoft Xbox" respectively, defeating
  // the whole point of grouping them together.
  //
  // Normalizes PATH SEGMENT BY SEGMENT rather than the whole string at
  // once, and only against siblings that share the same already-resolved
  // ancestor chain — so a "Games" level under "Xbox" is compared against
  // other "Xbox > Games > ..." entries, never against an unrelated "Games"
  // level that happens to sit under "PlayStation". Exact case-insensitive
  // match wins first per segment; a fuzzy one-contains-the-other fallback
  // (same idea as isSimilarProductName, just simpler since these are short
  // brand/line names, not full product titles) catches near-misses like
  // "Xbox" vs "XBox". A segment with nothing close becomes a new node at
  // that point in the tree (and everything below it also has to be new,
  // there being nothing established yet to match against). null stays null.
  // Public (not just an updateProductProfile implementation detail) so
  // index.ts's runProductLookup can resolve the CANONICAL path before
  // deciding whether a brand-logo search is even needed (see
  // getFamilyLogoUrl above) — calling it again inside updateProductProfile
  // on an already-resolved string is harmless, it just matches itself.
  resolveFamilyName(candidate) {
    const trimmed = candidate?.trim();
    if (!trimmed) return null;
    const segments = trimmed.split(">").map((s) => s.trim()).filter(Boolean);
    if (!segments.length) return null;
    const existingPaths = this.db.prepare("SELECT DISTINCT family FROM products WHERE family IS NOT NULL AND family != ''").all().map((row) => row.family.split(">").map((s) => s.trim()).filter(Boolean));
    const resolved = [];
    for (let depth = 0; depth < segments.length; depth++) {
      const candidateSegment = segments[depth];
      const candidateLower = candidateSegment.toLowerCase();
      const siblings = existingPaths.filter((path3) => path3.length > depth && resolved.every((seg, i) => path3[i].toLowerCase() === seg.toLowerCase())).map((path3) => path3[depth]);
      const match = siblings.find((sib) => {
        const sibLower = sib.toLowerCase();
        return sibLower === candidateLower || sibLower.includes(candidateLower) || candidateLower.includes(sibLower);
      });
      resolved.push(match ?? candidateSegment);
    }
    return resolved.join(" > ");
  }
  setProductLoading(id, loading) {
    this.db.prepare("UPDATE products SET loading = ?, updated_at = ? WHERE id = ?").run(loading ? 1 : 0, Date.now(), id);
  }
  // Manual correction/input from the Database screen. Title and the
  // research writeup are hand-corrections for when either gets something
  // wrong or goes stale; resalePriceUsd/resaleTimeToSell are the user's own
  // real sales history (what THEY actually sold this for, and how long it
  // took) — never touched by research or scanning, only ever set here.
  // imageUrl/keepThumbnail are the manual-thumbnail feature (see
  // products:pickThumbnail in index.ts) — imageUrl here is always a
  // data: URI already downloaded by the caller, never a bare remote URL.
  // Category stays AI-only (a controlled list, no reason to hand-correct).
  editProductProfile(id, patch) {
    const now2 = Date.now();
    if (patch.name !== void 0 && patch.name.trim()) {
      this.db.prepare("UPDATE products SET name = ?, updated_at = ? WHERE id = ?").run(patch.name.trim(), now2, id);
    }
    if (patch.aiSummary !== void 0) {
      this.db.prepare("UPDATE products SET ai_summary = ?, updated_at = ? WHERE id = ?").run(patch.aiSummary, now2, id);
    }
    if (patch.imageUrl !== void 0) {
      this.db.prepare("UPDATE products SET image_url = ?, updated_at = ? WHERE id = ?").run(patch.imageUrl, now2, id);
    }
    if (patch.keepThumbnail !== void 0) {
      this.db.prepare("UPDATE products SET keep_thumbnail = ?, updated_at = ? WHERE id = ?").run(patch.keepThumbnail ? 1 : 0, now2, id);
    }
    if (patch.resalePriceUsd !== void 0) {
      this.db.prepare("UPDATE products SET resale_price_usd = ?, updated_at = ? WHERE id = ?").run(patch.resalePriceUsd, now2, id);
    }
    if (patch.resaleTimeToSell !== void 0) {
      const trimmed = patch.resaleTimeToSell?.trim() || null;
      this.db.prepare("UPDATE products SET resale_time_to_sell = ?, updated_at = ? WHERE id = ?").run(trimmed, now2, id);
    }
    if (patch.desiredPriceUsd !== void 0) {
      this.db.prepare("UPDATE products SET desired_price_usd = ?, updated_at = ? WHERE id = ?").run(patch.desiredPriceUsd, now2, id);
    }
    if (patch.hardCapAtDesiredPrice !== void 0) {
      this.db.prepare("UPDATE products SET hard_cap_at_desired_price = ?, updated_at = ? WHERE id = ?").run(patch.hardCapAtDesiredPrice ? 1 : 0, now2, id);
    }
    if (patch.prioritized !== void 0) {
      this.db.prepare("UPDATE products SET prioritized = ?, updated_at = ? WHERE id = ?").run(patch.prioritized ? 1 : 0, now2, id);
    }
  }
  // User-authored, from that product's own Database chat (see chat.ts's
  // add_product_watch_note) — practical things to check for in real
  // listings (bundled extras, condition red flags). Append-only, capped to
  // the most recent entries, same pattern as recordProductObservation.
  // Returns the updated product so the caller can push a live UI update.
  appendProductWatchNote(id, note) {
    const trimmed = note.trim();
    if (!trimmed) return null;
    const product = this.getProductById(id);
    if (!product) return null;
    const prior = product.lookoutNotes ? product.lookoutNotes.split("\n---\n") : [];
    const next = [...prior, trimmed].slice(-15).join("\n---\n");
    this.db.prepare("UPDATE products SET lookout_notes = ?, updated_at = ? WHERE id = ?").run(next, Date.now(), id);
    return this.getProductById(id);
  }
  listProducts() {
    const rows = this.db.prepare("SELECT * FROM products ORDER BY created_at DESC").all();
    return rows.map(rowToProduct);
  }
  // A light view of the Database for lookups that only need to know which products exist: id, name and family, newest first. It
  // never reads a product's photo (a row's thumbnail is ~90 KB of text, so listProducts() on a library of hundreds is tens of
  // megabytes), and it is read fresh each time, so a product added a moment ago is always seen. Use this, not listProducts(),
  // for name matching and name lists; load the one row you need afterwards with getProductById.
  // The entries with no thumbnail yet (id and name only, never the photos of the others): what the background "research blank entries" sweep needs.
  listBlankProductIndex() {
    return this.db.prepare("SELECT id, name FROM products WHERE image_url IS NULL OR image_url = '' ORDER BY created_at DESC").all();
  }
  listProductIndex() {
    return this.db.prepare("SELECT id, name, family FROM products ORDER BY created_at DESC").all();
  }
  getProductById(id) {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    return row ? rowToProduct(row) : null;
  }
  // Case-insensitive exact-ish match used to link a Search For item's name
  // to a product profile for extra scoring context.
  getProductByName(name) {
    const row = this.db.prepare("SELECT * FROM products WHERE LOWER(name) = LOWER(?)").get(name);
    return row ? rowToProduct(row) : null;
  }
  // Exact match first, then a fuzzy fallback (see isSimilarProductName) —
  // this is what lets a differently-phrased listing of a product already in
  // the Database strengthen that existing entry instead of spawning a
  // near-duplicate one under its own slightly different name.
  findMatchingProduct(name) {
    const exact = this.getProductByName(name);
    if (exact) return exact;
    const similar = this.listProductIndex().find((p) => isSimilarProductName(name, p.name));
    return similar ? this.getProductById(similar.id) : null;
  }
  // Clynx Cloud Phase 6 — productSync.ts's own applier, mirroring
  // Store.upsertWatchFromCloud exactly: applies a remote product profile
  // (already decided by the caller to be newer, via its own updated_at
  // comparison — this method does no conflict logic of its own) into local
  // SQLite, keyed by the SAME id the remote row carries as its localId.
  // Inserts a brand-new row when this id doesn't exist locally yet (a
  // product added on another device), or overwrites the synced fields on an
  // existing row otherwise. Deliberately leaves image_url/family_logo_url/
  // loading untouched either way — those are either local-only binary data
  // (data: URIs, out of Phase 6's sync scope — see 006_products.sql) or, for
  // loading, a purely local in-flight-research flag that a remote write
  // should never toggle. Never called from chat.ts, index.ts's
  // runProductLookup, or any other product-mutation call site — those
  // remain untouched and keep going through addProductStub/
  // updateProductProfile/editProductProfile etc. above.
  upsertProductFromCloud(product) {
    const existing = this.getProductById(product.id);
    if (existing) {
      this.db.prepare(
        `UPDATE products SET
            name = ?, ai_summary = ?, ai_summary_generated_at = ?, observed_notes = ?, category = ?, family = ?,
            resale_price_usd = ?, resale_time_to_sell = ?, lookout_notes = ?, keep_thumbnail = ?,
            desired_price_usd = ?, hard_cap_at_desired_price = ?, prioritized = ?,
            ebay_avg_sold_price_usd = ?, ebay_avg_run_time_days = ?, ebay_avg_shipping_usd = ?,
            ebay_comps_sample_size = ?, ebay_comps_checked_at = ?, updated_at = ?
           WHERE id = ?`
      ).run(
        product.name,
        product.aiSummary,
        product.aiSummaryGeneratedAt,
        product.observedNotes,
        product.category,
        this.resolveFamilyName(product.family),
        product.resalePriceUsd,
        product.resaleTimeToSell,
        product.lookoutNotes,
        product.keepThumbnail ? 1 : 0,
        product.desiredPriceUsd,
        product.hardCapAtDesiredPrice ? 1 : 0,
        product.prioritized ? 1 : 0,
        product.ebayAvgSoldPriceUsd,
        product.ebayAvgRunTimeDays,
        product.ebayAvgShippingUsd,
        product.ebayCompsSampleSize,
        product.ebayCompsCheckedAt,
        product.updatedAt,
        product.id
      );
    } else {
      this.db.prepare(
        `INSERT INTO products (
            id, name, ai_summary, ai_summary_generated_at, observed_notes, category, family,
            resale_price_usd, resale_time_to_sell, lookout_notes, keep_thumbnail,
            desired_price_usd, hard_cap_at_desired_price, prioritized,
            ebay_avg_sold_price_usd, ebay_avg_run_time_days, ebay_avg_shipping_usd,
            ebay_comps_sample_size, ebay_comps_checked_at, loading, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(
        product.id,
        product.name,
        product.aiSummary,
        product.aiSummaryGeneratedAt,
        product.observedNotes,
        product.category,
        this.resolveFamilyName(product.family),
        product.resalePriceUsd,
        product.resaleTimeToSell,
        product.lookoutNotes,
        product.keepThumbnail ? 1 : 0,
        product.desiredPriceUsd,
        product.hardCapAtDesiredPrice ? 1 : 0,
        product.prioritized ? 1 : 0,
        product.ebayAvgSoldPriceUsd,
        product.ebayAvgRunTimeDays,
        product.ebayAvgShippingUsd,
        product.ebayCompsSampleSize,
        product.ebayCompsCheckedAt,
        product.createdAt,
        product.updatedAt
      );
    }
    return this.getProductById(product.id);
  }
  deleteProduct(id) {
    this.db.prepare("DELETE FROM products WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM product_images WHERE product_id = ?").run(id);
    this.identity?.forgetProduct(id);
    this.addPendingCloudDelete("product", id);
  }
  // Per explicit instruction — the Database's own "Clear all" button,
  // same shape as Feed's clearAllListings. Only the products themselves
  // and their reference-photo galleries; the Blacklist and Blacklisted
  // Images sections are separate data and untouched by this, same as
  // Feed's clear-all never touches the Blacklist either.
  clearAllProducts() {
    this.db.exec("DELETE FROM product_images; DELETE FROM products;");
    this.identity?.forgetAllProducts();
  }
  // --- Product reference-photo library ------------------------------------
  // See types.ts's ProductImage: a growing library of confirmed-genuine
  // photos per product, auto-populated whenever the scanner confirms a real
  // deal for it (see scrapeEngine.ts's evaluateListing), plus whatever the
  // user adds/removes by hand from the product's own page.
  static MAX_IMAGES_PER_PRODUCT = 20;
  listProductImages(productId) {
    const rows = this.db.prepare("SELECT * FROM product_images WHERE product_id = ? ORDER BY created_at DESC").all(productId);
    return rows.map(rowToProductImage);
  }
  // Auto-called on a confirmed deal, or the user manually adding one from
  // the product's page — same storage either way. Prunes the oldest once
  // over the cap so a long-running scan session can't grow this
  // unboundedly; a manually-added photo is just as prunable as an
  // auto-added one; the cap protects DB size, not curation intent.
  addProductImage(productId, imageData, sourceTitle, kind = "normal") {
    const id = (0, import_node_crypto3.randomUUID)();
    this.db.prepare("INSERT INTO product_images (id, product_id, image_data, source_title, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)").run(id, productId, imageData, sourceTitle, Date.now(), kind);
    const excess = this.db.prepare("SELECT id FROM product_images WHERE product_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?").all(productId, _Store.MAX_IMAGES_PER_PRODUCT);
    for (const row of excess) {
      this.db.prepare("DELETE FROM product_images WHERE id = ?").run(row.id);
    }
    return { id, productId, imageData, sourceTitle, createdAt: Date.now(), kind };
  }
  // How many ordinary (non-poor-condition) reference photos each product
  // has — one grouped query instead of loading every photo's bytes just to
  // count them. Products with none are simply absent from the map.
  countNormalImagesByProduct() {
    const rows = this.db.prepare("SELECT product_id, COUNT(*) as n FROM product_images WHERE kind = 'normal' GROUP BY product_id").all();
    return new Map(rows.map((r) => [r.product_id, r.n]));
  }
  // Bumps updated_at without changing anything else — for writes that only
  // touch product_images (which has no timestamp of its own on the product
  // row), so cloud sync and any UI keyed off updatedAt still notice them.
  touchProduct(id) {
    this.db.prepare("UPDATE products SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }
  deleteProductImage(id) {
    this.db.prepare("DELETE FROM product_images WHERE id = ?").run(id);
  }
  // Used by the general-tier vision check (see scrapeEngine.ts) to pick a
  // small, bounded set of known products to compare an unmatched listing's
  // photos against — capped there, not here, since the caller decides how
  // many reference images it can afford to attach to one vision call.
  // Ordered by most-recently-added image first, as a simple proxy for
  // "products the user has actively been finding/curating lately."
  listProductsWithImages(limit) {
    const rows = this.db.prepare(
      `SELECT DISTINCT product_id, MAX(created_at) as latest FROM product_images GROUP BY product_id ORDER BY latest DESC LIMIT ?`
    ).all(limit);
    const result = [];
    for (const row of rows) {
      const product = this.getProductById(row.product_id);
      if (!product) continue;
      result.push({ product, images: this.listProductImages(row.product_id).filter((img) => img.kind === "normal") });
    }
    return result;
  }
  // Per explicit instruction — the Prioritize star's actual mechanical
  // effect: every product marked prioritized gets included in the vision
  // "does this listing show a product I already know" reference set (see
  // scrapeEngine.ts's runPhotoAnalysis), regardless of how recently it was
  // last touched — listProductsWithImages above only ever returns the 3
  // MOST RECENT, which would routinely leave out a prioritized product
  // that hasn't come up in a while, exactly when the user wants the
  // opposite (found as often as possible). Only returns ones that actually
  // have at least one reference photo to compare against — a prioritized
  // product with none yet has nothing to visually match on regardless of
  // how much it's prioritized.
  listPrioritizedProductsWithImages() {
    const rows = this.db.prepare("SELECT id FROM products WHERE prioritized = 1").all();
    const result = [];
    for (const row of rows) {
      const product = this.getProductById(row.id);
      if (!product) continue;
      const images = this.listProductImages(row.id).filter((img) => img.kind === "normal");
      if (images.length) result.push({ product, images });
    }
    return result;
  }
  // Reinforcement, not discovery: called while the scanner evaluates a
  // listing that resolves to a recognizable product name (a Search For
  // match, or the AI's own general-deal category guess) — whether or not
  // that particular listing turned out to be a deal. Builds a running log of
  // real observed details (condition notes, bundle contents, anything the AI
  // noticed) so a product the user already asked about keeps getting
  // smarter as more listings for it turn up.
  //
  // Deliberately append-only — this never creates a new product record. Per
  // explicit instruction, the Database should only ever contain products
  // the user actually asked about (via chat's research_product, or the
  // Feed's Research button — see index.ts), never every product the scanner
  // happens to pass over; that's what "keeping tabs" without "cluttering
  // the Database" means in practice. So if `name` doesn't match anything
  // already in the Database — exactly or similarly, see findMatchingProduct
  // — there's nothing to reinforce and this is a silent no-op, not a
  // fallback creation. Capped to the most recent entries so this can't grow
  // unbounded over a long-running scan session. Returns the updated product
  // (or null if there was nothing to reinforce) so callers can push a live
  // Database update.
  recordProductObservation(name, note) {
    const trimmedName = name.trim();
    const trimmedNote = note.trim();
    if (!trimmedName || !trimmedNote) return null;
    const match = this.findMatchingProduct(trimmedName);
    if (!match) return null;
    return this.appendProductObservation(match, trimmedName, trimmedNote);
  }
  // The same note, written to a product the caller already resolved (the identity check may have picked a more
  // specific model than the one the name alone would fuzzy-match).
  appendProductObservation(match, trimmedName, trimmedNote) {
    const sameName = match.name.toLowerCase() === trimmedName.toLowerCase();
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const entry = sameName ? `[${date}] ${trimmedNote}` : `[${date}] (also seen listed as "${trimmedName}") ${trimmedNote}`;
    const prior = match.observedNotes ? match.observedNotes.split("\n---\n") : [];
    const next = [...prior, entry].slice(-15).join("\n---\n");
    this.db.prepare("UPDATE products SET observed_notes = ?, updated_at = ? WHERE id = ?").run(next, Date.now(), match.id);
    return this.getProductById(match.id);
  }
  // --- Category dismissals ("not interested" learning) -------------------
  // General-tier (unverified) deals carry a coarse AI-guessed category
  // (e.g. "cordless power tool") — this is deliberately scoped to that
  // pathway only, never to Search For items, since something you
  // explicitly added to Search For is by definition something you're
  // interested in; there's nothing to learn to skip there.
  // "category" is matched case-insensitively via COLLATE NOCASE at the
  // column level below, so this can just upsert on the raw string.
  recordCategoryDismissal(category) {
    const trimmed = category.trim();
    if (!trimmed) return;
    this.db.prepare(
      `INSERT INTO category_dismissals (category, count, last_dismissed_at) VALUES (?, 1, ?)
         ON CONFLICT(category) DO UPDATE SET count = count + 1, last_dismissed_at = excluded.last_dismissed_at`
    ).run(trimmed, Date.now());
  }
  // Categories dismissed `minCount` times or more — used as a cheap
  // substring-match pre-filter (see scorer.ts) to skip the general-deal AI
  // call entirely for listings matching a category the user has
  // consistently shown no interest in, rather than re-flagging the same
  // kind of thing forever.
  getDismissedCategories(minCount = 3) {
    const rows = this.db.prepare("SELECT category FROM category_dismissals WHERE count >= ?").all(minCount);
    return rows.map((r) => r.category);
  }
  // --- Blacklist -----------------------------------------------------------
  // See types.ts's BlacklistTerm — a growing list of terms/phrases that
  // instantly skip a listing (see isBlacklisted below) before it's ever
  // opened, for things categorically unrelated to a mail-order resale
  // business, distinct from category_dismissals above (which is about
  // resalable-but-uninteresting items, learned from repeated "Not
  // interested" clicks, not a hard skip).
  listBlacklistTerms() {
    const rows = this.db.prepare("SELECT * FROM blacklist_terms ORDER BY created_at DESC").all();
    return rows.map((r) => ({ term: r.term, source: r.source, createdAt: r.created_at }));
  }
  // Normalized (trimmed + lowercased) so "Apartment" and "apartment" are
  // the same entry — the primary key is the normalized form itself rather
  // than a separate id, which makes de-duping a plain INSERT OR IGNORE
  // instead of a separate existence check.
  // Per explicit instruction — "any time the AI blacklists something, make
  // sure it blacklists both the title and the image if possible": image is
  // genuinely optional (a chat-triggered "blacklist X" has no listing/photo
  // behind it at all) — only ever added when a caller actually has one in
  // hand for the SAME listing/product the term came from. Reuses
  // addBlacklistedImage below rather than a separate table, so it shows up
  // in the exact same Blacklisted Images gallery future thumbnail checks
  // already compare against.
  addBlacklistTerm(term, source2, image) {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return null;
    const createdAt = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO blacklist_terms (term, source, created_at) VALUES (?, ?, ?)").run(normalized, source2, createdAt);
    const row = this.db.prepare("SELECT * FROM blacklist_terms WHERE term = ?").get(normalized);
    if (!row) return null;
    if (image?.imageData) {
      this.addBlacklistedImage(image.imageData, image.sourceTitle, null, `Blacklisted alongside the term "${normalized}"`, normalized);
    }
    return { term: row.term, source: row.source, createdAt: row.created_at };
  }
  removeBlacklistTerm(term) {
    this.db.prepare("DELETE FROM blacklist_terms WHERE term = ?").run(term.trim().toLowerCase());
  }
  // --- Blacklisted images ----------------------------------------------
  // See types.ts's BlacklistedImage — the photo counterpart to the term
  // blacklist above, for a listing recognized as ineligible from its
  // THUMBNAIL alone (see vision.ts's classifyThumbnailImage and
  // scrapeEngine.ts's evaluateListing), independent of what its title says.
  static MAX_BLACKLISTED_IMAGES = 40;
  // Confirmed-first, newest-first within each group — a user-reviewed
  // example is worth more than an unreviewed AI guess both for the Database
  // gallery (so genuinely-checked examples surface first) and as the
  // reference set future thumbnail checks are compared against.
  listBlacklistedImages() {
    const rows = this.db.prepare("SELECT * FROM blacklisted_images ORDER BY confirmed DESC, created_at DESC").all();
    return rows.map((r) => ({
      id: r.id,
      imageData: r.image_data,
      sourceTitle: r.source_title,
      category: r.category,
      reason: r.reason,
      confirmed: !!r.confirmed,
      createdAt: r.created_at,
      linkedTerm: r.linked_term
    }));
  }
  addBlacklistedImage(imageData, sourceTitle, category, reason, linkedTerm = null) {
    const id = (0, import_node_crypto3.randomUUID)();
    const createdAt = Date.now();
    this.db.prepare(
      "INSERT INTO blacklisted_images (id, image_data, source_title, category, reason, confirmed, created_at, linked_term) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
    ).run(id, imageData, sourceTitle, category, reason, createdAt, linkedTerm);
    const keepUnconfirmed = Math.max(0, _Store.MAX_BLACKLISTED_IMAGES - this.countConfirmedBlacklistedImages());
    const excessUnconfirmed = this.db.prepare("SELECT id FROM blacklisted_images WHERE confirmed = 0 ORDER BY created_at DESC LIMIT -1 OFFSET ?").all(keepUnconfirmed);
    for (const row of excessUnconfirmed) {
      this.db.prepare("DELETE FROM blacklisted_images WHERE id = ?").run(row.id);
    }
    return { id, imageData, sourceTitle, category, reason, confirmed: false, createdAt, linkedTerm };
  }
  countConfirmedBlacklistedImages() {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM blacklisted_images WHERE confirmed = 1").get();
    return row.n;
  }
  // The user reviewing the Database gallery and agreeing the AI got this
  // one right — see BlacklistedImage.confirmed.
  confirmBlacklistedImage(id) {
    this.db.prepare("UPDATE blacklisted_images SET confirmed = 1 WHERE id = ?").run(id);
  }
  // The user reviewing the gallery and deciding the AI got this one WRONG —
  // per explicit instruction, removes it outright rather than leaving a
  // known-bad example sitting around (it would otherwise keep getting sent
  // as a reference example to future vision checks).
  removeBlacklistedImage(id) {
    this.db.prepare("DELETE FROM blacklisted_images WHERE id = ?").run(id);
  }
  // Deterministic, no AI call — checked before a listing is ever opened
  // (see scrapeEngine.ts), same "skip before spending anything on it"
  // posture as isSuspiciousPrice/isLikelyUnshippable. Whole-word/phrase
  // matched (not a raw substring) so a short term like "art" doesn't match
  // "cart" or "smart" — the same reasoning as scorer.ts's
  // titleContainsAllWords, just for one phrase rather than requiring every
  // word of it to appear (a blacklist phrase like "for rent" should match
  // as that exact phrase, not just "for" and "rent" appearing anywhere).
  isBlacklisted(title) {
    const lower = title.toLowerCase();
    for (const { term } of this.listBlacklistTerms()) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`).test(lower)) return term;
    }
    return null;
  }
  setFeedback(listingId, verdict, note) {
    const now2 = Date.now();
    this.db.prepare(
      `INSERT INTO feedback (listing_id, verdict, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, updated_at = excluded.updated_at`
    ).run(listingId, verdict, note, now2, now2);
  }
  clearFeedback(listingId) {
    this.db.prepare("DELETE FROM feedback WHERE listing_id = ?").run(listingId);
    this.addPendingCloudDelete("feedback", listingId);
  }
  // --- Clynx Cloud Phase 5 — Feed feedback sync ---------------------------
  // feedbackSync.ts's only caller into this table. Mirrors the
  // Watch/watchSync.ts push/pull shape: an in-memory sync cursor on the
  // service side compares against updated_at here, exactly like watches.
  // All feedback rows, for feedbackSync.ts's push — filtered by the
  // service's own in-memory cursor, same pattern as Store.listWatches()
  // feeding WatchSyncService.push().
  listFeedbackRaw() {
    const rows = this.db.prepare("SELECT listing_id, verdict, note, created_at, updated_at FROM feedback").all();
    return rows.map((r) => ({
      listingId: r.listing_id,
      verdict: r.verdict,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? r.created_at
    }));
  }
  // Single row lookup, for feedbackSync.ts's pull-side last-write-wins
  // comparison (mirrors Store.getWatchById's role in WatchSyncService.pull).
  getFeedbackRaw(listingId) {
    const row = this.db.prepare("SELECT verdict, note, updated_at, created_at FROM feedback WHERE listing_id = ?").get(listingId);
    if (!row) return null;
    return { verdict: row.verdict, note: row.note, updatedAt: row.updated_at ?? row.created_at };
  }
  // Applies a remote feedback row pulled from cloud. Only ever called after
  // feedbackSync.ts has already confirmed the remote row is strictly newer
  // (or there's no local row yet) — mirrors Store.upsertWatchFromCloud.
  // Only touches a listing that actually exists locally (feedback's FK to
  // listings) — a remote row for a listing this device has never seen is
  // silently skipped, same as it would be for any other cross-device
  // feedback reference.
  upsertFeedbackFromCloud(listingId, verdict, note, updatedAt) {
    const listingExists = this.db.prepare("SELECT 1 FROM listings WHERE id = ?").get(listingId);
    if (!listingExists) return;
    this.db.prepare(
      `INSERT INTO feedback (listing_id, verdict, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, updated_at = excluded.updated_at`
    ).run(listingId, verdict, note, updatedAt, updatedAt);
  }
  listRecent(limit = 200, offset = 0) {
    const rows = this.db.prepare(
      `SELECT l.*, f.verdict as feedback_verdict, f.note as feedback_note,
           (SELECT group_concat(w.name, char(31)) FROM watch_matches wm2 JOIN watches w ON w.id = wm2.watch_id WHERE wm2.listing_id = l.id) as watch_names
         FROM listings l LEFT JOIN feedback f ON f.listing_id = l.id
         ORDER BY l.first_seen_at DESC LIMIT ? OFFSET ?`
    ).all(limit, offset);
    return this.enrichManyWithMatchedProductPricing(rows.map(rowToRecord));
  }
  // Per explicit instruction — "the Listings Evaluated caps at 500, make it
  // have no cap": Dashboard's own stat used to just read listings.length off
  // the same capped listListings(500, 0) page the Feed uses for display,
  // which is fine for a scrollable feed but silently ceilings the all-time
  // stat once evaluation volume actually passes 500. A real COUNT(*) instead
  // of fetching every row keeps this cheap regardless of how large the table
  // grows.
  countListings() {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM listings").get();
    return row.count;
  }
  // Clynx Cloud Phase 3 — listingIngestSync.ts's downstream mirror push.
  // Every scanned listing (not just scored deals — see that file's own
  // comment for why), oldest-unsynced-first so a long backlog after a
  // fresh cloud.enabled flip drains in a stable order rather than always
  // re-picking whatever's newest. cloud_synced_at IS NULL covers both
  // "never pushed" and any row that failed a previous push attempt.
  listUnsyncedListings(limit = 50) {
    const rows = this.db.prepare(
      `SELECT l.*, f.verdict as feedback_verdict, f.note as feedback_note
         FROM listings l LEFT JOIN feedback f ON f.listing_id = l.id
         WHERE l.cloud_synced_at IS NULL
         ORDER BY l.first_seen_at ASC LIMIT ?`
    ).all(limit);
    return rows.map((row) => rowToRecord(row));
  }
  markListingsCloudSynced(ids) {
    if (ids.length === 0) return;
    const now2 = Date.now();
    const stmt = this.db.prepare("UPDATE listings SET cloud_synced_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(now2, id);
  }
  // Batch 2 Fix E — a listing whose ingest keeps getting rejected as invalid
  // by the cloud (a per-item validation failure reported in the ingest
  // response's own `failures` array — see listingIngestSync.ts — as opposed
  // to a network/request-level failure, which never calls this) would
  // otherwise sit in listUnsyncedListings' backlog and get retried, and
  // fail, every single tick forever. Each rejection bumps this listing's own
  // counter; once it's been rejected more than GIVE_UP_THRESHOLD times, this
  // sets cloud_synced_at to the -1 sentinel — listUnsyncedListings' existing
  // `WHERE cloud_synced_at IS NULL` filter already naturally excludes it
  // from every future tick without that query needing to know anything
  // about sentinels or attempt counts.
  static LISTING_CLOUD_SYNC_GIVE_UP_THRESHOLD = 5;
  recordListingCloudSyncFailures(ids) {
    if (ids.length === 0) return;
    const bump = this.db.prepare("UPDATE listings SET cloud_sync_attempts = cloud_sync_attempts + 1 WHERE id = ?");
    const giveUp = this.db.prepare("UPDATE listings SET cloud_synced_at = -1 WHERE id = ?");
    const readAttempts = this.db.prepare("SELECT cloud_sync_attempts FROM listings WHERE id = ?");
    for (const id of ids) {
      bump.run(id);
      const row = readAttempts.get(id);
      if (row && row.cloud_sync_attempts > _Store.LISTING_CLOUD_SYNC_GIVE_UP_THRESHOLD) giveUp.run(id);
    }
  }
  // --- Batch 2 Fix B — pending cloud deletes ------------------------------
  // A delete that happened locally (deleteWatch/clearFeedback/deleteProduct
  // below, the only writers) but hasn't been confirmed propagated to the
  // cloud mirror yet. watchSync.ts/feedbackSync.ts/productSync.ts each drain
  // their own resource_type's rows every sync tick.
  //
  // Residual limitation (documented per explicit instruction, not fully
  // closed by this fix): the DELETE and this INSERT are two separate
  // synchronous SQLite statements, not wrapped in one explicit transaction —
  // a crash landing in the narrow window between them could in principle
  // still lose the intent to propagate a delete that already happened
  // locally, letting a later pull resurrect it. Vanishingly unlikely (both
  // statements run back-to-back with no I/O or async work between them) and
  // out of scope for this fix; a real transaction would close it fully.
  addPendingCloudDelete(resourceType, localId) {
    this.db.prepare("INSERT OR IGNORE INTO pending_cloud_deletes (resource_type, local_id, created_at) VALUES (?, ?, ?)").run(resourceType, localId, Date.now());
  }
  listPendingCloudDeletes(resourceType) {
    const rows = this.db.prepare("SELECT local_id FROM pending_cloud_deletes WHERE resource_type = ?").all(resourceType);
    return rows.map((r) => r.local_id);
  }
  removePendingCloudDelete(resourceType, localId) {
    this.db.prepare("DELETE FROM pending_cloud_deletes WHERE resource_type = ? AND local_id = ?").run(resourceType, localId);
  }
  // Recent labeled examples, used as few-shot context to steer future AI
  // calls — see scorer.ts's extractGeneralDeal, the first (and, per
  // explicit instruction, intended) consumer of this.
  getFeedbackExamples(limit = 4) {
    const rows = this.db.prepare(
      `SELECT l.title, l.reasoning, f.verdict, f.note
         FROM feedback f JOIN listings l ON l.id = f.listing_id
         ORDER BY f.created_at DESC LIMIT ?`
    ).all(limit);
    return rows.map((r) => ({ title: r.title, verdict: r.verdict, note: r.note, reasoning: r.reasoning }));
  }
  // Condition-awareness — ListingCard's "?" badge confirm/deny, captured
  // as-is with no AI call here (the point is recording the user's raw
  // answer; the AI only ever sees it later, batched, via
  // getFlawFeedbackExamples on the NEXT listing's own vision call).
  addFlawFeedback(entry) {
    this.db.prepare(
      `INSERT INTO flaw_feedback (id, listing_id, photo_number, description, confidence, confirmed, listing_title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run((0, import_node_crypto3.randomUUID)(), entry.listingId, entry.photoNumber, entry.description, entry.confidence, entry.confirmed ? 1 : 0, entry.listingTitle, Date.now());
  }
  // Mirrors getFeedbackExamples above exactly — same few-shot-training-
  // example idea, just for flaw flags instead of deal verdicts. See
  // vision.ts's buildFlawFeedbackExamplesBlock, the one consumer of this.
  getFlawFeedbackExamples(limit = 6) {
    const rows = this.db.prepare(`SELECT listing_title, description, confidence, confirmed FROM flaw_feedback ORDER BY created_at DESC LIMIT ?`).all(limit);
    return rows.map((r) => ({ listingTitle: r.listing_title, description: r.description, confidence: r.confidence, confirmed: !!r.confirmed }));
  }
  // --- Watch (persistent background monitoring) --------------------------
  // Per explicit instruction — unlike searchItems (session-scoped, reset
  // every launch — see config.ts's loadConfig), Watches persist across app/
  // scanner/account restarts by design, which is exactly why they live in
  // SQLite instead of Config. See types.ts's Watch/WatchMatch for the full
  // shape and reasoning.
  // A Watch's own ntfy topic (see Watch.ntfyTopic); null or blank goes back to the topic in Config.
  setWatchNtfyTopic(id, topic) {
    const clean = topic?.trim() || null;
    this.db.prepare("UPDATE watches SET ntfy_topic = ?, updated_at = ? WHERE id = ?").run(clean, Date.now(), id);
    return this.getWatchById(id);
  }
  createWatch(data) {
    const id = (0, import_node_crypto3.randomUUID)();
    const now2 = Date.now();
    const first = data.terms?.[0];
    const searchPhrase = first ? first.phrase : data.searchPhrase;
    const matchKeywords = first ? first.matchKeywords : data.matchKeywords;
    const linkedProductId = first ? first.linkedProductId : data.linkedProductId;
    this.db.prepare(
      `INSERT INTO watches (
          id, name, platform, search_phrase, match_keywords, linked_product_id,
          min_price_usd, max_price_usd, min_profit_usd, min_discount_percent, max_listing_age_minutes, min_seller_rating_percent,
          location_mode, selected_state, selected_city_or_zip, search_radius_miles,
          terms_json, check_interval_minutes, account_ids,
          enabled, listings_seen_count, match_count, created_at, updated_at, next_check_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`
    ).run(
      id,
      data.name,
      data.platform ?? "facebook",
      searchPhrase,
      JSON.stringify(matchKeywords),
      linkedProductId,
      data.minPriceUsd,
      data.maxPriceUsd,
      data.minProfitUsd,
      data.minDiscountPercent,
      data.maxListingAgeMinutes,
      data.minSellerRatingPercent ?? null,
      data.locationMode,
      data.selectedState,
      data.selectedCityOrZip,
      data.searchRadiusMiles,
      data.terms?.length ? JSON.stringify(data.terms) : null,
      data.checkIntervalMinutes ?? 15,
      data.accountIds?.length ? JSON.stringify(data.accountIds) : null,
      now2,
      now2,
      // Due immediately — the active scheduler (once it exists) picks up
      // any watch whose next_check_at has already passed on its very
      // first poll tick, rather than waiting a full interval before a
      // brand-new watch gets its first active check.
      now2
    );
    return this.getWatchById(id);
  }
  updateWatch(id, patch) {
    const existing = this.getWatchById(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    if (patch.terms?.length) {
      merged.searchPhrase = patch.terms[0].phrase;
      merged.matchKeywords = patch.terms[0].matchKeywords;
      merged.linkedProductId = patch.terms[0].linkedProductId;
    } else {
      merged.terms = [
        { phrase: merged.searchPhrase, matchKeywords: merged.matchKeywords, linkedProductId: merged.linkedProductId },
        ...existing.terms.slice(1)
      ];
    }
    const locationChanged = merged.locationMode !== existing.locationMode || merged.selectedState !== existing.selectedState || merged.selectedCityOrZip !== existing.selectedCityOrZip || merged.searchRadiusMiles !== existing.searchRadiusMiles;
    this.db.prepare(
      `UPDATE watches SET
          name = ?, search_phrase = ?, match_keywords = ?, linked_product_id = ?,
          min_price_usd = ?, max_price_usd = ?, min_profit_usd = ?, min_discount_percent = ?, max_listing_age_minutes = ?, min_seller_rating_percent = ?,
          location_mode = ?, selected_state = ?, selected_city_or_zip = ?, search_radius_miles = ?,
          resolved_location_url = ?, resolved_location_label = ?, resolved_location_checked_at = ?, resolved_location_urls = ?,
          terms_json = ?, check_interval_minutes = ?, account_ids = ?,
          updated_at = ?
         WHERE id = ?`
    ).run(
      merged.name,
      merged.searchPhrase,
      JSON.stringify(merged.matchKeywords),
      merged.linkedProductId,
      merged.minPriceUsd,
      merged.maxPriceUsd,
      merged.minProfitUsd,
      merged.minDiscountPercent,
      merged.maxListingAgeMinutes,
      merged.minSellerRatingPercent ?? null,
      merged.locationMode,
      merged.selectedState,
      merged.selectedCityOrZip,
      merged.searchRadiusMiles,
      locationChanged ? null : merged.resolvedLocationUrl,
      locationChanged ? null : merged.resolvedLocationLabel,
      locationChanged ? null : merged.resolvedLocationCheckedAt,
      locationChanged || !merged.resolvedLocationUrls?.length ? null : JSON.stringify(merged.resolvedLocationUrls),
      JSON.stringify(merged.terms),
      merged.checkIntervalMinutes ?? 15,
      merged.accountIds?.length ? JSON.stringify(merged.accountIds) : null,
      Date.now(),
      id
    );
    const termsChanged = JSON.stringify(merged.terms.map((t) => t.phrase)) !== JSON.stringify(existing.terms.map((t) => t.phrase));
    if (locationChanged || termsChanged) this.clearWatchSearchLinks(id);
    if (locationChanged || termsChanged || merged.minPriceUsd !== existing.minPriceUsd || merged.maxPriceUsd !== existing.maxPriceUsd) {
      this.db.prepare("DELETE FROM watch_seen_listings WHERE watch_id = ?").run(id);
    }
    return this.getWatchById(id);
  }
  // Clynx Cloud Phase 2 (watchSync.ts) — applies a remote watch (already
  // decided by the caller to be newer, via its own updated_at comparison —
  // this method does no conflict logic of its own) into local SQLite,
  // keyed by the SAME id the remote row carries as its localId. Inserts a
  // brand-new row when this id doesn't exist locally yet (a watch created
  // on another device), or overwrites the synced fields on an existing row
  // otherwise. Never called from the scan loop, watchScheduler.ts, or
  // watchMatching.ts — those only ever go through createWatch/updateWatch
  // above, which remain untouched.
  //
  // Batch 2 Fix D — the cloud side no longer carries 8 desktop-local-only
  // operational/scheduler fields (nextCheckAt, lastCheckedAt,
  // lastActiveCheckAt, listingsSeenCount, matchCount, resolvedLocationUrl,
  // resolvedLocationLabel, resolvedLocationCheckedAt — see cloudClient.ts's
  // CloudWatch), so `watch` here is deliberately narrower than the full
  // Watch type and this method's own SQL no longer touches those 8 columns
  // at all: an existing local row keeps whatever it already had for them
  // (a remote sync must never clobber this device's own scheduler state),
  // and a brand-new-to-this-device row gets the SAME defaults
  // Store.createWatch gives a freshly-created watch (due for its first
  // active check immediately, zeroed counters, no cached location).
  upsertWatchFromCloud(watch) {
    const existing = this.getWatchById(watch.id);
    if (existing) {
      this.db.prepare(
        `UPDATE watches SET
            name = ?, search_phrase = ?, match_keywords = ?, linked_product_id = ?,
            min_price_usd = ?, max_price_usd = ?, min_profit_usd = ?, min_discount_percent = ?, max_listing_age_minutes = ?,
            min_seller_rating_percent = ?, platform = ?,
            location_mode = ?, selected_state = ?, selected_city_or_zip = ?, search_radius_miles = ?,
            enabled = ?, updated_at = ?
           WHERE id = ?`
      ).run(
        watch.name,
        watch.searchPhrase,
        JSON.stringify(watch.matchKeywords),
        watch.linkedProductId,
        watch.minPriceUsd,
        watch.maxPriceUsd,
        watch.minProfitUsd,
        watch.minDiscountPercent,
        watch.maxListingAgeMinutes,
        // A cloud row from a server that doesn't know these fields must not
        // wipe the local values (that would turn an eBay Watch back into a
        // Facebook one on the next pull).
        watch.minSellerRatingPercent !== void 0 ? watch.minSellerRatingPercent : existing.minSellerRatingPercent,
        watch.platform ?? existing.platform,
        watch.locationMode,
        watch.selectedState,
        watch.selectedCityOrZip,
        watch.searchRadiusMiles,
        watch.enabled ? 1 : 0,
        watch.updatedAt,
        watch.id
      );
    } else {
      const now2 = Date.now();
      this.db.prepare(
        `INSERT INTO watches (
            id, name, search_phrase, match_keywords, linked_product_id,
            min_price_usd, max_price_usd, min_profit_usd, min_discount_percent, max_listing_age_minutes,
            min_seller_rating_percent, platform,
            location_mode, selected_state, selected_city_or_zip, search_radius_miles,
            enabled, listings_seen_count, match_count, next_check_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
      ).run(
        watch.id,
        watch.name,
        watch.searchPhrase,
        JSON.stringify(watch.matchKeywords),
        watch.linkedProductId,
        watch.minPriceUsd,
        watch.maxPriceUsd,
        watch.minProfitUsd,
        watch.minDiscountPercent,
        watch.maxListingAgeMinutes,
        watch.minSellerRatingPercent ?? null,
        watch.platform ?? "facebook",
        watch.locationMode,
        watch.selectedState,
        watch.selectedCityOrZip,
        watch.searchRadiusMiles,
        watch.enabled ? 1 : 0,
        // Due immediately — same "picked up on the very first poll tick"
        // reasoning as Store.createWatch's own next_check_at.
        now2,
        watch.createdAt,
        watch.updatedAt
      );
    }
    return this.getWatchById(watch.id);
  }
  // Called only by the active scheduler (watchScheduler.ts) once a watch's
  // location resolves — a narrow write touching just the 3 cache columns,
  // unlike updateWatch's full-row UPDATE, so a scheduler-driven resolution
  // can never clobber an edit the user is making in WatchFormFlow at the
  // same time (or vice versa).
  setWatchResolvedLocation(id, data) {
    this.db.prepare("UPDATE watches SET resolved_location_url = ?, resolved_location_label = ?, resolved_location_checked_at = ? WHERE id = ?").run(data.url, data.label, data.checkedAt, id);
  }
  // The state / whole-country counterpart of setWatchResolvedLocation: the
  // list of places that Watch searches (see ScrapeEngine.resolveWatchPlaces).
  setWatchResolvedLocations(id, data) {
    this.db.prepare("UPDATE watches SET resolved_location_urls = ?, resolved_location_label = ?, resolved_location_checked_at = ? WHERE id = ?").run(JSON.stringify(data.urls), data.label, data.checkedAt, id);
  }
  // Per explicit instruction — a real due/overdue queue, not blind
  // per-watch polling: the active scheduler polls this on its own timer
  // and gets back only the single most-overdue enabled watch (or null when
  // nothing needs checking yet). idx_watches_due (on next_check_at) keeps
  // this cheap regardless of how many watches exist. Does NOT filter on
  // location_mode — a state/country-mode watch (active checking not yet
  // implemented, see watchScheduler.ts) can still come back due; the
  // scheduler itself is what defers those rather than busy-polling them.
  getDueWatch(now2) {
    const row = this.db.prepare("SELECT * FROM watches WHERE enabled = 1 AND platform = 'facebook' AND next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at ASC LIMIT 1").get(now2);
    return row ? rowToWatch(row) : null;
  }
  // Bumps last_active_check_at (an active check just ran, regardless of
  // whether anything matched) and schedules the next one. Deliberately
  // separate from recordWatchCandidateSeen's last_checked_at, which only
  // fires when a listing's TEXT actually candidate-matched (see that
  // method's own doc comment) — this fires every time the scheduler
  // completes a check, even one that found zero candidates, since it
  // reflects "did the scheduler look," not "did it find anything."
  scheduleNextWatchCheck(id, nextCheckAt) {
    this.db.prepare("UPDATE watches SET last_active_check_at = ?, next_check_at = ? WHERE id = ?").run(Date.now(), nextCheckAt, id);
  }
  setWatchEnabled(id, enabled) {
    this.db.prepare("UPDATE watches SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, Date.now(), id);
    return this.getWatchById(id);
  }
  deleteWatch(id) {
    this.db.prepare("DELETE FROM watch_matches WHERE watch_id = ?").run(id);
    this.db.prepare("DELETE FROM watch_seen_listings WHERE watch_id = ?").run(id);
    this.db.prepare("DELETE FROM watch_searches WHERE watch_id = ?").run(id);
    this.db.prepare("DELETE FROM watches WHERE id = ?").run(id);
    this.addPendingCloudDelete("watch", id);
  }
  listWatches() {
    const rows = this.db.prepare("SELECT * FROM watches ORDER BY created_at DESC").all();
    return rows.map((row) => this.withSearchLinks(rowToWatch(row)));
  }
  withSearchLinks(watch) {
    watch.searchLinks = this.listWatchSearchLinks(watch.id);
    return watch;
  }
  // --- Watch: seen listings, search links, geocoding --------------------------
  /** True once this Watch has come across this listing (it is then skipped). */
  hasWatchSeen(watchId, listingId) {
    return !!this.db.prepare("SELECT 1 FROM watch_seen_listings WHERE watch_id = ? AND listing_id = ?").get(watchId, listingId);
  }
  /** Remembers that this Watch has come across this listing. Returns false if it already had. */
  markWatchSeen(watchId, listingId) {
    const result = this.db.prepare("INSERT OR IGNORE INTO watch_seen_listings (watch_id, listing_id, seen_at) VALUES (?, ?, ?)").run(watchId, listingId, Date.now());
    return Number(result.changes) > 0;
  }
  /** Takes a listing back off a Watch's seen list (its check couldn't finish, so it should be looked at again). */
  unmarkWatchSeen(watchId, listingId) {
    this.db.prepare("DELETE FROM watch_seen_listings WHERE watch_id = ? AND listing_id = ?").run(watchId, listingId);
  }
  /** Remembers the exact Marketplace search a Watch ran for a term at a place (replacing the last one). */
  recordWatchSearchLink(watchId, term, placeKey, placeLabel, url) {
    this.db.prepare(
      `INSERT INTO watch_searches (watch_id, term, place_key, place_label, url, checked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(watch_id, term, place_key) DO UPDATE SET place_label = excluded.place_label, url = excluded.url, checked_at = excluded.checked_at`
    ).run(watchId, term, placeKey, placeLabel, url, Date.now());
  }
  listWatchSearchLinks(watchId) {
    const rows = this.db.prepare("SELECT term, place_label, url, checked_at FROM watch_searches WHERE watch_id = ? ORDER BY term, place_label").all(watchId);
    return rows.map((r) => ({ term: r.term, place: r.place_label, url: r.url, checkedAt: r.checked_at }));
  }
  /** Drops a Watch's remembered searches (its terms or place changed, so they no longer apply). */
  clearWatchSearchLinks(watchId) {
    this.db.prepare("DELETE FROM watch_searches WHERE watch_id = ?").run(watchId);
  }
  getGeocode(query) {
    const row = this.db.prepare("SELECT lat, lon, label, found, fetched_at FROM geocode_cache WHERE query = ?").get(query);
    if (!row) return null;
    return { found: !!row.found, lat: row.lat ?? 0, lon: row.lon ?? 0, label: row.label ?? null, fetchedAt: row.fetched_at };
  }
  setGeocode(query, result) {
    this.db.prepare(
      `INSERT INTO geocode_cache (query, lat, lon, label, found, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(query) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, label = excluded.label, found = excluded.found, fetched_at = excluded.fetched_at`
    ).run(query, result.found ? result.lat : null, result.found ? result.lon : null, result.found ? result.label : null, result.found ? 1 : 0, Date.now());
  }
  getWatchById(id) {
    const row = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id);
    return row ? this.withSearchLinks(rowToWatch(row)) : null;
  }
  // Per explicit instruction — "listings seen" / "last checked" on a
  // Watch card. Bumped whenever a listing's title candidate-matches this
  // watch (scrapeEngine.ts's evaluateListing), regardless of whether the
  // rest of its conditions end up satisfied — a meaningful, frequently-
  // updating signal that Clynx is actually looking, distinct from
  // matchCount (which only counts genuine matches).
  recordWatchCandidateSeen(watchId) {
    this.db.prepare("UPDATE watches SET listings_seen_count = listings_seen_count + 1, last_checked_at = ? WHERE id = ?").run(Date.now(), watchId);
  }
  // Per explicit instruction — "the same Marketplace listing found by
  // multiple Facebook accounts should NOT generate repeated Watch alerts."
  // hasSeenCached at the top of evaluateListing already guarantees a given
  // Facebook listing id only ever reaches scoring/matching once, globally,
  // across every account — but a single evaluation can still legitimately
  // reach this twice for the SAME watch (an immediate post-saveScored
  // check, then a deferred re-check after vision re-prices the listing —
  // see scrapeEngine.ts's runPostScoringPipeline), so the real dedup
  // backstop is UNIQUE(watch_id, listing_id) + INSERT OR IGNORE here.
  // Returns null (not a new WatchMatch) when this exact pair already
  // existed — the caller uses that to know whether to actually fire an
  // alert/increment match_count, rather than doing either on a no-op.
  recordWatchMatch(data) {
    const id = (0, import_node_crypto3.randomUUID)();
    const now2 = Date.now();
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO watch_matches (
          id, watch_id, listing_id, matched_at, found_by_account_id, found_by_account_label,
          discovery_mode, price_at_match, discount_percent_at_match, profit_usd_at_match, notified, notified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`
    ).run(
      id,
      data.watchId,
      data.listingId,
      now2,
      data.foundByAccountId,
      data.foundByAccountLabel,
      data.discoveryMode,
      data.priceAtMatch,
      data.discountPercentAtMatch,
      data.profitUsdAtMatch
    );
    if (result.changes === 0) return null;
    this.db.prepare("UPDATE watches SET match_count = match_count + 1 WHERE id = ?").run(data.watchId);
    return {
      id,
      watchId: data.watchId,
      listingId: data.listingId,
      matchedAt: now2,
      foundByAccountId: data.foundByAccountId,
      foundByAccountLabel: data.foundByAccountLabel,
      discoveryMode: data.discoveryMode,
      priceAtMatch: data.priceAtMatch,
      discountPercentAtMatch: data.discountPercentAtMatch,
      profitUsdAtMatch: data.profitUsdAtMatch,
      notified: false,
      notifiedAt: null
    };
  }
  markWatchMatchNotified(matchId) {
    this.db.prepare("UPDATE watch_matches SET notified = 1, notified_at = ? WHERE id = ?").run(Date.now(), matchId);
  }
  // Joined with the canonical listings row (see rowToRecord) rather than
  // returning bare WatchMatch rows — per explicit instruction, "reuse the
  // canonical listing record rather than copying the entire listing into
  // the Watch system," so the renderer can hand each match straight to the
  // existing ListingCard component. A listing_id with no matching row left
  // in `listings` (should not normally happen — listings are never
  // deleted just because Facebook's own listing vanished) is filtered out
  // rather than crashing the join.
  listWatchMatches(watchId) {
    const rows = this.db.prepare(
      `SELECT
           wm.id as wm_id, wm.watch_id as wm_watch_id, wm.listing_id as wm_listing_id, wm.matched_at as wm_matched_at,
           wm.found_by_account_id as wm_found_by_account_id, wm.found_by_account_label as wm_found_by_account_label,
           wm.discovery_mode as wm_discovery_mode, wm.price_at_match as wm_price_at_match,
           wm.discount_percent_at_match as wm_discount_percent_at_match, wm.profit_usd_at_match as wm_profit_usd_at_match,
           wm.notified as wm_notified, wm.notified_at as wm_notified_at,
           l.*, f.verdict as feedback_verdict, f.note as feedback_note,
           (SELECT group_concat(w.name, char(31)) FROM watch_matches wm2 JOIN watches w ON w.id = wm2.watch_id WHERE wm2.listing_id = l.id) as watch_names
         FROM watch_matches wm
         JOIN listings l ON l.id = wm.listing_id
         LEFT JOIN feedback f ON f.listing_id = l.id
         WHERE wm.watch_id = ?
         ORDER BY wm.matched_at DESC`
    ).all(watchId);
    return rows.map((row) => ({ match: rowToWatchMatch(row), listing: rowToRecord(row) }));
  }
  // Clynx Cloud Phase 2 (watchSync.ts) — bare match rows, no listings join
  // (the join above is a renderer/ListingCard convenience this sync path
  // doesn't need; matches pushed to cloud only ever carry the snapshotted
  // match fields, never full listing data — see cloudClient.ts's
  // watchMatchToCloud). Read-only, additive; never called from the scan
  // loop or watchScheduler.ts/watchMatching.ts.
  listRawWatchMatches(watchId) {
    const rows = this.db.prepare(
      `SELECT
           id as wm_id, watch_id as wm_watch_id, listing_id as wm_listing_id, matched_at as wm_matched_at,
           found_by_account_id as wm_found_by_account_id, found_by_account_label as wm_found_by_account_label,
           discovery_mode as wm_discovery_mode, price_at_match as wm_price_at_match,
           discount_percent_at_match as wm_discount_percent_at_match, profit_usd_at_match as wm_profit_usd_at_match,
           notified as wm_notified, notified_at as wm_notified_at
         FROM watch_matches
         WHERE watch_id = ?
         ORDER BY matched_at ASC`
    ).all(watchId);
    return rows.map(rowToWatchMatch);
  }
  // Per explicit instruction — drives the Sidebar's unseen-match pulse
  // indicator. Cheap EXISTS query rather than counting/fetching rows — the
  // Sidebar only needs a boolean.
  hasUnseenWatchMatches(sinceTimestamp) {
    const row = this.db.prepare("SELECT EXISTS(SELECT 1 FROM watch_matches WHERE matched_at > ?) as has_unseen").get(sinceTimestamp);
    return !!row.has_unseen;
  }
  close() {
    this.db.close();
  }
};
function rowToRecord(row) {
  return {
    id: row.id,
    justListed: !!row.just_listed,
    watchNames: typeof row.watch_names === "string" && row.watch_names ? row.watch_names.split("") : [],
    source: row.source === "ebay" ? "ebay" : "facebook",
    title: row.title,
    price: row.price,
    url: row.url,
    thumbnailUrl: row.thumbnail_url ?? null,
    imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
    description: row.description ?? "",
    locationText: row.location_text ?? null,
    listingAge: row.listing_age ?? null,
    matchedItem: row.matched_item,
    referencePriceUsd: row.reference_price_usd,
    discountPercent: row.discount_percent,
    conditionImpact: row.condition_impact ?? "unknown",
    confidence: row.confidence ?? "low",
    reasoning: row.reasoning ?? "",
    extractedAttributes: row.extracted_attributes ?? "",
    shippingMentioned: !!row.shipping_mentioned,
    isDeal: !!row.is_deal,
    dealTier: row.deal_tier ?? null,
    estimatedValueRange: row.estimated_value_range ?? null,
    notified: !!row.notified,
    firstSeenAt: row.first_seen_at,
    feedback: row.feedback_verdict ?? null,
    feedbackNote: row.feedback_note ?? null,
    sellerName: row.seller_name ?? null,
    sellerJoinedYear: row.seller_joined_year ?? null,
    sellerRating: row.seller_rating ?? null,
    sellerRatingCount: row.seller_rating_count ?? null,
    sellerFeedbackPercent: row.ebay_seller_feedback_percent ?? null,
    shippingCostUsd: row.ebay_shipping_usd ?? null,
    sellerHasProfilePhoto: row.seller_has_profile_photo === null ? null : !!row.seller_has_profile_photo,
    sellerRiskPassed: row.seller_risk_passed === void 0 ? true : !!row.seller_risk_passed,
    sellerRiskReasons: row.seller_risk_reasons ? JSON.parse(row.seller_risk_reasons) : [],
    photoAnalysis: row.photo_analysis ?? null,
    photoAnalysisCheckedAt: row.photo_analysis_checked_at ?? null,
    photoFlaws: row.photo_flaws ? JSON.parse(row.photo_flaws) : [],
    // Filled in by the Store methods below (enrichWithMatchedProductPricing)
    // — rowToRecord itself has no access to the products table.
    matchedProductAvgSoldPriceUsd: null,
    matchedProductAvgRunTimeDays: null,
    foundByAccountId: row.found_by_account_id ?? null,
    foundByAccountLabel: row.found_by_account_label ?? null,
    dealStatus: row.deal_status === "profitable_now" || row.deal_status === "negotiation" || row.deal_status === "worth_a_look" || row.deal_status === "pass" ? row.deal_status : null,
    gateConfidence: row.gate_confidence === "high" || row.gate_confidence === "medium" || row.gate_confidence === "low" ? row.gate_confidence : null,
    gateStars: row.gate_stars ?? null,
    gateHeadline: row.gate_headline ?? null,
    gateReasons: parseGateReasons(row.gate_reasons),
    gateFacts: parseGateFacts(row.gate_facts),
    requiredDiscountPercent: row.required_discount_percent ?? null,
    targetPriceUsd: row.target_price_usd ?? null,
    listingAgeHours: row.listing_age_hours ?? null
  };
}
function parseGateFacts(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const f = JSON.parse(raw);
    if (!f || typeof f !== "object") return null;
    const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
    const level = f.evidenceLevel === "strong" || f.evidenceLevel === "moderate" || f.evidenceLevel === "weak" ? f.evidenceLevel : "none";
    const basis = f.basis === "sold" || f.basis === "blend" || f.basis === "active" || f.basis === "user" ? f.basis : null;
    return {
      valueUsd: num(f.valueUsd),
      lotValueUsd: num(f.lotValueUsd),
      netProceedsUsd: num(f.netProceedsUsd),
      netPercent: num(f.netPercent),
      profitAtAskUsd: num(f.profitAtAskUsd),
      marginAtAskPercent: num(f.marginAtAskPercent),
      profitAtTargetUsd: num(f.profitAtTargetUsd),
      extrasCountedUsd: num(f.extrasCountedUsd) ?? 0,
      evidenceLevel: level,
      basis,
      sampleSize: num(f.sampleSize)
    };
  } catch {
    return null;
  }
}
function parseGateReasons(raw) {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
var PRODUCT_NAME_STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "with",
  "for",
  "of",
  "new",
  "used",
  "edition",
  "bundle",
  "set",
  "kit",
  "pack",
  "brand",
  "great",
  "condition",
  "like",
  "excellent",
  "good"
]);
function productNameTokens(name) {
  return new Set(
    name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !PRODUCT_NAME_STOPWORDS.has(w))
  );
}
var DATABASE_VARIANT_QUALIFIER_WORDS = /* @__PURE__ */ new Set(["pro", "slim", "max", "plus", "mini", "lite", "se", "xl", "oled", "air"]);
function isSimilarProductName(a, b) {
  if (isBrokenVariantName(a) !== isBrokenVariantName(b)) return false;
  const tokensA = productNameTokens(a);
  const tokensB = productNameTokens(b);
  if (!tokensA.size || !tokensB.size) return false;
  if (colorsConflict(a, b)) return false;
  const baseA = new Set([...tokensA].filter((t) => !DATABASE_VARIANT_QUALIFIER_WORDS.has(t)));
  const baseB = new Set([...tokensB].filter((t) => !DATABASE_VARIANT_QUALIFIER_WORDS.has(t)));
  const [smaller, larger] = baseA.size <= baseB.size ? [baseA, baseB] : [baseB, baseA];
  if (smaller.size < 2) return false;
  for (const t of smaller) if (!larger.has(t)) return false;
  const variantsA = new Set([...tokensA].filter((t) => DATABASE_VARIANT_QUALIFIER_WORDS.has(t)));
  const variantsB = new Set([...tokensB].filter((t) => DATABASE_VARIANT_QUALIFIER_WORDS.has(t)));
  if (variantsA.size !== variantsB.size || [...variantsA].some((v) => !variantsB.has(v))) return false;
  const extra = [...larger].filter((t) => !smaller.has(t));
  return !extra.some((t) => /^\d+(gb|tb|mb)$/i.test(t));
}
function colorlessProductTokens(name) {
  return new Set([...productNameTokens(name)].filter((t) => !isColorWord(t)));
}
function rowToProduct(row) {
  return {
    id: row.id,
    name: row.name,
    aiSummary: row.ai_summary ?? "",
    aiSummaryGeneratedAt: row.ai_summary_generated_at ?? null,
    observedNotes: row.observed_notes ?? "",
    category: row.category || "Other",
    family: row.family ?? null,
    familyLogoUrl: row.family_logo_url ?? null,
    imageUrl: row.image_url ?? null,
    resalePriceUsd: row.resale_price_usd ?? null,
    resaleTimeToSell: row.resale_time_to_sell ?? null,
    lookoutNotes: row.lookout_notes ?? "",
    keepThumbnail: !!row.keep_thumbnail,
    desiredPriceUsd: row.desired_price_usd ?? null,
    hardCapAtDesiredPrice: !!row.hard_cap_at_desired_price,
    prioritized: !!row.prioritized,
    ebayAvgSoldPriceUsd: row.ebay_avg_sold_price_usd ?? null,
    ebayAvgRunTimeDays: row.ebay_avg_run_time_days ?? null,
    ebayAvgShippingUsd: row.ebay_avg_shipping_usd ?? null,
    ebayCompsSampleSize: row.ebay_comps_sample_size ?? null,
    ebayCompsCheckedAt: row.ebay_comps_checked_at ?? null,
    ebayActiveMedianUsd: row.ebay_active_median_usd ?? null,
    ebayActiveSampleSize: row.ebay_active_sample_size ?? null,
    ebayEstimatedValueUsd: row.ebay_est_value_usd ?? null,
    ebayEstimateBasis: row.ebay_est_basis ?? null,
    ebayCompsIdentity: row.ebay_comps_identity === "exact" || row.ebay_comps_identity === "approximate" || row.ebay_comps_identity === "unresolved" ? row.ebay_comps_identity : null,
    myStore: parseMyStore(row.my_store_ref),
    parentProductId: row.parent_product_id ?? null,
    loading: !!row.loading,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at
  };
}
function parseMyStore(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const ref = JSON.parse(raw);
    return ref && typeof ref.medianUsd === "number" ? ref : null;
  } catch {
    return null;
  }
}
function rowToProductImage(row) {
  return {
    id: row.id,
    productId: row.product_id,
    imageData: row.image_data,
    sourceTitle: row.source_title ?? null,
    createdAt: row.created_at,
    kind: row.kind === "poor_condition" ? "poor_condition" : "normal"
  };
}
function parseUrlList(raw) {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}
function parseTerms(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed.map((t) => ({
      phrase: String(t.phrase ?? ""),
      matchKeywords: Array.isArray(t.matchKeywords) ? t.matchKeywords.map(String) : [],
      linkedProductId: t.linkedProductId ?? null
    }));
  } catch {
    return null;
  }
}
function rowToWatch(row) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform === "ebay" ? "ebay" : "facebook",
    searchPhrase: row.search_phrase,
    matchKeywords: JSON.parse(row.match_keywords || "[]"),
    linkedProductId: row.linked_product_id ?? null,
    minPriceUsd: row.min_price_usd ?? null,
    maxPriceUsd: row.max_price_usd ?? null,
    minProfitUsd: row.min_profit_usd ?? null,
    minDiscountPercent: row.min_discount_percent ?? null,
    maxListingAgeMinutes: row.max_listing_age_minutes ?? null,
    minSellerRatingPercent: row.min_seller_rating_percent ?? null,
    ntfyTopic: row.ntfy_topic ?? null,
    terms: parseTerms(row.terms_json) ?? [
      { phrase: row.search_phrase, matchKeywords: JSON.parse(row.match_keywords || "[]"), linkedProductId: row.linked_product_id ?? null }
    ],
    checkIntervalMinutes: row.check_interval_minutes ?? 15,
    accountIds: parseUrlList(row.account_ids),
    searchLinks: [],
    locationMode: row.location_mode,
    selectedState: row.selected_state ?? null,
    selectedCityOrZip: row.selected_city_or_zip ?? null,
    searchRadiusMiles: row.search_radius_miles ?? null,
    resolvedLocationUrl: row.resolved_location_url ?? null,
    resolvedLocationLabel: row.resolved_location_label ?? null,
    resolvedLocationCheckedAt: row.resolved_location_checked_at ?? null,
    resolvedLocationUrls: parseUrlList(row.resolved_location_urls),
    enabled: !!row.enabled,
    listingsSeenCount: row.listings_seen_count,
    matchCount: row.match_count,
    lastCheckedAt: row.last_checked_at ?? null,
    lastActiveCheckAt: row.last_active_check_at ?? null,
    nextCheckAt: row.next_check_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function rowToWatchMatch(row) {
  return {
    id: row.wm_id,
    watchId: row.wm_watch_id,
    listingId: row.wm_listing_id,
    matchedAt: row.wm_matched_at,
    foundByAccountId: row.wm_found_by_account_id ?? null,
    foundByAccountLabel: row.wm_found_by_account_label ?? null,
    discoveryMode: row.wm_discovery_mode,
    priceAtMatch: row.wm_price_at_match ?? null,
    discountPercentAtMatch: row.wm_discount_percent_at_match ?? null,
    profitUsdAtMatch: row.wm_profit_usd_at_match ?? null,
    notified: !!row.wm_notified,
    notifiedAt: row.wm_notified_at ?? null
  };
}

// audit/phase4_shadow/migration_test.ts
var source = import_node_path2.default.resolve(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db");
var scratch = import_node_path2.default.resolve(process.argv[3] ?? "C:/Users/biggt/ClynxMigrationTest");
if (/fb-marketplace-scout[\\/]+data[\\/]/i.test(source) || /AppData[\\/]+Roaming[\\/]+(Clynx|marketplace-scout)/i.test(source)) {
  console.error("Refusing to run: this looks like the app's own data folder. Give it a COPY of scout.db in another folder.");
  process.exit(2);
}
if (import_node_path2.default.dirname(source) === scratch) {
  console.error("Refusing to run: the scratch folder must differ from the folder of the copy.");
  process.exit(2);
}
var isIdentity = (t) => IDENTITY_TABLES.includes(t);
var sha256File = (f) => (0, import_node_crypto4.createHash)("sha256").update(import_node_fs2.default.readFileSync(f)).digest("hex");
function checksums(file) {
  const db = new import_node_sqlite2.DatabaseSync(file, { readOnly: true });
  const tables = {};
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name).filter((t) => !isIdentity(t));
  for (const t of names) {
    const h = (0, import_node_crypto4.createHash)("sha256");
    let last = -1;
    let rows = 0;
    for (; ; ) {
      const batch = db.prepare(`SELECT rowid AS _r, * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT 100`).all(last);
      if (!batch.length) break;
      for (const r of batch) h.update(JSON.stringify(r));
      rows += batch.length;
      last = batch[batch.length - 1]._r;
    }
    tables[t] = { rows, sha256: h.digest("hex") };
  }
  const n = (sql) => Number(db.prepare(sql).get().n);
  const relations = {
    listingsWithoutProduct: n("SELECT COUNT(*) AS n FROM listings WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products)"),
    imagesWithoutProduct: n("SELECT COUNT(*) AS n FROM product_images WHERE product_id NOT IN (SELECT id FROM products)"),
    productsWithMissingParent: n("SELECT COUNT(*) AS n FROM products WHERE parent_product_id IS NOT NULL AND parent_product_id NOT IN (SELECT id FROM products)"),
    watchesWithMissingProduct: n("SELECT COUNT(*) AS n FROM watches WHERE linked_product_id IS NOT NULL AND linked_product_id NOT IN (SELECT id FROM products)"),
    listingsWithProduct: n("SELECT COUNT(*) AS n FROM listings WHERE product_id IS NOT NULL"),
    productsWithParent: n("SELECT COUNT(*) AS n FROM products WHERE parent_product_id IS NOT NULL")
  };
  db.close();
  return { tables, relations };
}
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var tableList = (file) => {
  const db = new import_node_sqlite2.DatabaseSync(file, { readOnly: true });
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  db.close();
  return t;
};
var integrity = (file) => {
  const db = new import_node_sqlite2.DatabaseSync(file, { readOnly: true });
  const r = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const fk = db.prepare("PRAGMA foreign_key_check").all().length;
  db.close();
  return { integrity: r, foreignKeyViolations: fk };
};
var report = {};
var checks = [];
var check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== void 0 ? "  " + JSON.stringify(detail).slice(0, 300) : ""}`);
};
function drainStore(file, maxMs = 12e4) {
  const store = new Store(file, { identityFoundation: true });
  const t0 = Date.now();
  const times = [];
  while (Date.now() - t0 < maxMs) {
    const s = performance.now();
    const r = store.identity.backfillStep(20);
    times.push(performance.now() - s);
    if (r.done) break;
  }
  store.close();
  const sorted = [...times].sort((a, b) => a - b);
  const q = (f) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))].toFixed(1));
  return { steps: times.length, ms: Date.now() - t0, p50StepMs: q(0.5), p95StepMs: q(0.95), maxStepMs: Number(sorted[sorted.length - 1].toFixed(1)), stepsOver50Ms: times.filter((t) => t > 50).length };
}
async function main() {
  import_node_fs2.default.mkdirSync(scratch, { recursive: true });
  const sourceHashBefore = sha256File(source);
  const work = import_node_path2.default.join(scratch, "scout.db");
  import_node_fs2.default.copyFileSync(source, work);
  const pristine = import_node_path2.default.join(scratch, "scout.pristine.db");
  import_node_fs2.default.copyFileSync(source, pristine);
  check("the scratch copy is byte-identical to the copy given", sha256File(work) === sourceHashBefore);
  const base0 = checksums(work);
  report.baselineRows = Object.fromEntries(Object.entries(base0.tables).map(([k, v]) => [k, v.rows]));
  report.baselineRelations = base0.relations;
  {
    const off = new Store(work);
    off.close();
  }
  const baseOff = checksums(work);
  check("opening with the foundation OFF (today's behaviour) changes no existing table", same(base0.tables, baseOff.tables), Object.keys(base0.tables).filter((t) => base0.tables[t].sha256 !== baseOff.tables[t]?.sha256));
  check("...and creates no identity table", tableList(work).every((t) => !isIdentity(t)));
  const t1 = performance.now();
  {
    const on = new Store(work, { identityFoundation: true });
    on.close();
  }
  report.schemaCreateMs = Math.round(performance.now() - t1);
  const afterSchema = checksums(work);
  check("all identity tables exist after enabling", IDENTITY_TABLES.every((t) => tableList(work).includes(t)));
  check("row counts of every existing table are unchanged", same(Object.fromEntries(Object.entries(baseOff.tables).map(([k, v]) => [k, v.rows])), Object.fromEntries(Object.entries(afterSchema.tables).map(([k, v]) => [k, v.rows]))));
  check("content checksums of every existing table are unchanged", same(baseOff.tables, afterSchema.tables), Object.keys(baseOff.tables).filter((t) => baseOff.tables[t].sha256 !== afterSchema.tables[t]?.sha256));
  check("product / listing / photo / Watch / parent relationships are unchanged", same(baseOff.relations, afterSchema.relations), { before: baseOff.relations, after: afterSchema.relations });
  for (let i = 0; i < 3; i++) new Store(work, { identityFoundation: true }).close();
  check("repeated opens are idempotent (checksums identical)", same(afterSchema.tables, checksums(work).tables));
  const run1 = drainStore(work);
  report.backfillRun1 = run1;
  const afterBackfill = checksums(work);
  check("after the backfill every existing table is still identical", same(baseOff.tables, afterBackfill.tables), Object.keys(baseOff.tables).filter((t) => baseOff.tables[t].sha256 !== afterBackfill.tables[t]?.sha256));
  check("typical backfill steps are short (p95 under 50 ms) and the worst is under 250 ms", run1.p95StepMs < 50 && run1.maxStepMs < 250, run1);
  const db1 = new import_node_sqlite2.DatabaseSync(work, { readOnly: true });
  const n = (sql) => Number(db1.prepare(sql).get().n);
  const stats = {
    products: n("SELECT COUNT(*) AS n FROM products"),
    identities: n("SELECT COUNT(*) AS n FROM product_identity"),
    terms: n("SELECT COUNT(*) AS n FROM identity_terms"),
    relations: n("SELECT COUNT(*) AS n FROM product_relations"),
    relationsByKind: Object.fromEntries(db1.prepare("SELECT relation, COUNT(*) AS c FROM product_relations GROUP BY relation").all().map((r) => [r.relation, r.c])),
    relationsNotCandidate: n("SELECT COUNT(*) AS n FROM product_relations WHERE status != 'candidate'"),
    aliases: n("SELECT COUNT(*) AS n FROM product_aliases"),
    aliasesNotCandidate: n("SELECT COUNT(*) AS n FROM product_aliases WHERE status != 'candidate'"),
    listings: n("SELECT COUNT(*) AS n FROM listing_identity"),
    audit: n("SELECT COUNT(*) AS n FROM identity_audit"),
    productsByLevel: Object.fromEntries(db1.prepare("SELECT level, COUNT(*) AS c FROM product_identity GROUP BY level").all().map((r) => [r.level, r.c])),
    listingsByLevel: Object.fromEntries(db1.prepare("SELECT level, COUNT(*) AS c FROM listing_identity GROUP BY level").all().map((r) => [r.level, r.c])),
    listingsWhereBestDiffersFromStored: n("SELECT COUNT(*) AS n FROM listing_identity WHERE stored_product_id IS NOT NULL AND best_product_id IS NOT NULL AND stored_product_id != best_product_id")
  };
  report.stats = stats;
  check("every product has an identity row and every listing a listing identity", stats.identities === stats.products && stats.listings === n("SELECT COUNT(*) AS n FROM listings"), stats);
  check("every relation and alias is a candidate (none confirmed or rejected by the backfill)", stats.relationsNotCandidate === 0 && stats.aliasesNotCandidate === 0);
  db1.close();
  const identitySnapshot = (file) => {
    const d = new import_node_sqlite2.DatabaseSync(file, { readOnly: true });
    const h = (0, import_node_crypto4.createHash)("sha256");
    for (const t of ["product_identity", "identity_terms", "product_relations", "product_aliases", "listing_identity"]) {
      const cols = d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).filter((c) => !["computed_at", "created_at", "updated_at", "id"].includes(c));
      for (const r of d.prepare(`SELECT ${cols.join(", ")} FROM ${t} ORDER BY ${cols[0]}, ${cols[1] ?? cols[0]}${cols[2] ? ", " + cols[2] : ""}`).all()) h.update(JSON.stringify(r));
    }
    d.close();
    return h.digest("hex");
  };
  const snap1 = identitySnapshot(work);
  {
    const s = new Store(work, { identityFoundation: true });
    s.identity.resetBackfill();
    s.close();
  }
  const run2 = drainStore(work);
  report.backfillRun2 = run2;
  check("the repeat run is just as well behaved", run2.p95StepMs < 50 && run2.maxStepMs < 250, run2);
  check("re-running the whole backfill gives identical identity content (idempotent)", identitySnapshot(work) === snap1);
  check("...and still changes no existing table", same(baseOff.tables, checksums(work).tables));
  const crashed = import_node_path2.default.join(scratch, "scout.crash.db");
  import_node_fs2.default.copyFileSync(pristine, crashed);
  new Store(crashed, { identityFoundation: true }).close();
  const child = (0, import_node_child_process.spawnSync)(process.execPath, [__filename, "--child-backfill", crashed], { timeout: 4e3, encoding: "utf8" });
  const killed = child.signal !== null || child.status !== 0 || child.error !== void 0;
  const mid = new Store(crashed, { identityFoundation: true });
  const midStatus = mid.identity.backfillStatus();
  mid.close();
  report.interrupted = { killed, phaseAtInterruption: midStatus.phase };
  check("the backfill was interrupted part-way (killed)", killed && midStatus.phase !== "done", midStatus);
  drainStore(crashed);
  check("after the crash a restart resumes and finishes with identical identity content", identitySnapshot(crashed) === snap1);
  check("the crashed copy's existing tables are identical to the pristine ones", same(base0.tables, checksums(crashed).tables));
  check("the crashed copy passes the integrity check", integrity(crashed).integrity === "ok");
  {
    const s = new Store(work, { identityFoundation: true });
    const exported = s.identity.exportDecisions();
    s.identity.drop();
    s.close();
    report.exportedDecisions = { relations: exported.relations.length, aliases: exported.aliases.length };
  }
  check("rollback removed every identity table", tableList(work).every((t) => !isIdentity(t)));
  check("rollback left every existing table identical to the original", same(base0.tables, checksums(work).tables));
  const ig = integrity(work);
  check("the database passes SQLite's integrity check and has no foreign-key violations after rollback", ig.integrity === "ok" && ig.foreignKeyViolations === 0, ig);
  new Store(work).close();
  check("the app opens the rolled-back database normally with the foundation off", same(base0.tables, checksums(work).tables));
  check("the copy you gave was not modified (SHA-256 unchanged)", sha256File(source) === sourceHashBefore);
  report.checks = checks;
  report.sourceSha256 = sourceHashBefore;
  import_node_fs2.default.writeFileSync(import_node_path2.default.join(scratch, "migration_report.json"), JSON.stringify(report, null, 2));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`
${checks.length - failed} passed, ${failed} failed`);
  console.log(JSON.stringify({ stats: report.stats, backfillRun1: report.backfillRun1, backfillRun2: report.backfillRun2, schemaCreateMs: report.schemaCreateMs, interrupted: report.interrupted }, null, 1));
  process.exit(failed ? 1 : 0);
}
if (process.argv[2] === "--child-backfill") {
  const store = new Store(process.argv[3], { identityFoundation: true });
  const tick = () => {
    store.identity.backfillStep(2);
    setTimeout(tick, 15);
  };
  tick();
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

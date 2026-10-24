/**
 * Ascandir - Performance Analyst
 *
 * Misst, wie viel Rechenzeit die installierten Module im Browser verbrauchen,
 * erkennt Ruckler und ordnet sie Modulen zu, prüft im Hintergrund Konsole,
 * Assets, Texturen und Umgebung auf typische Performance-Probleme und
 * schreibt alles in exportierbare Berichte.
 *
 * Wichtig: Alle Module laufen im selben Browser-Thread. Deshalb gibt es keinen
 * echten "RAM pro Modul". Gemessen wird die Zeit, die der Code eines Moduls in
 * Hooks und libWrapper-Wrappern verbraucht – das ist der größte Hebel.
 *
 * Konvention: Jede interne Funktion, die beim Zuordnen per Stacktrace im Weg
 * stehen könnte, beginnt mit "__apa". Solche Zeilen werden beim Auswerten des
 * Stacktraces übersprungen.
 */

const MODULE_ID = "ascandir-performance-analyst";
const LS_PREFIX = `${MODULE_ID}.`;
const STARTED_AT = performance.now();

/* ================================================================ */
/*  Grundeinstellungen, die schon vor "init" gelesen werden müssen    */
/* ================================================================ */

/** Client-Einstellungen liegen im localStorage – so können wir sie lesen, bevor Foundry bereit ist. */
function readEarlySetting(key, fallback) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const WATCH_ENABLED = readEarlySetting("watchEnabled", true) !== false;
const CONSOLE_ENABLED = WATCH_ENABLED && readEarlySetting("consoleCapture", true) !== false;

/* ================================================================ */
/*  Hilfsfunktionen                                                  */
/* ================================================================ */

const now = () => performance.now();
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0);
const kb = (bytes) => round((bytes ?? 0) / 1024, 1);
const mb = (bytes) => round((bytes ?? 0) / 1048576, 2);
const fmtMs = (ms) => (ms >= 1000 ? `${round(ms / 1000, 2)} s` : `${round(ms, ms < 10 ? 2 : 1)} ms`);
const fmtBytes = (b) => (b >= 1048576 ? `${mb(b)} MB` : `${kb(b)} KB`);
const isGM = () => !!globalThis.game?.user?.isGM;
const randomId = () => (globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 12));

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ================================================================ */
/*  Wem gehört der Code? (Zuordnung zu Modulen)                       */
/* ================================================================ */

const OWNER_CORE = "core";
const OWNER_UNKNOWN = "unknown";
const OWNER_PENDING = "pending";
const OWNER_RENDER = "render";
const OWNER_CANVAS = "canvas";
const PATH_RE = /\/(modules|systems)\/([^/\s?#):]+)\//;
const CORE_RE = /foundry\.mjs|\/scripts\/foundry|\/common\/|\/client\//;

/** Wandelt eine URL (oder Pfad) in einen Besitzer um: Modul-ID, "system:<id>", "world", "data". */
function ownerFromUrl(url) {
  if (!url) return null;
  let u = String(url).replace(/(:\d+){1,2}$/, "");
  try { u = decodeURIComponent(u); } catch { /* bleibt roh */ }
  const m = u.match(PATH_RE);
  if (m) return m[1] === "systems" ? `system:${m[2]}` : m[2];
  if (/\/worlds\//.test(u)) return "world";
  if (/pixi/i.test(u)) return OWNER_CANVAS;
  if (CORE_RE.test(u)) return OWNER_CORE;
  // Jede andere Skriptdatei vom eigenen Foundry-Server gehört zu Foundry selbst.
  try {
    const x = new URL(u, location.href);
    if (x.origin === location.origin && /\.m?js$/i.test(x.pathname)) return OWNER_CORE;
  } catch { /* keine URL */ }
  return null;
}

const URL_IN_LINE = /((?:https?|file):\/\/[^\s)]+?)(?::\d+){0,2}(?:\)|\s|$)/;

/** Erste Codestelle im Stack, die nicht zu uns gehört – zur Fehlersuche bei unbekannten Besitzern. */
function stackSite(stack) {
  for (const line of String(stack ?? "").split("\n")) {
    if (line.includes("__apa")) continue;
    const m = line.match(URL_IN_LINE);
    if (!m) continue;
    const fn = line.trim().replace(/^at\s+/, "").split(/[ @(]/)[0];
    return `${fn && !fn.startsWith("http") ? `${fn} – ` : ""}${shortUrl(line.match(/((?:https?|file):\/\/[^\s)]+)/)?.[1] ?? "")}`;
  }
  return "";
}

function shortUrl(url) {
  if (!url) return "";
  try {
    const x = new URL(url, location.href);
    const path = decodeURIComponent(x.pathname);
    const host = x.origin === location.origin ? "" : x.host;
    const parts = path.split("/").filter(Boolean);
    return `${host}${parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : `/${parts.join("/")}`}`;
  } catch { return String(url).slice(-80); }
}

/** Liest aus einem Stacktrace das erste Modul/System, das nicht zu unserer Mess-Infrastruktur gehört. */
function ownerFromStack(stack) {
  if (!stack) return null;
  let sawCore = false;
  for (const line of String(stack).split("\n")) {
    if (line.includes("__apa")) continue;
    let u = line;
    try { u = decodeURIComponent(line); } catch { /* roh */ }
    const url = u.match(/((?:https?|file):\/\/[^\s)]+)/)?.[1] ?? u;
    const o = ownerFromUrl(url);
    if (o === OWNER_CORE || o === OWNER_CANVAS) { sawCore = true; continue; }
    if (o && o !== "data") return o;
  }
  return sawCore ? OWNER_CORE : null;
}

/** Wie __apaCapture, liefert aber zusätzlich die Codestelle (für unbekannte Besitzer). */
function __apaCaptureFull() {
  let stack = "";
  const old = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 40;
    stack = new Error().stack ?? "";
  } catch { /* egal */ } finally {
    try { Error.stackTraceLimit = old; } catch { /* egal */ }
  }
  const owner = ownerFromStack(stack) ?? OWNER_UNKNOWN;
  return { owner, site: owner === OWNER_UNKNOWN ? stackSite(stack) : "" };
}

/** Erzeugt einen Stacktrace an der aktuellen Stelle und ordnet ihn zu. */
function __apaCapture(fallback = OWNER_UNKNOWN) {
  let stack = "";
  const old = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 40;
    stack = new Error().stack ?? "";
  } catch { /* egal */ } finally {
    try { Error.stackTraceLimit = old; } catch { /* egal */ }
  }
  return ownerFromStack(stack) ?? fallback;
}

/** Anzeigename eines Besitzers. */
function ownerLabel(id) {
  if (!id) return "–";
  if (id === OWNER_CORE) return "Foundry-Kern";
  if (id === OWNER_UNKNOWN) return "Nicht zuordenbar";
  if (isPending(id)) return "Wird noch zugeordnet …";
  if (id === OWNER_RENDER) return "Browser (Zeichnen, Layout, Aufräumen)";
  if (id === OWNER_CANVAS) return "Canvas-Zeichenschleife (PIXI)";
  if (id === "world") return "Welt-Dateien";
  if (id === "data") return "Eigene Dateien (Data)";
  if (id.startsWith("system:")) {
    const sid = id.slice(7);
    const sys = globalThis.game?.system;
    return `System: ${sys?.id === sid ? sys.title : sid}`;
  }
  const mod = globalThis.game?.modules?.get?.(id);
  return mod?.title ?? id;
}

function ownerKind(id) {
  if (id === OWNER_CORE) return "core";
  if (id === MODULE_ID) return "self";
  if (id?.startsWith("system:")) return "system";
  if (id === OWNER_CANVAS) return "core";
  if (isPending(id) || [OWNER_UNKNOWN, OWNER_RENDER, "world", "data"].includes(id)) return "other";
  return "module";
}

/** libWrapper meldet Paket-IDs ohne "system:"-Präfix. */
function normalizePackage(pkg) {
  if (!pkg) return OWNER_UNKNOWN;
  const sys = globalThis.game?.system;
  if (sys?.id === pkg && !globalThis.game?.modules?.get?.(pkg)) return `system:${pkg}`;
  return pkg;
}

/* ================================================================ */
/*  Statistik-Speicher                                               */
/* ================================================================ */

class OwnerStats {
  constructor() {
    this.startupTime = 0;   // Zeit bis "ready"
    this.runTime = 0;       // Zeit nach "ready"
    this.calls = 0;
    this.maxTime = 0;
    this.maxLabel = "";
    this.by = new Map();    // Hook/Funktion -> {time, calls, max, kind}
    this.jankCount = 0;
    this.jankMs = 0;
    this.errors = 0;
    this.warnings = 0;
    this.deprecations = 0;
    this.sockOut = 0;
    this.sockOutBytes = 0;
    this.sockIn = 0;
    this.sockInBytes = 0;
    this.docOps = 0;
    this.docBy = new Map();
  }
}

class Scope {
  constructor(name) {
    this.name = name;
    this.startDate = Date.now();
    this.startPerf = now();
    this.endPerf = null;
    this.owners = new Map();
    this.frames = { count: 0, total: 0, j50: 0, j100: 0, j250: 0, worst: 0, fpsMin: null };
    this.fps = [];          // {t, fps}
    this.longFrames = [];   // {t, at, dur, source, owners:[{id,ms}]}
    this.samples = [];      // {t, heap, dom, apps}
    this.timeline = [];     // nur bei Aufzeichnungen
    this.socket = new Map(); // event -> {out,in,outBytes,inBytes}
    this.overheadCalls = 0;
    this.markers = [];
  }
  owner(id) {
    let o = this.owners.get(id);
    if (!o) { o = new OwnerStats(); this.owners.set(id, o); }
    return o;
  }
  elapsed() { return (this.endPerf ?? now()) - this.startPerf; }
}

const state = {
  load: new Scope("load"),
  rec: null,          // aktuelle Aufzeichnung
  recEndAt: null,     // automatisches Ende (performance.now)
  recLabel: "",
  reports: [],        // gespeicherte Berichte
  ready: false,
  phases: { script: STARTED_AT, init: null, setup: null, ready: null, firstCanvas: null },
  scenes: [],         // {name, ms, at}
  canvasInitAt: null,
  sceneLoading: false,
  hookMode: WATCH_ENABLED ? "aktiv" : "aus",
  lwMode: "nicht vorhanden",
  lwPatched: 0,
  loafSupported: false,
  env: {},
  assets: new Map(),  // url -> Asset
  failedAssets: new Map(),
  consoleEntries: new Map(),
  issues: new Map(),
  textures: null,
  world: null,
  clients: new Map(), // userId -> {name, at, report, pending}
  inbox: [],          // von Spielern gesendete Berichte (nur SL)
  pendingNotes: [],
  pendingSourceSearch: true
};

const TIMELINE_CAP = 25000;
const LONGFRAME_CAP = 400;
const SAMPLE_CAP = 1500;
const FPS_CAP = 3600;
const CONSOLE_CAP = 2000;

function forScopes(fn) {
  fn(state.load);
  if (state.rec) fn(state.rec);
}

/* Ringpuffer für Spans >= 1 ms – zum Zuordnen von Rucklern. */
const SPAN_CAP = 4000;
const spans = new Array(SPAN_CAP);
let spanIdx = 0;

function pushSpan(owner, label, t0, self) {
  spans[spanIdx] = { owner, label, t0, self };
  spanIdx = (spanIdx + 1) % SPAN_CAP;
}

function timelinePush(entry) {
  const rec = state.rec;
  if (!rec || rec.timeline.length >= TIMELINE_CAP) return;
  entry.t = round(now() - rec.startPerf, 2);
  rec.timeline.push(entry);
}

/* ================================================================ */
/*  Zeitmessung mit "Eigenzeit" (verschachtelte Aufrufe abgezogen)    */
/* ================================================================ */

const frameStack = [];

function __apaRecord(scope, owner, label, kind, self) {
  const o = scope.owner(owner);
  if (state.ready) o.runTime += self; else o.startupTime += self;
  o.calls++;
  if (self > o.maxTime) { o.maxTime = self; o.maxLabel = label; }
  let b = o.by.get(label);
  if (!b) { b = { time: 0, calls: 0, max: 0, kind }; o.by.set(label, b); }
  b.time += self;
  b.calls++;
  if (self > b.max) b.max = self;
  scope.overheadCalls++;
}

/**
 * Führt fn aus und misst die Eigenzeit. owner === null bedeutet "neutral":
 * Die Zeit wird nicht verbucht, aber vom Aufrufer abgezogen (z. B. der
 * Original-Funktionsaufruf innerhalb eines libWrapper-Wrappers).
 */
function __apaTimed(owner, label, kind, fn, thisArg, args) {
  const f = { child: 0 };
  frameStack.push(f);
  const t0 = now();
  try {
    return fn.apply(thisArg, args);
  } finally {
    const dur = now() - t0;
    frameStack.pop();
    const parent = frameStack[frameStack.length - 1];
    if (parent) parent.child += dur;
    if (owner) {
      const self = Math.max(0, dur - f.child);
      __apaRecord(state.load, owner, label, kind, self);
      if (state.rec) {
        __apaRecord(state.rec, owner, label, kind, self);
        if (self >= 0.5) timelinePush({ type: kind, owner, label, ms: round(self, 2) });
      }
      if (self >= 1) pushSpan(owner, label, t0, self);
    }
  }
}

/* ================================================================ */
/*  Hooks messen                                                     */
/* ================================================================ */

const WRAPPED = Symbol("apaWrapped");
const ORIG = Symbol("apaOrig");
const OWNER = Symbol("apaOwner");
const pendingWrappers = [];
const isPending = (id) => typeof id === "string" && id.startsWith(OWNER_PENDING);

function wrapEntry(H, entry, owner, site = "") {
  if (!entry || typeof entry.fn !== "function" || entry.fn[WRAPPED]) return false;
  const orig = entry.fn;
  const label = site ? `${entry.hook} ← ${site}` : entry.hook;
  const w = function __apaHook(...args) {
    return __apaTimed(w[OWNER], label, "hook", orig, this, args);
  };
  w[WRAPPED] = true;
  w[ORIG] = orig;
  w[OWNER] = owner;
  // Lesbarer Name für Foundrys Fehlermeldungen; die Markierung "__apa" muss bleiben (Stacktrace-Filter).
  try { Object.defineProperty(w, "name", { value: `${orig.name || "anonym"} ⟨__apa⟩` }); } catch { /* egal */ }
  try { entry.fn = w; } catch { return false; }
  return entry.fn === w;
}

function findEntry(H, hook, id) {
  const list = H.events?.[hook];
  if (!Array.isArray(list)) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.id === id) return list[i];
  return null;
}

function patchHooks() {
  const H = globalThis.Hooks;
  if (!H || H.__apaPatched) return;
  let events;
  try { events = H.events; } catch { events = null; }
  if (!events || typeof events !== "object") {
    state.hookMode = "nicht möglich (Hooks.events fehlt)";
    return;
  }

  // Prüfen, ob Hooks.events wirklich die echten Einträge liefert.
  const probeId = H.on("apaProbe", () => {});
  const probe = findEntry(H, "apaProbe", probeId);
  const works = probe && wrapEntry(H, probe, MODULE_ID) && findEntry(H, "apaProbe", probeId)?.fn?.[WRAPPED];
  H.off("apaProbe", probeId);
  if (!works) {
    state.hookMode = "nicht möglich (Foundry-Interna geändert)";
    return;
  }

  // Bereits registrierte Hooks (von Modulen, die vor uns geladen wurden).
  // Jeder bekommt einen eigenen Zwischenspeicher, der später dem richtigen Modul gutgeschrieben wird.
  for (const list of Object.values(H.events)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const key = `${OWNER_PENDING}:${pendingWrappers.length}`;
      if (wrapEntry(H, entry, key)) pendingWrappers.push(entry.fn);
    }
  }

  const origOn = H.on;
  const origOnce = H.once;
  const origOff = H.off;

  H.on = function __apaOn(hook, fn, options) {
    const id = origOn.call(this, hook, fn, options);
    try {
      const entry = findEntry(H, hook, id);
      if (entry && !entry.fn?.[WRAPPED]) {
        const c = __apaCaptureFull();
        wrapEntry(H, entry, c.owner, c.site);
      }
    } catch { /* Messen darf nie das Spiel stören */ }
    return id;
  };

  H.once = function __apaOnce(hook, fn) {
    const id = origOnce.call(this, hook, fn);
    try {
      const entry = findEntry(H, hook, id);
      if (entry && !entry.fn?.[WRAPPED]) {
        const c = __apaCaptureFull();
        wrapEntry(H, entry, c.owner, c.site);
      }
    } catch { /* egal */ }
    return id;
  };

  H.off = function __apaOff(hook, fn) {
    if (typeof fn === "function" && !fn[WRAPPED]) {
      try {
        const list = H.events?.[hook];
        const entry = Array.isArray(list) ? list.find((e) => e.fn === fn || e.fn?.[ORIG] === fn) : null;
        if (entry) return origOff.call(this, hook, entry.id);
      } catch { /* weiter mit Original */ }
    }
    return origOff.call(this, hook, fn);
  };

  H.__apaPatched = true;
}

/** Zählt registrierte Hooks pro Besitzer. */
function registeredHooksByOwner() {
  const res = new Map();
  const H = globalThis.Hooks;
  let events;
  try { events = H?.events; } catch { events = null; }
  if (!events) return res;
  for (const list of Object.values(events)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      let o = e.fn?.[OWNER] ?? OWNER_UNKNOWN;
      if (isPending(o)) o = OWNER_PENDING;
      res.set(o, (res.get(o) ?? 0) + 1);
    }
  }
  return res;
}

/**
 * Hooks, die vor uns registriert wurden, kennen ihren Besitzer nicht.
 * Wir suchen den Quelltext der Funktion in den geladenen Modul-Dateien.
 */
function mergeStats(target, src) {
  for (const k of ["startupTime", "runTime", "calls", "jankCount", "jankMs", "errors", "warnings", "deprecations", "sockOut", "sockOutBytes", "sockIn", "sockInBytes", "docOps"]) target[k] += src[k];
  if (src.maxTime > target.maxTime) { target.maxTime = src.maxTime; target.maxLabel = src.maxLabel; }
  for (const [k, v] of src.by) {
    const b = target.by.get(k) ?? { time: 0, calls: 0, max: 0, kind: v.kind };
    b.time += v.time; b.calls += v.calls; b.max = Math.max(b.max, v.max);
    target.by.set(k, b);
  }
  for (const [k, v] of src.docBy) target.docBy.set(k, (target.docBy.get(k) ?? 0) + v);
}

async function resolvePendingOwners() {
  // Auch Hooks, die schon gefeuert und entfernt wurden (z. B. "init"), stehen in dieser Liste.
  const pending = pendingWrappers.filter((w) => isPending(w[OWNER]));
  if (!pending.length) { state.pendingSourceSearch = false; return; }

  const urls = new Set();
  for (const r of performance.getEntriesByType("resource")) {
    if (/\.m?js(\?|$)/.test(r.name) && PATH_RE.test(r.name) && !r.name.includes(`/modules/${MODULE_ID}/`)) urls.add(r.name.split("#")[0]);
  }
  const sources = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (res.ok) sources.push({ owner: ownerFromUrl(url), text: await res.text() });
    } catch { /* Datei nicht lesbar */ }
  }

  for (const w of pending) {
    let src = "";
    try { src = Function.prototype.toString.call(w[ORIG]); } catch { /* egal */ }
    let owner = OWNER_UNKNOWN;
    if (src && src.length >= 25 && !src.includes("[native code]")) {
      const owners = new Set();
      for (const s of sources) if (s.text.includes(src)) owners.add(s.owner);
      // Nirgends in Modulen/Systemen gefunden -> Foundry selbst.
      owner = owners.size === 1 ? [...owners][0] : (owners.size === 0 ? OWNER_CORE : OWNER_UNKNOWN);
    }
    const key = w[OWNER];
    w[OWNER] = owner;
    // Bereits gemessene Zeit (z. B. aus "init") dem richtigen Besitzer gutschreiben.
    for (const scope of [state.load, state.rec]) {
      const p = scope?.owners.get(key);
      if (!p) continue;
      mergeStats(scope.owner(owner), p);
      scope.owners.delete(key);
    }
  }
  state.pendingSourceSearch = false;
  Analyst.refreshSoon();
}

/* ================================================================ */
/*  libWrapper messen                                                */
/* ================================================================ */

function makeLwRegister(lw, orig) {
  return function __apaLwRegister(pkg, target, fn, type, options) {
    let wrapped = fn;
    try {
      if (typeof fn === "function") {
        const owner = normalizePackage(pkg);
        const label = typeof target === "string" ? target : "libWrapper";
        const isOverride = String(type ?? "").toUpperCase().includes("OVERRIDE");
        wrapped = function __apaLwCall(...args) {
          if (!isOverride && typeof args[0] === "function") {
            const next = args[0];
            args[0] = function __apaLwNext(...a) { return __apaTimed(null, null, null, next, this, a); };
          }
          return __apaTimed(owner, label, "wrap", fn, this, args);
        };
        state.lwPatched++;
      }
    } catch { wrapped = fn; }
    return orig.call(lw, pkg, target, wrapped, type, options);
  };
}

/**
 * libWrapper ist schreibgeschützt. Statt es zu verändern, legen wir eine Hülle davor:
 * Alle Eigenschaften werden 1:1 an das echte libWrapper durchgereicht, nur "register" misst mit.
 */
function makeLwShim(lw, register) {
  const shim = function libWrapper(...args) { return new.target ? Reflect.construct(lw, args, new.target) : lw.apply(this, args); };
  const seen = new Set(["register", "length", "name", "prototype", "arguments", "caller"]);
  for (let obj = lw; obj && obj !== Function.prototype && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
    for (const key of Reflect.ownKeys(obj)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const d = Object.getOwnPropertyDescriptor(obj, key);
      if (!d) continue;
      if ("value" in d) {
        const v = d.value;
        Object.defineProperty(shim, key, { get: () => (typeof v === "function" ? v.bind(lw) : lw[key]), set: (nv) => { lw[key] = nv; }, enumerable: d.enumerable, configurable: true });
      } else {
        Object.defineProperty(shim, key, { get: () => lw[key], set: d.set ? (nv) => { lw[key] = nv; } : undefined, enumerable: d.enumerable, configurable: true });
      }
    }
  }
  Object.defineProperty(shim, "register", { value: register, configurable: true, writable: true });
  Object.defineProperty(shim, "__apaPatched", { value: true });
  Object.defineProperty(shim, "__apaOriginal", { value: lw });
  try { Object.defineProperty(shim, "prototype", { value: lw.prototype }); } catch { /* egal */ }
  return shim;
}

function patchLibWrapper() {
  const lw = globalThis.libWrapper;
  if (!lw || lw.__apaPatched) return;
  const orig = lw.register;
  if (typeof orig !== "function") return;
  const register = makeLwRegister(lw, orig);

  // 1. Versuch: direkt ersetzen.
  try {
    lw.register = register;
    if (lw.register === register) {
      try { lw.__apaPatched = true; } catch { /* egal */ }
      state.lwMode = "aktiv";
      return;
    }
  } catch { /* schreibgeschützt */ }

  // 2. Versuch: Hülle vor das globale libWrapper setzen.
  try {
    const shim = makeLwShim(lw, register);
    const desc = Object.getOwnPropertyDescriptor(globalThis, "libWrapper");
    if (!desc || desc.writable || desc.set) globalThis.libWrapper = shim;
    else if (desc.configurable) Object.defineProperty(globalThis, "libWrapper", { ...desc, value: shim });
    if (globalThis.libWrapper === shim) {
      state.lwMode = "aktiv (über Hülle)";
      return;
    }
  } catch (err) {
    console.debug("Performance Analyst | libWrapper", err);
  }
  state.lwMode = "nicht möglich";
}

/* ================================================================ */
/*  Frames, Ruckler, FPS                                             */
/* ================================================================ */

let lastFrameTs = 0;
let secStart = 0;
let secFrames = 0;
let currentFps = 0;

function __apaFrame(ts) {
  try {
    if (lastFrameTs && !document.hidden) {
      const d = ts - lastFrameTs;
      if (d > 0 && d < 3000) onFrame(lastFrameTs, ts, d);
    }
    if (document.hidden) { secStart = 0; secFrames = 0; }
  } catch { /* egal */ }
  lastFrameTs = ts;
  requestAnimationFrame(__apaFrame);
}

function onFrame(start, end, d) {
  forScopes((s) => {
    const f = s.frames;
    f.count++;
    f.total += d;
    if (d > f.worst) f.worst = d;
    if (d >= 50) f.j50++;
    if (d >= 100) f.j100++;
    if (d >= 250) f.j250++;
  });
  if (!secStart) secStart = end;
  secFrames++;
  if (end - secStart >= 1000) {
    currentFps = (secFrames * 1000) / (end - secStart);
    const sample = { t: Date.now(), fps: round(currentFps, 1) };
    forScopes((s) => {
      s.fps.push(sample);
      if (s.fps.length > FPS_CAP) s.fps.shift();
      if (s.frames.fpsMin === null || currentFps < s.frames.fpsMin) s.frames.fpsMin = currentFps;
    });
    secStart = end;
    secFrames = 0;
  }
  if (d >= 50 && !state.loafSupported) registerLongFrame(start, d, "Bildwechsel", []);
}

/**
 * Ordnet einen langen Frame zu.
 * spans   = gemessene Hook-/libWrapper-Zeiten (Eigenzeit, genau einem Modul zugeordnet)
 * scripts = vom Browser gemeldete Skripte (Long Animation Frames, nur Chromium). Deren Zeit
 *           enthält auch die darin aufgerufenen Hooks – die ziehen wir ab, sonst zählt alles doppelt.
 * layoutMs = vom Browser gemeldete Zeit für Zeichnen/Layout.
 */
function registerLongFrame(start, dur, source, scripts, layoutMs = 0) {
  const end = start + dur;
  const contrib = new Map();
  const details = [];
  const inFrame = [];
  for (const sp of spans) {
    if (!sp || sp.t0 < start - 2 || sp.t0 > end) continue;
    inFrame.push(sp);
    contrib.set(sp.owner, (contrib.get(sp.owner) ?? 0) + sp.self);
  }
  const spanAgg = new Map();
  for (const sp of inFrame) {
    const k = `${sp.owner}|${sp.label}`;
    const a = spanAgg.get(k) ?? { owner: sp.owner, what: sp.label, ms: 0, n: 0 };
    a.ms += sp.self;
    a.n++;
    spanAgg.set(k, a);
  }
  for (const a of spanAgg.values()) details.push({ owner: a.owner, ms: round(a.ms, 1), what: `${a.what}${a.n > 1 ? ` (${a.n}×)` : ""}` });

  for (const sc of scripts) {
    let o = ownerFromUrl(sc.url);
    if (!o || o === "data") o = OWNER_UNKNOWN;
    // Hook-Zeiten anderer Besitzer, die innerhalb dieses Skripts liefen, abziehen.
    let inner = 0;
    if (sc.start) for (const sp of inFrame) if (sp.owner !== o && sp.t0 >= sc.start - 1 && sp.t0 <= sc.start + sc.ms) inner += sp.self;
    const own = Math.max(0, sc.ms - inner);
    if (own < 1) continue;
    contrib.set(o, (contrib.get(o) ?? 0) + own);
    const fn = sc.fn ? `${sc.fn}()` : "";
    const where = sc.url ? shortUrl(sc.url) : "";
    details.push({ owner: o, ms: round(own, 1), what: [fn, sc.invoker, where].filter(Boolean).join(" · ") || "(keine Angabe vom Browser)" });
  }
  let sum = 0;
  for (const v of contrib.values()) sum += v;
  const rest = dur - sum;
  if (rest > 5) {
    contrib.set(OWNER_RENDER, (contrib.get(OWNER_RENDER) ?? 0) + rest);
    details.push({ owner: OWNER_RENDER, ms: round(rest, 1), what: layoutMs > 1 ? `davon Zeichnen/Layout ${round(layoutMs, 0)} ms` : "nicht aufschlüsselbar (z. B. Zeichnen, Garbage Collection)" });
  }
  const owners = [...contrib.entries()]
    .map(([id, ms]) => ({ id, ms: round(Math.min(ms, dur), 1) }))
    .filter((o) => o.ms >= 0.5)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6);
  const phase = !state.ready ? "Weltstart" : (state.sceneLoading ? "Szenenwechsel" : "");
  const lf = {
    t: Date.now() - Math.max(0, now() - start),
    dur: round(dur, 1),
    source,
    phase,
    owners,
    details: details.sort((a, b) => b.ms - a.ms).slice(0, 8)
  };
  forScopes((s) => {
    s.longFrames.push(lf);
    if (s.longFrames.length > LONGFRAME_CAP) s.longFrames.shift();
    for (const o of owners) {
      if (o.id === OWNER_RENDER) continue;
      const st = s.owner(o.id);
      st.jankCount++;
      st.jankMs += o.ms;
    }
  });
  timelinePush({ type: "ruckler", ms: lf.dur, phase, owners: owners.slice(0, 3).map((o) => `${o.id}:${o.ms}`).join(", "), details: lf.details.slice(0, 4).map((d) => `${d.owner}:${d.ms}:${d.what}`) });
  Health.onLongFrame(lf);
}

function startLoafObserver() {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) return;
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const scripts = (e.scripts ?? []).map((s) => ({
          url: s.sourceURL || "",
          fn: s.sourceFunctionName || "",
          invoker: s.invoker || "",
          start: s.startTime || 0,
          ms: s.duration ?? 0
        }));
        const end = e.startTime + e.duration;
        const layoutMs = e.renderStart ? end - e.renderStart : 0;
        registerLongFrame(e.startTime, e.duration, "Long Animation Frame", scripts, layoutMs);
      }
    });
    obs.observe({ type: "long-animation-frame", buffered: true });
    state.loafSupported = true;
  } catch { state.loafSupported = false; }
}

/* ================================================================ */
/*  Speicher / DOM-Proben                                            */
/* ================================================================ */

function takeSample() {
  const sample = {
    t: Date.now(),
    heap: performance.memory?.usedJSHeapSize ?? null,
    dom: document.getElementsByTagName("*").length,
    apps: (globalThis.foundry?.applications?.instances?.size ?? 0) + Object.keys(globalThis.ui?.windows ?? {}).length
  };
  forScopes((s) => {
    s.samples.push(sample);
    if (s.samples.length > SAMPLE_CAP) s.samples.shift();
  });
  checkSampleIssues();
}

function checkSampleIssues() {
  const s = state.load.samples;
  const last = s[s.length - 1];
  if (!last) return;
  if (last.dom > 25000) addIssue("dom-nodes", "warn", "Sehr viele HTML-Elemente", `Die Oberfläche besteht aus ${last.dom.toLocaleString("de-DE")} Elementen. Ab etwa 15.000–25.000 wird jedes Neuzeichnen spürbar langsamer. Ursache sind oft viele offene Fenster, ein langer Chat-Verlauf oder Module mit großen Listen.`);
  if (last.apps > 25) addIssue("many-apps", "info", "Viele offene Fenster", `${last.apps} Fenster/Anwendungen sind gleichzeitig offen.`);
  if (last.heap && s.length > 20) {
    const base = s[Math.min(8, s.length - 1)]?.heap;
    const growth = last.heap - (base ?? last.heap);
    if (growth > 400 * 1048576) addIssue("heap-growth", "warn", "Speicher wächst stetig", `Der Browser-Speicher ist seit Sitzungsbeginn um ${mb(growth)} MB gewachsen (jetzt ${mb(last.heap)} MB). Wenn das weiter steigt, deutet es auf ein Speicherleck hin – oft durch ein Modul, das Daten nie freigibt.`);
  }
}

/* ================================================================ */
/*  Probleme sammeln                                                 */
/* ================================================================ */

const SEVERITY_ORDER = { critical: 0, warn: 1, info: 2 };
let notifyCount = 0;
let notifyWindowStart = 0;

function addIssue(key, severity, title, detail, owner = null) {
  const existing = state.issues.get(key);
  if (existing) {
    existing.count++;
    existing.detail = detail;
    existing.last = Date.now();
    if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[existing.severity]) existing.severity = severity;
    return existing;
  }
  const issue = { key, severity, title, detail, owner, count: 1, first: Date.now(), last: Date.now() };
  state.issues.set(key, issue);
  timelinePush({ type: "problem", severity, label: title });
  notifyIssue(issue);
  return issue;
}

function notifyIssue(issue) {
  if (!state.ready) { state.pendingNotes.push(issue); return; }
  if (!isGM()) return;
  let level = "critical";
  try { level = game.settings.get(MODULE_ID, "notifyLevel"); } catch { /* Standard */ }
  if (level === "off") return;
  if (level === "critical" && issue.severity !== "critical") return;
  if (level === "all" && issue.severity === "info") return;
  const t = Date.now();
  if (t - notifyWindowStart > 60000) { notifyWindowStart = t; notifyCount = 0; }
  if (++notifyCount > 4) return;
  const fn = issue.severity === "critical" ? "error" : "warn";
  ui.notifications?.[fn]?.(`Performance Analyst: ${issue.title}${issue.owner ? ` (${ownerLabel(issue.owner)})` : ""}`, { console: false });
}

/* ================================================================ */
/*  Konsole mitlesen                                                 */
/* ================================================================ */

const DEPRECATION_RE = /deprecat|migrated to|no longer supported|has been (renamed|moved|replaced)|backwards-compatible|will be removed|veraltet/i;

function stringifyArg(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  if (a === undefined) return "undefined";
  try {
    const s = JSON.stringify(a);
    return s && s.length > 300 ? `${s.slice(0, 300)} …` : (s ?? String(a));
  } catch { return String(a); }
}

function normalizeKey(level, msg) {
  return `${level}|${msg.slice(0, 240).replace(/\b[a-zA-Z0-9]{16}\b/g, "ID").replace(/\d+(\.\d+)?/g, "#")}`;
}

function __apaNoteConsole(level, args) {
  const first = args.find((a) => a instanceof Error);
  let msg = args.map(stringifyArg).join(" ").trim();
  if (!msg) return;
  if (msg.length > 1200) msg = `${msg.slice(0, 1200)} …`;
  const category = level === "error" ? "error" : (DEPRECATION_RE.test(msg) ? "deprecation" : "warning");
  const key = normalizeKey(category, msg.split("\n")[0]);
  let e = state.consoleEntries.get(key);
  if (!e) {
    if (state.consoleEntries.size >= CONSOLE_CAP) return;
    const owner = ownerFromStack(first?.stack) ?? ownerFromStack(msg) ?? __apaCapture(OWNER_UNKNOWN);
    e = { key, category, msg: msg.split("\n").slice(0, 6).join("\n"), owner, count: 0, first: Date.now(), last: Date.now(), winStart: Date.now(), winCount: 0 };
    state.consoleEntries.set(key, e);
  }
  e.count++;
  e.last = Date.now();
  if (e.last - e.winStart > 60000) { e.winStart = e.last; e.winCount = 0; }
  e.winCount++;
  forScopes((s) => {
    const o = s.owner(e.owner);
    if (category === "error") o.errors++;
    else if (category === "deprecation") o.deprecations++;
    else o.warnings++;
  });
  if (e.count === 1 || e.count % 50 === 0) timelinePush({ type: category, owner: e.owner, label: e.msg.split("\n")[0].slice(0, 160), n: e.count });
  if (e.winCount === 30) {
    const first = e.msg.split("\n")[0].slice(0, 200);
    if (category === "error") addIssue(`spam:${key}`, "critical", "Fehler-Spam in der Konsole", `Dieser Fehler kam mehr als 30-mal pro Minute (insgesamt ${e.count}×). Ständig wiederholte Fehler kosten selbst viel Leistung: „${first}“`, e.owner);
    else if (category === "deprecation") addIssue(`spam:${key}`, "warn", "Veraltete Foundry-Funktion im Dauereinsatz", `Ein Modul ruft mehr als 30-mal pro Minute eine veraltete Funktion auf (insgesamt ${e.count}×). Jeder Aufruf erzeugt intern einen Stacktrace und kostet Zeit. Abhilfe: Modul aktualisieren. „${first}“`, e.owner);
    else addIssue(`spam:${key}`, "warn", "Warnungs-Spam in der Konsole", `Diese Warnung kam mehr als 30-mal pro Minute (insgesamt ${e.count}×): „${first}“`, e.owner);
  }
}

let inConsoleNote = false;

function patchConsole() {
  for (const level of ["error", "warn"]) {
    const orig = console[level];
    if (typeof orig !== "function" || orig.__apa) continue;
    const w = function __apaConsole(...args) {
      if (!inConsoleNote) {
        inConsoleNote = true;
        try { __apaNoteConsole(level, args); } catch { /* nie stören */ } finally { inConsoleNote = false; }
      }
      return orig.apply(this, args);
    };
    w.__apa = true;
    console[level] = w;
  }
}

function listenWindowErrors() {
  window.addEventListener("error", (ev) => {
    try {
      const el = ev.target;
      if (el && el !== window && (el.src || el.href)) {
        const url = el.currentSrc || el.src || el.href;
        noteFailedAsset(url, el.tagName?.toLowerCase() ?? "element");
        return;
      }
      if (ev.error || ev.message) __apaNoteConsole("error", [ev.error ?? new Error(String(ev.message))]);
    } catch { /* egal */ }
  }, true);
  window.addEventListener("unhandledrejection", (ev) => {
    try {
      const r = ev.reason;
      __apaNoteConsole("error", [r instanceof Error ? r : new Error(`Unbehandelte Promise-Ablehnung: ${stringifyArg(r)}`)]);
    } catch { /* egal */ }
  });
}

/* ================================================================ */
/*  Assets (Dateien, die der Browser lädt)                           */
/* ================================================================ */

const EXT_TYPES = {
  image: ["png", "jpg", "jpeg", "webp", "avif", "gif", "svg", "bmp", "tif", "tiff"],
  audio: ["ogg", "oga", "mp3", "wav", "flac", "m4a", "aac", "opus"],
  video: ["webm", "mp4", "m4v", "ogv", "mov"],
  script: ["js", "mjs"],
  style: ["css"],
  font: ["woff", "woff2", "ttf", "otf"],
  data: ["json", "db"]
};

function assetType(url) {
  const ext = (url.split("?")[0].split("#")[0].split(".").pop() ?? "").toLowerCase();
  for (const [t, list] of Object.entries(EXT_TYPES)) if (list.includes(ext)) return { type: t, ext };
  return { type: "other", ext };
}

function thresholds() {
  const def = { image: 3, audio: 10, video: 30 };
  try {
    return {
      image: game.settings.get(MODULE_ID, "limitImageMB") ?? def.image,
      audio: game.settings.get(MODULE_ID, "limitAudioMB") ?? def.audio,
      video: game.settings.get(MODULE_ID, "limitVideoMB") ?? def.video
    };
  } catch { return def; }
}

function prettyPath(url) {
  try {
    const u = new URL(url, location.href);
    return decodeURIComponent(u.pathname);
  } catch { return url; }
}

function noteResource(e) {
  if (!e?.name || e.name.startsWith("data:") || e.name.startsWith("blob:")) return;
  const url = e.name.split("#")[0];
  const { type, ext } = assetType(url);
  const size = Math.max(e.encodedBodySize || 0, e.transferSize || 0);
  const prev = state.assets.get(url);
  const asset = prev ?? { url, path: prettyPath(url), type, ext, owner: ownerFromUrl(url) ?? "data", size: 0, decoded: 0, duration: 0, loads: 0, status: null };
  asset.size = Math.max(asset.size, size);
  asset.decoded = Math.max(asset.decoded, e.decodedBodySize || 0);
  asset.duration = Math.max(asset.duration, e.duration || 0);
  asset.loads++;
  if (e.responseStatus) asset.status = e.responseStatus;
  state.assets.set(url, asset);
  if (state.ready) checkAsset(asset);
}

function checkAsset(a) {
  const lim = thresholds();
  const m = a.size / 1048576;
  if (a.status >= 400) noteFailedAsset(a.url, a.type, a.status);
  if (a.type === "image" && m > lim.image) {
    const tip = ["png", "jpg", "jpeg", "bmp", "tif", "tiff"].includes(a.ext) ? " Als WebP gespeichert ist so ein Bild meist 60–80 % kleiner." : "";
    addIssue(`asset:${a.url}`, m > lim.image * 3 ? "critical" : "warn", "Großes Bild", `${a.path} ist ${round(m, 1)} MB groß.${tip}`, a.owner);
  } else if (a.type === "image" && a.ext === "gif" && m > 1) {
    addIssue(`asset:${a.url}`, "warn", "Animiertes GIF", `${a.path} (${round(m, 1)} MB) – GIFs sind groß und langsam. Als WebM-Video ist die Animation meist ein Bruchteil so groß.`, a.owner);
  } else if (a.type === "audio" && m > lim.audio) {
    const tip = ["wav", "flac"].includes(a.ext) ? " Als OGG gespeichert schrumpft die Datei meist auf ein Zehntel." : "";
    addIssue(`asset:${a.url}`, "warn", "Große Audiodatei", `${a.path} ist ${round(m, 1)} MB groß.${tip}`, a.owner);
  } else if (a.type === "video" && m > lim.video) {
    addIssue(`asset:${a.url}`, "warn", "Großes Video", `${a.path} ist ${round(m, 1)} MB groß. Videos als Token/Kachel werden ständig neu auf die Grafikkarte geladen.`, a.owner);
  } else if (a.type === "script" && m > 3) {
    addIssue(`asset:${a.url}`, "info", "Sehr großes Skript", `${a.path} ist ${round(m, 1)} MB groß und verlängert jeden Start.`, a.owner);
  }
  if (a.duration > 8000 && a.size > 0) {
    addIssue(`slow:${a.url}`, "info", "Langsam geladene Datei", `${a.path} brauchte ${round(a.duration / 1000, 1)} s zum Laden (${fmtBytes(a.size)}).`, a.owner);
  }
}

function noteFailedAsset(url, kind, status = null) {
  if (!url || url.startsWith("data:")) return;
  const key = url.split("#")[0];
  const f = state.failedAssets.get(key) ?? { url: key, path: prettyPath(key), kind, status, count: 0, owner: ownerFromUrl(key) ?? "data" };
  f.count++;
  if (status) f.status = status;
  state.failedAssets.set(key, f);
  // API-Abfragen ohne Dateiendung (z. B. /api/plutonium) sind meist harmlose Prüfungen.
  const isFile = /\.[a-z0-9]{2,5}$/i.test(f.path);
  if (!isFile && f.count < 10) return;
  addIssue(`fail:${key}`, "warn", "Datei nicht gefunden / nicht ladbar", `${f.path}${f.status ? ` (Status ${f.status})` : ""}. Fehlende Dateien lösen bei jedem Versuch erneut Anfragen und Fehler aus.`, f.owner);
}

function startResourceObserver() {
  try { performance.setResourceTimingBufferSize?.(8000); } catch { /* egal */ }
  try {
    for (const e of performance.getEntriesByType("resource")) noteResource(e);
    const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) noteResource(e); });
    obs.observe({ type: "resource", buffered: false });
  } catch { /* egal */ }
}

/* ================================================================ */
/*  Netzwerk (Socket)                                                */
/* ================================================================ */

let docOpsWindow = { start: 0, n: 0 };

function socketStat(scope, event) {
  let s = scope.socket.get(event);
  if (!s) { s = { out: 0, in: 0, outBytes: 0, inBytes: 0 }; scope.socket.set(event, s); }
  return s;
}

function estimateSize(args) {
  if (!state.rec) return 0;
  try {
    const s = JSON.stringify(args.filter((a) => typeof a !== "function"));
    return s ? s.length : 0;
  } catch { return 0; }
}

function __apaNoteSocketOut(event, args) {
  const size = estimateSize(args);
  let owner = null;
  if (typeof event === "string" && event.startsWith("module.")) owner = event.slice(7);
  else if (typeof event === "string" && event.startsWith("system.")) owner = `system:${event.slice(7)}`;
  forScopes((s) => {
    const st = socketStat(s, String(event));
    st.out++;
    st.outBytes += size;
    if (owner) {
      const o = s.owner(owner);
      o.sockOut++;
      o.sockOutBytes += size;
    }
  });
}

/**
 * Wer ändert Dokumente? Gemessen am Aufruf von create/update/deleteDocuments –
 * dort ist der Stacktrace noch vollständig (beim späteren Senden nicht mehr).
 */
function __apaNoteDoc(docName, action, n) {
  const t = Date.now();
  if (t - docOpsWindow.start > 1000) docOpsWindow = { start: t, n: 0 };
  docOpsWindow.n++;
  const owner = docOpsWindow.n > 40 ? OWNER_UNKNOWN : __apaCapture(OWNER_CORE);
  const label = `${docName ?? "?"}.${action}`;
  forScopes((s) => {
    const o = s.owner(owner);
    o.docOps += n;
    o.docBy.set(label, (o.docBy.get(label) ?? 0) + n);
  });
  timelinePush({ type: "dokument", owner, label, n });
  if (docOpsWindow.n === 25) addIssue(`docspam:${owner}`, "warn", "Viele Dokument-Änderungen pro Sekunde", `In einer Sekunde wurden über 25 Änderungen angestoßen, zuletzt durch ${ownerLabel(owner)}. Jede Änderung geht an den Server und von dort an alle Spieler.`, owner);
}

function patchDocuments() {
  const Doc = globalThis.foundry?.abstract?.Document;
  if (!Doc || Doc.__apaPatched) return;
  for (const [method, action] of [["createDocuments", "create"], ["updateDocuments", "update"], ["deleteDocuments", "delete"]]) {
    const orig = Doc[method];
    if (typeof orig !== "function") continue;
    try {
      Doc[method] = function __apaDoc(...args) {
        try { __apaNoteDoc(this.documentName, action, Array.isArray(args[0]) ? args[0].length : 1); } catch { /* egal */ }
        return orig.apply(this, args);
      };
    } catch { /* egal */ }
  }
  Doc.__apaPatched = true;
}

function noteSocketIn(event, args) {
  const size = estimateSize(args);
  let owner = null;
  if (typeof event === "string" && event.startsWith("module.")) owner = event.slice(7);
  else if (typeof event === "string" && event.startsWith("system.")) owner = `system:${event.slice(7)}`;
  forScopes((s) => {
    const st = socketStat(s, String(event));
    st.in++;
    st.inBytes += size;
    if (owner) {
      const o = s.owner(owner);
      o.sockIn++;
      o.sockInBytes += size;
    }
  });
}

function patchSocket() {
  const sock = game.socket;
  if (!sock || sock.__apaPatched) return;
  const origEmit = sock.emit;
  sock.emit = function __apaEmit(event, ...args) {
    try { __apaNoteSocketOut(event, args); } catch { /* egal */ }
    return origEmit.call(this, event, ...args);
  };
  try { sock.onAny?.((event, ...args) => { try { noteSocketIn(event, args); } catch { /* egal */ } }); } catch { /* egal */ }
  sock.__apaPatched = true;
}

/* ================================================================ */
/*  Umgebung prüfen (Browser, Grafikkarte, Foundry-Einstellungen)    */
/* ================================================================ */

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Electron\//.test(ua)) return `Electron ${ua.match(/Electron\/([\d.]+)/)?.[1] ?? ""} (Foundry-App)`;
  if (/Firefox\//.test(ua)) return `Firefox ${ua.match(/Firefox\/([\d.]+)/)?.[1] ?? ""}`;
  if (/Edg\//.test(ua)) return `Edge ${ua.match(/Edg\/([\d.]+)/)?.[1] ?? ""}`;
  if (/OPR\//.test(ua)) return `Opera ${ua.match(/OPR\/([\d.]+)/)?.[1] ?? ""}`;
  if (/Chrome\//.test(ua)) return `Chrome/Chromium ${ua.match(/Chrome\/([\d.]+)/)?.[1] ?? ""}`;
  if (/Safari\//.test(ua)) return "Safari";
  return ua;
}

function checkEnvironment() {
  const env = state.env;
  env.browser = detectBrowser();
  env.cores = navigator.hardwareConcurrency ?? null;
  env.deviceMemory = navigator.deviceMemory ?? null;
  env.dpr = window.devicePixelRatio;
  env.screen = `${screen.width}×${screen.height}`;
  env.viewport = `${window.innerWidth}×${window.innerHeight}`;
  env.foundry = game.version ?? game.release?.version;
  env.system = `${game.system?.title ?? game.system?.id} ${game.system?.version ?? ""}`;
  env.modulesActive = [...game.modules].filter((m) => m.active).length;
  env.loaf = state.loafSupported ? "ja" : "nein (Firefox o. ä.)";
  env.heapApi = performance.memory ? "ja" : "nein";
  env.hookMode = state.hookMode;
  env.lwMode = state.lwMode;
  try { env.performanceMode = game.settings.get("core", "performanceMode"); } catch { /* egal */ }
  try { env.maxFPS = game.settings.get("core", "maxFPS"); } catch { /* egal */ }

  const gl = globalThis.canvas?.app?.renderer?.gl;
  if (gl) {
    try {
      env.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      env.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      env.gpuVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    } catch { /* egal */ }
    if (env.gpu && /swiftshader|llvmpipe|softpipe|basic render|software|mesa offscreen/i.test(env.gpu)) {
      addIssue("gpu-software", "critical", "Grafikkarte wird nicht genutzt", `Der Browser zeichnet per Software („${env.gpu}“). Das ist der häufigste Grund für extrem schlechte Leistung. Lösung: In den Browser-Einstellungen „Hardwarebeschleunigung verwenden“ aktivieren und Grafiktreiber aktualisieren.`);
    }
  } else {
    try { if (game.settings.get("core", "noCanvas")) env.gpu = "Canvas deaktiviert"; } catch { /* egal */ }
  }

  const debug = globalThis.CONFIG?.debug ?? {};
  const debugOn = Object.entries(debug).filter(([, v]) => v === true).map(([k]) => k);
  env.debugFlags = debugOn.join(", ") || "keine";
  if (debugOn.length) {
    addIssue("config-debug", debugOn.includes("hooks") ? "critical" : "warn", "Debug-Modus aktiv", `Folgende CONFIG.debug-Schalter sind an: ${debugOn.join(", ")}. Besonders „hooks“ protokolliert jeden einzelnen Hook und bremst stark. Meist von einem Entwickler- oder Debug-Modul gesetzt.`);
  }

  // Modul-Kompatibilität
  const major = Number(String(env.foundry ?? "").split(".")[0]) || null;
  for (const m of game.modules) {
    if (!m.active) continue;
    const comp = m.compatibility ?? {};
    const verified = Number(String(comp.verified ?? "").split(".")[0]) || null;
    const maximum = Number(String(comp.maximum ?? "").split(".")[0]) || null;
    if (major && maximum && maximum < major) {
      addIssue(`compat-max:${m.id}`, "warn", "Modul offiziell nicht für diese Foundry-Version", `${m.title} gibt als höchste Version ${comp.maximum} an. Solche Module erzeugen oft Fehler oder veraltete Aufrufe.`, m.id);
    } else if (major && verified && verified < major - 1) {
      addIssue(`compat-ver:${m.id}`, "info", "Modul lange nicht verifiziert", `${m.title} wurde zuletzt für Foundry ${comp.verified} geprüft.`, m.id);
    }
  }
}

/* ================================================================ */
/*  Szene: Ladezeit, Inhalte, Texturen                               */
/* ================================================================ */

const SCENE_COLLECTIONS = [
  ["tokens", "Token"], ["tiles", "Kacheln"], ["walls", "Wände"], ["lights", "Lichter"],
  ["sounds", "Geräusche"], ["drawings", "Zeichnungen"], ["notes", "Notizen"], ["regions", "Regionen"], ["templates", "Schablonen"]
];

function sceneCounts(scene) {
  const counts = {};
  for (const [key, label] of SCENE_COLLECTIONS) {
    const c = scene?.[key];
    if (c && typeof c.size === "number") counts[label] = c.size;
  }
  return counts;
}

function checkScene(scene) {
  const c = sceneCounts(scene);
  const name = scene?.name ?? "Szene";
  if ((c["Lichter"] ?? 0) > 60) addIssue(`scene-lights:${scene.id}`, "info", "Viele Lichtquellen", `„${name}“ hat ${c["Lichter"]} Lichter. Jede Lichtquelle mit Wänden muss bei Bewegung neu berechnet werden.`);
  if ((c["Wände"] ?? 0) > 4000) addIssue(`scene-walls:${scene.id}`, "info", "Sehr viele Wände", `„${name}“ hat ${c["Wände"]} Wände. Das verlangsamt Sicht- und Lichtberechnung.`);
  if ((c["Token"] ?? 0) > 150) addIssue(`scene-tokens:${scene.id}`, "info", "Sehr viele Token", `„${name}“ hat ${c["Token"]} Token.`);
  if ((c["Geräusche"] ?? 0) > 40) addIssue(`scene-sounds:${scene.id}`, "info", "Viele Umgebungsgeräusche", `„${name}“ hat ${c["Geräusche"]} Geräuschquellen.`);
  return c;
}

/** Läuft durch den kompletten Canvas und sammelt alle Texturen (auch die anderer Module). */
function scanTextures() {
  const cv = globalThis.canvas;
  if (!cv?.ready || !cv.stage) return null;
  const seen = new Map();
  const noteBase = (base) => {
    if (!base || seen.has(base)) return;
    const w = base.realWidth ?? base.pixelWidth ?? base.width ?? 0;
    const h = base.realHeight ?? base.pixelHeight ?? base.height ?? 0;
    if (w * h <= 256) return;
    const res = base.resource ?? base.source ?? {};
    const el = res.source ?? res;
    const url = res.url ?? res.src ?? el?.currentSrc ?? el?.src ?? (typeof base.label === "string" ? base.label : "") ?? "";
    const isVideo = !!(el && typeof HTMLVideoElement !== "undefined" && el instanceof HTMLVideoElement);
    const isRender = !url && (!!base.framebuffer || /Render/i.test(base.constructor?.name ?? ""));
    seen.set(base, {
      url: url ? prettyPath(url) : "",
      w, h,
      bytes: w * h * 4 * (base.mipmap ? 1.33 : 1),
      video: isVideo,
      render: isRender,
      owner: url ? (ownerFromUrl(url) ?? "data") : OWNER_CORE
    });
  };
  const walk = (obj, depth) => {
    if (!obj || depth > 60) return;
    const tex = obj.texture;
    if (tex) noteBase(tex.baseTexture ?? tex.source ?? tex);
    const ch = obj.children;
    if (ch?.length) for (const c of ch) walk(c, depth + 1);
  };
  try { walk(cv.stage, 0); } catch { /* egal */ }
  try {
    const cache = globalThis.PIXI?.utils?.BaseTextureCache;
    if (cache) for (const bt of new Set(Object.values(cache))) noteBase(bt);
  } catch { /* egal */ }

  const list = [...seen.values()];
  const maxTex = state.env.maxTexture ?? 16384;
  const files = list.filter((t) => !t.render).sort((a, b) => b.bytes - a.bytes);
  const total = list.reduce((s, t) => s + t.bytes, 0);
  const fileBytes = files.reduce((s, t) => s + t.bytes, 0);
  const result = {
    at: Date.now(),
    scene: cv.scene?.name ?? "",
    count: files.length,
    videos: files.filter((t) => t.video).length,
    renderTextures: list.length - files.length,
    totalBytes: total,
    fileBytes,
    top: files.slice(0, 40).map((t) => ({ ...t, bytes: Math.round(t.bytes) }))
  };
  for (const t of files) {
    const side = Math.max(t.w, t.h);
    if (side > maxTex) addIssue(`tex-max:${t.url}`, "critical", "Bild größer als die Grafikkarte erlaubt", `${t.url} ist ${t.w}×${t.h} Pixel, die Grafikkarte schafft maximal ${maxTex}. Das Bild wird verkleinert oder fehlt. Auf höchstens ${Math.min(maxTex, 8192)} Pixel Kantenlänge verkleinern.`, t.owner);
    else if (side > 8192) addIssue(`tex-big:${t.url}`, "warn", "Sehr hoch aufgelöstes Bild", `${t.url} ist ${t.w}×${t.h} Pixel (≈ ${mb(t.bytes)} MB Grafikspeicher). Ab 8192 Pixel haben schwächere Grafikkarten und Tablets Probleme.`, t.owner);
  }
  if (result.videos > 15) addIssue(`tex-videos:${cv.scene?.id}`, "info", "Viele Video-Texturen", `In der Szene laufen ${result.videos} Videos (animierte Token/Kacheln). Jedes Video wird pro Bild neu auf die Grafikkarte geladen.`);
  if (fileBytes > 3 * 1073741824) addIssue(`vram:${cv.scene?.id}`, "critical", "Szene braucht sehr viel Grafikspeicher", `Geschätzt ${round(fileBytes / 1073741824, 1)} GB Grafikspeicher allein für Bilder. Schwächere Grafikkarten lagern dann aus und ruckeln stark.`);
  else if (fileBytes > 1.5 * 1073741824) addIssue(`vram:${cv.scene?.id}`, "warn", "Szene braucht viel Grafikspeicher", `Geschätzt ${round(fileBytes / 1073741824, 1)} GB Grafikspeicher für Bilder.`);
  state.textures = result;
  return result;
}

/* ================================================================ */
/*  Welt-Scan: Flag- und Einstellungsdaten pro Modul                  */
/* ================================================================ */

function scanFlags(src, acc, depth = 0) {
  if (!src || typeof src !== "object" || depth > 5) return;
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== "object") continue;
    if (k === "flags" && !Array.isArray(v)) {
      for (const [ns, data] of Object.entries(v)) {
        let n = 0;
        try { n = JSON.stringify(data)?.length ?? 0; } catch { /* egal */ }
        const a = acc[ns] ?? (acc[ns] = { bytes: 0, docs: 0 });
        a.bytes += n;
        a.docs++;
      }
    } else if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === "object" && "_id" in x) scanFlags(x, acc, depth + 1);
    } else if (k === "delta") {
      scanFlags(v, acc, depth + 1);
    }
  }
}

async function worldScan(progress) {
  const flags = {};
  const counts = [];
  let done = 0;
  for (const [name, coll] of game.collections?.entries?.() ?? []) {
    let n = 0;
    for (const doc of coll) {
      scanFlags(doc._source ?? doc, flags);
      n++;
      if (++done % 250 === 0) {
        progress?.(done);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    counts.push({ name, count: n });
  }

  const settings = {};
  const addSetting = (key, value, scope) => {
    const ns = String(key).split(".")[0];
    const s = settings[ns] ?? (settings[ns] = { world: 0, client: 0, user: 0 });
    s[scope] += typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0);
  };
  try {
    const ws = game.settings.storage.get("world");
    for (const s of ws ?? []) addSetting(s.key, s.value ?? s._source?.value, "world");
  } catch { /* egal */ }
  try {
    const us = game.settings.storage.get("user");
    for (const s of us ?? []) addSetting(s.key, s.value ?? s._source?.value, "user");
  } catch { /* egal */ }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.includes(".")) addSetting(k, localStorage.getItem(k) ?? "", "client");
    }
  } catch { /* egal */ }

  const active = new Set([...game.modules].filter((m) => m.active).map((m) => m.id));
  const known = new Set([...game.modules].map((m) => m.id));
  const nsRows = new Set([...Object.keys(flags), ...Object.keys(settings)]);
  const rows = [...nsRows].map((ns) => {
    const status = ns === "core" ? "Kern" : ns === game.system.id ? "System" : active.has(ns) ? "aktiv" : known.has(ns) ? "deaktiviert" : "nicht installiert";
    return {
      ns,
      label: ns === "core" ? "Foundry-Kern" : ns === game.system.id ? `System: ${game.system.title}` : (game.modules.get(ns)?.title ?? ns),
      status,
      flagBytes: flags[ns]?.bytes ?? 0,
      flagDocs: flags[ns]?.docs ?? 0,
      settingBytes: (settings[ns]?.world ?? 0) + (settings[ns]?.user ?? 0) + (settings[ns]?.client ?? 0)
    };
  }).sort((a, b) => (b.flagBytes + b.settingBytes) - (a.flagBytes + a.settingBytes));

  for (const r of rows) {
    const total = r.flagBytes + r.settingBytes;
    if (total > 20 * 1048576) addIssue(`world-data:${r.ns}`, "warn", "Modul speichert sehr viele Daten in der Welt", `${r.label} hat ${mb(total)} MB in Dokumenten/Einstellungen abgelegt. Das wird bei jedem Weltstart geladen und an alle Spieler geschickt.`, r.ns);
    if ((r.status === "deaktiviert" || r.status === "nicht installiert") && total > 1048576) addIssue(`world-orphan:${r.ns}`, "info", "Datenreste eines ungenutzten Moduls", `${r.label} (${r.status}) hat noch ${mb(total)} MB Daten in der Welt.`, r.ns);
  }
  const msgCount = game.messages?.size ?? 0;
  if (msgCount > 5000) addIssue("chat-huge", "warn", "Sehr langer Chat-Verlauf", `${msgCount} Chat-Nachrichten. Jede wird beim Start an jeden Spieler geschickt. Tipp: Chat exportieren und leeren.`);
  else if (msgCount > 2000) addIssue("chat-big", "info", "Langer Chat-Verlauf", `${msgCount} Chat-Nachrichten. Ein regelmäßiges Leeren hält den Weltstart schnell.`);

  state.world = { at: Date.now(), docs: done, counts: counts.sort((a, b) => b.count - a.count), rows };
  return state.world;
}

/* ================================================================ */
/*  Berichte                                                         */
/* ================================================================ */

const STARTUP_LABELS = new Set(["init", "i18nInit", "setup", "ready"]);

function moduleRows(scope) {
  const reg = registeredHooksByOwner();
  const code = new Map();
  const media = new Map();
  for (const a of state.assets.values()) {
    const target = ["script", "style"].includes(a.type) ? code : media;
    const c = target.get(a.owner) ?? { bytes: 0, ms: 0, n: 0 };
    c.bytes += a.size;
    c.ms += a.duration;
    c.n++;
    target.set(a.owner, c);
  }
  // Noch nicht zugeordnete Hooks zu einer Zeile zusammenfassen.
  const owners = new Map();
  for (const [id, o] of scope.owners) {
    if (!isPending(id)) { owners.set(id, o); continue; }
    if (!owners.has(OWNER_PENDING)) owners.set(OWNER_PENDING, new OwnerStats());
    mergeStats(owners.get(OWNER_PENDING), o);
  }
  const ids = new Set(owners.keys());
  for (const m of globalThis.game?.modules ?? []) if (m.active) ids.add(m.id);
  if (globalThis.game?.system) ids.add(`system:${game.system.id}`);
  ids.add(OWNER_CORE);
  ids.delete("world");
  ids.delete("data");
  const minutes = Math.max(scope.elapsed() / 60000, 1 / 60);
  return [...ids].map((id) => {
    const o = owners.get(id) ?? new OwnerStats();
    const mod = globalThis.game?.modules?.get?.(id);
    const top = [...o.by.entries()]
      .map(([label, b]) => ({ label, kind: b.kind, time: round(b.time, 2), calls: b.calls, avg: round(b.time / Math.max(b.calls, 1), 3), max: round(b.max, 2) }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 15);
    return {
      id,
      label: ownerLabel(id),
      kind: ownerKind(id),
      version: mod?.version ?? (id.startsWith("system:") ? game.system?.version : ""),
      startup: round(o.startupTime, 1),
      runtime: round(o.runTime, 1),
      perMin: round(o.runTime / minutes, 2),
      calls: o.calls,
      max: round(o.maxTime, 1),
      maxLabel: o.maxLabel,
      jankCount: o.jankCount,
      jankMs: round(o.jankMs, 1),
      errors: o.errors,
      warnings: o.warnings,
      deprecations: o.deprecations,
      sockOut: o.sockOut,
      sockIn: o.sockIn,
      sockBytes: o.sockOutBytes + o.sockInBytes,
      docOps: o.docOps,
      docBy: Object.fromEntries([...o.docBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)),
      hooks: reg.get(id) ?? 0,
      codeBytes: code.get(id)?.bytes ?? 0,
      codeMs: round(code.get(id)?.ms ?? 0, 0),
      mediaBytes: media.get(id)?.bytes ?? 0,
      top
    };
  });
}

function buildReport(scope, { timeline = true, maxAssets = 150, maxConsole = 300, maxFrames = 200 } = {}) {
  const f = scope.frames;
  const fpsVals = scope.fps.map((x) => x.fps);
  const assets = [...state.assets.values()];
  const byType = {};
  for (const a of assets) {
    const t = byType[a.type] ?? (byType[a.type] = { n: 0, bytes: 0 });
    t.n++;
    t.bytes += a.size;
  }
  const lastSample = scope.samples[scope.samples.length - 1] ?? null;
  const report = {
    meta: {
      module: game.modules?.get(MODULE_ID)?.version ?? "dev",
      created: new Date().toISOString(),
      scope: scope.name,
      label: scope === state.rec ? state.recLabel : (scope.label ?? ""),
      started: new Date(scope.startDate).toISOString(),
      durationMs: Math.round(scope.elapsed()),
      user: game.user?.name ?? "",
      userId: game.user?.id ?? "",
      isGM: isGM(),
      world: game.world?.title ?? "",
      scene: globalThis.canvas?.scene?.name ?? ""
    },
    env: { ...state.env },
    phases: {
      script: round(state.phases.script, 0),
      init: state.phases.init && round(state.phases.init, 0),
      setup: state.phases.setup && round(state.phases.setup, 0),
      ready: state.phases.ready && round(state.phases.ready, 0),
      firstCanvas: state.phases.firstCanvas && round(state.phases.firstCanvas, 0)
    },
    scenes: state.scenes.slice(-20),
    frames: {
      count: f.count,
      avgFps: f.total ? round((f.count * 1000) / f.total, 1) : null,
      minFps: f.fpsMin !== null ? round(f.fpsMin, 1) : null,
      currentFps: round(currentFps, 1),
      canvasFps: globalThis.canvas?.app?.ticker?.FPS ? round(globalThis.canvas.app.ticker.FPS, 0) : null,
      j50: f.j50, j100: f.j100, j250: f.j250,
      worst: round(f.worst, 1),
      medianFps: fpsVals.length ? [...fpsVals].sort((a, b) => a - b)[Math.floor(fpsVals.length / 2)] : null
    },
    overhead: { calls: scope.overheadCalls, estMs: round(scope.overheadCalls * 0.0008, 1) },
    sample: lastSample,
    modules: moduleRows(scope),
    longFrames: scope.longFrames.slice(-maxFrames),
    assetSummary: { count: assets.length, bytes: assets.reduce((s, a) => s + a.size, 0), byType },
    assets: assets.sort((a, b) => b.size - a.size).slice(0, maxAssets).map(({ url, ...rest }) => ({ ...rest, size: rest.size, duration: round(rest.duration, 0) })),
    failedAssets: [...state.failedAssets.values()].slice(0, 100),
    console: [...state.consoleEntries.values()].sort((a, b) => b.count - a.count).slice(0, maxConsole)
      .map(({ key, winStart, winCount, ...rest }) => rest),
    socket: [...scope.socket.entries()].map(([event, s]) => ({ event, ...s })).sort((a, b) => (b.out + b.in) - (a.out + a.in)).slice(0, 60),
    issues: [...state.issues.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.last - a.last),
    textures: state.textures,
    world: state.world,
    fps: scope.fps.slice(-900),
    samples: scope.samples.slice(-600),
    markers: scope.markers.slice()
  };
  if (timeline) report.timeline = scope.timeline.slice();
  return report;
}

/** Kurze Text-Zusammenfassung – zum Einfügen in einen Chat oder ein Ticket. */
function summaryText(r) {
  const L = [];
  const m = r.meta;
  L.push(`# Performance-Bericht (${m.scope === "rec" ? "Aufzeichnung" : "seit Laden"}${m.label ? `: ${m.label}` : ""})`);
  L.push(`Dauer: ${fmtDuration(m.durationMs)} · Nutzer: ${m.user}${m.isGM ? " (SL)" : ""} · Szene: ${m.scene || "–"}`);
  L.push(`Foundry ${r.env.foundry} · ${r.env.system} · ${r.env.browser} · GPU: ${r.env.gpu ?? "?"} · Module aktiv: ${r.env.modulesActive}`);
  L.push(`Bildrate Browser: Ø ${r.frames.avgFps ?? "?"} FPS, min ${r.frames.minFps ?? "?"}${r.frames.canvasFps ? ` · Canvas ${r.frames.canvasFps} FPS` : ""} · Ruckler >100 ms: ${r.frames.j100}, >250 ms: ${r.frames.j250}, schlimmster: ${r.frames.worst} ms`);
  if (r.sample) L.push(`HTML-Elemente: ${r.sample.dom}${r.sample.heap ? ` · JS-Speicher: ${mb(r.sample.heap)} MB` : ""}`);
  if (r.phases.ready) L.push(`Start: init ${fmtMs(r.phases.init)}, ready ${fmtMs(r.phases.ready)}${r.phases.firstCanvas ? `, erste Szene ${fmtMs(r.phases.firstCanvas)}` : ""}`);
  L.push("");
  L.push("## Laufzeit nach Modul (Top 12)");
  const run = r.modules.filter((x) => x.runtime > 0).sort((a, b) => b.runtime - a.runtime).slice(0, 12);
  for (const x of run) L.push(`- ${x.label}: ${fmtMs(x.runtime)} (${x.perMin} ms/Min, ${x.calls} Aufrufe, max ${x.max} ms bei ${x.maxLabel || "–"}, Ruckler-Beteiligung ${x.jankCount}×)`);
  L.push("");
  L.push("## Startzeit nach Modul (Top 8)");
  for (const x of r.modules.filter((x) => x.startup > 0).sort((a, b) => b.startup - a.startup).slice(0, 8)) L.push(`- ${x.label}: ${fmtMs(x.startup)}`);
  const err = r.modules.filter((x) => x.errors + x.warnings + x.deprecations > 0).sort((a, b) => (b.errors * 10 + b.deprecations) - (a.errors * 10 + a.deprecations)).slice(0, 8);
  if (err.length) {
    L.push("");
    L.push("## Konsole nach Modul");
    for (const x of err) L.push(`- ${x.label}: ${x.errors} Fehler, ${x.warnings} Warnungen, ${x.deprecations} veraltete Aufrufe`);
  }
  if (r.issues.length) {
    L.push("");
    L.push("## Gefundene Probleme");
    for (const i of r.issues.slice(0, 25)) L.push(`- [${i.severity === "critical" ? "KRITISCH" : i.severity === "warn" ? "Warnung" : "Hinweis"}] ${i.title}${i.owner ? ` (${ownerLabel(i.owner)})` : ""}: ${i.detail}`);
  }
  if (r.longFrames.length) {
    L.push("");
    L.push("## Schlimmste Ruckler");
    for (const f of [...r.longFrames].sort((a, b) => b.dur - a.dur).slice(0, 10)) {
      L.push(`- ${f.dur} ms${f.phase ? ` [${f.phase}]` : ""}: ${f.owners.map((o) => `${ownerLabel(o.id)} ${o.ms} ms`).join(", ")}`);
      for (const d of (f.details ?? []).slice(0, 3)) L.push(`    · ${ownerLabel(d.owner)}: ${d.what} (${d.ms} ms)`);
    }
  }
  return L.join("\n");
}

function toCsv(r) {
  const cols = [
    ["label", "Modul"], ["id", "ID"], ["version", "Version"], ["startup", "Start ms"], ["runtime", "Laufzeit ms"],
    ["perMin", "ms pro Minute"], ["calls", "Aufrufe"], ["max", "Max ms"], ["maxLabel", "Max bei"], ["jankCount", "Ruckler"],
    ["jankMs", "Ruckler ms"], ["errors", "Fehler"], ["warnings", "Warnungen"], ["deprecations", "Veraltet"],
    ["sockOut", "Netz raus"], ["sockIn", "Netz rein"], ["docOps", "Dok.-Änderungen"], ["hooks", "Hooks"],
    ["codeBytes", "Code Bytes"], ["mediaBytes", "Medien Bytes"]
  ];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.map((c) => q(c[1])).join(";")];
  for (const row of r.modules) lines.push(cols.map(([k]) => q(typeof row[k] === "number" ? String(row[k]).replace(".", ",") : row[k])).join(";"));
  return lines.join("\n");
}

function download(content, filename, type) {
  if (globalThis.foundry?.utils?.saveDataToFile) return foundry.utils.saveDataToFile(content, type, filename);
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

/* ================================================================ */
/*  Aufzeichnung                                                     */
/* ================================================================ */

const REPORTS_KEY = `${MODULE_ID}.savedReports`;

function loadSavedReports() {
  try {
    const raw = localStorage.getItem(REPORTS_KEY);
    if (raw) state.reports = JSON.parse(raw) ?? [];
  } catch { state.reports = []; }
}

function persistReports() {
  const slim = state.reports.slice(-5).map((r) => ({ ...r, timeline: undefined, samples: r.samples?.slice(-200), fps: r.fps?.slice(-300) }));
  for (let n = slim.length; n > 0; n--) {
    try {
      localStorage.setItem(REPORTS_KEY, JSON.stringify(slim.slice(-n)));
      return;
    } catch { /* zu groß – weniger Berichte versuchen */ }
  }
}

function startRecording(minutes = 0, label = "") {
  if (state.rec) stopRecording();
  state.rec = new Scope("rec");
  state.recLabel = label || `Aufzeichnung ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
  state.recEndAt = minutes > 0 ? now() + minutes * 60000 : null;
  takeSample();
  timelinePush({ type: "marker", label: "Start" });
  RecBadge.show();
  Analyst.refreshSoon();
}

function stopRecording() {
  const rec = state.rec;
  if (!rec) return null;
  timelinePush({ type: "marker", label: "Ende" });
  rec.endPerf = now();
  rec.label = state.recLabel;
  const report = buildReport(rec);
  state.reports.push(report);
  if (state.reports.length > 10) state.reports.shift();
  persistReports();
  state.rec = null;
  state.recEndAt = null;
  RecBadge.hide();
  Analyst.state.view = `saved:${state.reports.length - 1}`;
  Analyst.refreshSoon();
  ui.notifications?.info?.(`Performance Analyst: „${report.meta.label}“ gespeichert.`);
  return report;
}

function addMarker(text) {
  const t = String(text ?? "").trim() || "Markierung";
  forScopes((s) => s.markers.push({ t: Date.now(), label: t }));
  timelinePush({ type: "marker", label: t });
}

/* ================================================================ */
/*  Kleine Aufnahme-Anzeige am Bildschirmrand                         */
/* ================================================================ */

const RecBadge = {
  el: null,
  timer: null,
  show() {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.id = "apa-rec-badge";
      this.el.title = "Performance Analyst öffnen";
      this.el.addEventListener("click", () => Analyst.open());
      document.body.appendChild(this.el);
    }
    this.update();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.update(), 1000);
  },
  hide() {
    clearInterval(this.timer);
    this.timer = null;
    this.el?.remove();
    this.el = null;
  },
  update() {
    if (!state.rec) return this.hide();
    if (state.recEndAt && now() >= state.recEndAt) { stopRecording(); return; }
    const left = state.recEndAt ? ` · noch ${fmtDuration(state.recEndAt - now())}` : "";
    if (this.el) this.el.innerHTML = `<i class="fa-solid fa-circle"></i> REC ${fmtDuration(state.rec.elapsed())}${left} · ${round(currentFps, 0)} FPS`;
  }
};

/* ================================================================ */
/*  Ampel-Button ganz links in der Steuerleiste                       */
/* ================================================================ */

function canAccess() {
  if (isGM()) return true;
  try { return game.settings.get(MODULE_ID, "playerAccess") !== false; } catch { return true; }
}

function sceneButtonWanted() {
  if (!canAccess()) return false;
  try { return game.settings.get(MODULE_ID, "sceneButton") !== false; } catch { return true; }
}

/** Dauerhafte Probleme, die den Button rot halten, solange sie bestehen. */
const PERSISTENT_CRITICAL = ["gpu-software", "config-debug"];

const Health = {
  level: "ok",
  reasons: [],
  recent: [],
  timer: null,

  onLongFrame(lf) {
    // Szenenwechsel und Weltstart dürfen kurz ruckeln; eigene Fensteraktualisierung zählt nicht.
    if (lf.phase) return;
    if (lf.owners[0]?.id === MODULE_ID) return;
    this.recent.push({ t: lf.t, dur: lf.dur });
    if (lf.dur >= 250) this.apply();
  },

  compute() {
    const t = Date.now();
    this.recent = this.recent.filter((f) => t - f.t < 60000);
    const big = this.recent.filter((f) => f.dur >= 250).length;
    const mid = this.recent.filter((f) => f.dur >= 100).length;
    const fps = !document.hidden && currentFps > 0 ? currentFps : null;
    const issues = [...state.issues.values()];
    const critical = issues.filter((i) => i.severity === "critical" && (PERSISTENT_CRITICAL.includes(i.key) || t - i.last < 120000));
    const warns = issues.filter((i) => i.severity === "warn" && t - i.last < 120000);
    const reasons = [];
    let level = "ok";
    const bad = (txt) => { level = "bad"; reasons.push(txt); };
    const warn = (txt) => { if (level === "ok") level = "warn"; reasons.push(txt); };
    if (big >= 3) bad(`${big} starke Ruckler (über 250 ms) in der letzten Minute`);
    else if (big >= 1) warn(`${big} starker Ruckler (über 250 ms) in der letzten Minute`);
    if (mid >= 10) bad(`${mid} Ruckler über 100 ms in der letzten Minute`);
    else if (mid >= 3 && big < 3) warn(`${mid} Ruckler über 100 ms in der letzten Minute`);
    if (fps !== null && fps < 20) bad(`nur ${round(fps, 0)} Bilder pro Sekunde`);
    else if (fps !== null && fps < 35) warn(`nur ${round(fps, 0)} Bilder pro Sekunde`);
    for (const i of critical.slice(0, 2)) bad(i.title);
    for (const i of warns.slice(0, 2)) warn(i.title);
    this.level = level;
    this.reasons = reasons;
  },

  ensureButton() {
    let btn = document.querySelector(".apa-scene-btn");
    if (!sceneButtonWanted()) {
      btn?.closest(".apa-scene-li")?.remove();
      return null;
    }
    if (btn) return btn;
    const menu = document.querySelector("#scene-controls-layers")
      ?? document.querySelector("#scene-controls menu")
      ?? document.querySelector("#controls menu, #controls ol.main-controls");
    if (!menu) return null;
    const li = document.createElement("li");
    li.className = "apa-scene-li";
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "control ui-control layer icon fa-solid fa-gauge-high apa-scene-btn";
    btn.setAttribute("aria-label", "Performance Analyst");
    btn.dataset.tooltipDirection = "RIGHT";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      Analyst.open();
    });
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.rec) stopRecording();
      else startRecording(5, "Schnellaufnahme");
      this.apply();
    });
    li.append(btn);
    menu.append(li);
    return btn;
  },

  apply() {
    if (!state.ready) return;
    this.compute();
    const btn = this.ensureButton();
    if (!btn) return;
    btn.classList.toggle("apa-health-warn", this.level === "warn");
    btn.classList.toggle("apa-health-bad", this.level === "bad");
    btn.classList.toggle("apa-recording", !!state.rec);
    const unread = isGM() ? state.inbox.filter((i) => !i.read).length : 0;
    btn.classList.toggle("apa-inbox", unread > 0);
    const head = { ok: "Performance: alles im grünen Bereich", warn: "Performance: auffällig", bad: "Performance: echte Probleme" }[this.level];
    const lines = [`<strong>${head}</strong>`, ...this.reasons.map((r) => `• ${esc(r)}`)];
    if (state.rec) lines.push(`<em>Aufzeichnung läuft (${fmtDuration(state.rec.elapsed())})</em>`);
    if (unread) lines.push(`<strong style="color:#6aa7e8">${unread} neue${unread === 1 ? "r" : ""} Spieler-Bericht${unread === 1 ? "" : "e"}</strong>`);
    lines.push(`<span style="opacity:.7">Klick: Analyst öffnen · Rechtsklick: ${state.rec ? "Aufzeichnung beenden" : "5 Min aufzeichnen"}</span>`);
    const tip = lines.join("<br>");
    if (btn.dataset.tooltip !== tip) btn.dataset.tooltip = tip;
  },

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => { try { this.apply(); } catch { /* egal */ } }, 2000);
    this.apply();
  }
};

/* ================================================================ */
/*  Spieler-Berichte per Socket                                       */
/* ================================================================ */

const SOCKET = `module.${MODULE_ID}`;

function setupSocket() {
  game.socket.on(SOCKET, (msg) => {
    try {
      if (msg?.t === "req" && !isGM()) {
        let allowed = true;
        try { allowed = game.settings.get(MODULE_ID, "allowRemote"); } catch { /* Standard */ }
        if (!allowed) return;
        const scope = state.rec ?? state.load;
        const report = buildReport(scope, { timeline: false, maxAssets: 40, maxConsole: 60, maxFrames: 40 });
        report.samples = report.samples.slice(-60);
        report.fps = report.fps.slice(-300);
        game.socket.emit(SOCKET, { t: "res", req: msg.req, to: msg.from, user: game.user.id, report });
      } else if (msg?.t === "push" && isGM()) {
        receivePlayerReport(msg);
      } else if (msg?.t === "pushAck" && msg.to === game.user.id) {
        ui.notifications?.info?.(`Performance-Bericht ist beim Spielleiter angekommen (${msg.gm}).`);
      } else if (msg?.t === "res" && isGM() && msg.to === game.user.id) {
        const user = game.users.get(msg.user);
        state.clients.set(msg.user, { name: user?.name ?? msg.user, at: Date.now(), report: msg.report, pending: false });
        Analyst.refreshSoon();
      }
    } catch (err) {
      console.debug("Performance Analyst | Socket", err);
    }
  });
}

/* ---------- Spieler schickt dem SL einen Bericht ---------- */

const INBOX_KEY = `${MODULE_ID}.inbox`;
const INBOX_CAP = 10;

/** Verkleinert einen Bericht, damit er sicher über die Socket-Verbindung passt. */
function slimReport(rep) {
  const r = { ...rep };
  r.timeline = (rep.timeline ?? []).slice(-3000);
  r.assets = (rep.assets ?? []).slice(0, 60);
  r.console = (rep.console ?? []).slice(0, 80);
  r.longFrames = (rep.longFrames ?? []).slice(-150);
  r.fps = (rep.fps ?? []).slice(-600);
  r.samples = (rep.samples ?? []).slice(-120);
  r.world = null;
  let size = JSON.stringify(r).length;
  if (size > 700000) {
    r.timeline = r.timeline.slice(-400);
    r.longFrames = r.longFrames.slice(-50);
    r.console = r.console.slice(0, 30);
    r.assets = r.assets.slice(0, 25);
    size = JSON.stringify(r).length;
  }
  if (size > 900000) r.timeline = [];
  return r;
}

function sendReportToGM(note = "") {
  const gms = game.users.filter((u) => u.isGM && u.active);
  const v = Analyst.state.view;
  let report;
  if (v.startsWith("saved:") && state.reports[Number(v.slice(6))]) report = state.reports[Number(v.slice(6))];
  else if (state.rec) report = buildReport(state.rec, { timeline: true });
  else report = buildReport(state.load, { timeline: false });
  report = slimReport(report);
  report.meta = { ...report.meta, note: String(note ?? "").slice(0, 500), sentAt: new Date().toISOString() };
  if (!gms.length) {
    ui.notifications.warn("Kein Spielleiter online – der Bericht wird stattdessen als Datei gespeichert.");
    download(JSON.stringify(report, null, 1), `performance-bericht_${game.user.name}_${fileStamp()}.json`, "application/json");
    return false;
  }
  game.socket.emit(SOCKET, { t: "push", from: game.user.id, report });
  ui.notifications.info("Performance-Bericht an den Spielleiter gesendet.");
  return true;
}

function receivePlayerReport(msg) {
  const user = game.users.get(msg.from);
  const item = {
    id: randomId(),
    userId: msg.from,
    name: user?.name ?? msg.report?.meta?.user ?? "Spieler",
    at: Date.now(),
    note: msg.report?.meta?.note ?? "",
    read: false,
    report: msg.report
  };
  state.inbox.unshift(item);
  if (state.inbox.length > INBOX_CAP) state.inbox.length = INBOX_CAP;
  persistInbox();
  // Bewusst keine Benachrichtigung beim SL – nur der blaue Punkt am Ampel-Button (stört nicht im Spiel).
  try { game.socket.emit(SOCKET, { t: "pushAck", to: msg.from, gm: game.user.name }); } catch { /* egal */ }
  Health.apply();
  Analyst.refreshSoon();
}

function loadInbox() {
  try { state.inbox = JSON.parse(localStorage.getItem(INBOX_KEY) ?? "[]") ?? []; } catch { state.inbox = []; }
}

function persistInbox() {
  for (let n = Math.min(state.inbox.length, 6); n >= 0; n--) {
    try {
      if (n === 0) { localStorage.removeItem(INBOX_KEY); return; }
      localStorage.setItem(INBOX_KEY, JSON.stringify(state.inbox.slice(0, n)));
      return;
    } catch { /* zu groß – weniger versuchen */ }
  }
}

function requestClientReports() {
  const req = randomId();
  for (const u of game.users) {
    if (!u.active || u.id === game.user.id) continue;
    const prev = state.clients.get(u.id);
    state.clients.set(u.id, { name: u.name, at: prev?.at ?? null, report: prev?.report ?? null, pending: true });
  }
  game.socket.emit(SOCKET, { t: "req", req, from: game.user.id });
  setTimeout(() => {
    for (const c of state.clients.values()) c.pending = false;
    Analyst.refreshSoon();
  }, 8000);
  Analyst.refreshSoon();
}

/* ================================================================ */
/*  Fenster                                                          */
/* ================================================================ */

const TABS = [
  ["overview", "Übersicht", "fa-solid fa-gauge-high"],
  ["modules", "Module", "fa-solid fa-cubes"],
  ["frames", "Ruckler", "fa-solid fa-wave-square"],
  ["assets", "Dateien", "fa-solid fa-photo-film"],
  ["console", "Konsole", "fa-solid fa-terminal"],
  ["network", "Netzwerk", "fa-solid fa-network-wired"],
  ["world", "Welt", "fa-solid fa-earth-europe", true],
  ["clients", "Spieler", "fa-solid fa-users", true],
  ["log", "Berichte", "fa-solid fa-file-export"]
];

const SEV_LABEL = { critical: "Kritisch", warn: "Warnung", info: "Hinweis" };
const SEV_ICON = { critical: "fa-solid fa-circle-exclamation", warn: "fa-solid fa-triangle-exclamation", info: "fa-solid fa-circle-info" };
const KIND_LABEL = { core: "Kern", system: "System", module: "Modul", self: "Dieses Modul", other: "Sonstiges" };

const Analyst = {
  app: null,
  state: { tab: "overview", view: "live:load", sort: "runtime", sortDir: -1, detail: null, filter: "", consoleFilter: "all", markText: "", showSelf: false, worldBusy: false },
  _refreshTimer: null,
  open() {
    if (!canAccess()) {
      ui.notifications?.warn?.("Der Spielleiter hat den Performance Analyst für Spieler deaktiviert.");
      return;
    }
    if (!this.app) this.app = new AnalystApp();
    this.app.render({ force: true });
    try { this.app.bringToFront?.(); } catch { /* egal */ }
  },
  refreshSoon() {
    if (!this.app?.rendered) return;
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.app?.render(), 50);
  },
  currentReport() {
    const v = this.state.view;
    if (v === "live:rec" && state.rec) return { report: buildReport(state.rec, { timeline: false }), live: true };
    if (v.startsWith("saved:")) {
      const r = state.reports[Number(v.slice(6))];
      if (r) return { report: r, live: false };
    }
    if (v.startsWith("client:")) {
      const c = state.clients.get(v.slice(7));
      if (c?.report) return { report: c.report, live: false, client: c };
    }
    if (v.startsWith("inbox:")) {
      const item = state.inbox.find((i) => i.id === v.slice(6));
      if (item?.report) {
        if (!item.read) { item.read = true; persistInbox(); setTimeout(() => Health.apply(), 0); }
        return { report: item.report, live: false, inbox: item };
      }
    }
    this.state.view = "live:load";
    return { report: buildReport(state.load, { timeline: false }), live: true };
  }
};

/* ---------- HTML-Bausteine ---------- */

function bar(value, max, cls = "") {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return `<span class="apa-bar ${cls}"><span style="width:${pct.toFixed(1)}%"></span></span>`;
}

function stat(label, value, sub = "", cls = "") {
  return `<div class="apa-stat ${cls}"><div class="apa-stat-label">${esc(label)}</div><div class="apa-stat-value">${value}</div>${sub ? `<div class="apa-stat-sub">${sub}</div>` : ""}</div>`;
}

function issueList(issues, limit = 100) {
  if (!issues.length) return `<p class="apa-empty"><i class="fa-solid fa-circle-check"></i> Bisher keine Auffälligkeiten gefunden.</p>`;
  return `<ul class="apa-issues">${issues.slice(0, limit).map((i) => `
    <li class="sev-${i.severity}">
      <i class="${SEV_ICON[i.severity]}"></i>
      <div><strong>${esc(i.title)}</strong>${i.owner ? ` <span class="apa-chip">${esc(ownerLabel(i.owner))}</span>` : ""}${i.count > 1 ? ` <span class="apa-muted">${i.count}×</span>` : ""}
      <div class="apa-issue-detail">${esc(i.detail)}</div></div>
    </li>`).join("")}</ul>`;
}

function sparkline(points, key, height = 70) {
  const vals = points.map((p) => p[key]).filter((v) => typeof v === "number");
  if (vals.length < 2) return `<p class="apa-empty">Noch zu wenige Messpunkte.</p>`;
  const w = 600;
  const max = Math.max(...vals, key === "fps" ? 60 : 1);
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`).join(" ");
  return `<svg class="apa-spark" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none"><polyline points="${pts}" /></svg>
    <div class="apa-spark-scale"><span>max ${round(max, 0)}</span><span>min ${round(Math.min(...vals), 0)}</span></div>`;
}

/* ---------- Tabs ---------- */

function tabOverview(r, ctx) {
  const f = r.frames;
  const errs = r.console.filter((c) => c.category === "error").reduce((s, c) => s + c.count, 0);
  const deps = r.console.filter((c) => c.category === "deprecation").reduce((s, c) => s + c.count, 0);
  const run = r.modules.filter((x) => x.runtime > 0 && (ctx.showSelf || x.kind !== "self")).sort((a, b) => b.runtime - a.runtime).slice(0, 6);
  const start = r.modules.filter((x) => x.startup > 0 && (ctx.showSelf || x.kind !== "self")).sort((a, b) => b.startup - a.startup).slice(0, 6);
  const maxRun = run[0]?.runtime ?? 1;
  const maxStart = start[0]?.startup ?? 1;
  const fpsCls = f.avgFps === null ? "" : f.avgFps < 25 ? "bad" : f.avgFps < 45 ? "meh" : "good";
  const env = r.env;
  const crit = r.issues.filter((i) => i.severity === "critical").length;
  return `
  <div class="apa-stats">
    ${stat("Ø Bildrate Browser", f.avgFps !== null ? `${f.avgFps} FPS` : "–", `aktuell ${f.currentFps ?? "–"} · min ${f.minFps ?? "–"}${f.canvasFps ? ` · Canvas ${f.canvasFps} FPS` : ""}`, fpsCls)}
    ${stat("Ruckler", `${f.j100}`, `>100 ms · ${f.j250}× >250 ms · max ${f.worst} ms`, f.j250 > 5 ? "bad" : f.j100 > 20 ? "meh" : "good")}
    ${stat("Probleme", `${r.issues.length}`, `${crit} kritisch`, crit ? "bad" : r.issues.length ? "meh" : "good")}
    ${stat("Konsole", `${errs}`, `Fehler · ${deps} veraltete Aufrufe`, errs > 50 ? "bad" : errs ? "meh" : "good")}
    ${stat("Oberfläche", r.sample ? r.sample.dom.toLocaleString("de-DE") : "–", "HTML-Elemente", r.sample?.dom > 25000 ? "bad" : r.sample?.dom > 15000 ? "meh" : "")}
    ${stat("JS-Speicher", r.sample?.heap ? `${mb(r.sample.heap)} MB` : "–", r.sample?.heap ? "gesamter Tab" : "nur in Chromium messbar")}
  </div>
  <div class="apa-grid2">
    <section><h3><i class="fa-solid fa-stopwatch"></i> Meiste Laufzeit</h3>
      ${run.length ? `<table class="apa-mini">${run.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${fmtMs(x.runtime)}</td><td class="w">${bar(x.runtime, maxRun)}</td></tr>`).join("")}</table>` : `<p class="apa-empty">Noch keine Laufzeit gemessen.</p>`}
    </section>
    <section><h3><i class="fa-solid fa-hourglass-start"></i> Meiste Startzeit</h3>
      ${start.length ? `<table class="apa-mini">${start.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${fmtMs(x.startup)}</td><td class="w">${bar(x.startup, maxStart, "alt")}</td></tr>`).join("")}</table>` : `<p class="apa-empty">Keine Daten.</p>`}
    </section>
  </div>
  <section><h3><i class="fa-solid fa-stethoscope"></i> Gefundene Probleme</h3>${issueList(r.issues)}</section>
  <section><h3><i class="fa-solid fa-desktop"></i> Umgebung</h3>
    <table class="apa-kv">
      <tr><th>Browser</th><td>${esc(env.browser)}</td><th>Grafik</th><td>${esc(env.gpu ?? "–")}</td></tr>
      <tr><th>Foundry / System</th><td>${esc(env.foundry)} · ${esc(env.system)}</td><th>Max. Texturgröße</th><td>${esc(env.maxTexture ?? "–")}</td></tr>
      <tr><th>Bildschirm</th><td>${esc(env.screen)} · Skalierung ${esc(env.dpr)}</td><th>CPU-Kerne / RAM</th><td>${esc(env.cores ?? "–")} / ${env.deviceMemory ? `${env.deviceMemory} GB+` : "–"}</td></tr>
      <tr><th>Leistungsmodus</th><td>${esc(env.performanceMode ?? "–")} · max ${esc(env.maxFPS ?? "–")} FPS</td><th>Aktive Module</th><td>${esc(env.modulesActive ?? "–")}</td></tr>
      <tr><th>Hook-Messung</th><td>${esc(env.hookMode)}</td><th>libWrapper-Messung</th><td>${esc(env.lwMode)}${state.lwPatched ? ` (${state.lwPatched} Wrapper)` : ""}</td></tr>
      <tr><th>Ruckler-Zuordnung</th><td>${state.loafSupported ? "Browser-genau (Long Animation Frames)" : "über Hook-Zeiten (Firefox-Modus)"}</td><th>Debug-Schalter</th><td>${esc(env.debugFlags ?? "–")}</td></tr>
      <tr><th>Weltstart</th><td colspan="3">${r.phases.ready ? `init nach ${fmtMs(r.phases.init)} · bereit nach ${fmtMs(r.phases.ready)}${r.phases.firstCanvas ? ` · erste Szene nach ${fmtMs(r.phases.firstCanvas)}` : ""}` : "–"}</td></tr>
      <tr><th>Messaufwand</th><td colspan="3">${r.overhead.calls.toLocaleString("de-DE")} gemessene Aufrufe · geschätzt ${fmtMs(r.overhead.estMs)} Zusatzzeit durch die Messung selbst</td></tr>
    </table>
  </section>`;
}

const SORTS = {
  label: "Modul", startup: "Start", runtime: "Laufzeit", perMin: "ms/Min", calls: "Aufrufe", max: "Max",
  jankCount: "Ruckler", errors: "Konsole", sockOut: "Netz", codeBytes: "Code", hooks: "Hooks"
};

function tabModules(r, ctx) {
  const filter = ctx.filter.toLowerCase();
  let rows = r.modules.filter((x) => (ctx.showSelf || x.kind !== "self") && (!filter || x.label.toLowerCase().includes(filter) || x.id.toLowerCase().includes(filter)));
  const key = ctx.sort;
  rows.sort((a, b) => {
    const va = key === "errors" ? a.errors * 10 + a.deprecations + a.warnings : a[key];
    const vb = key === "errors" ? b.errors * 10 + b.deprecations + b.warnings : b[key];
    if (typeof va === "string") return ctx.sortDir * va.localeCompare(vb);
    return ctx.sortDir * ((va ?? 0) - (vb ?? 0));
  });
  const maxRun = Math.max(...rows.map((x) => x.runtime), 1);
  const th = (k, cls = "num") => `<th class="${cls} ${ctx.sort === k ? "sorted" : ""}" data-action="sort" data-key="${k}">${SORTS[k]}${ctx.sort === k ? ` <i class="fa-solid fa-caret-${ctx.sortDir < 0 ? "down" : "up"}"></i>` : ""}</th>`;
  return `
  <div class="apa-toolbar">
    <input type="search" name="filter" placeholder="Modul suchen …" value="${esc(ctx.filter)}">
    <label class="apa-check"><input type="checkbox" name="showSelf" ${ctx.showSelf ? "checked" : ""}> Dieses Modul anzeigen</label>
    <span class="apa-muted">Laufzeit = gemessene Eigenzeit in Hooks und libWrapper-Wrappern nach dem Weltstart. Zeile anklicken für Details.</span>
  </div>
  <div class="apa-table-wrap">
  <table class="apa-table">
    <thead><tr>${th("label", "")}${th("startup")}${th("runtime")}${th("perMin")}${th("calls")}${th("max")}${th("jankCount")}${th("errors")}${th("sockOut")}${th("codeBytes")}${th("hooks")}</tr></thead>
    <tbody>${rows.map((x) => `
      <tr class="kind-${x.kind} ${ctx.detail === x.id ? "open" : ""}" data-action="detail" data-id="${esc(x.id)}">
        <td><span class="apa-kind">${KIND_LABEL[x.kind]}</span> ${esc(x.label)}${x.version ? ` <span class="apa-muted">${esc(x.version)}</span>` : ""}</td>
        <td class="num">${x.startup ? fmtMs(x.startup) : "–"}</td>
        <td class="num">${x.runtime ? fmtMs(x.runtime) : "–"}${bar(x.runtime, maxRun)}</td>
        <td class="num">${x.perMin || "–"}</td>
        <td class="num">${x.calls ? x.calls.toLocaleString("de-DE") : "–"}</td>
        <td class="num" title="${esc(x.maxLabel)}">${x.max ? fmtMs(x.max) : "–"}</td>
        <td class="num">${x.jankCount ? `${x.jankCount}× <span class="apa-muted">${fmtMs(x.jankMs)}</span>` : "–"}</td>
        <td class="num">${x.errors ? `<span class="c-err">${x.errors}</span>` : ""}${x.warnings ? ` <span class="c-warn">${x.warnings}</span>` : ""}${x.deprecations ? ` <span class="c-dep">${x.deprecations}</span>` : ""}${!(x.errors + x.warnings + x.deprecations) ? "–" : ""}</td>
        <td class="num">${x.sockOut + x.sockIn ? `${x.sockOut}↑ ${x.sockIn}↓` : "–"}${x.docOps ? ` <span class="apa-muted">${x.docOps} Dok.</span>` : ""}</td>
        <td class="num">${x.codeBytes ? fmtBytes(x.codeBytes) : "–"}</td>
        <td class="num">${x.hooks || "–"}</td>
      </tr>
      ${ctx.detail === x.id ? `<tr class="apa-detail-row"><td colspan="11">${moduleDetail(x)}</td></tr>` : ""}`).join("")}
    </tbody>
  </table></div>
  <p class="apa-legend"><span class="c-err">rot</span> Fehler · <span class="c-warn">gelb</span> Warnungen · <span class="c-dep">blau</span> veraltete Aufrufe (Deprecations)</p>`;
}

function moduleDetail(x) {
  const top = x.top ?? [];
  const docs = Object.entries(x.docBy ?? {});
  return `<div class="apa-detail">
    <div>
      <h4>Teuerste Hooks / Funktionen</h4>
      ${top.length ? `<table class="apa-mini"><tr><th>Name</th><th class="num">Gesamt</th><th class="num">Aufrufe</th><th class="num">Ø</th><th class="num">Max</th></tr>
        ${top.map((t) => `<tr><td>${t.kind === "wrap" ? '<span class="apa-chip">libWrapper</span> ' : ""}${esc(t.label)}</td><td class="num">${fmtMs(t.time)}</td><td class="num">${t.calls}</td><td class="num">${fmtMs(t.avg)}</td><td class="num">${fmtMs(t.max)}</td></tr>`).join("")}</table>` : `<p class="apa-empty">Keine gemessenen Aufrufe.</p>`}
    </div>
    <div>
      <h4>Weitere Werte</h4>
      <table class="apa-kv">
        <tr><th>Startzeit (bis „ready“)</th><td>${fmtMs(x.startup)}</td></tr>
        <tr><th>Code-Dateien</th><td>${fmtBytes(x.codeBytes)}, Ladezeit gesamt ${fmtMs(x.codeMs)}</td></tr>
        <tr><th>Medien des Moduls</th><td>${fmtBytes(x.mediaBytes)}</td></tr>
        <tr><th>Registrierte Hooks</th><td>${x.hooks}</td></tr>
        <tr><th>Netzwerk</th><td>${x.sockOut} gesendet, ${x.sockIn} empfangen${x.sockBytes ? `, ≈ ${fmtBytes(x.sockBytes)}` : ""}</td></tr>
        ${docs.length ? `<tr><th>Dokument-Änderungen</th><td>${docs.map(([k, v]) => `${esc(k)}: ${v}`).join(", ")}</td></tr>` : ""}
      </table>
    </div>
  </div>`;
}

function tabFrames(r, ctx) {
  const all = r.longFrames;
  const inGame = all.filter((f) => !f.phase);
  const loading = all.length - inGame.length;
  const lf = [...all].reverse();
  const worst = [...inGame].sort((a, b) => b.dur - a.dur).slice(0, 10);
  const blame = new Map();
  for (const f of inGame) for (const o of f.owners) blame.set(o.id, (blame.get(o.id) ?? 0) + o.ms);
  const blameRows = [...blame.entries()].filter(([id]) => ctx.showSelf || id !== MODULE_ID).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const maxB = blameRows[0]?.[1] ?? 1;

  // Was steckt hinter den nicht zuordenbaren / Kern-Anteilen?
  const unknownWhat = new Map();
  for (const f of inGame) for (const d of f.details ?? []) {
    if (![OWNER_UNKNOWN, OWNER_CORE, OWNER_CANVAS].includes(d.owner)) continue;
    const k = `${d.owner}|${d.what}`;
    const u = unknownWhat.get(k) ?? { owner: d.owner, what: d.what, ms: 0, n: 0 };
    u.ms += d.ms;
    u.n++;
    unknownWhat.set(k, u);
  }
  const unknownRows = [...unknownWhat.values()].sort((a, b) => b.ms - a.ms).slice(0, 15);

  const chipCls = (id) => (id === OWNER_RENDER ? "dim" : id === OWNER_UNKNOWN ? "unk" : "");
  const frameLine = (f) => `<tr><td>${new Date(f.t).toLocaleTimeString("de-DE")}${f.phase ? `<br><span class="apa-chip phase">${esc(f.phase)}</span>` : ""}</td><td class="num ${f.dur > 250 ? "c-err" : f.dur > 100 ? "c-warn" : ""}">${fmtMs(f.dur)}</td>
    <td>${f.owners.map((o) => `<span class="apa-chip ${chipCls(o.id)}">${esc(ownerLabel(o.id))} ${round(o.ms, 0)} ms</span>`).join(" ")}
    ${(f.details ?? []).length ? `<div class="apa-frame-details">${f.details.slice(0, 4).map((d) => `<div><span class="apa-muted">${esc(ownerLabel(d.owner))}:</span> ${esc(d.what)} <span class="apa-muted">${round(d.ms, 0)} ms</span></div>`).join("")}</div>` : ""}</td></tr>`;
  return `
  <section><h3><i class="fa-solid fa-chart-line"></i> Bildrate (Browser)</h3>${sparkline(r.fps, "fps")}</section>
  <div class="apa-grid2">
    <section><h3><i class="fa-solid fa-user-ninja"></i> Wer steckt in den Rucklern?</h3>
      ${blameRows.length ? `<table class="apa-mini">${blameRows.map(([id, ms]) => `<tr><td>${esc(ownerLabel(id))}</td><td class="num">${fmtMs(ms)}</td><td class="w">${bar(ms, maxB, id === OWNER_RENDER ? "dim" : "")}</td></tr>`).join("")}</table>
      <p class="apa-muted">Nur Ruckler im laufenden Spiel${loading ? ` – ${loading} beim Weltstart oder Szenenwechsel sind ausgeklammert (die sind normal)` : ""}. „Browser“ ist Zeit ohne Skript: Zeichnen, Layout, Garbage Collection.</p>` : `<p class="apa-empty">Keine Ruckler über 50 ms im laufenden Spiel.</p>`}
    </section>
    <section><h3><i class="fa-solid fa-skull"></i> Schlimmste Ruckler im Spiel</h3>
      ${worst.length ? `<table class="apa-mini">${worst.map(frameLine).join("")}</table>` : `<p class="apa-empty">Keine.</p>`}
    </section>
  </div>
  ${unknownRows.length ? `<section><h3><i class="fa-solid fa-magnifying-glass"></i> Was steckt hinter Foundry-Kern und „Nicht zuordenbar“?</h3>
    <p class="apa-muted">Das meldet der Browser über diese Ruckler: Funktionsname · Auslöser · Datei. „Window.requestAnimationFrame“ ist Foundrys Zeichenschleife, „Promise.then“ ist nachgelagerter Code nach einem await.</p>
    <table class="apa-mini"><tr><th>Herkunft</th><th>Was lief</th><th class="num">Zeit</th><th class="num">Ruckler</th></tr>
    ${unknownRows.map((u) => `<tr><td>${esc(ownerLabel(u.owner))}</td><td class="path">${esc(u.what)}</td><td class="num">${fmtMs(u.ms)}</td><td class="num">${u.n}</td></tr>`).join("")}</table></section>` : ""}
  <section><h3><i class="fa-solid fa-list"></i> Alle Ruckler (≥ 50 ms)</h3>
    ${lf.length ? `<div class="apa-table-wrap"><table class="apa-table">${lf.slice(0, 120).map(frameLine).join("")}</table></div>` : `<p class="apa-empty">Keine.</p>`}
  </section>
  ${r.scenes.length ? `<section><h3><i class="fa-solid fa-map"></i> Szenen-Ladezeiten</h3><table class="apa-mini">${[...r.scenes].reverse().map((sc) => `<tr><td>${esc(sc.name)}</td><td class="num">${fmtMs(sc.ms)}</td><td>${Object.entries(sc.counts ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · ")}</td></tr>`).join("")}</table></section>` : ""}`;
}

function tabAssets(r) {
  const s = r.assetSummary;
  const types = Object.entries(s.byType).sort((a, b) => b[1].bytes - a[1].bytes);
  const TYPE_LABEL = { image: "Bilder", audio: "Audio", video: "Video", script: "Skripte", style: "Stylesheets", font: "Schriften", data: "Daten", other: "Sonstiges" };
  const tex = r.textures;
  const lim = thresholds();
  const flag = (a) => (a.type === "image" && a.size > lim.image * 1048576) || (a.type === "audio" && a.size > lim.audio * 1048576) || (a.type === "video" && a.size > lim.video * 1048576);
  return `
  <div class="apa-stats">
    ${stat("Geladene Dateien", s.count.toLocaleString("de-DE"), fmtBytes(s.bytes))}
    ${types.slice(0, 5).map(([t, v]) => stat(TYPE_LABEL[t] ?? t, v.n.toLocaleString("de-DE"), fmtBytes(v.bytes))).join("")}
  </div>
  <section><h3><i class="fa-solid fa-images"></i> Szene auf der Grafikkarte ${Analyst.live ? `<button type="button" data-action="textureScan"><i class="fa-solid fa-magnifying-glass"></i> Jetzt prüfen</button>` : ""}</h3>
    ${tex ? `<p>${esc(tex.scene)}: ${tex.count} Bilder/Videos (${tex.videos} Videos) ≈ <strong>${fmtBytes(tex.fileBytes)}</strong> Grafikspeicher, dazu ${tex.renderTextures} interne Puffer (gesamt ≈ ${fmtBytes(tex.totalBytes)}). <span class="apa-muted">Schätzung: Breite × Höhe × 4 Byte.</span></p>
      <div class="apa-table-wrap"><table class="apa-table"><thead><tr><th>Datei</th><th class="num">Pixel</th><th class="num">Grafikspeicher</th><th>Herkunft</th></tr></thead>
      <tbody>${tex.top.map((t) => `<tr><td class="path">${t.video ? '<span class="apa-chip">Video</span> ' : ""}${esc(t.url || "(ohne Datei)")}</td><td class="num ${Math.max(t.w, t.h) > 8192 ? "c-warn" : ""}">${t.w}×${t.h}</td><td class="num">${fmtBytes(t.bytes)}</td><td>${esc(ownerLabel(t.owner))}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="apa-empty">Wird beim Laden einer Szene automatisch geprüft.</p>`}
  </section>
  ${r.failedAssets.length ? `<section><h3><i class="fa-solid fa-link-slash"></i> Nicht ladbare Dateien</h3><table class="apa-mini">${r.failedAssets.map((f) => `<tr><td class="path">${esc(f.path)}</td><td>${f.status ?? ""}</td><td>${f.count}×</td><td>${esc(ownerLabel(f.owner))}</td></tr>`).join("")}</table></section>` : ""}
  <section><h3><i class="fa-solid fa-weight-hanging"></i> Größte Dateien</h3>
    <p class="apa-muted">Grenzwerte (in den Moduleinstellungen änderbar): Bilder ${lim.image} MB, Audio ${lim.audio} MB, Video ${lim.video} MB. Größe 0 = aus dem Cache oder nicht messbar.</p>
    <div class="apa-table-wrap"><table class="apa-table"><thead><tr><th>Datei</th><th>Typ</th><th class="num">Größe</th><th class="num">Ladezeit</th><th>Herkunft</th></tr></thead>
    <tbody>${r.assets.slice(0, 100).map((a) => `<tr class="${flag(a) ? "flagged" : ""}"><td class="path">${esc(a.path)}</td><td>${esc(a.ext)}</td><td class="num">${fmtBytes(a.size)}</td><td class="num">${fmtMs(a.duration)}</td><td>${esc(ownerLabel(a.owner))}</td></tr>`).join("")}</tbody></table></div>
  </section>`;
}

function tabConsole(r, ctx) {
  const CAT = { error: ["Fehler", "c-err"], warning: ["Warnung", "c-warn"], deprecation: ["Veraltet", "c-dep"] };
  const list = r.console.filter((c) => ctx.consoleFilter === "all" || c.category === ctx.consoleFilter);
  const counts = { error: 0, warning: 0, deprecation: 0 };
  for (const c of r.console) counts[c.category] += c.count;
  const btn = (k, label) => `<button type="button" class="${ctx.consoleFilter === k ? "active" : ""}" data-action="consoleFilter" data-key="${k}">${label}</button>`;
  return `
  <div class="apa-toolbar">
    ${btn("all", "Alle")}${btn("error", `Fehler (${counts.error})`)}${btn("warning", `Warnungen (${counts.warning})`)}${btn("deprecation", `Veraltet (${counts.deprecation})`)}
    <span class="apa-muted">Gleiche Meldungen werden zusammengefasst. „Veraltet“ = Modul nutzt alte Foundry-Funktionen; das erzeugt jedes Mal einen Stacktrace und kostet Zeit.</span>
  </div>
  ${list.length ? `<div class="apa-table-wrap"><table class="apa-table apa-console"><thead><tr><th>Art</th><th class="num">Anzahl</th><th>Quelle</th><th>Meldung</th></tr></thead><tbody>
    ${list.map((c) => `<tr><td><span class="${CAT[c.category][1]}">${CAT[c.category][0]}</span></td><td class="num">${c.count}</td><td>${esc(ownerLabel(c.owner))}</td><td><pre>${esc(c.msg)}</pre></td></tr>`).join("")}
  </tbody></table></div>` : `<p class="apa-empty"><i class="fa-solid fa-circle-check"></i> Keine Meldungen.</p>`}
  ${!CONSOLE_ENABLED ? `<p class="apa-muted">Das Mitlesen der Konsole ist in den Einstellungen ausgeschaltet.</p>` : ""}`;
}

function tabNetwork(r) {
  const rows = r.socket;
  const mods = r.modules.filter((x) => x.sockOut + x.sockIn + x.docOps > 0).sort((a, b) => (b.sockOut + b.sockIn + b.docOps) - (a.sockOut + a.sockIn + a.docOps));
  return `
  <p class="apa-muted">Nachrichten zwischen diesem Browser und dem Foundry-Server. Größen werden nur während einer Aufzeichnung geschätzt.</p>
  <div class="apa-grid2">
    <section><h3>Nach Modul</h3>
      ${mods.length ? `<table class="apa-mini"><tr><th>Modul</th><th class="num">gesendet</th><th class="num">empfangen</th><th class="num">Dok.-Änderungen</th></tr>${mods.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${x.sockOut}</td><td class="num">${x.sockIn}</td><td class="num">${x.docOps || "–"}</td></tr>`).join("")}</table>` : `<p class="apa-empty">Noch kein Verkehr zugeordnet.</p>`}
    </section>
    <section><h3>Nach Nachricht</h3>
      ${rows.length ? `<table class="apa-mini"><tr><th>Ereignis</th><th class="num">↑</th><th class="num">↓</th><th class="num">Größe</th></tr>${rows.map((s) => `<tr><td>${esc(s.event)}</td><td class="num">${s.out}</td><td class="num">${s.in}</td><td class="num">${s.outBytes + s.inBytes ? fmtBytes(s.outBytes + s.inBytes) : "–"}</td></tr>`).join("")}</table>` : `<p class="apa-empty">Noch kein Verkehr.</p>`}
    </section>
  </div>`;
}

function tabWorld(r, ctx) {
  if (!isGM()) return `<p class="apa-empty">Nur für den Spielleiter.</p>`;
  const w = r.world;
  return `
  <div class="apa-toolbar">
    <button type="button" data-action="worldScan" ${ctx.worldBusy ? "disabled" : ""}><i class="fa-solid fa-magnifying-glass-chart"></i> ${ctx.worldBusy ? `Prüfe … ${ctx.worldProgress ?? ""}` : "Welt prüfen"}</button>
    <span class="apa-muted">Misst, wie viele Daten jedes Modul in Akteuren, Gegenständen, Szenen usw. (Flags) und in Einstellungen speichert. Kann bei großen Welten einige Sekunden dauern.</span>
  </div>
  ${w ? `
  <p>Geprüft: ${w.docs.toLocaleString("de-DE")} Dokumente am ${new Date(w.at).toLocaleString("de-DE")}.</p>
  <div class="apa-grid2">
    <section><h3>Daten pro Modul</h3>
      <div class="apa-table-wrap"><table class="apa-table"><thead><tr><th>Modul</th><th>Status</th><th class="num">Flag-Daten</th><th class="num">Dokumente</th><th class="num">Einstellungen</th></tr></thead>
      <tbody>${w.rows.slice(0, 80).map((x) => `<tr class="${x.status === "deaktiviert" || x.status === "nicht installiert" ? "dimrow" : ""}"><td>${esc(x.label)}</td><td>${esc(x.status)}</td><td class="num">${x.flagBytes ? fmtBytes(x.flagBytes) : "–"}</td><td class="num">${x.flagDocs || "–"}</td><td class="num">${x.settingBytes ? fmtBytes(x.settingBytes) : "–"}</td></tr>`).join("")}</tbody></table></div>
    </section>
    <section><h3>Dokumente in der Welt</h3>
      <table class="apa-mini">${w.counts.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.count.toLocaleString("de-DE")}</td></tr>`).join("")}</table>
    </section>
  </div>` : `<p class="apa-empty">Noch nicht geprüft.</p>`}`;
}

function tabClients(r, ctx) {
  if (!isGM()) return `<p class="apa-empty">Nur für den Spielleiter.</p>`;
  const clients = [...state.clients.entries()];
  const inbox = state.inbox;
  return `
  <section><h3><i class="fa-solid fa-inbox"></i> Eingegangene Berichte von Spielern</h3>
    ${inbox.length ? `<table class="apa-mini"><tr><th>Spieler</th><th>Gesendet</th><th>Notiz</th><th class="num">Ø FPS</th><th class="num">Ruckler</th><th class="num">Probleme</th><th></th></tr>
    ${inbox.map((i) => `<tr class="${i.read ? "" : "apa-unread"}"><td>${i.read ? "" : '<i class="fa-solid fa-circle apa-dot"></i> '}${esc(i.name)}</td><td>${new Date(i.at).toLocaleString("de-DE")}</td><td>${esc(i.note || "–")}</td>
      <td class="num">${i.report?.frames?.avgFps ?? "–"}</td><td class="num">${i.report?.frames?.j100 ?? "–"}</td><td class="num">${i.report?.issues?.length ?? "–"}</td>
      <td class="nowrap"><button type="button" data-action="viewInbox" data-id="${esc(i.id)}">Ansehen</button> <button type="button" data-action="exportInbox" data-id="${esc(i.id)}" title="Als Datei speichern"><i class="fa-solid fa-file-arrow-down"></i></button> <button type="button" data-action="deleteInbox" data-id="${esc(i.id)}" title="Löschen"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("")}</table>
    <p class="apa-muted">Spieler senden Berichte selbst über ihren Analyst (Tab „Berichte“ → „An SL senden“). Beim Ansehen kannst du im Tab „Berichte“ die Zusammenfassung kopieren oder das JSON exportieren.</p>`
    : `<p class="apa-empty">Noch keine Berichte erhalten. Spieler können über ihren Analyst (Tab „Berichte“) einen Bericht an dich senden.</p>`}
  </section>
  <div class="apa-toolbar">
    <button type="button" data-action="collect"><i class="fa-solid fa-satellite-dish"></i> Berichte der Spieler einsammeln</button>
    <span class="apa-muted">Fragt alle verbundenen Spieler nach ihren Messwerten (ihre laufende Aufzeichnung oder „seit Laden“). Die Spieler brauchen das Modul ebenfalls aktiv – das ist automatisch so, wenn es in der Welt aktiviert ist.</span>
  </div>
  ${clients.length ? `<div class="apa-table-wrap"><table class="apa-table"><thead><tr><th>Spieler</th><th>Browser</th><th>Grafik</th><th class="num">Ø FPS</th><th class="num">Ruckler &gt;100 ms</th><th class="num">Probleme</th><th>Größter Verbraucher</th><th></th></tr></thead><tbody>
    ${clients.map(([id, c]) => {
      const rep = c.report;
      if (!rep) return `<tr><td>${esc(c.name)}</td><td colspan="7">${c.pending ? '<i class="fa-solid fa-spinner fa-spin"></i> wartet auf Antwort …' : "keine Antwort (Modul aus oder Spieler hat Berichte deaktiviert)"}</td></tr>`;
      const top = [...rep.modules].filter((x) => x.kind !== "self").sort((a, b) => b.runtime - a.runtime)[0];
      return `<tr><td>${esc(c.name)}${c.pending ? ' <i class="fa-solid fa-spinner fa-spin"></i>' : ""}</td><td>${esc(rep.env.browser)}</td><td>${esc(rep.env.gpu ?? "–")}</td><td class="num">${rep.frames.avgFps ?? "–"}</td><td class="num">${rep.frames.j100}</td><td class="num">${rep.issues.length}</td><td>${top ? `${esc(top.label)} (${fmtMs(top.runtime)})` : "–"}</td>
        <td><button type="button" data-action="viewClient" data-id="${esc(id)}">Ansehen</button></td></tr>`;
    }).join("")}
  </tbody></table></div>` : `<p class="apa-empty">Noch keine Berichte eingesammelt.</p>`}`;
}

function tabLog(r, ctx) {
  const reports = state.reports.map((rep, i) => ({ rep, i })).reverse();
  const v = ctx.view;
  const sendWhat = v.startsWith("saved:") ? "die angezeigte gespeicherte Aufzeichnung" : state.rec ? "die laufende Aufzeichnung (mit Zeitleiste)" : "deine Messwerte seit dem Laden";
  const sendBox = !isGM() ? `
  <section class="apa-send"><h3><i class="fa-solid fa-paper-plane"></i> Problem an den Spielleiter melden</h3>
    <p>Ruckelt es bei dir? Schick dem Spielleiter deinen Bericht. Gesendet wird ${sendWhat}.
    ${state.rec ? "" : " Tipp: Noch besser ist eine Aufzeichnung – unten starten, das Ruckelnde nachstellen, dann senden."}</p>
    <div class="apa-toolbar">
      <input type="text" name="sendNote" placeholder="Was ist passiert? z. B. „ruckelt beim Bewegen im Kampf“" value="${esc(ctx.sendNote ?? "")}">
      <button type="button" data-action="sendToGM" class="primary"><i class="fa-solid fa-paper-plane"></i> An SL senden</button>
    </div>
  </section>` : "";
  return `${sendBox}
  <section><h3><i class="fa-solid fa-circle-dot"></i> Aufzeichnung</h3>
    ${state.rec ? `
      <p>Läuft seit ${fmtDuration(state.rec.elapsed())}${state.recEndAt ? `, endet automatisch in ${fmtDuration(state.recEndAt - now())}` : ""}.</p>
      <div class="apa-toolbar">
        <input type="text" name="markText" placeholder="Was passiert gerade? z. B. „Kampf beginnt“" value="${esc(ctx.markText)}">
        <button type="button" data-action="mark"><i class="fa-solid fa-flag"></i> Markierung setzen</button>
        <button type="button" data-action="recStop" class="danger"><i class="fa-solid fa-stop"></i> Beenden &amp; speichern</button>
      </div>` : `
      <p class="apa-muted">Eine Aufzeichnung misst nur einen bestimmten Zeitraum, z. B. eine Kampfrunde oder einen Szenenwechsel. Sie protokolliert dabei zusätzlich jeden Aufruf über 0,5 ms mit Zeitstempel (Zeitleiste im JSON-Export).</p>
      <div class="apa-toolbar">
        <input type="text" name="recLabel" placeholder="Name, z. B. „Kampf Taverne“">
        <button type="button" data-action="recStart" data-min="5"><i class="fa-solid fa-play"></i> 5 Minuten</button>
        <button type="button" data-action="recStart" data-min="15"><i class="fa-solid fa-play"></i> 15 Minuten</button>
        <button type="button" data-action="recStart" data-min="0"><i class="fa-solid fa-play"></i> Bis ich stoppe</button>
      </div>`}
  </section>
  <section><h3><i class="fa-solid fa-file-arrow-down"></i> Angezeigten Bericht exportieren</h3>
    <div class="apa-toolbar">
      <button type="button" data-action="copySummary"><i class="fa-solid fa-copy"></i> Zusammenfassung kopieren</button>
      <button type="button" data-action="exportJson"><i class="fa-solid fa-file-code"></i> Vollständig (JSON)</button>
      <button type="button" data-action="exportCsv"><i class="fa-solid fa-file-csv"></i> Modultabelle (CSV/Excel)</button>
    </div>
    <p class="apa-muted">Die Zusammenfassung ist kurzer Text, den du z. B. direkt Claude in den Chat einfügen kannst. Das JSON enthält alles inklusive Zeitleiste.</p>
  </section>
  <section><h3><i class="fa-solid fa-box-archive"></i> Gespeicherte Aufzeichnungen</h3>
    ${reports.length ? `<table class="apa-mini">${reports.map(({ rep, i }) => `<tr><td>${esc(rep.meta.label || "Aufzeichnung")}</td><td>${new Date(rep.meta.started).toLocaleString("de-DE")}</td><td>${fmtDuration(rep.meta.durationMs)}</td><td>Ø ${rep.frames.avgFps ?? "–"} FPS</td>
      <td><button type="button" data-action="viewSaved" data-id="${i}">Ansehen</button> <button type="button" data-action="deleteSaved" data-id="${i}" title="Löschen"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("")}</table>
      <p class="apa-muted">Die letzten 5 Aufzeichnungen bleiben in diesem Browser auch nach einem Neuladen erhalten (ohne Zeitleiste).</p>` : `<p class="apa-empty">Noch keine Aufzeichnungen.</p>`}
  </section>`;
}

/* ---------- Anwendung ---------- */

const { ApplicationV2 } = foundry.applications.api;

class AnalystApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "apa-analyst",
    classes: ["apa-app"],
    tag: "div",
    window: { title: "Ascandir - Performance Analyst", icon: "fa-solid fa-gauge-high", resizable: true },
    position: { width: 1040, height: 720 },
    actions: {
      // Hinweis: "tab" ist in ApplicationV2 reserviert (eigene Tab-Gruppen) – daher "apaTab".
      apaTab(event, target) { Analyst.state.tab = target.dataset.tab; this.render(); },
      sort(event, target) {
        const k = target.dataset.key;
        if (Analyst.state.sort === k) Analyst.state.sortDir *= -1;
        else { Analyst.state.sort = k; Analyst.state.sortDir = k === "label" ? 1 : -1; }
        this.render();
      },
      detail(event, target) {
        const id = target.dataset.id;
        Analyst.state.detail = Analyst.state.detail === id ? null : id;
        this.render();
      },
      consoleFilter(event, target) { Analyst.state.consoleFilter = target.dataset.key; this.render(); },
      recStart(event, target) {
        const label = this.element.querySelector("input[name=recLabel]")?.value ?? "";
        startRecording(Number(target.dataset.min) || 0, label);
        Analyst.state.view = "live:rec";
        this.render();
      },
      recStop() { stopRecording(); this.render(); },
      mark() {
        addMarker(Analyst.state.markText);
        Analyst.state.markText = "";
        ui.notifications.info("Markierung gesetzt.");
        this.render();
      },
      textureScan() { scanTextures(); this.render(); },
      async worldScan() {
        Analyst.state.worldBusy = true;
        this.render();
        try {
          await worldScan((n) => { Analyst.state.worldProgress = n; });
        } catch (err) {
          console.error("Performance Analyst | Welt-Scan", err);
        }
        Analyst.state.worldBusy = false;
        this.render();
      },
      collect() { requestClientReports(); },
      sendToGM() {
        const note = this.element.querySelector("input[name=sendNote]")?.value ?? Analyst.state.sendNote ?? "";
        if (sendReportToGM(note)) Analyst.state.sendNote = "";
        this.render();
      },
      goSend() { Analyst.state.tab = "log"; this.render(); },
      viewInbox(event, target) { Analyst.state.view = `inbox:${target.dataset.id}`; Analyst.state.tab = "overview"; this.render(); },
      exportInbox(event, target) {
        const item = state.inbox.find((i) => i.id === target.dataset.id);
        if (item) download(JSON.stringify(item.report, null, 1), `performance-bericht_${item.name}_${fileStamp()}.json`, "application/json");
      },
      deleteInbox(event, target) {
        state.inbox = state.inbox.filter((i) => i.id !== target.dataset.id);
        persistInbox();
        if (Analyst.state.view === `inbox:${target.dataset.id}`) Analyst.state.view = "live:load";
        Health.apply();
        this.render();
      },
      viewClient(event, target) { Analyst.state.view = `client:${target.dataset.id}`; Analyst.state.tab = "overview"; this.render(); },
      viewSaved(event, target) { Analyst.state.view = `saved:${target.dataset.id}`; Analyst.state.tab = "overview"; this.render(); },
      deleteSaved(event, target) {
        state.reports.splice(Number(target.dataset.id), 1);
        persistReports();
        Analyst.state.view = "live:load";
        this.render();
      },
      async copySummary() {
        const { report } = Analyst.currentReport();
        const text = summaryText(report);
        try {
          await navigator.clipboard.writeText(text);
          ui.notifications.info("Zusammenfassung in die Zwischenablage kopiert.");
        } catch {
          download(text, `performance-zusammenfassung_${fileStamp()}.txt`, "text/plain");
        }
      },
      exportJson() {
        const v = Analyst.state.view;
        let report = Analyst.currentReport().report;
        if (v === "live:rec" && state.rec) report = buildReport(state.rec, { timeline: true });
        else if (v === "live:load") report = buildReport(state.load, { timeline: false });
        download(JSON.stringify(report, null, 1), `performance-bericht_${fileStamp()}.json`, "application/json");
      },
      exportCsv() {
        const { report } = Analyst.currentReport();
        download(`﻿${toCsv(report)}`, `performance-module_${fileStamp()}.csv`, "text/csv");
      }
    }
  };

  async _renderHTML() {
    const { report, live, client, inbox } = Analyst.currentReport();
    Analyst.live = live;
    const ctx = Analyst.state;
    const tabs = TABS.filter(([, , , gmOnly]) => !gmOnly || isGM());
    if (!tabs.some(([id]) => id === ctx.tab)) ctx.tab = "overview";
    const views = [`<option value="live:load" ${ctx.view === "live:load" ? "selected" : ""}>Live – seit dem Laden</option>`];
    if (state.rec) views.push(`<option value="live:rec" ${ctx.view === "live:rec" ? "selected" : ""}>Live – laufende Aufzeichnung</option>`);
    state.reports.forEach((rep, i) => views.push(`<option value="saved:${i}" ${ctx.view === `saved:${i}` ? "selected" : ""}>Gespeichert – ${esc(rep.meta.label || "Aufzeichnung")}</option>`));
    for (const [id, c] of state.clients) if (c.report) views.push(`<option value="client:${esc(id)}" ${ctx.view === `client:${id}` ? "selected" : ""}>Spieler – ${esc(c.name)}</option>`);
    if (isGM()) for (const i of state.inbox) views.push(`<option value="inbox:${esc(i.id)}" ${ctx.view === `inbox:${i.id}` ? "selected" : ""}>Gesendet von ${esc(i.name)} – ${new Date(i.at).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</option>`);

    const recCtl = state.rec
      ? `<span class="apa-rec"><i class="fa-solid fa-circle"></i> ${fmtDuration(state.rec.elapsed())}</span><button type="button" data-action="recStop"><i class="fa-solid fa-stop"></i> Stopp</button>`
      : `<button type="button" data-action="recStart" data-min="5" title="5 Minuten aufzeichnen"><i class="fa-solid fa-circle-dot"></i> Aufzeichnen</button>`;

    const body = {
      overview: tabOverview, modules: tabModules, frames: tabFrames, assets: tabAssets,
      console: tabConsole, network: tabNetwork, world: tabWorld, clients: tabClients, log: tabLog
    }[ctx.tab](report, ctx);

    const banner = !live
      ? `<div class="apa-banner"><i class="fa-solid fa-clock-rotate-left"></i> Du siehst ${inbox ? `den gesendeten Bericht von <strong>${esc(inbox.name)}</strong>${inbox.note ? ` – Notiz: „${esc(inbox.note)}“` : ""}` : client ? `den Bericht von <strong>${esc(client.name)}</strong>` : `die gespeicherte Aufzeichnung <strong>${esc(report.meta.label)}</strong>`} (${fmtDuration(report.meta.durationMs)}, ${new Date(report.meta.created).toLocaleString("de-DE")}). Export und Zusammenfassung im Tab „Berichte“.</div>`
      : (!WATCH_ENABLED ? `<div class="apa-banner bad"><i class="fa-solid fa-power-off"></i> Die Hintergrund-Überwachung ist in den Einstellungen ausgeschaltet. Es werden kaum Daten gesammelt.</div>` : "");

    return `
      <div class="apa-head">
        <nav class="apa-tabs">${tabs.map(([id, label, icon]) => `<a class="${ctx.tab === id ? "active" : ""}" data-action="apaTab" data-tab="${id}"><i class="${icon}"></i> ${label}</a>`).join("")}</nav>
        <div class="apa-head-right">
          ${!isGM() ? `<button type="button" data-action="goSend" title="Bericht an den Spielleiter senden"><i class="fa-solid fa-paper-plane"></i> An SL senden</button>` : ""}
          <select name="view">${views.join("")}</select>
          ${recCtl}
        </div>
      </div>
      ${banner}
      <div class="apa-scroll">${body}</div>`;
  }

  _replaceHTML(result, content) {
    const old = content.querySelector(".apa-scroll");
    const top = old?.scrollTop ?? 0;
    const wraps = [...content.querySelectorAll(".apa-table-wrap")].map((w) => w.scrollTop);
    content.innerHTML = result;
    const nu = content.querySelector(".apa-scroll");
    if (nu) nu.scrollTop = top;
    content.querySelectorAll(".apa-table-wrap").forEach((w, i) => { if (wraps[i]) w.scrollTop = wraps[i]; });
  }

  _onRender(context, options) {
    const el = this.element;
    el.querySelector("select[name=view]")?.addEventListener("change", (ev) => {
      Analyst.state.view = ev.target.value;
      this.render();
    });
    const filter = el.querySelector("input[name=filter]");
    filter?.addEventListener("input", (ev) => {
      Analyst.state.filter = ev.target.value;
      clearTimeout(this._filterTimer);
      this._filterTimer = setTimeout(() => {
        this.render().then(() => {
          const f = this.element.querySelector("input[name=filter]");
          if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
        });
      }, 250);
    });
    el.querySelector("input[name=showSelf]")?.addEventListener("change", (ev) => {
      Analyst.state.showSelf = ev.target.checked;
      this.render();
    });
    el.querySelector("input[name=markText]")?.addEventListener("input", (ev) => { Analyst.state.markText = ev.target.value; });
    el.querySelector("input[name=sendNote]")?.addEventListener("input", (ev) => { Analyst.state.sendNote = ev.target.value; });
    el.querySelector("input[name=markText]")?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); addMarker(Analyst.state.markText); Analyst.state.markText = ""; this.render(); }
    });

    if (!this._interval) {
      this._interval = setInterval(() => {
        if (!this.rendered) return;
        let auto = true;
        try { auto = game.settings.get(MODULE_ID, "autoRefresh"); } catch { /* Standard */ }
        if (!auto || !Analyst.live || this.minimized || document.hidden) return;
        const active = document.activeElement;
        if (active && this.element?.contains(active) && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
        this.render();
      }, 4000);
    }
  }

  _onClose(options) {
    clearInterval(this._interval);
    this._interval = null;
    super._onClose?.(options);
  }
}

class AnalystMenu extends ApplicationV2 {
  render() {
    Analyst.open();
    return this;
  }
}

/* ================================================================ */
/*  Einstellungen, Tastenkürzel, Einstiegspunkte                      */
/* ================================================================ */

function registerSettings() {
  const t = (k) => game.i18n.localize(`APA.Settings.${k}`);
  game.settings.registerMenu(MODULE_ID, "open", {
    name: t("OpenName"),
    label: t("OpenLabel"),
    hint: t("OpenHint"),
    icon: "fa-solid fa-gauge-high",
    type: AnalystMenu,
    restricted: false
  });
  game.settings.register(MODULE_ID, "watchEnabled", {
    name: t("WatchName"), hint: t("WatchHint"),
    scope: "client", config: true, type: Boolean, default: true, requiresReload: true
  });
  game.settings.register(MODULE_ID, "consoleCapture", {
    name: t("ConsoleName"), hint: t("ConsoleHint"),
    scope: "client", config: true, type: Boolean, default: true, requiresReload: true
  });
  game.settings.register(MODULE_ID, "notifyLevel", {
    name: t("NotifyName"), hint: t("NotifyHint"),
    scope: "client", config: true, type: String, default: "critical",
    choices: { off: t("NotifyOff"), critical: t("NotifyCritical"), all: t("NotifyAll") }
  });
  game.settings.register(MODULE_ID, "sceneButton", {
    name: t("ButtonName"), hint: t("ButtonHint"),
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => Health.apply()
  });
  game.settings.register(MODULE_ID, "playerAccess", {
    name: t("AccessName"), hint: t("AccessHint"),
    scope: "world", config: true, type: Boolean, default: true, restricted: true,
    onChange: () => Health.apply()
  });
  game.settings.register(MODULE_ID, "autoRefresh", {
    name: t("RefreshName"), hint: t("RefreshHint"),
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "allowRemote", {
    name: t("RemoteName"), hint: t("RemoteHint"),
    scope: "world", config: true, type: Boolean, default: true, restricted: true
  });
  const num = (key, def, max) => game.settings.register(MODULE_ID, key, {
    name: t(`${key}Name`), hint: t(`${key}Hint`),
    scope: "world", config: true, type: Number, default: def, restricted: true,
    range: { min: 1, max, step: 1 }
  });
  num("limitImageMB", 3, 50);
  num("limitAudioMB", 10, 200);
  num("limitVideoMB", 30, 500);
}

function registerKeybinding() {
  game.keybindings.register(MODULE_ID, "open", {
    name: "APA.Keybinding.Open",
    editable: [{ key: "KeyP", modifiers: ["Alt", "Shift"] }],
    onDown: () => { Analyst.open(); return true; },
    restricted: false
  });
}

function addSidebarButton(app, html) {
  try {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector(".apa-open-btn") || !canAccess()) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "apa-open-btn";
    btn.innerHTML = `<i class="fa-solid fa-gauge-high"></i> Performance Analyst`;
    btn.addEventListener("click", () => Analyst.open());
    const anchor = root.querySelector("section.settings, section.documentation, #settings-game, section") ?? root;
    anchor.append(btn);
  } catch { /* Button ist nur Komfort */ }
}

/* ================================================================ */
/*  Start                                                            */
/* ================================================================ */

if (WATCH_ENABLED) {
  try { patchHooks(); } catch (err) { state.hookMode = "Fehler beim Einrichten"; console.debug("Performance Analyst |", err); }
  try { patchLibWrapper(); } catch { /* egal */ }
  try { patchDocuments(); } catch { /* egal */ }
  if (CONSOLE_ENABLED) {
    try { patchConsole(); } catch { /* egal */ }
  }
  try { listenWindowErrors(); } catch { /* egal */ }
  startResourceObserver();
  startLoafObserver();
  requestAnimationFrame(__apaFrame);
}

Hooks.once("init", () => {
  state.phases.init = now();
  registerSettings();
  registerKeybinding();
  if (WATCH_ENABLED) patchLibWrapper();
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open: () => Analyst.open(),
      startRecording: (minutes = 0, label = "") => startRecording(minutes, label),
      stopRecording: () => stopRecording(),
      report: () => buildReport(state.rec ?? state.load),
      summary: () => summaryText(buildReport(state.rec ?? state.load, { timeline: false })),
      scanWorld: () => worldScan(),
      scanTextures: () => scanTextures()
    };
  }
  loadSavedReports();
});

Hooks.once("libWrapper.Ready", () => { if (WATCH_ENABLED) patchLibWrapper(); });

Hooks.once("setup", () => { state.phases.setup = now(); });

Hooks.once("ready", () => {
  // Erst nach allen anderen "ready"-Hooks umschalten, damit deren Zeit noch als Startzeit zählt.
  setTimeout(onAllReady, 0);
});

function onAllReady() {
  state.phases.ready = now();
  state.ready = true;
  if (WATCH_ENABLED) {
    try { patchSocket(); } catch { /* egal */ }
    try { checkEnvironment(); } catch (err) { console.debug("Performance Analyst | Umgebung", err); }
    for (const a of state.assets.values()) checkAsset(a);
    setInterval(takeSample, 15000);
    takeSample();
    setTimeout(() => { resolvePendingOwners().catch(() => { state.pendingSourceSearch = false; }); }, 4000);
  }
  try { setupSocket(); } catch { /* egal */ }
  if (isGM()) loadInbox();
  try { Health.start(); } catch (err) { console.debug("Performance Analyst | Button", err); }
  const queued = state.pendingNotes.splice(0);
  for (const issue of queued) notifyIssue(issue);
}

Hooks.on("canvasInit", () => {
  state.canvasInitAt = now();
  state.sceneLoading = true;
});

Hooks.on("renderSceneControls", () => {
  try { Health.apply(); } catch { /* egal */ }
});

Hooks.on("canvasReady", (cv) => {
  if (!state.phases.firstCanvas) state.phases.firstCanvas = now();
  // Kurz nachladen lassen (Texturen, Licht), erst dann zählen Ruckler wieder normal.
  setTimeout(() => { state.sceneLoading = false; }, 4000);
  const scene = cv?.scene ?? globalThis.canvas?.scene;
  const ms = state.canvasInitAt ? now() - state.canvasInitAt : null;
  let counts = {};
  try { counts = checkScene(scene); } catch { /* egal */ }
  if (ms !== null && scene) {
    state.scenes.push({ name: scene.name, ms: round(ms, 0), at: Date.now(), counts });
    if (state.scenes.length > 50) state.scenes.shift();
    timelinePush({ type: "szene", label: scene.name, ms: round(ms, 0) });
    if (ms > 15000) addIssue(`scene-slow:${scene.id}`, "warn", "Szene lädt sehr langsam", `„${scene.name}“ brauchte ${round(ms / 1000, 1)} s zum Laden. Häufige Ursachen: riesige Hintergrundbilder, viele Videos, viele Lichter/Wände oder Module, die beim Szenenaufbau viel rechnen.`);
  }
  if (WATCH_ENABLED) {
    // Texturen erst prüfen, wenn alles fertig gezeichnet ist.
    setTimeout(() => {
      try { checkEnvironment(); scanTextures(); } catch (err) { console.debug("Performance Analyst | Texturen", err); }
      Analyst.refreshSoon();
    }, 2500);
  }
});

Hooks.on("renderSettings", addSidebarButton);

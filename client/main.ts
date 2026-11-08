import "./style.css";
import { cardFields, esc, senseKey, type Hit } from "./card";
import { DICT, Dict, download, loadStored } from "./dict";

// ---------- persisted state ----------
interface Named { id: string; name: string }
interface Settings {
  session?: string;
  user?: string;
  deck?: string;
  notetype?: string;
  nFields?: number;
  decks?: Named[];
  notetypes?: Named[];
}
interface Queued { fields: string[]; key: string; word: string; t: string }

const load = <T,>(k: string, d: T): T => {
  try { return JSON.parse(localStorage.getItem(k) ?? "") ?? d; } catch { return d; }
};
const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

let cfg: Settings = load("ptw.s", {});
let queue: Queued[] = load("ptw.q", []);
const added = new Set<string>(load<string[]>("ptw.a", []));
const saveCfg = () => save("ptw.s", cfg);
const saveQueue = () => { save("ptw.q", queue); badge(); };
const markAdded = (k: string) => {
  added.add(k);
  save("ptw.a", [...added].slice(-3000));
};

// ---------- dom ----------
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const input = $<HTMLInputElement>("#q");
const list = $("#r");
const toastEl = $("#toast");
const qBadge = $("#qn");
const dlg = $<HTMLDialogElement>("#cfg");

let toastT = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (toastEl.hidden = true), 2600);
}

function badge() {
  qBadge.textContent = queue.length ? String(queue.length) : "";
  qBadge.hidden = !queue.length;
}

// ---------- dictionary ----------
const status = $("#st");
let dict: Dict | undefined;
let hits: Hit[] = [];
let open = 0; // index of expanded entry

function showStatus(html: string, pct?: number) {
  status.hidden = !html;
  status.innerHTML = html + (pct === undefined ? "" : `<div class="bar"><i style="width:${pct}%"></i></div>`);
}

async function initDict() {
  const stored = await loadStored();
  if (stored) {
    dict = stored.dict;
    search();
    // a newer dictionary shipped with an app update: fetch it quietly, keep using the old one meanwhile
    if (stored.version !== DICT.version) download(() => {}).then((d) => { dict = d; search(); }, () => {});
    return;
  }
  const mb = (n: number) => (n / 1e6).toFixed(1);
  showStatus("Downloading dictionary…", 0);
  try {
    dict = await download((got, total) =>
      showStatus(`Downloading dictionary… ${mb(got)} / ${mb(total)} MB`, Math.min(100, (got / total) * 100)));
    showStatus("");
    search();
  } catch {
    showStatus("The dictionary is downloaded once on first use. Connect to the internet to continue.");
    addEventListener("online", initDict, { once: true });
  }
}

// ---------- search ----------
function render() {
  const q = input.value.trim();
  if (!hits.length) {
    list.innerHTML = q && dict ? `<p class="empty">No matches for “${esc(q)}”</p>` : "";
    return;
  }
  list.innerHTML = hits
    .map((h, i) => {
      const e = h.e;
      const via = h.f !== e.w ? `<span class="via">← ${esc(h.f)}${h.n ? ` · ${esc(h.n)}` : ""}</span>` : "";
      const head = `<button class="hd" data-i="${i}"><b>${esc(e.w)}</b> <span class="pos">${esc(e.p)}</span>${via}${
        i === open ? "" : `<span class="gl">${esc(e.s[0]?.t ?? "")}</span>`
      }</button>`;
      if (i !== open) return `<li>${head}</li>`;
      const senses = e.s
        .map((s, j) => {
          const done = added.has(senseKey(e, s));
          return `<li class="s${done ? " done" : ""}" data-i="${i}" data-j="${j}"><div class="t">${esc(s.t)}${
            s.l ? ` <span class="lb">${esc(s.l.join(", "))}</span>` : ""
          }</div>${s.d ? `<div class="d">${esc(s.d)}</div>` : ""}${
            s.x ? `<div class="x"><i>${esc(s.x[0])}</i>${s.x[1] ? ` — ${esc(s.x[1])}` : ""}</div>` : ""
          }<span class="add">${done ? "✓" : "+"}</span></li>`;
        })
        .join("");
      const sub = [e.h, e.i].filter(Boolean).map((x) => esc(x!)).join(" · ");
      return `<li class="open">${head}${sub ? `<div class="sub">${sub}</div>` : ""}<ol>${senses}</ol></li>`;
    })
    .join("");
}

function search() {
  if (!dict) return;
  hits = dict.search(input.value);
  open = 0;
  render();
  scrollTo(0, 0);
}

input.addEventListener("input", search);

list.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const hd = t.closest<HTMLElement>(".hd");
  if (hd) {
    const i = +hd.dataset.i!;
    open = open === i ? -1 : i;
    render();
    list.children[i]?.scrollIntoView({ block: "nearest" });
    return;
  }
  const s = t.closest<HTMLElement>(".s");
  if (s) addSense(+s.dataset.i!, +s.dataset.j!);
});

// ---------- anki ----------
function addSense(i: number, j: number) {
  const e = hits[i]?.e, s = e?.s[j];
  if (!e || !s) return;
  const key = senseKey(e, s);
  if (added.has(key) && !confirm(`“${e.w}: ${s.t}” was already added. Add again?`)) return;
  queue.push({ fields: cardFields(e, s), key, word: e.w, t: s.t });
  saveQueue();
  markAdded(key);
  render();
  if (!cfg.session || !cfg.deck) toast("Saved. Log in to AnkiWeb (⚙) to sync it.");
  else if (!navigator.onLine) toast("Offline — saved, will sync later");
  else toast(`Adding “${e.w}”…`);
  flush();
}

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cfg.session ? { "X-Anki-Session": cfg.session } : {}) },
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (res.status === 401) {
    cfg.session = undefined;
    saveCfg();
  }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
};

let flushing = false;
async function flush() {
  if (flushing || !queue.length || !cfg.session || !cfg.deck || !cfg.notetype || !navigator.onLine) return;
  flushing = true;
  let sent = 0;
  try {
    while (queue.length) {
      const n = queue[0]!;
      const fields = [...n.fields];
      while (fields.length < (cfg.nFields ?? 2)) fields.push("");
      await api("/api/anki/add", {
        method: "POST",
        body: JSON.stringify({ fields, tags: "ptwords", deck: cfg.deck, notetype: cfg.notetype }),
      });
      queue.shift();
      saveQueue();
      sent++;
    }
    toast(sent === 1 ? "Added to Anki ✓" : `Synced ${sent} cards to Anki ✓`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status) toast(e.status === 401 ? "AnkiWeb login expired — log in again (⚙)" : `Anki: ${e.message}`);
    // network errors: stay queued silently, retried on next open / reconnect
  } finally {
    flushing = false;
  }
}

addEventListener("online", flush);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && flush());

// ---------- settings dialog ----------
const opts = (xs: Named[] = [], sel?: string) =>
  xs.map((x) => `<option value="${x.id}"${x.id === sel ? " selected" : ""}>${esc(x.name)}</option>`).join("");

function renderCfg() {
  const body = $("#cfgb");
  const pending = queue.length
    ? `<h3>Waiting to sync (${queue.length})</h3><ul class="pend">${queue
        .map((n, i) => `<li><span>${esc(n.word)} — ${esc(n.t)}</span><button data-del="${i}" aria-label="Remove">×</button></li>`)
        .join("")}</ul><button id="sync">Sync now</button>`
    : "";
  if (!cfg.session) {
    body.innerHTML = `<form id="login"><p>Log in to AnkiWeb. Your password is sent to AnkiWeb via this app's server and is not stored.</p>
<input name="u" type="email" placeholder="AnkiWeb email" autocomplete="username" required value="${esc(cfg.user ?? "")}">
<input name="p" type="password" placeholder="Password" autocomplete="current-password" required>
<button>Log in</button></form>${pending}`;
  } else {
    body.innerHTML = `<p>Logged in as <b>${esc(cfg.user ?? "")}</b></p>
<label>Deck<select id="deck">${opts(cfg.decks, cfg.deck)}</select></label>
<label>Note type<select id="nt">${opts(cfg.notetypes, cfg.notetype)}</select></label>
<p class="hint">Word goes in the 1st field, meaning in the 2nd.</p>
<button id="out" class="sec">Log out</button>${pending}`;
  }
}

dlg.addEventListener("submit", async (ev) => {
  const f = ev.target as HTMLFormElement;
  if (f.id !== "login") return;
  ev.preventDefault();
  const fd = new FormData(f);
  const btn = f.querySelector("button")!;
  btn.disabled = true;
  btn.textContent = "Logging in…";
  try {
    cfg.user = String(fd.get("u")).trim();
    const r = await api("/api/anki/login", {
      method: "POST",
      body: JSON.stringify({ username: cfg.user, password: fd.get("p") }),
    });
    const basic = (r.notetypes as Named[]).find((n) => n.name === "Basic");
    Object.assign(cfg, {
      session: r.session,
      decks: r.decks,
      notetypes: r.notetypes,
      deck: cfg.deck && r.decks.some((d: Named) => d.id === cfg.deck) ? cfg.deck : r.deck,
      notetype: basic?.id ?? r.notetype,
    });
    cfg.nFields = basic ? (await api(`/api/anki/fields?nt=${basic.id}`)).fields.length : r.fields.length;
    saveCfg();
    renderCfg();
    flush();
  } catch (err) {
    toast((err as Error).message);
    btn.disabled = false;
    btn.textContent = "Log in";
  }
});

dlg.addEventListener("change", async (ev) => {
  const t = ev.target as HTMLSelectElement;
  if (t.id === "deck") cfg.deck = t.value;
  if (t.id === "nt") {
    cfg.notetype = t.value;
    try { cfg.nFields = (await api(`/api/anki/fields?nt=${t.value}`)).fields.length; } catch (e) { toast((e as Error).message); }
  }
  saveCfg();
});

dlg.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t === dlg || t.id === "x") dlg.close();
  else if (t.id === "out") { cfg = { user: cfg.user }; saveCfg(); renderCfg(); }
  else if (t.id === "sync") flush().then(renderCfg);
  else if (t.dataset.del) { queue.splice(+t.dataset.del, 1); saveQueue(); renderCfg(); }
});

$("#gear").addEventListener("click", () => {
  renderCfg();
  dlg.showModal();
  // refresh deck list in the background
  if (cfg.session && navigator.onLine) {
    api("/api/anki/info").then((r) => { cfg.decks = r.decks; cfg.notetypes = r.notetypes; saveCfg(); if (dlg.open) renderCfg(); },
      () => dlg.open && renderCfg());
  }
});

// ---------- boot ----------
badge();
initDict();
flush();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");

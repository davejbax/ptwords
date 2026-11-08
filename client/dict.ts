// On-device dictionary: downloaded once, kept in IndexedDB, searched in memory.
// Binary layout is documented in scripts/build_dict.py.
import { norm } from "../src/shared/norm";
import type { Entry, Hit } from "./card";

declare const __DICT__: { file: string; version: string; size: number };
export const DICT = __DICT__;

const MAX = 10;

const te = new TextEncoder();
const td = new TextDecoder();

/** Start offset of each "\n"-separated line, plus a sentinel (length + 1). */
function lineStarts(b: Uint8Array, n?: number): Uint32Array {
  if (n === undefined) {
    n = b.length ? 1 : 0;
    for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) n++;
  }
  const o = new Uint32Array(n + 1);
  for (let i = 0, p = 0; i < n; i++) {
    o[i] = p;
    const nl = b.indexOf(10, p);
    p = nl === -1 ? b.length + 1 : nl + 1;
  }
  o[n] = b.length + 1;
  return o;
}

/**
 * The index stays as raw UTF-8 bytes: no per-word strings are created at load,
 * which keeps opening the app fast. UTF-8 byte order equals the code-point
 * order the build script sorted by, so binary search works on bytes directly.
 */
export class Dict {
  private keys: Uint8Array;
  private keyAt: Uint32Array;
  private surf: Uint8Array;
  private surfAt: Uint32Array;
  private lem: Uint8Array;
  private lemAt: Uint32Array;
  private lemmas = new Map<number, Entry>();
  private lid: Uint32Array;
  private note: Uint16Array;
  private rank: Uint32Array;
  private notes: string[];

  constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x31575450) throw new Error("bad dictionary file"); // "PTW1"
    const secs: [number, number][] = [];
    for (let i = 0, n = dv.getUint32(4, true), o = 8; i < n; i++) {
      const len = dv.getUint32(o, true);
      secs.push([o + 4, len]);
      o += 4 + len + ((4 - (len % 4)) % 4);
    }
    const bytes = (i: number) => new Uint8Array(buf, ...secs[i]!);
    const words = <T,>(C: new (b: ArrayBuffer, o: number, n: number) => T, i: number, size: number) =>
      new C(buf, secs[i]![0], secs[i]![1] / size);
    this.notes = JSON.parse(td.decode(bytes(0))).notes;
    this.lid = words(Uint32Array, 4, 4);
    this.note = words(Uint16Array, 5, 2);
    this.rank = words(Uint32Array, 6, 4);
    const n = this.lid.length;
    const pre = secs.length >= 10; // prepared on-device copy carries the line offsets
    this.keys = bytes(1);
    this.keyAt = pre ? words(Uint32Array, 7, 4) : lineStarts(this.keys, n);
    this.surf = bytes(2);
    this.surfAt = pre ? words(Uint32Array, 8, 4) : lineStarts(this.surf, n);
    this.lem = bytes(3);
    this.lemAt = pre ? words(Uint32Array, 9, 4) : lineStarts(this.lem);
    this.buf = buf;
    this.nsec = secs.length;
  }

  private buf: ArrayBuffer;
  private nsec: number;

  /** The file plus its line offsets, so later opens skip all parsing. */
  prepared(): Blob {
    if (this.nsec >= 10) return new Blob([this.buf]);
    const head = new Uint8Array(this.buf.slice(0, 8));
    new DataView(head.buffer).setUint32(4, this.nsec + 3, true);
    const parts: BlobPart[] = [head, new Uint8Array(this.buf, 8)];
    for (const a of [this.keyAt, this.surfAt, this.lemAt]) {
      parts.push(new Uint32Array([a.byteLength]), a as Uint32Array<ArrayBuffer>);
    }
    return new Blob(parts);
  }

  private line(b: Uint8Array, at: Uint32Array, i: number) {
    return b.subarray(at[i]!, at[i + 1]! - 1);
  }

  private entry(id: number): Entry {
    let e = this.lemmas.get(id);
    if (!e) this.lemmas.set(id, (e = JSON.parse(td.decode(this.line(this.lem, this.lemAt, id - 1)))));
    return e!;
  }

  /** Compare key i against q: <0, 0, >0. */
  private cmp(i: number, q: Uint8Array) {
    const s = this.keyAt[i]!, len = this.keyAt[i + 1]! - 1 - s, k = this.keys;
    for (let j = 0, m = Math.min(len, q.length); j < m; j++) {
      const d = k[s + j]! - q[j]!;
      if (d) return d;
    }
    return len - q.length;
  }

  private startsWith(i: number, q: Uint8Array) {
    const s = this.keyAt[i]!;
    if (this.keyAt[i + 1]! - 1 - s < q.length) return false;
    for (let j = 0; j < q.length; j++) if (this.keys[s + j] !== q[j]) return false;
    return true;
  }

  /**
   * Prefix search over all forms. Each lemma is represented by its best-matching
   * form; ranking: exact spelling > exact (accent-insensitive) > frequency.
   */
  search(q: string): Hit[] {
    const k = norm(q);
    if (!k) return [];
    const kb = te.encode(k);
    const qb = te.encode(q.toLowerCase().trim());
    const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, j) => x === b[j]);

    let lo = 0, hi = this.lid.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cmp(mid, kb) < 0) lo = mid + 1;
      else hi = mid;
    }
    const best = new Map<number, [score: number, form: number]>(); // by lemma id
    for (let i = lo; i < this.lid.length && this.startsWith(i, kb); i++) {
      const exactKey = this.keyAt[i + 1]! - 1 - this.keyAt[i]! === kb.length;
      let sc = this.rank[i]!;
      if (exactKey) {
        // weights keep exact matches above any frequency
        sc += 2 ** 33;
        const sf = this.line(this.surf, this.surfAt, i);
        if (eq(sf.length ? sf : this.line(this.keys, this.keyAt, i), qb)) sc += 2 ** 34;
      }
      const id = this.lid[i]!;
      const prev = best.get(id);
      if (!prev || sc > prev[0]) best.set(id, [sc, i]);
    }
    return [...best]
      .sort((a, b) => b[1][0] - a[1][0] || a[0] - b[0])
      .slice(0, MAX)
      .map(([id, [, i]]) => {
        const sf = this.line(this.surf, this.surfAt, i);
        return {
          f: td.decode(sf.length ? sf : this.line(this.keys, this.keyAt, i)),
          n: this.notes[this.note[i]!] ?? "",
          e: this.entry(id),
        };
      });
  }
}

// ---------- persistence (IndexedDB) ----------
const idb = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    const open = indexedDB.open("ptwords", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => rej(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const r = fn(db.transaction("kv", mode).objectStore("kv"));
      r.onsuccess = () => { res(r.result); db.close(); };
      r.onerror = () => { rej(r.error); db.close(); };
    };
  });

interface Stored { version: string; blob: Blob }

/** Loads the stored dictionary, if any. */
export async function loadStored(): Promise<{ version: string; dict: Dict } | undefined> {
  try {
    const s = await idb<Stored | undefined>("readonly", (st) => st.get("dict"));
    if (!s?.blob) return undefined;
    return { version: s.version, dict: new Dict(await s.blob.arrayBuffer()) };
  } catch {
    return undefined;
  }
}

/** Downloads + decompresses the dictionary, reporting compressed bytes received. */
export async function download(onProgress: (got: number, total: number) => void): Promise<Dict> {
  const res = await fetch(`/dict/${DICT.file}`);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = +(res.headers.get("Content-Length") ?? 0) || DICT.size;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const stream = new Blob(chunks as BlobPart[]).stream().pipeThrough(new DecompressionStream("gzip"));
  const dict = new Dict(await new Response(stream).arrayBuffer()); // validates before persisting
  await idb("readwrite", (s) => s.put({ version: DICT.version, blob: dict.prepared() } satisfies Stored, "dict"));
  navigator.storage?.persist?.(); // ask the browser not to evict it
  return dict;
}

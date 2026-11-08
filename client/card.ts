export interface Sense { t: string; d: string; l?: string[]; x?: [string, string] }
export interface Entry { w: string; p: string; h?: string; i?: string; s: Sense[] }
export interface Hit { f: string; n: string; e: Entry }

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const small = (s: string) => `<div style="font-size:.6em;opacity:.65">${s}</div>`;

/** Anki fields [Front, Back] for one sense of an entry. */
export function cardFields(e: Entry, s: Sense): [string, string] {
  const front = esc(e.w) + small(esc(e.h ?? e.p) + (e.i ? ` &middot; ${esc(e.i)}` : ""));
  let back = `<div><b>${esc(s.t)}</b></div>`;
  if (s.d) back += `<div>${esc(s.d)}</div>`;
  if (s.l?.length) back += small(`(${esc(s.l.join(", "))})`);
  if (s.x) back += `<div style="margin-top:.7em"><i>${esc(s.x[0])}</i>${s.x[1] ? `<br>${esc(s.x[1])}` : ""}</div>`;
  return [front, back];
}

export const senseKey = (e: Entry, s: Sense) => `${e.w}|${e.p}|${s.t}|${s.d}`;

// Thin client for AnkiWeb's (undocumented) web API — the same protobuf
// endpoints AnkiWeb's own "Add" page uses. Schemas were taken from AnkiWeb's
// frontend bundle; if AnkiWeb changes them this is the file to update.
import { encode, PbMsg, type PbField } from "./proto";

const WEB = "https://ankiweb.net";
const USER = "https://ankiuser.net";
const UA = "ptwords/1.0 (+personal Anki helper)";

export class AnkiError extends Error {
  constructor(readonly status: number, msg: string) {
    super(msg);
  }
}

async function call(url: string, body: PbField[], cookie?: string): Promise<PbMsg> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "User-Agent": UA,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: encode(body),
    redirect: "manual",
  });
  if (res.status === 403 || res.status === 401 || (res.status >= 300 && res.status < 400)) {
    throw new AnkiError(401, "AnkiWeb session expired — log in again");
  }
  if (!res.ok) throw new AnkiError(502, `AnkiWeb ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return PbMsg.parse(new Uint8Array(await res.arrayBuffer()));
}

/** Logs in and returns a Cookie header value for ankiuser.net. */
export async function login(username: string, password: string): Promise<string> {
  const r = await call(`${WEB}/svc/account/login`, [
    [1, "string", username],
    [2, "string", password],
  ]);
  const status = Number(r.int(1));
  if (status === 2) throw new AnkiError(401, "No AnkiWeb account with that email");
  if (status === 3) throw new AnkiError(401, "Wrong password");
  const token = r.str(2);
  if (status !== 1 || !token) throw new AnkiError(502, `Unexpected AnkiWeb login status ${status}`);

  const res = await fetch(`${USER}/account/ankiuser-login?t=${encodeURIComponent(token)}`, {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";", 1)[0] ?? "").filter((c) => c.includes("="));
  if (!cookies.length) throw new AnkiError(502, `AnkiWeb didn't return a session (HTTP ${res.status})`);
  return cookies.join("; ");
}

export interface Named { id: string; name: string }

export async function infoForAdding(cookie: string) {
  const r = await call(`${USER}/svc/editor/get-info-for-adding`, [], cookie);
  const named = (m: PbMsg): Named => ({ id: m.int(1).toString(), name: m.str(2) });
  return {
    notetypes: r.msgs(1).map(named),
    decks: r.msgs(2).map(named),
    deck: r.int(3).toString(),
    notetype: r.int(4).toString(),
    fields: r.msgs(5).map((f) => f.str(2)),
  };
}

export async function notetypeFields(cookie: string, notetypeId: string): Promise<string[]> {
  const r = await call(`${USER}/svc/editor/get-notetype-fields`, [[1, "varint", BigInt(notetypeId)]], cookie);
  return r.msgs(1).map((f) => f.str(2));
}

export async function addNote(cookie: string, n: { fields: string[]; tags: string; notetype: string; deck: string }) {
  await call(
    `${USER}/svc/editor/add-or-update`,
    [
      ...n.fields.map((f): PbField => [1, "string", f]),
      [2, "string", n.tags],
      [3, "message", [
        [1, "varint", BigInt(n.notetype)],
        [2, "varint", BigInt(n.deck)],
      ]],
    ],
    cookie,
  );
}

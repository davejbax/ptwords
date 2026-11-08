import { Hono } from "hono";
import { AnkiError, addNote, infoForAdding, login, notetypeFields } from "./anki";

type Env = {
  /** Optional comma-separated list of AnkiWeb emails allowed to log in through this deployment. */
  ALLOWED_USERS?: string;
};

const app = new Hono<{ Bindings: Env }>();

// ---- AnkiWeb proxy. The browser can't talk to AnkiWeb directly (CORS), so
// the worker relays requests. It stores nothing: the client keeps the AnkiWeb
// session cookie and sends it back in X-Anki-Session.

const session = (c: { req: { header(n: string): string | undefined } }) => {
  const s = c.req.header("X-Anki-Session");
  if (!s) throw new AnkiError(401, "Not logged in to AnkiWeb");
  return s;
};

app.post("/api/anki/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  const user = (username ?? "").trim();
  const allowed = c.env.ALLOWED_USERS?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed?.length && !allowed.includes(user.toLowerCase())) throw new AnkiError(403, "This account isn't allowed here");
  const cookie = await login(user, password ?? "");
  return c.json({ session: cookie, ...(await infoForAdding(cookie)) });
});

app.get("/api/anki/info", async (c) => c.json(await infoForAdding(session(c))));

app.get("/api/anki/fields", async (c) => c.json({ fields: await notetypeFields(session(c), c.req.query("nt") ?? "0") }));

app.post("/api/anki/add", async (c) => {
  const n = await c.req.json<{ fields: string[]; tags?: string; notetype: string; deck: string }>();
  if (!Array.isArray(n.fields) || !/^\d+$/.test(n.notetype) || !/^\d+$/.test(n.deck)) {
    return c.json({ error: "bad note" }, 400);
  }
  await addNote(session(c), { fields: n.fields.map(String), tags: n.tags ?? "", notetype: n.notetype, deck: n.deck });
  return c.json({ ok: true });
});

app.onError((err, c) => {
  if (err instanceof AnkiError) return c.json({ error: err.message }, err.status as 401);
  console.error(err);
  return c.json({ error: "Server error" }, 500);
});

// only /api/* reaches the Worker; everything else is served as static assets
app.all("*", (c) => c.json({ error: "not found" }, 404));

export default app;

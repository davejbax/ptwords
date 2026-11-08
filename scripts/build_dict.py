#!/usr/bin/env python3
"""Build the on-device European Portuguese dictionary from a kaikki.org
(English Wiktionary) Portuguese JSONL dump plus an EP frequency list.

Usage: python3 scripts/build_dict.py data/pt.jsonl data/pt_freq.txt out/

Writes out/ptdict-<hash>.bin (gzipped binary, downloaded once by the app and
searched on-device) and out/dict.json (its name/size, read by the Vite build).

European-Portuguese policy:
  * senses tagged Brazil (and not also Portugal) are dropped;
  * entries left with no senses are dropped;
  * Brazilian spellings ("Brazilian Portuguese standard form of facto") become
    search forms that resolve to the EP lemma, with a note;
  * IPA is taken from Portugal-tagged pronunciations only;
  * only constructed examples (not quotations, which skew Brazilian) are kept.
"""
import gzip
import hashlib
import json
import os
import struct
from array import array
import re
import sys
import unicodedata
from collections import defaultdict

SRC, FREQ, OUT = sys.argv[1:4]

POS = {
    "noun": "n.", "verb": "v.", "adj": "adj.", "adv": "adv.", "pron": "pron.",
    "prep": "prep.", "conj": "conj.", "intj": "interj.", "det": "det.",
    "article": "art.", "num": "num.", "phrase": "phrase", "prep_phrase": "phrase",
    "proverb": "proverb", "contraction": "contr.", "particle": "part.",
}
SKIP_POS = {"name", "suffix", "prefix", "infix", "interfix", "character",
            "symbol", "abbrev", "romanization", "punct"}
# sense tags worth showing to the user
SHOW_TAGS = {
    "Portugal", "informal", "formal", "colloquial", "slang", "vulgar",
    "derogatory", "dated", "archaic", "obsolete", "rare", "figuratively",
    "literary", "humorous", "transitive", "intransitive", "pronominal",
    "reflexive", "copulative", "auxiliary", "impersonal", "uncountable",
    "plural", "offensive", "euphemistic", "Africa", "Angola", "Mozambique",
}
# Wiktionary "form of" descriptions get long; abbreviate for display
ABBR = [
    ("first-person", "1st"), ("second-person", "2nd"), ("third-person", "3rd"),
    ("singular", "sg."), ("plural", "pl."), ("indicative", "ind."),
    ("subjunctive", "subj."), ("imperative", "imp."), ("present", "pres."),
    ("preterite", "pret."), ("imperfect", "impf."), ("pluperfect", "pluperf."),
    ("future", "fut."), ("conditional", "cond."), ("infinitive", "inf."),
    ("participle", "part."), ("personal", "pers."), ("affirmative", "aff."),
    ("negative", "neg."), ("masculine", "m."), ("feminine", "f."),
]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s.lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn").strip()


def is_br(tags) -> bool:
    return "Brazil" in tags and "Portugal" not in tags


def abbreviate(s: str) -> str:
    for a, b in ABBR:
        s = s.replace(a, b)
    return s


freq = {}
with open(FREQ, encoding="utf-8") as f:
    for line in f:
        w, _, c = line.rstrip("\n").rpartition(" ")
        if w:
            freq[w] = int(c)

# (word, pos) -> merged lemma record
lemmas: dict = {}
# list of (form, lemma_word, lemma_pos_or_None, note)
form_links = []


def split_gloss(glosses):
    """English Wiktionary glosses -> (translation, definition)."""
    if len(glosses) >= 2:  # [parent sense, sub-sense]
        return glosses[0].rstrip(":"), glosses[-1]
    g = glosses[0]
    m = re.match(r"^([^(;]+?)\s*\((.*)$", g)
    if m:
        rest = m.group(2).replace(")", "", 1).strip()
        return m.group(1), rest
    m = re.match(r"^([^;]+);\s*(.+)$", g)
    if m:
        return m.group(1), m.group(2)
    return g, ""


# Glosses that only *refer* to another word's meaning ("synonym of esconder",
# "clipping of lente de contacto (“contact lens”)", "See ter de, ter que.").
# Unlike spelling variants (which redirect search to the standard word), these
# keep their own headword and get the referenced word's senses copied in.
REF = re.compile(
    r"^(synonym of|abbreviation of|initialism of|acronym of|clipping of|ellipsis of|"
    r"apocopic form of|euphemistic form of|short for|diminutive of|augmentative of|"
    r"contraction of|See(?: also)?|(?:European Portuguese|Portugal)(?: standard)? (?:form|spelling) of)\s+(.+)$")
REF_LABEL = {"apocopic form of": "short form of", "see also": "see", "see": "see"}
EP_REF = re.compile(r"^(?:european portuguese|portugal)")  # same word, EP spelling: no label


def parse_ref(kind, rest, linked):
    """-> (targets, hint): the referenced words and any short gloss given for them."""
    hint = None
    m = re.search(r"\(“([^”]+)”\)", rest)
    if m:
        hint = m.group(1)
    elif ": " in rest:
        hint = rest.split(": ", 1)[1]
    elif re.search(r"\(([^()]+)\)\s*$", rest) and not linked:
        hint = re.search(r"\(([^()]+)\)\s*$", rest).group(1)
    if linked:
        return linked, hint
    body = re.sub(r"\(.*?\)|“.*?”", "", rest.split(": ", 1)[0]).strip().rstrip(".;")
    parts = re.split(r",\s*|\s+or\s+|\s+\+\s+", body)
    return [x.strip() for x in parts if x.strip() and len(x) < 40], hint


# glosses that are really "X of Y" links which kaikki didn't tag as form-of/alt-of
LINKISH = re.compile(
    r"^(?:.*\b(?:spelling|form|inflection|singular|plural|participle|indicative|"
    r"subjunctive|imperative|gerund|infinitive)"
    r"|pre-reform spelling.*?)\s+of\s+([^\s:;,()]+(?: [^\s:;,()]+)?)\s*(?:[(:;,].*)?$")


def ep_ipa(sounds):
    best = None
    for s in sounds or []:
        if "ipa" not in s:
            continue
        tags = s.get("tags", [])
        if "Portugal" in tags or "Lisbon" in tags:
            if best is None or "Lisbon" in tags:
                best = s["ipa"]
    return best


def head_of(e):
    for h in e.get("head_templates", []):
        x = h.get("expansion", "")
        if x and len(x) <= 70 and e.get("pos") != "verb":
            return x
    return None


with open(SRC, encoding="utf-8") as f:
    for line in f:
        e = json.loads(line)
        word, pos = e.get("word"), e.get("pos")
        if not word or pos in SKIP_POS or pos not in POS:
            continue
        real = []
        for s in e.get("senses", []):
            tags = s.get("tags", [])
            gl = s.get("glosses")
            if not gl:
                continue
            ref = REF.match(gl[-1]) or REF.match(gl[0])
            if ref and not gl[-1].startswith("Same as"):
                if is_br(tags):
                    continue
                kind = ref.group(1).lower()
                linked = [x["word"] for x in (s.get("alt_of") or s.get("form_of") or [])
                          if x.get("word") and not x["word"].startswith("any ")]
                targets, hint = parse_ref(kind, ref.group(2), linked)
                labels = [t for t in tags if t in SHOW_TAGS]
                kind = "" if EP_REF.match(kind) else REF_LABEL.get(kind, kind)
                real.append({"ref": (kind, targets, hint), "l": labels})
                continue
            if "form-of" in tags and s.get("form_of"):
                note = abbreviate(gl[-1].rstrip(":"))
                if note.startswith("inflection of"):
                    note = ""
                for fo in s["form_of"]:
                    form_links.append((word, fo["word"], pos, note, is_br(tags)))
                continue
            if "alt-of" in tags and s.get("alt_of"):
                note = gl[0]
                low = note.lower()
                if "brazil" in low:
                    note = "Brazilian spelling"
                elif "pre-reform" in low or "superseded" in low or "pre-1990" in low:
                    note = "pre-reform spelling"
                elif "misspelling" in low:
                    note = "misspelling"
                else:
                    note = "alternative form"
                for ao in s["alt_of"]:
                    form_links.append((word, ao["word"], pos, note, False))
                continue
            if is_br(tags) or "misspelling" in tags:
                continue
            m = LINKISH.match(gl[0]) or LINKISH.match(gl[-1])
            if m:
                low = m.group(0).lower()
                note = ("pre-reform spelling" if "pre-reform" in low else
                        "Brazilian spelling" if "brazil" in low else abbreviate(m.group(0).rsplit(" of ", 1)[0]))
                form_links.append((word, m.group(1), pos, note, False))
                continue
            tr, df = split_gloss(gl)
            raw = (s.get("raw_glosses") or [""])[0]
            quals = re.match(r"^\(([^)]*)\)", raw)
            labels = [t for t in tags if t in SHOW_TAGS]
            if quals:
                for q in quals.group(1).split(","):
                    q = q.strip()
                    if q and q not in labels and q != "Brazil" and len(q) < 25:
                        labels.append(q)
            sense = {"t": tr, "d": df}
            if labels:
                sense["l"] = labels[:4]
            for ex in s.get("examples", []):
                if ex.get("type") == "example" and ex.get("text") and len(ex["text"]) < 160:
                    sense["x"] = [ex["text"], ex.get("translation") or ex.get("english") or ""]
                    break
            real.append(sense)
        if not real:
            continue
        key = (word, pos)
        rec = lemmas.get(key)
        if rec is None:
            rec = lemmas[key] = {"w": word, "p": POS[pos], "s": [], "forms": set()}
            ipa, head = ep_ipa(e.get("sounds")), head_of(e)
            if ipa:
                rec["i"] = ipa
            if head and head != word:
                rec["h"] = head
        sk = lambda x: (x.get("t"), x.get("d"), str(x.get("ref")))
        seen = {sk(x) for x in rec["s"]}
        rec["s"].extend(x for x in real if sk(x) not in seen)
        for fm in e.get("forms", []):
            ft = fm.get("form", "")
            ftags = fm.get("tags", [])
            if (not ft or ft == word or " " in ft or
                    any(t in ftags for t in ("table-tags", "inflection-template", "class",
                                             "romanization")) or len(ft) > 40):
                continue
            if is_br(ftags):
                continue
            rec["forms"].add((ft, abbreviate(" ".join(t for t in ftags if t not in ("Portugal",)))))

# ---- resolve meaning references: copy the referenced word's senses in
words = defaultdict(list)
for (w, p), rec in lemmas.items():
    words[w].append(rec)
resolved: dict = {}
ep_pairs = []  # (EP-spelled rec, Brazilian spelling it took its senses from)


def resolve(rec, stack=()):
    if id(rec) in resolved:
        return resolved[id(rec)]
    out = []
    for s in rec["s"]:
        if "ref" not in s:
            out.append(s)
            continue
        kind, targets, hint = s["ref"]
        got = []
        for t in targets:
            cands = [r for r in words.get(t, []) if r is not rec and id(r) not in stack]
            same = [r for r in cands if r["p"] == rec["p"]]
            ts = [x for r in (same or cands) for x in resolve(r, stack + (id(rec),))]
            if hint:  # the reference names the meaning it wants: keep matching senses
                h = re.compile(r"\b" + re.escape(hint.lower().split(";")[0].strip()) + r"\b")
                ts = [x for x in ts if h.search((x["t"] + " " + x["d"]).lower())] or ts
            if ts and not kind:
                ep_pairs.append((rec, t))
            for x in (ts if not kind else ts[:8]):
                got.append({**x, "l": ([*s["l"], *(x.get("l") or [])][:3] + ([f"{kind} {t}"] if kind else []))})
        if not got and hint:  # referenced word isn't in the dictionary: use the gloss it gave
            got.append({"t": hint, "d": "", "l": [*s["l"], f"{kind} {', '.join(targets)}"]})
        out.extend(got)
    seen, uniq = set(), []
    for x in out:
        k = (x["t"], x["d"])
        if k not in seen:
            seen.add(k)
            uniq.append(x)
    if not stack:
        resolved[id(rec)] = uniq
    return uniq


# Last line of defence: a definition must never be just a pointer elsewhere.
POINTER = re.compile(
    r"^(?:See |Same as|(?i:synonym of|abbreviation of|initialism of|acronym of|clipping of|ellipsis of|"
    r"short for|contraction of|diminutive of|augmentative of|.*\b(?:form|spelling|inflection) of \S+))")
unresolved = 0
for key in list(lemmas):
    rec = lemmas[key]
    had_refs = any("ref" in x for x in rec["s"])
    rec["s"] = [x for x in resolve(rec) if not POINTER.match(x["t"])]
    if not rec["s"]:
        unresolved += had_refs
        del lemmas[key]
print(f"dropped {unresolved} entries whose references couldn't be resolved", file=sys.stderr)

# Brazilian spellings whose meaning now lives on the EP spelling (antônimo -> antónimo)
# stop being separate results and become search redirects to the EP word.
POS_KEY = {v: k for k, v in POS.items()}
alias = {}
key_of = {id(r): k for k, r in lemmas.items()}
for rec, t in ep_pairs:
    br = next((r for r in words.get(t, []) if r["p"] == rec["p"] and r is not rec), None)
    if br is None or any("Portugal" in (x.get("l") or []) for x in br["s"]):
        continue
    lemmas.pop(key_of.get(id(br)), None)
    alias[(t, rec["p"])] = rec["w"]
    form_links.append((t, rec["w"], POS_KEY.get(rec["p"]), "Brazilian spelling", False))
print(f"folded {len(alias)} Brazilian spellings into their EP spelling", file=sys.stderr)

# ---- assign ids, ordered by frequency so lower ids are commoner words
by_word = defaultdict(list)
for (w, p), rec in lemmas.items():
    by_word[w].append(rec)
order = sorted(lemmas.values(), key=lambda r: (-freq.get(r["w"], 0), -len(r["s"]), r["w"], r["p"]))
for i, r in enumerate(order, 1):
    r["id"] = i

# form rows: key -> {(form, lemma_id): (score, note)}
rows: dict = {}


def add(form, rec, note, is_lemma):
    k = norm(form)
    if not k:
        return
    score = freq.get(form, 0) * 2 + (1 if is_lemma else 0)
    key = (k, form, rec["id"])
    cur = rows.get(key)
    if cur is None or (is_lemma and cur[1]):
        rows[key] = (score, "" if is_lemma else note)
    elif cur[1] and "ind." in note and "ind." not in cur[1]:
        rows[key] = (cur[0], note)  # e.g. está: prefer "ind. pres. 3rd sg." over "imp. 2nd sg."


for r in order:
    add(r["w"], r, "", True)
    for ft, note in r["forms"]:
        add(ft, r, note, False)
for form, target, pos, note, br in form_links:
    if " " in form:  # conjugated idioms ("fui ao cu") just clutter results
        continue
    target = alias.get((target, POS.get(pos)), target)
    cands = by_word.get(target, [])
    same = [r for r in cands if r["p"] == POS.get(pos)]
    for rec in same or cands:
        add(form, rec, ("Brazilian " + note) if br and note else note, False)

# ---- binary container, gzipped. Layout (little-endian, sections 4-byte aligned):
#   "PTW1" u32 nsections, then per section: u32 byte length, bytes, zero padding.
#   0 meta JSON {notes: [...]}     1 keys (norm form) "\n"-joined, sorted
#   2 surfaces "\n"-joined ("" = same as key)   3 lemma JSON lines (id = line + 1)
#   4 u32 lemma id per form        5 u16 note index per form   6 u32 rank per form
notes = [""]
note_ix = {"": 0}
forms = sorted(((k, f, lid, s, n) for (k, f, lid), (s, n) in rows.items()), key=lambda x: (x[0], -x[3]))
for *_, n in forms:
    if n not in note_ix:
        note_ix[n] = len(notes)
        notes.append(n)
assert len(notes) < 65536
dump = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))
sections = [
    dump({"notes": notes}).encode(),
    "\n".join(k for k, *_ in forms).encode(),
    "\n".join("" if f == k else f for k, f, *_ in forms).encode(),
    "\n".join(dump({k: r[k] for k in ("w", "p", "h", "i", "s") if k in r}) for r in order).encode(),
    array("I", (lid for _, _, lid, _, _ in forms)).tobytes(),
    array("H", (note_ix[n] for *_, n in forms)).tobytes(),
    array("I", (min(s, 2**32 - 1) for _, _, _, s, _ in forms)).tobytes(),
]
assert sys.byteorder == "little"
buf = bytearray(b"PTW1" + struct.pack("<I", len(sections)))
for sec in sections:
    buf += struct.pack("<I", len(sec)) + sec + b"\0" * (-len(sec) % 4)
data = gzip.compress(bytes(buf), compresslevel=9, mtime=0)
version = hashlib.sha256(data).hexdigest()[:10]
os.makedirs(OUT, exist_ok=True)
for old in os.listdir(OUT):
    if old.startswith("ptdict-"):
        os.remove(os.path.join(OUT, old))
name = f"ptdict-{version}.bin"
with open(os.path.join(OUT, name), "wb") as f:
    f.write(data)
with open(os.path.join(OUT, "dict.json"), "w") as f:
    json.dump({"file": name, "version": version, "size": len(data), "raw": len(buf)}, f)
print(f"lemmas={len(order)} forms={len(forms)} raw={len(buf):,} gz={len(data):,} -> {name}", file=sys.stderr)

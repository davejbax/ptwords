// Minimal protobuf wire-format codec — just enough for AnkiWeb's /svc/* API.

export type PbField =
  | [no: number, kind: "varint", value: bigint | number | boolean]
  | [no: number, kind: "string", value: string]
  | [no: number, kind: "message", value: PbField[]];

const te = new TextEncoder();
const td = new TextDecoder();

function varint(out: number[], v: bigint) {
  v = BigInt.asUintN(64, v);
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

function encodeInto(out: number[], fields: PbField[]) {
  for (const [no, kind, value] of fields) {
    if (kind === "varint") {
      varint(out, BigInt(no << 3));
      varint(out, BigInt(typeof value === "boolean" ? Number(value) : value));
      continue;
    }
    const bytes = kind === "string" ? te.encode(value) : encode(value);
    varint(out, BigInt((no << 3) | 2));
    varint(out, BigInt(bytes.length));
    for (const b of bytes) out.push(b);
  }
}

export function encode(fields: PbField[]): Uint8Array {
  const out: number[] = [];
  encodeInto(out, fields);
  return Uint8Array.from(out);
}

/** Decoded message: field number -> list of raw values (varints as bigint, length-delimited as bytes). */
export class PbMsg {
  constructor(readonly f: Map<number, (bigint | Uint8Array)[]>) {}
  static parse(buf: Uint8Array): PbMsg {
    const f = new Map<number, (bigint | Uint8Array)[]>();
    let i = 0;
    const rv = () => {
      let r = 0n, s = 0n;
      for (;;) {
        const b = buf[i++];
        if (b === undefined) throw new Error("truncated protobuf");
        r |= BigInt(b & 0x7f) << s;
        if (!(b & 0x80)) return r;
        s += 7n;
      }
    };
    while (i < buf.length) {
      const tag = Number(rv());
      const no = tag >> 3, wt = tag & 7;
      let v: bigint | Uint8Array;
      if (wt === 0) v = rv();
      else if (wt === 2) {
        const len = Number(rv());
        v = buf.subarray(i, i + len);
        i += len;
      } else if (wt === 1) { v = buf.subarray(i, i + 8); i += 8; }
      else if (wt === 5) { v = buf.subarray(i, i + 4); i += 4; }
      else throw new Error("unsupported wire type " + wt);
      const list = f.get(no);
      list ? list.push(v) : f.set(no, [v]);
    }
    return new PbMsg(f);
  }
  int(no: number): bigint {
    const v = this.f.get(no)?.[0];
    return typeof v === "bigint" ? v : 0n;
  }
  str(no: number): string {
    const v = this.f.get(no)?.[0];
    return v instanceof Uint8Array ? td.decode(v) : "";
  }
  msgs(no: number): PbMsg[] {
    return (this.f.get(no) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map(PbMsg.parse);
  }
}

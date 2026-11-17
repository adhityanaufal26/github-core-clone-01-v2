// github-core-clone-01-v2 — single-process GitHub-compatible git forge.
// Node 22 stdlib only. One in-memory store shared by REST, GraphQL, MCP and
// git smart HTTP, so a contents commit is visible to git clone, GET /commits
// and GraphQL fixtures alike.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { deflateSync, inflateSync } from "node:zlib";

// ---------------------------------------------------------------- constants
const VIEWER = {
  login: "adaiversen",
  id: 1000,
  name: "ada iversen",
  email: "adaiversen@example.invalid",
};
const ZERO = "0000000000000000000000000000000000000000";
const GIT_AUTHOR = "ada iversen <adaiversen@example.invalid>";
const EPOCH = 1700000000; // deterministic clock base (seconds)
let tsCounter = 0;
function isoNow(): string {
  return new Date((EPOCH + tsCounter++) * 1000).toISOString();
}
function gitTs(): number {
  return EPOCH + tsCounter++;
}
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`).toString("base64");
}
function sha1(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}
function b64(buf: Buffer): string {
  return buf.toString("base64");
}
function unb64(s: string): Buffer {
  return Buffer.from(s, "base64");
}

// ---------------------------------------------------------------- pkt-lines
function pktLine(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = (b.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(len, "ascii"), b]);
}
const FLUSH = Buffer.from("0000", "ascii");
const DELIM = Buffer.from("0001", "ascii");
interface Pkt { text: string | null; flush: boolean; delim: boolean; }
function pktDecode(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString("ascii", i, i + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { out.push({ text: null, flush: true, delim: false }); i += 4; continue; }
    if (len === 1) { out.push({ text: null, flush: false, delim: true }); i += 4; continue; }
    if (i + len > buf.length) break;
    const payload = buf.subarray(i + 4, i + len);
    let text = payload.toString("utf8");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    out.push({ text, flush: false, delim: false });
    i += len;
  }
  return out;
}
// Split a smart-HTTP request body into pkt-line part + trailing pack bytes.
function splitPack(buf: Buffer): { lines: Pkt[]; packOff: number } {
  let i = 0;
  const lines: Pkt[] = [];
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString("ascii", i, i + 4), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) { lines.push({ text: null, flush: true, delim: false }); i += 4; continue; }
    if (len === 1) { lines.push({ text: null, flush: false, delim: true }); i += 4; continue; }
    if (i + len > buf.length) break;
    // A pack starts with "PACK" — stop pkt parsing there.
    if (buf.toString("ascii", i + 4, i + 8) === "PACK") break;
    const payload = buf.subarray(i + 4, i + len);
    let text = payload.toString("utf8");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    lines.push({ text, flush: false, delim: false });
    i += len;
  }
  return { lines, packOff: i };
}

// ---------------------------------------------------------------- git objects
// Stored object: {type, data} where data is the raw object content (no header).
interface GitObj { type: "commit" | "tree" | "blob" | "tag"; data: Buffer; }
function hashObj(type: string, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, "ascii"), data]));
}
interface Commit { tree: string; parents: string[]; author: string; committer: string; message: string; }
function parseCommit(data: Buffer): Commit {
  const text = data.toString("utf8");
  const headEnd = text.indexOf("\n\n");
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : "";
  const c: Commit = { tree: "", parents: [], author: "", committer: "", message };
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) c.tree = line.slice(5);
    else if (line.startsWith("parent ")) c.parents.push(line.slice(7));
    else if (line.startsWith("author ")) c.author = line.slice(7);
    else if (line.startsWith("committer ")) c.committer = line.slice(10);
  }
  return c;
}
function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const ts = gitTs();
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${GIT_AUTHOR} ${ts} +0000\n`;
  s += `committer ${GIT_AUTHOR} ${ts} +0000\n`;
  s += `\n${message}`;
  if (!message.endsWith("\n")) s += "\n";
  return Buffer.from(s, "utf8");
}
interface TreeEntry { mode: string; name: string; oid: string; }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString("ascii", i, sp);
    const nul = data.indexOf(0, sp);
    const name = data.toString("utf8", sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    (a.mode === "40000" ? a.name + "/" : a.name) < (b.mode === "40000" ? b.name + "/" : b.name) ? -1 : 1);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}
interface Tag { object: string; type: string; tag: string; tagger: string; message: string; }
function parseTag(data: Buffer): Tag {
  const text = data.toString("utf8");
  const headEnd = text.indexOf("\n\n");
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const t: Tag = { object: "", type: "", tag: "", tagger: "", message: headEnd >= 0 ? text.slice(headEnd + 2) : "" };
  for (const line of head.split("\n")) {
    if (line.startsWith("object ")) t.object = line.slice(7);
    else if (line.startsWith("type ")) t.type = line.slice(5);
    else if (line.startsWith("tag ")) t.tag = line.slice(4);
    else if (line.startsWith("tagger ")) t.tagger = line.slice(7);
  }
  return t;
}

// ---------------------------------------------------------------- pack codec
const TYPE_NUM: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag", 6: "ofs_delta", 7: "ref_delta" };
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
function readVarint(buf: Buffer, off: number): [number, number] {
  let b = buf[off];
  let size = b & 0x0f;
  let shift = 4;
  off++;
  while (b & 0x80) {
    b = buf[off++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return [size, off];
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVar = (): number => {
    let v = 0;
    let s = 0;
    for (;;) {
      const b = delta[off++];
      v |= (b & 0x7f) << s;
      s += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const dstSize = readVar();
  if (srcSize !== base.length) throw new Error("delta base size mismatch");
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else throw new Error("delta op 0");
  }
  const res = Buffer.concat(out);
  if (res.length !== dstSize) throw new Error("delta result size mismatch");
  return res;
}
interface ParsedPack { objects: Map<string, GitObj>; }
function readPack(buf: Buffer): ParsedPack {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "PACK") throw new Error("bad pack header");
  const count = buf.readUInt32BE(8);
  let off = 12;
  interface Entry { start: number; typeNum: number; baseOff: number; baseOid: string; data: Buffer; }
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const start = off;
    const typeNum = (buf[off] >> 4) & 0x07;
    const [size, afterSize] = readVarint(buf, off);
    off = afterSize;
    let baseOid = "";
    let baseOff = 0;
    if (typeNum === 6) {
      let b = buf[off++];
      let v = b & 0x7f;
      while (b & 0x80) { b = buf[off++]; v = ((v + 1) << 7) | (b & 0x7f); }
      baseOff = start - v;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(off, off + 20).toString("hex");
      off += 20;
    }
    if (!TYPE_NUM[typeNum]) throw new Error(`unknown pack type ${typeNum}`);
    const cl = compressedLen(buf.subarray(off), size);
    const data = inflateSync(buf.subarray(off, off + cl));
    if (data.length !== size) throw new Error("pack object size mismatch");
    off += cl;
    entries.push({ start, typeNum, baseOff, baseOid, data });
  }
  const objs = new Map<string, GitObj>();
  const offToOid = new Map<number, string>();
  const pending: Entry[] = [];
  for (const e of entries) {
    if (e.typeNum === 6 || e.typeNum === 7) { pending.push(e); continue; }
    const type = TYPE_NUM[e.typeNum] as GitObj["type"];
    const oid = hashObj(type, e.data);
    objs.set(oid, { type, data: e.data });
    offToOid.set(e.start, oid);
  }
  let rest = pending;
  for (let guard = 0; guard < count + 2 && rest.length; guard++) {
    const next: Entry[] = [];
    for (const e of rest) {
      const baseOid = e.typeNum === 7 ? e.baseOid : offToOid.get(e.baseOff);
      const base = baseOid ? objs.get(baseOid) : undefined;
      if (!base) { next.push(e); continue; }
      const data = applyDelta(base.data, e.data);
      const oid = hashObj(base.type, data);
      objs.set(oid, { type: base.type, data });
      offToOid.set(e.start, oid);
    }
    if (next.length === rest.length) throw new Error("delta base missing");
    rest = next;
  }
  return { objects: objs };
}
// Length of the zlib stream at the start of `slice` that inflates to `size`
// bytes. inflateSync throws on truncation and ignores trailing data, so the
// predicate "inflates to exactly size" is monotonic and binary search finds
// the smallest successful prefix — the exact stream end.
function compressedLen(slice: Buffer, size: number): number {
  let lo = 1;
  let hi = slice.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(slice.subarray(0, mid));
      if (out.length === size) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}
function writePack(objects: { oid: string; type: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "ascii");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  chunks.push(head);
  for (const o of objects) {
    const size = o.data.length;
    const typeCode = TYPE_CODE[o.type];
    // varint header: first byte holds type (3 bits) + low 4 bits of size.
    const hdr: number[] = [];
    let s = size;
    let first = ((typeCode & 0x07) << 4) | (s & 0x0f);
    s >>= 4;
    if (s) first |= 0x80;
    hdr.push(first);
    while (s) {
      let b = s & 0x7f;
      s >>= 7;
      if (s) b |= 0x80;
      hdr.push(b);
    }
    chunks.push(Buffer.from(hdr));
    chunks.push(deflateSync(o.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------- store
interface Label { id: number; name: string; color: string; description: string; }
interface Comment { id: number; body: string; user: string; created_at: string; updated_at: string; }
interface Issue {
  id: number; number: number; title: string; body: string; state: "open" | "closed";
  labels: string[]; comments: Comment[]; created_at: string; updated_at: string;
  closed_at: string | null; seq: number; jsonCache: string;
}
interface PR {
  id: number; number: number; title: string; body: string; state: "open" | "closed";
  head: string; base: string; merged: boolean; merged_at: string | null;
  merge_commit_sha: string | null; created_at: string; updated_at: string; seq: number;
}
interface Repo {
  id: number; owner: string; name: string; private: boolean; description: string;
  defaultBranch: string; created_at: string; updated_at: string;
  refs: Map<string, string>; // full ref name -> commit oid
  objects: Map<string, GitObj>;
  issues: Map<number, Issue>; issueSeq: number;
  pulls: Map<number, PR>; prSeq: number;
  labels: Map<string, Label>; labelSeq: number;
  version: number; // bumps on any ref change; invalidates caches
  packCache: Map<string, Buffer>;
  advCache: Map<string, Buffer>; // "up-v0" | "recv-v0" | "up-v2" per version
}
let repoSeq = 0;
let globalSeq = 0;
const repos = new Map<string, Repo>();
const reposById = new Map<number, Repo>();
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
function createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
  const now = isoNow();
  const r: Repo = {
    id: ++repoSeq, owner, name, private: isPrivate, description,
    defaultBranch: "main", created_at: now, updated_at: now,
    refs: new Map(), objects: new Map(),
    issues: new Map(), issueSeq: 0,
    pulls: new Map(), prSeq: 0,
    labels: new Map(), labelSeq: 0,
    version: 0, packCache: new Map(), advCache: new Map(),
  };
  repos.set(repoKey(owner, name), r);
  reposById.set(r.id, r);
  return r;
}
function bump(r: Repo): void {
  r.version++;
  r.packCache.clear();
  r.advCache.clear();
}
function storeObj(r: Repo, type: GitObj["type"], data: Buffer): string {
  const oid = hashObj(type, data);
  if (!r.objects.has(oid)) r.objects.set(oid, { type, data });
  return oid;
}
function getCommit(r: Repo, oid: string): Commit | undefined {
  const o = r.objects.get(oid);
  if (!o || o.type !== "commit") return undefined;
  return parseCommit(o.data);
}
// Flatten a tree into path -> {oid, mode} (files only).
function flattenTree(r: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const o = r.objects.get(treeOid);
  if (!o || o.type !== "tree") return;
  for (const e of parseTree(o.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === "40000") flattenTree(r, e.oid, p, out);
    else out.set(p, { oid: e.oid, mode: e.mode });
  }
}
// Build tree objects from a flat file map; returns root tree oid.
function buildTrees(r: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
  const ensure = (d: string): Map<string, { oid: string; mode: string }> => {
    let m = dirs.get(d);
    if (!m) { m = new Map(); dirs.set(d, m); }
    return m;
  };
  ensure("");
  for (const [path, f] of files) {
    const parts = path.split("/");
    const name = parts.pop()!;
    const dir = parts.join("/");
    ensure(dir).set(name, f);
    let cur = "";
    for (const p of parts) {
      const parent = cur;
      cur = cur ? `${cur}/${p}` : p;
      ensure(parent).set(p, { oid: "", mode: "40000" });
    }
  }
  const build = (dir: string): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of ensure(dir)) {
      if (f.mode === "40000") {
        const sub = dir ? `${dir}/${name}` : name;
        entries.push({ mode: "40000", name, oid: build(sub) });
      } else entries.push({ mode: f.mode, name, oid: f.oid });
    }
    return storeObj(r, "tree", buildTree(entries));
  };
  return build("");
}
// Commit a file change (create/update/delete) on a branch; creates the branch
// from the default branch tip (or as a root commit) if it does not exist yet.
function commitFile(r: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
  const refName = `refs/heads/${branch}`;
  let tip = r.refs.get(refName);
  if (!tip) {
    tip = r.refs.get(`refs/heads/${r.defaultBranch}`);
    if (tip) r.refs.set(refName, tip);
  }
  const files = new Map<string, { oid: string; mode: string }>();
  if (tip) {
    const c = getCommit(r, tip);
    if (c) flattenTree(r, c.tree, "", files);
  }
  let blobSha: string | null = null;
  if (content === null) files.delete(path);
  else {
    blobSha = storeObj(r, "blob", content);
    files.set(path, { oid: blobSha, mode: "100644" });
  }
  const treeOid = buildTrees(r, files);
  const parents = tip ? [tip] : [];
  const commitData = buildCommit(treeOid, parents, message);
  const commitSha = storeObj(r, "commit", commitData);
  r.refs.set(refName, commitSha);
  bump(r);
  return { commitSha, blobSha };
}
function ancestors(r: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = getCommit(r, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return seen;
}
function isAncestor(r: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const stack = [desc];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = getCommit(r, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return false;
}
function mergeBase(r: Repo, a: string, b: string): string | null {
  const ancA = ancestors(r, a);
  const stack = [b];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (ancA.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = getCommit(r, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return null;
}
function treeFiles(r: Repo, tip: string | undefined): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (!tip) return out;
  const c = getCommit(r, tip);
  if (c) flattenTree(r, c.tree, "", out);
  return out;
}
// Diff two flattened trees: paths whose contents differ.
function diffFiles(a: Map<string, { oid: string; mode: string }>, b: Map<string, { oid: string; mode: string }>): string[] {
  const out: string[] = [];
  for (const [p, fa] of a) {
    const fb = b.get(p);
    if (!fb || fb.oid !== fa.oid) out.push(p);
  }
  for (const p of b.keys()) if (!a.has(p)) out.push(p);
  return out;
}
function prConflict(r: Repo, pr: PR): boolean {
  const headTip = r.refs.get(`refs/heads/${pr.head}`);
  const baseTip = r.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) return false;
  const mb = mergeBase(r, headTip, baseTip);
  const mbFiles = treeFiles(r, mb ?? undefined);
  const headFiles = treeFiles(r, headTip);
  const baseFiles = treeFiles(r, baseTip);
  const headChanged = new Set(diffFiles(mbFiles, headFiles));
  const baseChanged = new Set(diffFiles(mbFiles, baseFiles));
  for (const p of headChanged) {
    if (!baseChanged.has(p)) continue;
    const h = headFiles.get(p);
    const b = baseFiles.get(p);
    if ((h?.oid ?? null) !== (b?.oid ?? null)) return true;
  }
  return false;
}
function mergeableState(r: Repo, pr: PR): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
  const headTip = r.refs.get(`refs/heads/${pr.head}`);
  const baseTip = r.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) return "UNKNOWN";
  return prConflict(r, pr) ? "CONFLICTING" : "MERGEABLE";
}
// Squash/merge/rebase: new commit on base tip with head's changes over the
// merge-base. Returns the merge commit sha, or null if conflicted.
function doMerge(r: Repo, pr: PR, method: string): string | null {
  const headTip = r.refs.get(`refs/heads/${pr.head}`);
  const baseTip = r.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) return null;
  if (prConflict(r, pr)) return null;
  const mb = mergeBase(r, headTip, baseTip);
  const mbFiles = treeFiles(r, mb ?? undefined);
  const headFiles = treeFiles(r, headTip);
  const baseFiles = treeFiles(r, baseTip);
  const merged = new Map(baseFiles);
  for (const p of diffFiles(mbFiles, headFiles)) {
    const h = headFiles.get(p);
    if (h) merged.set(p, h);
    else merged.delete(p);
  }
  const treeOid = buildTrees(r, merged);
  const parents = method === "merge" ? [baseTip, headTip] : [baseTip];
  const commitData = buildCommit(treeOid, parents, `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`);
  const sha = storeObj(r, "commit", commitData);
  r.refs.set(`refs/heads/${pr.base}`, sha);
  bump(r);
  return sha;
}
function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 0x0a) n++;
  return n + 1;
}

// ------------------------------------------------------------------- http
let reqCounter = 0;
function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-request-id": `req-${++reqCounter}`,
    "content-length": String(Buffer.byteLength(payload)),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(payload);
}
function sendRaw(res: import("node:http").ServerResponse, status: number, buf: Buffer, contentType: string, extra?: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": contentType,
    "x-github-request-id": `req-${++reqCounter}`,
    "content-length": String(buf.length),
    ...extra,
  });
  res.end(buf);
}
function notFound(res: import("node:http").ServerResponse): void {
  sendJson(res, 404, { message: "Not Found", documentation_url: "" });
}
function unauth(res: import("node:http").ServerResponse): void {
  sendJson(res, 401, { message: "Requires authentication" });
}
function badJson(res: import("node:http").ServerResponse): void {
  sendJson(res, 400, { message: "Problems parsing JSON" });
}
function unprocessable(res: import("node:http").ServerResponse, message: string): void {
  sendJson(res, 422, { message, errors: [{ resource: "Repo", code: "custom", message }] });
}

// ------------------------------------------------------------------- shapes
function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login, id: VIEWER.id, node_id: gid("user", String(VIEWER.id)),
    avatar_url: "", gravatar_id: "", url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`, type: "User", site_admin: false,
    name: VIEWER.name, company: "", blog: "", location: "", email: VIEWER.email,
    hireable: false, bio: "", public_repos: repos.size, public_gists: 0,
    followers: 0, following: 0, created_at: "2024-01-01T00:00:00Z", updated_at: isoNow(),
  };
}
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, node_id: gid("repo", String(r.id)), name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER.id, node_id: gid("user", String(VIEWER.id)), avatar_url: "", type: "User" },
    private: r.private, html_url: `https://github.com/${r.owner}/${r.name}`,
    description: r.description, fork: false,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    clone_url: `http://127.0.0.1/${r.owner}/${r.name}.git`,
    git_url: `git://127.0.0.1/${r.owner}/${r.name}.git`,
    ssh_url: `git@github.com:${r.owner}/${r.name}.git`,
    homepage: "", size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: false, has_downloads: true, has_wiki: false,
    has_pages: false, forks_count: 0, open_issues_count: [...r.issues.values()].filter((i) => i.state === "open").length,
    license: null, default_branch: r.defaultBranch,
    created_at: r.created_at, updated_at: r.updated_at, pushed_at: r.updated_at,
  };
}
function branchJson(r: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name, commit: { sha, url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}` },
    protected: false,
  };
}
function commitJson(r: Repo, sha: string): Record<string, unknown> | null {
  const c = getCommit(r, sha);
  if (!c) return null;
  return {
    sha, node_id: gid("commit", sha),
    commit: {
      author: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
      committer: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
      message: c.message.replace(/\n$/, ""), tree: { sha: c.tree },
      url: `/api/v3/repos/${r.owner}/${r.name}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}`,
    html_url: `https://github.com/${r.owner}/${r.name}/commit/${sha}`,
    parents: c.parents.map((p) => ({ sha: p })),
    author: { login: VIEWER.login, id: VIEWER.id, type: "User" },
    committer: { login: VIEWER.login, id: VIEWER.id, type: "User" },
  };
}
function contentsUrl(r: Repo, path: string): string {
  return `/api/v3/repos/${r.owner}/${r.name}/contents/${path}`;
}
function fileJson(r: Repo, path: string, oid: string, data: Buffer): Record<string, unknown> {
  const name = path.split("/").pop()!;
  return {
    type: "file", encoding: "base64", size: data.length, name, path,
    content: b64(data), sha: oid, url: contentsUrl(r, path),
    git_url: `/api/v3/repos/${r.owner}/${r.name}/git/blobs/${oid}`,
    html_url: `https://github.com/${r.owner}/${r.name}/blob/HEAD/${path}`,
    download_url: contentsUrl(r, path),
    _links: { git: `/api/v3/repos/${r.owner}/${r.name}/git/blobs/${oid}`, html: `https://github.com/${r.owner}/${r.name}/blob/HEAD/${path}`, self: contentsUrl(r, path) },
  };
}
function labelJson(l: Label): Record<string, unknown> {
  return { id: l.id, node_id: gid("label", String(l.id)), url: "", name: l.name, color: l.color, description: l.description, default: false };
}
function issueObj(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, node_id: gid("issue", `${r.id}:${i.number}`), number: i.number,
    title: i.title, body: i.body, state: i.state,
    labels: i.labels.map((n) => labelJson(r.labels.get(n)!)),
    user: { login: VIEWER.login, id: VIEWER.id, node_id: gid("user", String(VIEWER.id)), type: "User" },
    assignee: null, assignees: [], locked: false, comments: i.comments.length,
    created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
function refreshIssueCache(r: Repo, i: Issue): void {
  i.jsonCache = JSON.stringify(issueObj(r, i));
}
function commentJson(r: Repo, i: Issue, c: Comment): Record<string, unknown> {
  return {
    id: c.id, node_id: gid("comment", `${r.id}:${i.number}:${c.id}`),
    body: c.body, user: { login: VIEWER.login, id: VIEWER.id, type: "User" },
    created_at: c.created_at, updated_at: c.updated_at,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/comments/${c.id}`,
    html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}#issuecomment-${c.id}`,
  };
}
function prObj(r: Repo, p: PR): Record<string, unknown> {
  const headSha = r.refs.get(`refs/heads/${p.head}`) ?? ZERO;
  const baseSha = r.refs.get(`refs/heads/${p.base}`) ?? ZERO;
  return {
    id: p.id, node_id: gid("pr", `${r.id}:${p.number}`), number: p.number,
    title: p.title, body: p.body, state: p.state, locked: false,
    head: { label: `${VIEWER.login}:${p.head}`, ref: p.head, sha: headSha, user: { login: VIEWER.login, id: VIEWER.id, type: "User" }, repo: repoJson(r) },
    base: { label: `${VIEWER.login}:${p.base}`, ref: p.base, sha: baseSha, user: { login: VIEWER.login, id: VIEWER.id, type: "User" }, repo: repoJson(r) },
    user: { login: VIEWER.login, id: VIEWER.id, type: "User" },
    merged: p.merged, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha,
    mergeable: mergeableState(r, p) === "MERGEABLE",
    mergeable_state: mergeableState(r, p).toLowerCase(),
    created_at: p.created_at, updated_at: p.updated_at, closed_at: p.state === "closed" ? p.updated_at : null,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
    comments: 0, review_comments: 0, commits: 1, additions: 0, deletions: 0, changed_files: 0,
  };
}
function linkHeader(base: string, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  const q = (p: number) => `${base}${base.includes("?") ? "&" : "?"}page=${p}&per_page=${perPage}`;
  if (page < totalPages) { parts.push(`<${q(page + 1)}>; rel="next"`); parts.push(`<${q(totalPages)}>; rel="last"`); }
  if (page > 1) { parts.push(`<${q(1)}>; rel="first"`); parts.push(`<${q(page - 1)}>; rel="prev"`); }
  return parts.length ? parts.join(", ") : null;
}

// ------------------------------------------------------------------- rest
type Body = Record<string, unknown> | null;
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function num(v: unknown, d: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}
function authOk(req: import("node:http").IncomingMessage, expected: string | undefined): boolean {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return false;
  const tok = h.slice(7);
  if (!tok) return false;
  if (expected) return tok === expected;
  return true;
}
function handleRest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: Body, seg: string[], q: URLSearchParams, method: string, expected: string | undefined): void {
  const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
  const noAuth = (seg.length === 0 && method === "GET") || (seg.length === 1 && seg[0] === "meta" && method === "GET");
  if (!noAuth && !authOk(req, expected)) { unauth(res); return; }
  if (seg.length === 0 && method === "GET") {
    sendJson(res, 200, { current_user_url: "/api/v3/user", repository_url: "/api/v3/repos/{owner}/{repo}" }, { "x-oauth-scopes": "repo, read:org" });
    return;
  }
  if (seg.length === 1 && seg[0] === "meta" && method === "GET") {
    sendJson(res, 200, { installed_version: "1.0.0" });
    return;
  }
  if (seg[0] === "user" && seg.length === 1 && method === "GET") { sendJson(res, 200, userJson()); return; }
  if (seg[0] === "user" && seg[1] === "repos") {
    if (method === "GET") {
      const mine = [...repos.values()].filter((r) => r.owner === VIEWER.login);
      const page = num(q.get("page"), 1);
      const perPage = num(q.get("per_page"), 30);
      const total = mine.length;
      const slice = mine.slice((page - 1) * perPage, page * perPage);
      const link = linkHeader(`${origin}/api/v3/user/repos`, page, perPage, total);
      sendJson(res, 200, slice.map(repoJson), link ? { link } : undefined);
      return;
    }
    if (method === "POST") {
      const name = str(body?.name);
      if (!name) { unprocessable(res, "name is required"); return; }
      if (getRepo(VIEWER.login, name)) { unprocessable(res, `Repository ${VIEWER.login}/${name} already exists`); return; }
      const r = createRepo(VIEWER.login, name, body?.private === true, str(body?.description));
      sendJson(res, 201, repoJson(r));
      return;
    }
  }
  if (seg[0] !== "repos" || seg.length < 3) { notFound(res); return; }
  const owner = decodeURIComponent(seg[1]);
  const rname = decodeURIComponent(seg[2]);
  const r = getRepo(owner, rname);
  const rest = seg.slice(3);
  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (!r) { notFound(res); return; }
    if (method === "GET") { sendJson(res, 200, repoJson(r)); return; }
    if (method === "PATCH") {
      if (typeof body?.description === "string") r.description = body.description;
      if (typeof body?.private === "boolean") r.private = body.private;
      if (typeof body?.default_branch === "string" && r.refs.has(`refs/heads/${body.default_branch}`)) r.defaultBranch = body.default_branch;
      r.updated_at = isoNow();
      sendJson(res, 200, repoJson(r));
      return;
    }
    if (method === "DELETE") {
      repos.delete(repoKey(owner, rname));
      reposById.delete(r.id);
      res.writeHead(204, { "x-github-request-id": `req-${++reqCounter}` });
      res.end();
      return;
    }
    notFound(res);
    return;
  }
  if (!r) { notFound(res); return; }
  // git/refs
  if (rest[0] === "git" && rest[1] === "refs" && method === "POST") {
    const ref = str(body?.ref);
    const sha = str(body?.sha);
    if (!ref.startsWith("refs/")) { unprocessable(res, "Invalid ref"); return; }
    if (r.refs.has(ref)) { unprocessable(res, "Reference already exists"); return; }
    if (!r.objects.has(sha)) { unprocessable(res, "Object does not exist"); return; }
    r.refs.set(ref, sha);
    bump(r);
    sendJson(res, 201, { ref, node_id: gid("ref", ref), object: { sha, type: "commit", url: `/api/v3/repos/${owner}/${rname}/git/commits/${sha}` }, url: `/api/v3/repos/${owner}/${rname}/git/refs/${ref}` });
    return;
  }
  if (rest[0] === "git" && rest[1] === "refs" && rest[2] === "heads" && method === "GET") {
    const branch = rest.slice(3).map(decodeURIComponent).join("/");
    const sha = r.refs.get(`refs/heads/${branch}`);
    if (!sha) { notFound(res); return; }
    sendJson(res, 200, { ref: `refs/heads/${branch}`, node_id: gid("ref", `refs/heads/${branch}`), object: { sha, type: "commit", url: `/api/v3/repos/${owner}/${rname}/git/commits/${sha}` }, url: `/api/v3/repos/${owner}/${rname}/git/refs/heads/${branch}` });
    return;
  }
  // branches
  if (rest[0] === "branches" && method === "GET") {
    if (rest.length === 1) {
      const list = [...r.refs.keys()].filter((k) => k.startsWith("refs/heads/")).map((k) => k.slice(11));
      sendJson(res, 200, list.map((b) => branchJson(r, b, r.refs.get(`refs/heads/${b}`)!)));
      return;
    }
    const branch = rest.slice(1).map(decodeURIComponent).join("/");
    const sha = r.refs.get(`refs/heads/${branch}`);
    if (!sha) { notFound(res); return; }
    sendJson(res, 200, branchJson(r, branch, sha));
    return;
  }
  // commits
  if (rest[0] === "commits" && method === "GET") {
    let tip: string | undefined;
    const shaQ = q.get("sha");
    if (shaQ) {
      tip = r.refs.get(`refs/heads/${shaQ}`) ?? (r.objects.has(shaQ) ? shaQ : undefined);
    } else {
      tip = r.refs.get(`refs/heads/${r.defaultBranch}`);
    }
    if (!tip) { notFound(res); return; }
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length && out.length < 30) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const cj = commitJson(r, cur);
      if (!cj) continue;
      out.push(cj);
      const c = getCommit(r, cur);
      if (c) for (const p of c.parents) stack.push(p);
    }
    sendJson(res, 200, out);
    return;
  }
  // contents
  if (rest[0] === "contents") {
    const path = rest.slice(1).map(decodeURIComponent).join("/");
    const branch = str(body?.branch) || r.defaultBranch;
    if (method === "GET") {
      const tip = r.refs.get(`refs/heads/${branch}`) ?? r.refs.get(`refs/heads/${r.defaultBranch}`);
      if (!tip) { notFound(res); return; }
      const files = treeFiles(r, tip);
      if (path === "") {
        const entries = dirEntries(r, files, "");
        sendJson(res, 200, entries);
        return;
      }
      const f = files.get(path);
      if (f) {
        const obj = r.objects.get(f.oid);
        if (!obj) { notFound(res); return; }
        sendJson(res, 200, fileJson(r, path, f.oid, obj.data));
        return;
      }
      const prefix = `${path}/`;
      const hasChild = [...files.keys()].some((k) => k.startsWith(prefix));
      if (hasChild) { sendJson(res, 200, dirEntries(r, files, path)); return; }
      notFound(res);
      return;
    }
    if (method === "PUT") {
      const content = str(body?.content);
      const message = str(body?.message) || `Update ${path}`;
      const sha = str(body?.sha);
      if (!content) { unprocessable(res, "content is required"); return; }
      const tip = r.refs.get(`refs/heads/${branch}`);
      const files = treeFiles(r, tip);
      const existing = files.get(path);
      if (existing) {
        if (!sha || sha !== existing.oid) {
          sendJson(res, 409, { message: "sha does not match the current file" });
          return;
        }
      } else if (sha) {
        sendJson(res, 409, { message: "sha does not match the current file" });
        return;
      }
      const buf = unb64(content);
      const prevTip = r.refs.get(`refs/heads/${branch}`);
      const { commitSha } = commitFile(r, branch, path, buf, message);
      const blobSha = hashObj("blob", buf);
      const c = getCommit(r, commitSha)!;
      sendJson(res, existing ? 200 : 201, {
        content: fileJson(r, path, blobSha, buf),
        commit: {
          sha: commitSha, node_id: gid("commit", commitSha), message: c.message.replace(/\n$/, ""),
          author: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
          committer: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
          url: `/api/v3/repos/${owner}/${rname}/git/commits/${commitSha}`,
          html_url: `https://github.com/${owner}/${rname}/commit/${commitSha}`,
          parents: prevTip ? [{ sha: prevTip }] : [],
        },
      });
      return;
    }
    if (method === "DELETE") {
      const sha = str(body?.sha);
      const message = str(body?.message) || `Delete ${path}`;
      const tip = r.refs.get(`refs/heads/${branch}`);
      const files = treeFiles(r, tip);
      const existing = files.get(path);
      if (!existing) { notFound(res); return; }
      if (sha && sha !== existing.oid) { unprocessable(res, "sha does not match the current file"); return; }
      const { commitSha } = commitFile(r, branch, path, null, message);
      sendJson(res, 200, { commit: { sha: commitSha, node_id: gid("commit", commitSha), message, url: `/api/v3/repos/${owner}/${rname}/git/commits/${commitSha}`, html_url: `https://github.com/${owner}/${rname}/commit/${commitSha}` } });
      return;
    }
    notFound(res);
    return;
  }
  // labels
  if (rest[0] === "labels" && method === "POST") {
    const name = str(body?.name);
    if (!name) { unprocessable(res, "name is required"); return; }
    if (r.labels.has(name)) { unprocessable(res, `Label '${name}' already exists`); return; }
    const l: Label = { id: ++r.labelSeq, name, color: str(body?.color) || "ededed", description: str(body?.description) };
    r.labels.set(name, l);
    sendJson(res, 201, labelJson(l));
    return;
  }
  // issues
  if (rest[0] === "issues") {
    if (rest.length === 1) {
      if (method === "GET") {
        const state = q.get("state") || "open";
        const page = num(q.get("page"), 1);
        const perPage = num(q.get("per_page"), 30);
        const direction = q.get("direction") || "desc";
        let list = [...r.issues.values()].sort((a, b) => direction === "asc" ? a.seq - b.seq : b.seq - a.seq);
        if (state !== "all") list = list.filter((i) => i.state === state);
        const total = list.length;
        const slice = list.slice((page - 1) * perPage, page * perPage);
        const link = linkHeader(`${origin}/api/v3/repos/${owner}/${rname}/issues?state=${state}`, page, perPage, total);
        sendJson(res, 200, slice.map((i) => issueObj(r, i)), link ? { link } : undefined);
        return;
      }
      if (method === "POST") {
        const title = str(body?.title);
        if (!title) { unprocessable(res, "title is required"); return; }
        const labels: string[] = Array.isArray(body?.labels) ? body.labels.map((x: unknown) => typeof x === "string" ? x : str((x as Record<string, unknown>)?.name)) : [];
        for (const n of labels) {
          if (!r.labels.has(n)) { unprocessable(res, `Label '${n}' does not exist`); return; }
        }
        const now = isoNow();
        const num_ = ++r.issueSeq;
        const issue: Issue = {
          id: ++globalSeq, number: num_, title, body: str(body?.body), state: "open",
          labels, comments: [], created_at: now, updated_at: now, closed_at: null,
          seq: ++globalSeq, jsonCache: "",
        };
        r.issues.set(num_, issue);
        refreshIssueCache(r, issue);
        sendJson(res, 201, issue.jsonCache);
        return;
      }
    }
    const n = parseInt(rest[1] ?? "", 10);
    const issue = Number.isFinite(n) ? r.issues.get(n) : undefined;
    if (!issue) { notFound(res); return; }
    if (rest.length === 2) {
      if (method === "GET") { sendJson(res, 200, issue.jsonCache); return; }
      if (method === "PATCH") {
        if (typeof body?.title === "string") issue.title = body.title;
        if (typeof body?.body === "string") issue.body = body.body;
        if (body?.state === "closed") { issue.state = "closed"; issue.closed_at = isoNow(); }
        else if (body?.state === "open") { issue.state = "open"; issue.closed_at = null; }
        issue.updated_at = isoNow();
        refreshIssueCache(r, issue);
        sendJson(res, 200, issue.jsonCache);
        return;
      }
    }
    if (rest.length === 3 && rest[2] === "comments") {
      if (method === "GET") {
        sendJson(res, 200, issue.comments.map((c) => commentJson(r, issue, c)));
        return;
      }
      if (method === "POST") {
        const cbody = str(body?.body);
        if (!cbody) { unprocessable(res, "body is required"); return; }
        const now = isoNow();
        const c: Comment = { id: ++globalSeq, body: cbody, user: VIEWER.login, created_at: now, updated_at: now };
        issue.comments.push(c);
        issue.updated_at = now;
        refreshIssueCache(r, issue);
        sendJson(res, 201, commentJson(r, issue, c));
        return;
      }
    }
    notFound(res);
    return;
  }
  // pulls
  if (rest[0] === "pulls") {
    if (rest.length === 1) {
      if (method === "GET") {
        const state = q.get("state") || "open";
        const page = num(q.get("page"), 1);
        const perPage = num(q.get("per_page"), 30);
        const direction = q.get("direction") || "desc";
        let list = [...r.pulls.values()].sort((a, b) => direction === "asc" ? a.seq - b.seq : b.seq - a.seq);
        if (state !== "all") list = list.filter((p) => p.state === state);
        const total = list.length;
        const slice = list.slice((page - 1) * perPage, page * perPage);
        const link = linkHeader(`${origin}/api/v3/repos/${owner}/${rname}/pulls?state=${state}`, page, perPage, total);
        sendJson(res, 200, slice.map((p) => prObj(r, p)), link ? { link } : undefined);
        return;
      }
      if (method === "POST") {
        const title = str(body?.title);
        const head = str(body?.head);
        const base = str(body?.base);
        if (!title || !head || !base) { unprocessable(res, "title, head and base are required"); return; }
        if (!r.refs.has(`refs/heads/${head}`)) { unprocessable(res, `Head branch '${head}' does not exist`); return; }
        if (!r.refs.has(`refs/heads/${base}`)) { unprocessable(res, `Base branch '${base}' does not exist`); return; }
        for (const p of r.pulls.values()) {
          if (p.state === "open" && p.head === head && p.base === base) {
            unprocessable(res, `A pull request already exists for ${head} -> ${base}`);
            return;
          }
        }
        const now = isoNow();
        const num_ = ++r.prSeq;
        const pr: PR = {
          id: ++globalSeq, number: num_, title, body: str(body?.body), state: "open",
          head, base, merged: false, merged_at: null, merge_commit_sha: null,
          created_at: now, updated_at: now, seq: ++globalSeq,
        };
        r.pulls.set(num_, pr);
        sendJson(res, 201, prObj(r, pr));
        return;
      }
    }
    const n = parseInt(rest[1] ?? "", 10);
    const pr = Number.isFinite(n) ? r.pulls.get(n) : undefined;
    if (!pr) { notFound(res); return; }
    if (rest.length === 2) {
      if (method === "GET") { sendJson(res, 200, prObj(r, pr)); return; }
      if (method === "PATCH") {
        if (typeof body?.title === "string") pr.title = body.title;
        if (typeof body?.body === "string") pr.body = body.body;
        if (body?.state === "closed") pr.state = "closed";
        else if (body?.state === "open") pr.state = "open";
        pr.updated_at = isoNow();
        sendJson(res, 200, prObj(r, pr));
        return;
      }
    }
    if (rest.length === 3 && rest[2] === "files" && method === "GET") {
      sendJson(res, 200, prFiles(r, pr));
      return;
    }
    if (rest.length === 3 && rest[2] === "merge" && method === "PUT") {
      if (pr.merged) { sendJson(res, 405, { message: "Pull Request is already merged" }); return; }
      if (pr.state !== "open") { sendJson(res, 405, { message: "Pull Request is not open" }); return; }
      const method_ = str(body?.merge_method) || "merge";
      const sha = doMerge(r, pr, method_);
      if (!sha) { sendJson(res, 405, { message: "Merge conflict" }); return; }
      pr.merged = true;
      pr.state = "closed";
      pr.merged_at = isoNow();
      pr.merge_commit_sha = sha;
      pr.updated_at = isoNow();
      sendJson(res, 200, { sha, merged: true, message: "Pull request successfully merged" });
      return;
    }
    notFound(res);
    return;
  }
  notFound(res);
}
function dirEntries(r: Repo, files: Map<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir ? `${dir}/` : "";
  const seen = new Map<string, { type: string; oid: string; size: number }>();
  for (const [p, f] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) seen.set(rest, { type: "file", oid: f.oid, size: r.objects.get(f.oid)?.data.length ?? 0 });
    else {
      const d = rest.slice(0, slash);
      if (!seen.has(d)) seen.set(d, { type: "dir", oid: "", size: 0 });
    }
  }
  return [...seen.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([name, e]) => {
    const path = dir ? `${dir}/${name}` : name;
    return {
      type: e.type, size: e.size, name, path, sha: e.oid,
      url: contentsUrl(r, path),
      git_url: `/api/v3/repos/${r.owner}/${r.name}/git/trees/${e.oid}`,
      html_url: `https://github.com/${r.owner}/${r.name}/tree/HEAD/${path}`,
      download_url: e.type === "file" ? contentsUrl(r, path) : null,
    };
  });
}
function prFiles(r: Repo, pr: PR): Record<string, unknown>[] {
  const headTip = r.refs.get(`refs/heads/${pr.head}`);
  const baseTip = r.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) return [];
  const mb = mergeBase(r, headTip, baseTip);
  const baseFiles = treeFiles(r, mb ?? undefined);
  const headFiles = treeFiles(r, headTip);
  const out: Record<string, unknown>[] = [];
  for (const p of diffFiles(baseFiles, headFiles)) {
    const oldF = baseFiles.get(p);
    const newF = headFiles.get(p);
    const oldData = oldF ? r.objects.get(oldF.oid)?.data : undefined;
    const newData = newF ? r.objects.get(newF.oid)?.data : undefined;
    const oldLines = oldData ? countLines(oldData) : 0;
    const newLines = newData ? countLines(newData) : 0;
    const status = !oldF ? "added" : !newF ? "removed" : "modified";
    const additions = status === "removed" ? 0 : newLines;
    const deletions = status === "added" ? 0 : oldLines;
    out.push({
      sha: newF?.oid ?? oldF?.oid ?? "", filename: p, status,
      additions, deletions, changes: additions + deletions,
      blob_url: `https://github.com/${r.owner}/${r.name}/blob/HEAD/${p}`,
      raw_url: contentsUrl(r, p), contents_url: contentsUrl(r, p), patch: "",
    });
  }
  return out.sort((a, b) => String(a.filename) < String(b.filename) ? -1 : 1);
}

// ------------------------------------------------------------------- git
interface RefEntry { name: string; oid: string; peeled?: string; }
function listRefs(r: Repo): RefEntry[] {
  const out: RefEntry[] = [];
  const headTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
  if (headTip) out.push({ name: "HEAD", oid: headTip });
  const names = [...r.refs.keys()].sort();
  for (const name of names) {
    const oid = r.refs.get(name)!;
    out.push({ name, oid });
    const obj = r.objects.get(oid);
    if (obj && obj.type === "tag") {
      const t = parseTag(obj.data);
      out.push({ name: `${name}^{}`, oid: t.object, peeled: name });
    }
  }
  return out;
}
const V0_UPLOAD_CAPS = "side-band-64k thin-pack ofs-delta shallow multi_ack agent=forge/1.0";
const V0_RECV_CAPS = "report-status side-band-64k delete-refs ofs-delta agent=forge/1.0";
function advertiseV0(r: Repo, service: "git-upload-pack" | "git-receive-pack"): Buffer {
  const cacheKey = service === "git-upload-pack" ? "up-v0" : "recv-v0";
  const cached = r.advCache.get(cacheKey);
  if (cached) return cached;
  const caps = service === "git-upload-pack" ? V0_UPLOAD_CAPS : V0_RECV_CAPS;
  const symref = r.refs.has(`refs/heads/${r.defaultBranch}`) ? ` symref=HEAD:refs/heads/${r.defaultBranch}` : "";
  const fullCaps = `${caps}${symref}`;
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = listRefs(r);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO} capabilities^{}\0${fullCaps}\n`);
  } else {
    refs.forEach((e, i) => {
      if (i === 0) lines.push(`${e.oid} ${e.name}\0${fullCaps}\n`);
      else lines.push(`${e.oid} ${e.name}\n`);
    });
  }
  for (const l of lines) chunks.push(pktLine(l));
  chunks.push(FLUSH);
  const buf = Buffer.concat(chunks);
  r.advCache.set(cacheKey, buf);
  return buf;
}
const V2_ADV = Buffer.concat([
  pktLine("version 2\n"),
  pktLine("ls-refs=unborn\n"),
  pktLine("fetch=shallow filter\n"),
  pktLine("object-format=sha1\n"),
  pktLine("agent=forge/1.0\n"),
  FLUSH,
]);
function sideband(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    const n = Math.min(65515, pack.length - off);
    const payload = Buffer.alloc(1 + n);
    payload[0] = 1;
    pack.copy(payload, 1, off, off + n);
    const len = (payload.length + 4).toString(16).padStart(4, "0");
    chunks.push(Buffer.from(len, "ascii"), payload);
    off += n;
  }
  return Buffer.concat(chunks);
}
function includeCommitTree(r: Repo, oid: string, out: Map<string, GitObj>): void {
  const c = r.objects.get(oid);
  if (!c) return;
  out.set(oid, c);
  if (c.type !== "commit") return;
  const commit = parseCommit(c.data);
  const walkTree = (treeOid: string): void => {
    const t = r.objects.get(treeOid);
    if (!t) return;
    out.set(treeOid, t);
    for (const e of parseTree(t.data)) {
      const child = r.objects.get(e.oid);
      if (!child) continue;
      if (e.mode === "40000") walkTree(e.oid);
      else out.set(e.oid, child);
    }
  };
  walkTree(commit.tree);
}
// Every object id reachable from the given tips (commits, trees, blobs, tags).
// Traversal stops at shallow commits: a shallow have's parents are NOT held.
function heldObjects(r: Repo, haves: string[], shallowIn: string[]): Set<string> {
  const shallowSet = new Set(shallowIn);
  const held = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (held.has(treeOid)) return;
    const t = r.objects.get(treeOid);
    if (!t || t.type !== "tree") return;
    held.add(treeOid);
    for (const e of parseTree(t.data)) {
      if (e.mode === "40000") walkTree(e.oid);
      else held.add(e.oid);
    }
  };
  const stack = [...haves];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = r.objects.get(oid);
    if (!o) continue;
    held.add(oid);
    if (o.type === "commit") {
      const c = parseCommit(o.data);
      walkTree(c.tree);
      if (!shallowSet.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (o.type === "tag") stack.push(parseTag(o.data).object);
  }
  return held;
}
interface FetchPlan { pack: Buffer; shallow: string[]; unshallow: string[]; }
function planFetch(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): FetchPlan {
  const haveSet = new Set(haves);
  const included = new Map<string, GitObj>();
  const gens = new Map<string, number>();
  const visited = new Set<string>();
  const queue: [string, number][] = [];
  for (const w of wants) {
    const obj = r.objects.get(w);
    if (obj?.type === "tag") {
      included.set(w, obj);
      const t = parseTag(obj.data);
      queue.push([t.object, 1]);
    } else queue.push([w, 1]);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const [oid, gen] = queue[qi];
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (depth !== null && gen > depth) continue;
    const isHave = haveSet.has(oid);
    if (isHave && gen > 1) continue;
    if (isHave && gen === 1 && depth === null) continue;
    if (!isHave) {
      gens.set(oid, gen);
      includeCommitTree(r, oid, included);
    }
    const c = getCommit(r, oid);
    if (c) for (const p of c.parents) queue.push([p, gen + 1]);
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of gens) {
      if (gen !== depth) continue;
      const c = getCommit(r, oid);
      if (c && c.parents.length) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const s of shallowIn) {
      const c = getCommit(r, s);
      if (c && c.parents.some((p) => gens.has(p))) unshallow.push(s);
    }
  }
  // Never re-send objects the client already holds (reachable from haves).
  if (haves.length) {
    const held = heldObjects(r, haves, shallowIn);
    for (const oid of held) included.delete(oid);
  }
  const objs = [...included.values()].map((o) => ({ oid: hashObj(o.type, o.data), type: o.type, data: o.data }));
  objs.sort((a, b) => a.oid < b.oid ? -1 : 1);
  return { pack: writePack(objs), shallow, unshallow };
}
function fetchV2Response(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): Buffer {
  const key = `v2|${wants.join(",")}|${haves.join(",")}|${shallowIn.join(",")}|${depth}`;
  const cached = r.packCache.get(key);
  if (cached) return cached;
  const plan = planFetch(r, wants, haves, shallowIn, depth);
  const chunks: Buffer[] = [
    pktLine("acknowledgments\n"), pktLine("NAK\n"), FLUSH,
  ];
  if (plan.shallow.length || plan.unshallow.length) {
    chunks.push(pktLine("shallow-info\n"));
    for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
    chunks.push(FLUSH);
  }
  chunks.push(pktLine("packfile\n"), sideband(plan.pack), FLUSH);
  const buf = Buffer.concat(chunks);
  r.packCache.set(key, buf);
  return buf;
}
function fetchV0Response(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): Buffer {
  const key = `v0|${wants.join(",")}|${haves.join(",")}|${shallowIn.join(",")}|${depth}`;
  const cached = r.packCache.get(key);
  if (cached) return cached;
  const plan = planFetch(r, wants, haves, shallowIn, depth);
  const chunks: Buffer[] = [pktLine("NAK\n")];
  for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
  chunks.push(sideband(plan.pack));
  const buf = Buffer.concat(chunks);
  r.packCache.set(key, buf);
  return buf;
}
function handleInfoRefs(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, r: Repo, service: string): void {
  if (service === "git-upload-pack") {
    const v2 = req.headers["git-protocol"] === "version=2";
    if (v2) {
      sendRaw(res, 200, V2_ADV, "application/x-git-upload-pack-advertisement");
      return;
    }
    sendRaw(res, 200, advertiseV0(r, "git-upload-pack"), "application/x-git-upload-pack-advertisement");
    return;
  }
  if (service === "git-receive-pack") {
    sendRaw(res, 200, advertiseV0(r, "git-receive-pack"), "application/x-git-receive-pack-advertisement");
    return;
  }
  res.writeHead(400, { "content-type": "text/plain" });
  res.end("service parameter required");
}
function handleLsRefs(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, r: Repo, body: Buffer): void {
  const { lines } = splitPack(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const l of lines) {
    if (l.delim) { inArgs = true; continue; }
    if (l.flush) break;
    if (!l.text) continue;
    if (!inArgs) continue; // command= / agent= / object-format= lines
    const t = l.text;
    if (t === "peel") peel = true;
    else if (t === "symrefs") symrefs = true;
    else if (t === "unborn") unborn = true;
    else if (t.startsWith("ref-prefix ")) prefixes.push(t.slice(11));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const refs = listRefs(r);
  const chunks: Buffer[] = [];
  const headTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
  if (!headTip && unborn && matches("HEAD")) {
    chunks.push(pktLine(`unborn HEAD symref-target:refs/heads/${r.defaultBranch}\n`));
  }
  for (const e of refs) {
    if (e.name === "HEAD") {
      if (symrefs && matches("HEAD")) chunks.push(pktLine(`${e.oid} HEAD symref-target:refs/heads/${r.defaultBranch}\n`));
      continue;
    }
    if (e.name.endsWith("^{}")) continue; // v0-style peel lines are not emitted in v2
    if (!matches(e.name)) continue;
    let line = `${e.oid} ${e.name}`;
    if (peel) {
      const obj = r.objects.get(e.oid);
      if (obj?.type === "tag") line += ` peeled:${parseTag(obj.data).object}`;
    }
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(chunks), "application/x-git-upload-pack-result");
}
function handleUploadPack(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, r: Repo, body: Buffer): void {
  const v2 = req.headers["git-protocol"] === "version=2";
  const { lines } = splitPack(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  let ok = false;
  for (const l of lines) {
    if (l.flush) break;
    if (l.delim) continue;
    if (!l.text) continue;
    const t = l.text;
    // v2 command line and v0/v2 capability lines carry no args; arg lines are
    // identical in both versions ("want ", "have ", "shallow ", "deepen ", "done").
    if (t.startsWith("command=fetch")) { ok = true; continue; }
    if (t.startsWith("want ")) wants.push(t.slice(5, 45));
    else if (t.startsWith("have ")) haves.push(t.slice(5, 45));
    else if (t.startsWith("shallow ")) shallowIn.push(t.slice(8));
    else if (t.startsWith("deepen ")) depth = parseInt(t.slice(7), 10);
    else if (t === "done") ok = true;
  }
  if (!ok || wants.length === 0) { res.writeHead(400); res.end("bad fetch request"); return; }
  const out = v2
    ? fetchV2Response(r, wants, haves, shallowIn, depth)
    : fetchV0Response(r, wants, haves, shallowIn, depth);
  sendRaw(res, 200, out, "application/x-git-upload-pack-result");
}
function handleReceivePack(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, r: Repo, body: Buffer): void {
  const { lines, packOff } = splitPack(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sidebandCap = false;
  let malformed = false;
  for (const l of lines) {
    if (l.flush) break;
    if (l.delim) continue;
    if (!l.text) continue;
    let t = l.text;
    const nul = t.indexOf("\0");
    if (nul >= 0) {
      const caps = t.slice(nul + 1);
      if (caps.includes("side-band-64k")) sidebandCap = true;
      t = t.slice(0, nul);
    }
    const parts = t.split(" ");
    if (parts.length < 3 || !/^[0-9a-f]{40}$/.test(parts[0]) || !/^[0-9a-f]{40}$/.test(parts[1])) { malformed = true; continue; }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const report: string[] = [];
  let unpackOk = true;
  let unpackErr = "";
  let packObjects = new Map<string, GitObj>();
  if (packOff < body.length) {
    try {
      packObjects = readPack(body.subarray(packOff)).objects;
    } catch (e) {
      unpackOk = false;
      unpackErr = e instanceof Error ? e.message : "unpack failed";
    }
  }
  if (!unpackOk) {
    report.push(`unpack ${unpackErr}`);
    for (const c of commands) report.push(`ng ${c.ref} unpack error`);
  } else {
    for (const [, o] of packObjects) {
      const oid = hashObj(o.type, o.data);
      if (!r.objects.has(oid)) r.objects.set(oid, o);
    }
    report.push("unpack ok");
    for (const c of commands) {
      const current = r.refs.get(c.ref);
      let reason = "";
      if (c.newOid === ZERO) {
        if (!current) reason = "ref does not exist";
        else if (c.oldOid !== ZERO && c.oldOid !== current) reason = "non-fast-forward";
      } else if (c.oldOid === ZERO) {
        if (current) reason = "already exists";
        else if (!r.objects.has(c.newOid)) reason = "object not found";
      } else {
        if (!current) reason = "non-fast-forward";
        else if (c.oldOid !== current) reason = "non-fast-forward";
        else if (!r.objects.has(c.newOid)) reason = "object not found";
        else if (!isAncestor(r, current, c.newOid)) reason = "non-fast-forward";
      }
      if (reason) { report.push(`ng ${c.ref} ${reason}`); continue; }
      if (c.newOid === ZERO) r.refs.delete(c.ref);
      else r.refs.set(c.ref, c.newOid);
      bump(r);
      report.push(`ok ${c.ref}`);
    }
  }
  void malformed;
  const text = report.map((l) => `${l}\n`).join("");
  let out: Buffer;
  if (sidebandCap) {
    const payload = Buffer.concat([Buffer.from([1]), Buffer.from(text, "utf8")]);
    const len = (payload.length + 4).toString(16).padStart(4, "0");
    out = Buffer.concat([Buffer.from(len, "ascii"), payload, FLUSH]);
  } else {
    const chunks = report.map((l) => pktLine(`${l}\n`));
    chunks.push(FLUSH);
    out = Buffer.concat(chunks);
  }
  sendRaw(res, 200, out, "application/x-git-receive-pack-result");
}

// ------------------------------------------------------------------- graphql
type GVal = string | number | boolean | null | { v: string } | { e: string } | GVal[] | { [k: string]: GVal };
interface GField { alias: string | null; name: string; args: Record<string, GVal>; sel: GField[] | null; frag: string | null; }
interface GOp { name: string | null; vars: Record<string, GVal>; sel: GField[]; isMutation: boolean; }
class GQLError extends Error {}
function gqlTokenize(src: string): (string | { s: string } | { n: number })[] {
  const toks: (string | { s: string } | { n: number })[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s|,/.test(ch)) { i++; continue; }
    if (ch === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if ("{}():!=$@[]".includes(ch)) { toks.push(ch); i++; continue; }
    if (src.startsWith("...", i)) { toks.push("..."); i += 3; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") { j++; const e = src[j]; out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e; j++; }
        else { out += src[j]; j++; }
      }
      toks.push({ s: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (m) { toks.push({ n: parseFloat(m[0]) }); i += m[0].length; continue; }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (m) { toks.push(m[0]); i += m[0].length; continue; }
    }
    throw new GQLError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return toks;
}
class GParser {
  private i = 0;
  private toks: (string | { s: string } | { n: number })[];
  constructor(toks: (string | { s: string } | { n: number })[]) { this.toks = toks; }
  private peek(): unknown { return this.toks[this.i]; }
  private next(): unknown { return this.toks[this.i++]; }
  private expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new GQLError(`expected ${t}, got ${JSON.stringify(got)}`);
  }
  private is(t: string): boolean { return this.peek() === t; }
  private nameTok(): string {
    const t = this.next();
    if (typeof t !== "string") throw new GQLError("expected name");
    return t;
  }
  parseDocument(): GOp[] {
    const ops: GOp[] = [];
    while (this.i < this.toks.length) {
      if (this.is("{")) { ops.push({ name: null, vars: {}, sel: this.parseSel(), isMutation: false }); continue; }
      const kw = this.nameTok();
      if (kw === "fragment") {
        // Named fragment definition: skip it (checks use inline fragments).
        this.nameTok();
        this.expect("on");
        this.nameTok();
        this.parseSel();
        continue;
      }
      if (kw !== "query" && kw !== "mutation" && kw !== "subscription") throw new GQLError(`unexpected ${kw}`);
      let name: string | null = null;
      if (typeof this.peek() === "string" && this.peek() !== "(" && this.peek() !== "{") name = this.nameTok();
      const vars: Record<string, GVal> = {};
      if (this.is("(")) {
        this.next();
        while (!this.is(")")) {
          this.expect("$");
          const vn = this.nameTok();
          this.expect(":");
          // type: skip tokens until = or , or )
          let depth = 0;
          while (this.i < this.toks.length) {
            const t = this.peek();
            if (t === "[") depth++;
            if (t === "]") depth--;
            if (depth === 0 && (t === "=" || t === ")" || t === ",")) break;
            this.next();
          }
          if (this.is("=")) { this.next(); vars[vn] = this.parseValue(); }
          else vars[vn] = null;
          if (this.is(",")) this.next();
        }
        this.expect(")");
      }
      ops.push({ name, vars, sel: this.parseSel(), isMutation: kw === "mutation" });
    }
    return ops;
  }
  private parseSel(): GField[] {
    this.expect("{");
    const fields: GField[] = [];
    while (!this.is("}")) {
      if (this.is("...")) {
        this.next();
        let frag: string | null = null;
        if (this.is("on")) { this.next(); frag = this.nameTok(); }
        else this.nameTok(); // named spread — type unknown, include all
        const sel = this.parseSel();
        fields.push({ alias: null, name: "__fragment", args: {}, sel, frag });
        continue;
      }
      const first = this.nameTok();
      let alias: string | null = null;
      let name = first;
      if (this.is(":")) { this.next(); alias = first; name = this.nameTok(); }
      const args: Record<string, GVal> = {};
      if (this.is("(")) {
        this.next();
        while (!this.is(")")) {
          const an = this.nameTok();
          this.expect(":");
          args[an] = this.parseValue();
          if (this.is(",")) this.next();
        }
        this.expect(")");
      }
      // directives: @foo(...) — skip
      while (this.is("@")) {
        this.next();
        this.nameTok();
        if (this.is("(")) {
          this.next();
          let d = 1;
          while (d > 0) { const t = this.next(); if (t === "(") d++; else if (t === ")") d--; }
        }
      }
      let sel: GField[] | null = null;
      if (this.is("{")) sel = this.parseSel();
      fields.push({ alias, name, args, sel, frag: null });
    }
    this.expect("}");
    return fields;
  }
  private parseValue(): GVal {
    const t = this.next();
    if (t === "$") return { v: this.nameTok() };
    if (t === "[") {
      const arr: GVal[] = [];
      while (!this.is("]")) { arr.push(this.parseValue()); if (this.is(",")) this.next(); }
      this.expect("]");
      return arr;
    }
    if (t === "{") {
      const obj: { [k: string]: GVal } = {};
      while (!this.is("}")) {
        const k = this.nameTok();
        this.expect(":");
        obj[k] = this.parseValue();
        if (this.is(",")) this.next();
      }
      this.expect("}");
      return obj;
    }
    if (typeof t === "object") {
      if ("s" in t) return t.s;
      return t.n;
    }
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (typeof t === "string") return { e: t };
    throw new GQLError("bad value");
  }
}
function resolveVars(v: GVal, vars: Record<string, GVal>): unknown {
  if (v && typeof v === "object" && "v" in v) return vars[(v as { v: string }).v] ?? null;
  if (v && typeof v === "object" && "e" in v) return (v as { e: string }).e;
  if (Array.isArray(v)) return v.map((x) => resolveVars(x, vars));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = resolveVars(x, vars);
    return o;
  }
  return v;
}
// Value objects carry a __type tag for field resolution.
type GObj = Record<string, unknown> & { __type: string };
function userObj(): GObj {
  return { __type: "User", login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, avatarUrl: "" };
}
function repoObj(r: Repo): GObj {
  return { __type: "Repository", __repo: r, id: gid("repo", String(r.id)), databaseId: r.id, name: r.name, nameWithOwner: `${r.owner}/${r.name}`, owner: userObj(), defaultBranchRef: { __type: "Ref", name: r.defaultBranch }, viewerPermission: "ADMIN", hasIssuesEnabled: true };
}
function issueObjG(r: Repo, i: Issue): GObj {
  return { __type: "Issue", __repo: r, __issue: i, id: gid("issue", `${r.id}:${i.number}`), number: i.number, title: i.title, body: i.body, state: i.state.toUpperCase(), createdAt: i.created_at, updatedAt: i.updated_at, author: userObj() };
}
function prObjG(r: Repo, p: PR): GObj {
  return { __type: "PullRequest", __repo: r, __pr: p, id: gid("pr", `${r.id}:${p.number}`), number: p.number, title: p.title, body: p.body, state: p.state.toUpperCase(), merged: p.merged, mergedAt: p.merged_at, mergeCommitSha: p.merge_commit_sha, headRefName: p.head, baseRefName: p.base, headRef: { __type: "Ref", name: p.head }, baseRef: { __type: "Ref", name: p.base }, author: userObj() };
}
function commentObjG(r: Repo, i: Issue, c: Comment): GObj {
  return { __type: "IssueComment", __repo: r, __issue: i, __comment: c, id: gid("comment", `${r.id}:${i.number}:${c.id}`), body: c.body, createdAt: c.created_at, author: userObj() };
}
function cursorFor(kind: string, key: string): string {
  return Buffer.from(`cursor:${kind}:${key}`).toString("base64");
}
function conn<T>(nodes: T[], first: number | null, after: string | null, keyOf: (t: T) => string, kind: string): Record<string, unknown> {
  let start = 0;
  if (after) {
    const dec = Buffer.from(after, "base64").toString("utf8");
    const idx = nodes.findIndex((n) => cursorFor(kind, keyOf(n)) === after || keyOf(n) === dec.split(":").pop());
    if (idx >= 0) start = idx + 1;
  }
  const page = first !== null ? nodes.slice(start, start + first) : nodes.slice(start);
  const hasNext = start + page.length < nodes.length;
  return {
    nodes: page,
    edges: page.map((n) => ({ node: n, cursor: cursorFor(kind, keyOf(n)) })),
    pageInfo: { hasNextPage: hasNext, hasPreviousPage: start > 0, startCursor: page.length ? cursorFor(kind, keyOf(page[0])) : null, endCursor: page.length ? cursorFor(kind, keyOf(page[page.length - 1])) : null },
    totalCount: nodes.length,
  };
}
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ["viewer", "repository", "node", "__type", "__schema"],
  Repository: ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "url", "createdAt", "issue", "issues", "pullRequest", "pullRequests"],
  Issue: ["id", "number", "title", "body", "state", "createdAt", "updatedAt", "author", "labels", "comments", "url"],
  PullRequest: ["id", "number", "title", "body", "state", "merged", "mergedAt", "mergeCommitSha", "headRefName", "baseRefName", "mergeable", "files", "headRef", "baseRef", "author", "url"],
  User: ["login", "id", "name", "email", "avatarUrl"],
  Ref: ["name", "target"],
  IssueConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  PullRequestConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  IssueEdge: ["node", "cursor"],
  PullRequestEdge: ["node", "cursor"],
  PageInfo: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
  IssueComment: ["id", "body", "author", "createdAt"],
  IssueCommentConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  PullRequestChangedFileConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  ChangedFile: ["path", "additions", "deletions", "changeType"],
  LabelConnection: ["nodes", "totalCount"],
  Label: ["id", "name", "color", "description"],
  Mutation: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
  __Type: ["name", "kind", "description", "fields", "enumValues", "inputFields", "ofType"],
  __Field: ["name", "description", "type", "args"],
  __InputValue: ["name", "description", "type"],
  __EnumValue: ["name", "description"],
};
function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const dec = Buffer.from(id, "base64").toString("utf8");
    const i = dec.indexOf(":");
    if (i < 0) return null;
    return { kind: dec.slice(0, i), key: dec.slice(i + 1) };
  } catch { return null; }
}
function findRepoById(id: number): Repo | undefined { return reposById.get(id); }
function resolveRootField(f: GField, vars: Record<string, GVal>): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.args)) args[k] = resolveVars(v, vars);
  if (f.name === "viewer") return userObj();
  if (f.name === "repository") {
    const r = getRepo(String(args.owner ?? ""), String(args.name ?? ""));
    return r ? repoObj(r) : null;
  }
  if (f.name === "node") {
    const d = decodeGid(String(args.id ?? ""));
    if (!d) return null;
    if (d.kind === "repo") {
      const r = findRepoById(parseInt(d.key, 10));
      return r ? repoObj(r) : null;
    }
    if (d.kind === "issue") {
      const [rid, num] = d.key.split(":");
      const r = findRepoById(parseInt(rid, 10));
      const i = r?.issues.get(parseInt(num, 10));
      return r && i ? issueObjG(r, i) : null;
    }
    if (d.kind === "pr") {
      const [rid, num] = d.key.split(":");
      const r = findRepoById(parseInt(rid, 10));
      const p = r?.pulls.get(parseInt(num, 10));
      return r && p ? prObjG(r, p) : null;
    }
    if (d.kind === "comment") {
      const [rid, inum, cid] = d.key.split(":");
      const r = findRepoById(parseInt(rid, 10));
      const i = r?.issues.get(parseInt(inum, 10));
      const c = i?.comments.find((x) => x.id === parseInt(cid, 10));
      return r && i && c ? commentObjG(r, i, c) : null;
    }
    return null;
  }
  if (f.name === "__type") {
    const name = String(args.name ?? "");
    if (name === "SearchType") {
      return { __type: "__Type", name, kind: "ENUM", description: null, fields: null, enumValues: ["ISSUE", "PULL_REQUEST", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "CODE", "MILESTONE"].map((n) => ({ __type: "__EnumValue", name: n, description: null })), inputFields: null, ofType: null };
    }
    const fields = TYPE_FIELDS[name] ?? [];
    return { __type: "__Type", name, kind: "OBJECT", description: null, fields: fields.map((n) => ({ __type: "__Field", name: n, description: null, type: { __type: "__Type", name: "String", kind: "SCALAR" }, args: [] })), enumValues: null, inputFields: null, ofType: null };
  }
  if (f.name === "__schema") {
    return { __type: "__Schema", queryType: { __type: "__Type", name: "Query" }, mutationType: { __type: "__Type", name: "Mutation" }, types: Object.keys(TYPE_FIELDS).map((n) => ({ __type: "__Type", name: n })) };
  }
  throw new GQLError(`Cannot query field "${f.name}" on type "Query".`);
}
function resolveMutation(f: GField, vars: Record<string, GVal>): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.args)) args[k] = resolveVars(v, vars);
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (f.name === "createIssue") {
    const d = decodeGid(String(input.repositoryId ?? ""));
    const r = d && d.kind === "repo" ? findRepoById(parseInt(d.key, 10)) : undefined;
    if (!r) throw new GQLError("repository not found");
    const now = isoNow();
    const num_ = ++r.issueSeq;
    const issue: Issue = { id: ++globalSeq, number: num_, title: String(input.title ?? ""), body: String(input.body ?? ""), state: "open", labels: [], comments: [], created_at: now, updated_at: now, closed_at: null, seq: ++globalSeq, jsonCache: "" };
    r.issues.set(num_, issue);
    refreshIssueCache(r, issue);
    return { __type: "CreateIssuePayload", issue: issueObjG(r, issue), clientMutationId: null };
  }
  if (f.name === "closeIssue") {
    const d = decodeGid(String(input.issueId ?? ""));
    if (!d || d.kind !== "issue") throw new GQLError("issue not found");
    const [rid, num] = d.key.split(":");
    const r = findRepoById(parseInt(rid, 10));
    const i = r?.issues.get(parseInt(num, 10));
    if (!r || !i) throw new GQLError("issue not found");
    i.state = "closed";
    i.closed_at = isoNow();
    i.updated_at = isoNow();
    refreshIssueCache(r, i);
    return { __type: "CloseIssuePayload", issue: issueObjG(r, i), clientMutationId: null };
  }
  if (f.name === "createPullRequest") {
    const d = decodeGid(String(input.repositoryId ?? ""));
    const r = d && d.kind === "repo" ? findRepoById(parseInt(d.key, 10)) : undefined;
    if (!r) throw new GQLError("repository not found");
    const head = String(input.headRefName ?? "");
    const base = String(input.baseRefName ?? "");
    if (!r.refs.has(`refs/heads/${head}`) || !r.refs.has(`refs/heads/${base}`)) throw new GQLError("head or base branch not found");
    const now = isoNow();
    const num_ = ++r.prSeq;
    const pr: PR = { id: ++globalSeq, number: num_, title: String(input.title ?? ""), body: String(input.body ?? ""), state: "open", head, base, merged: false, merged_at: null, merge_commit_sha: null, created_at: now, updated_at: now, seq: ++globalSeq };
    r.pulls.set(num_, pr);
    return { __type: "CreatePullRequestPayload", pullRequest: prObjG(r, pr), clientMutationId: null };
  }
  if (f.name === "mergePullRequest") {
    const d = decodeGid(String(input.pullRequestId ?? ""));
    if (!d || d.kind !== "pr") throw new GQLError("pull request not found");
    const [rid, num] = d.key.split(":");
    const r = findRepoById(parseInt(rid, 10));
    const p = r?.pulls.get(parseInt(num, 10));
    if (!r || !p) throw new GQLError("pull request not found");
    const method = String(input.mergeMethod ?? "SQUASH").toLowerCase();
    const sha = doMerge(r, p, method === "squash" ? "squash" : method);
    if (!sha) throw new GQLError("merge conflict");
    p.merged = true;
    p.state = "closed";
    p.merged_at = isoNow();
    p.merge_commit_sha = sha;
    p.updated_at = isoNow();
    return { __type: "MergePullRequestPayload", pullRequest: prObjG(r, p), clientMutationId: null };
  }
  if (f.name === "addComment") {
    const d = decodeGid(String(input.subjectId ?? ""));
    if (!d || (d.kind !== "issue" && d.kind !== "pr")) throw new GQLError("subject not found");
    const [rid, num] = d.key.split(":");
    const r = findRepoById(parseInt(rid, 10));
    if (!r) throw new GQLError("subject not found");
    // Comments live on issues; a PR subject maps to its issue twin by number.
    let issue = r.issues.get(parseInt(num, 10));
    if (!issue && d.kind === "pr") {
      const p = r.pulls.get(parseInt(num, 10));
      if (!p) throw new GQLError("subject not found");
      const now = isoNow();
      issue = { id: ++globalSeq, number: p.number, title: p.title, body: p.body, state: p.state === "open" ? "open" : "closed", labels: [], comments: [], created_at: now, updated_at: now, closed_at: null, seq: ++globalSeq, jsonCache: "" };
      r.issues.set(p.number, issue);
      refreshIssueCache(r, issue);
    }
    if (!issue) throw new GQLError("subject not found");
    const now = isoNow();
    const c: Comment = { id: ++globalSeq, body: String(input.body ?? ""), user: VIEWER.login, created_at: now, updated_at: now };
    issue.comments.push(c);
    issue.updated_at = now;
    refreshIssueCache(r, issue);
    const cg = commentObjG(r, issue, c);
    return { __type: "AddCommentPayload", commentEdge: { __type: "IssueCommentEdge", node: cg, cursor: cursorFor("comment", `${r.id}:${issue.number}:${c.id}`) }, comment: cg, clientMutationId: null };
  }
  throw new GQLError(`Cannot query field "${f.name}" on type "Mutation".`);
}
function resolveField(obj: GObj, f: GField, vars: Record<string, GVal>): unknown {
  const type = obj.__type;
  const allowed = TYPE_FIELDS[type];
  if (allowed && !allowed.includes(f.name) && !f.name.startsWith("__")) {
    throw new GQLError(`Cannot query field "${f.name}" on type "${type}".`);
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.args)) args[k] = resolveVars(v, vars);
  if (type === "Repository") {
    const r = obj.__repo as Repo;
    if (f.name === "issue") {
      const i = r.issues.get(Number(args.number));
      return i ? issueObjG(r, i) : null;
    }
    if (f.name === "issues") {
      let list = [...r.issues.values()].sort((a, b) => b.seq - a.seq);
      if (Array.isArray(args.states)) {
        const want = new Set((args.states as unknown[]).map((s) => String(s).toLowerCase()));
        list = list.filter((i) => want.has(i.state));
      }
      if (args.orderBy && typeof args.orderBy === "object") {
        const ob = args.orderBy as Record<string, unknown>;
        if (String(ob.direction ?? "DESC") === "DESC") list.sort((a, b) => b.seq - a.seq);
        else list.sort((a, b) => a.seq - b.seq);
      }
      const first = typeof args.first === "number" ? args.first : null;
      return { __type: "IssueConnection", ...conn(list.map((i) => issueObjG(r, i)), first, typeof args.after === "string" ? args.after : null, (g) => String((g as GObj).__issue ? (g as unknown as { __issue: Issue }).__issue.number : ""), "issue") };
    }
    if (f.name === "pullRequest") {
      const p = r.pulls.get(Number(args.number));
      return p ? prObjG(r, p) : null;
    }
    if (f.name === "pullRequests") {
      const list = [...r.pulls.values()].sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === "number" ? args.first : null;
      return { __type: "PullRequestConnection", ...conn(list.map((p) => prObjG(r, p)), first, typeof args.after === "string" ? args.after : null, (g) => String((g as unknown as { __pr: PR }).__pr.number), "pr") };
    }
    return obj[f.name] ?? null;
  }
  if (type === "Issue") {
    const r = obj.__repo as Repo;
    const i = obj.__issue as Issue;
    if (f.name === "labels") {
      const nodes = i.labels.map((n) => ({ __type: "Label", ...r.labels.get(n)! }));
      return { __type: "LabelConnection", nodes, totalCount: nodes.length };
    }
    if (f.name === "comments") {
      const first = typeof args.first === "number" ? args.first : null;
      return { __type: "IssueCommentConnection", ...conn(i.comments.map((c) => commentObjG(r, i, c)), first, typeof args.after === "string" ? args.after : null, (g) => String((g as unknown as { __comment: Comment }).__comment.id), "comment") };
    }
    return obj[f.name] ?? null;
  }
  if (type === "PullRequest") {
    const r = obj.__repo as Repo;
    const p = obj.__pr as PR;
    if (f.name === "mergeable") return mergeableState(r, p);
    if (f.name === "files") {
      const files = prFiles(r, p);
      const nodes = files.map((x) => ({ __type: "ChangedFile", path: x.filename, additions: x.additions, deletions: x.deletions, changeType: String(x.status).toUpperCase() }));
      const first = typeof args.first === "number" ? args.first : null;
      return { __type: "PullRequestChangedFileConnection", ...conn(nodes, first, typeof args.after === "string" ? args.after : null, (g) => String((g as { path: unknown }).path), "file") };
    }
    return obj[f.name] ?? null;
  }
  if (type === "__Type") {
    if (f.name === "fields") {
      const fields = obj.fields as unknown[] | null;
      return fields ?? null;
    }
    if (f.name === "enumValues") return obj.enumValues ?? null;
    return obj[f.name] ?? null;
  }
  return obj[f.name] ?? null;
}
function project(obj: unknown, sel: GField[], vars: Record<string, GVal>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || obj === undefined) return out;
  const g = obj as GObj;
  for (const f of sel) {
    if (f.name === "__fragment") {
      if (f.frag && g.__type !== f.frag) continue;
      Object.assign(out, project(obj, f.sel ?? [], vars));
      continue;
    }
    const key = f.alias ?? f.name;
    const val = resolveField(g, f, vars);
    if (f.sel && val !== null && val !== undefined) {
      if (Array.isArray(val)) out[key] = val.map((v) => project(v, f.sel!, vars));
      else out[key] = project(val, f.sel!, vars);
    } else out[key] = val;
  }
  return out;
}
function executeGraphQL(doc: unknown, operationName: string | undefined, variables: Record<string, GVal>): Record<string, unknown> {
  let ops: GOp[];
  try {
    ops = new GParser(gqlTokenize(String((doc as { query: string }).query ?? ""))).parseDocument();
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : "parse error" }] };
  }
  const op = operationName ? ops.find((o) => o.name === operationName) : ops[0];
  if (!op) return { errors: [{ message: `unknown operation ${operationName}` }] };
  const vars = { ...op.vars, ...variables };
  try {
    const data: Record<string, unknown> = {};
    for (const f of op.sel) {
      const key = f.alias ?? f.name;
      const val = op.isMutation ? resolveMutation(f, vars) : resolveRootField(f, vars);
      if (f.sel && val !== null && val !== undefined) {
        if (Array.isArray(val)) data[key] = val.map((v) => project(v, f.sel!, vars));
        else data[key] = project(val, f.sel!, vars);
      } else data[key] = val;
    }
    return { data };
  } catch (e) {
    if (e instanceof GQLError) return { data: null, errors: [{ message: e.message }] };
    throw e;
  }
}

// ------------------------------------------------------------------- mcp
const MCP_TOOLS: Record<string, unknown>[] = [
  { name: "create_repo", description: "Create a new repository owned by the viewer.", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" } }, required: ["name"] } },
  { name: "get_repo", description: "Get a repository by owner and name.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
  { name: "create_issue", description: "Create an issue in a repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } },
  { name: "list_issues", description: "List issues in a repository, optionally filtered by state.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] } },
  { name: "create_pull_request", description: "Create a pull request in a repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, head: { type: "string" }, base: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title", "head", "base"] } },
  { name: "merge_pull_request", description: "Merge a pull request in a repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" } }, required: ["owner", "repo", "pull_number"] } },
];
function mcpToolResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj };
}
function mcpErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}
function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = (req: string[]): string | null => {
    for (const k of req) if (args[k] === undefined || args[k] === null || args[k] === "") return k;
    return null;
  };
  if (name === "create_repo") {
    const m = missing(["name"]);
    if (m) return mcpErrorResult(`missing required argument: ${m}`);
    const nm = String(args.name);
    if (getRepo(VIEWER.login, nm)) return mcpErrorResult(`Repository ${VIEWER.login}/${nm} already exists`);
    const r = createRepo(VIEWER.login, nm, args.private === true, String(args.description ?? ""));
    return mcpToolResult({ ...repoJson(r), full_name: `${r.owner}/${r.name}` });
  }
  if (name === "get_repo") {
    const m = missing(["owner", "repo"]);
    if (m) return mcpErrorResult(`missing required argument: ${m}`);
    const r = getRepo(String(args.owner), String(args.repo));
    if (!r) return mcpErrorResult(`Repository ${args.owner}/${args.repo} not found`);
    return mcpToolResult(repoJson(r));
  }
  if (name === "create_issue") {
    const m = missing(["owner", "repo", "title"]);
    if (m) return mcpErrorResult(`missing required argument: ${m}`);
    const r = getRepo(String(args.owner), String(args.repo));
    if (!r) return mcpErrorResult(`Repository ${args.owner}/${args.repo} not found`);
    const now = isoNow();
    const num_ = ++r.issueSeq;
    const issue: Issue = { id: ++globalSeq, number: num_, title: String(args.title), body: String(args.body ?? ""), state: "open", labels: [], comments: [], created_at: now, updated_at: now, closed_at: null, seq: ++globalSeq, jsonCache: "" };
    r.issues.set(num_, issue);
    refreshIssueCache(r, issue);
    return mcpToolResult(issueObj(r, issue));
  }
  if (name === "list_issues") {
    const m = missing(["owner", "repo"]);
    if (m) return mcpErrorResult(`missing required argument: ${m}`);
    const r = getRepo(String(args.owner), String(args.repo));
    if (!r) return mcpErrorResult(`Repository ${args.owner}/${args.repo} not found`);
    const state = String(args.state ?? "open");
    let list = [...r.issues.values()].sort((a, b) => b.seq - a.seq);
    if (state !== "all") list = list.filter((i) => i.state === state);
    return mcpToolResult(list.map((i) => issueObj(r, i)));
  }
  if (name === "create_pull_request") {
    const m = missing(["owner", "repo", "title", "head", "base"]);
    if (m) return mcpErrorResult(`missing required argument: ${m}`);
    const r = getRepo(String(args.owner), String(args.repo));
    if (!r) return mcpErrorResult(`Repository ${args.owner}/${args.repo} not found`);
    const head = String(args.head);
    const base = String(args.base);
    if (!r.refs.has(`refs/heads/${head}`)) return mcpErrorResult(`Head branch '${head}' does not exist`);
    if (!r.refs.has(`refs/heads/${base}`)) return mcpErrorResult(`Base branch '${base}' does not exist`);
    const now = isoNow();
    const num_ = ++r.prSeq;
    const pr: PR = { id: ++globalSeq, number: num_, title: String(args.title), body: String(args.body ?? ""), state: "open", head, base, merged: false, merged_at: null, merge_commit_sha: null, created_at: now, updated_at: now, seq: ++globalSeq };
    r.pulls.set(num_, pr);
    return mcpToolResult(prObj(r, pr));
  }
  if (name === "merge_pull_request") {
    const m = missing(["owner", "repo", "pull_number"]);
    if (m) return mcpErrorResult(`missing required argument: ${m}`);
    const r = getRepo(String(args.owner), String(args.repo));
    if (!r) return mcpErrorResult(`Repository ${args.owner}/${args.repo} not found`);
    const pr = r.pulls.get(Number(args.pull_number));
    if (!pr) return mcpErrorResult(`Pull request #${args.pull_number} not found`);
    if (pr.merged) return mcpErrorResult("Pull request is already merged");
    const sha = doMerge(r, pr, "merge");
    if (!sha) return mcpErrorResult("Merge conflict");
    pr.merged = true;
    pr.state = "closed";
    pr.merged_at = isoNow();
    pr.merge_commit_sha = sha;
    pr.updated_at = isoNow();
    return mcpToolResult({ sha, merged: true, message: "Pull request successfully merged" });
  }
  return mcpErrorResult(`unknown tool: ${name}`);
}
function handleMcp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, raw: Buffer, expected: string | undefined): void {
  if (!authOk(req, expected)) { unauth(res); return; }
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    sendJson(res, 400, { jsonrpc: "2.0", id: (msg as { id?: unknown } | null)?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  const id = "id" in msg ? msg.id : null;
  const isNotification = id === undefined || id === null;
  if (isNotification) {
    // notifications/initialized etc: acknowledge with 202, no body needed.
    res.writeHead(202, { "content-type": "application/json", "x-github-request-id": `req-${++reqCounter}` });
    res.end("{}");
    return;
  }
  const method = msg.method as string;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const result = (r: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id, result: r });
  const err = (code: number, message: string) => sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
  if (method === "server/discover") {
    const serverInfo = { name: "github-core-clone", version: "1.0.0" };
    result({
      supportedVersions: ["2026-07-28", "2025-11-25"],
      capabilities: { tools: {}, logging: {}, prompts: {}, resources: {} },
      serverInfo,
      instructions: "A GitHub-compatible git forge. Use the six tools to manage repositories, issues and pull requests.",
      _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
    });
    return;
  }
  if (method === "initialize") {
    const offered = String((params.protocolVersion as string) ?? "2025-11-25");
    result({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: "github-core-clone", version: "1.0.0" },
    });
    return;
  }
  if (method === "ping") { result({}); return; }
  if (method === "tools/list") {
    result({ tools: MCP_TOOLS });
    return;
  }
  if (method === "tools/call") {
    const toolName = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!MCP_TOOLS.some((t) => t.name === toolName)) { err(-32601, `Method not found: ${toolName}`); return; }
    try {
      result(callMcpTool(toolName, args));
    } catch (e) {
      err(-32602, e instanceof Error ? e.message : "tool call failed");
    }
    return;
  }
  err(-32601, `Method not found: ${method}`);
}

// ------------------------------------------------------------------- dispatch
function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 64 * 1024 * 1024) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
export function createApp(shopToken?: string) {
  const expected = shopToken;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const q = url.searchParams;
      const method = req.method ?? "GET";
      // GET /healthz — no auth, no body.
      if (path === "/healthz" && method === "GET") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      const isGit = /\.git\//.test(path) || path.endsWith(".git");
      const needsBody = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
      const raw = needsBody ? await readBody(req) : Buffer.alloc(0);
      if (path === "/api/graphql" && method === "POST") {
        if (!authOk(req, expected)) { unauth(res); return; }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { errors: [{ message: "Problems parsing JSON" }] });
          return;
        }
        const docs = Array.isArray(payload) ? payload : [payload];
        const results = docs.map((d) => {
          const doc = d as { query?: string; operationName?: string; variables?: Record<string, GVal> };
          return executeGraphQL(doc, doc.operationName, doc.variables ?? {});
        });
        sendJson(res, 200, Array.isArray(payload) ? results : results[0]);
        return;
      }
      if (path === "/mcp" && method === "POST") {
        handleMcp(req, res, raw, expected);
        return;
      }
      if (path.startsWith("/api/v3")) {
        let body: Body = null;
        if (raw.length) {
          try {
            body = JSON.parse(raw.toString("utf8")) as Body;
          } catch {
            badJson(res);
            return;
          }
        }
        const seg = path.slice("/api/v3".length).split("/").filter((s) => s !== "");
        handleRest(req, res, body, seg, q, method, expected);
        return;
      }
      // Git smart HTTP: /{owner}/{repo}.git/...
      const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (m) {
        const owner = decodeURIComponent(m[1]);
        const repoName = decodeURIComponent(m[2]);
        const action = m[3];
        const r = getRepo(owner, repoName);
        if (action === "info/refs") {
          // info/refs is unauthenticated for advertisement reads in the suite.
          if (!r) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not Found"); return; }
          handleInfoRefs(req, res, r, String(q.get("service") ?? ""));
          return;
        }
        if (!authOk(req, expected)) { unauth(res); return; }
        if (!r) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not Found"); return; }
        if (action === "git-upload-pack") {
          if (req.headers["git-protocol"] === "version=2" && raw.length === 0) {
            // ls-refs uses the upload-pack endpoint with an empty-body POST? No —
            // ls-refs is a distinct command in the body; empty body means bad request.
            res.writeHead(400); res.end("bad request"); return;
          }
          // Distinguish ls-refs (v2) from fetch by the command line.
          const { lines } = splitPack(raw);
          const first = lines.find((l) => l.text)?.text ?? "";
          if (first.startsWith("command=ls-refs")) handleLsRefs(req, res, r, raw);
          else handleUploadPack(req, res, r, raw);
          return;
        }
        if (action === "git-receive-pack") {
          handleReceivePack(req, res, r, raw);
          return;
        }
      }
      notFound(res);
    } catch (e) {
      console.error("handler error:", e);
      if (!res.headersSent) sendJson(res, 500, { message: "Internal Server Error" });
      else res.end();
    }
  });
  return server;
}

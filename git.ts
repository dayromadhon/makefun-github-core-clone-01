// git smart HTTP, implemented from scratch on node:crypto and node:zlib: pkt-line framing,
// packfile read/write (plain objects, no deltas), protocol v2 (upload-pack) and v0
// (upload-pack and receive-pack), and the ref advertisement. No git binary, no dependencies.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

export const AGENT = 'github-core-clone-01/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines; throws on a malformed header or a truncated packet. */
export function decodePktLines(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** The text of every data packet, control packets dropped. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). The trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack size varint truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
}

/**
 * Read a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA entries. A thin pack's bases
 * resolve through `resolveBase`. Every object's SHA-1 is recomputed by the caller storing it.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index++) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects };
}

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

export interface RefInfo {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The repository's refs, sorted by name, with peeled tag targets. */
export function listRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefInfo = { oid, name };
    const object = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      entry.peeled = parseTag(object.data).object;
    }
    refs.push(entry);
  }
  return refs;
}

/** The oid HEAD resolves to: the default branch tip, or ZERO when the repo is unborn. */
export function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------------------------
// smart HTTP responses
// ---------------------------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V2_CAPABILITIES = ['fetch=shallow filter', 'ls-refs=unborn', 'object-format=sha1', `agent=${AGENT}`];
const V0_UPLOAD_CAPS =
  `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs thin-pack ofs-delta agent=${AGENT}`;

/** GET /{owner}/{repo}.git/info/refs — v2 when Git-Protocol: version=2 is asked for upload-pack. */
export function infoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', gitProtocolV2: boolean): GitResponse {
  const refs = listRefs(repo);
  if (service === 'git-upload-pack' && gitProtocolV2) {
    const lines: (string | 'flush')[] = ['version 2\n', ...V2_CAPABILITIES.map((c) => `${c}\n`), 'flush'];
    return { status: 200, contentType: UPLOAD_AD, body: pktLines(lines) };
  }
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headOid(repo);
    const headLine = head === ZERO_OID ? null : `${head} HEAD\0${caps}\n`;
    const lines: string[] = [];
    if (headLine !== null) lines.push(headLine);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
    // The first ref line carries the capabilities when there is no HEAD line (unborn default
    // branch with other refs is impossible here, but keep the framing valid regardless).
    if (headLine === null && lines.length > 0) {
      lines[0] = lines[0].replace('\n', `\0${caps}\n`);
    }
    for (const line of lines) parts.push(pktLine(line));
  }
  parts.push(pktFlush());
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// fetch: the objects a request wants
// ---------------------------------------------------------------------------------------------

export interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must send. `wants` are commit/tag ids; `haves` are commits the client
 * already holds; `depth` (when given) is an absolute commit-generation limit from the wants.
 * The client never receives an object reachable from a have, nor a commit deeper than `depth`.
 */
export function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBefore: string[],
  depth: number | null,
): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: the closure of its haves, except that a shallow boundary's
  // parents are NOT held (the client's shallow clone never received them), so the walk stops
  // at each shallow boundary's tree instead of descending into its parents.
  const shallowSet = new Set(shallowBefore);
  const haveReachable = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (haveReachable.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      haveReachable.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }
  // Commit generations from the wants (0 = the wants themselves), following parents. A commit
  // at generation >= depth is never included: depth 1 sends the tip alone, depth 2 the tip and
  // its parent, and so on.
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, gen: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    }
  }
  const includedCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (depth !== null && gen >= depth) continue;
    const known = generations.get(oid);
    if (known !== undefined && known <= gen) continue;
    generations.set(oid, gen);
    includedCommits.add(oid);
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  // The objects to send: the included commits, the trees and blobs of exactly those commits
  // (never a cut-off parent's tree), and any wanted tag object itself.
  const toSend = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const tid = stack.pop()!;
      if (toSend.has(tid)) continue;
      const tree = lookup(tid);
      if (!tree || tree.type !== 'tree') continue;
      toSend.add(tid);
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else toSend.add(entry.oid);
      }
    }
  };
  for (const oid of includedCommits) {
    toSend.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') addTree(parseCommit(object.data).tree);
  }
  for (const want of wants) {
    if (lookup(want)?.type === 'tag') toSend.add(want);
  }
  const shallow = new Set<string>();
  for (const oid of includedCommits) {
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((p) => !includedCommits.has(p))) shallow.add(oid);
  }
  const unshallow = new Set<string>();
  for (const before of shallowBefore) {
    if (includedCommits.has(before) && !shallow.has(before)) unshallow.add(before);
  }
  const objects: GitObject[] = [];
  for (const oid of toSend) {
    if (haveReachable.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  // Deterministic pack order: commits first (newest generations first), then trees, then blobs.
  const rank = (o: GitObject): number => (o.type === 'commit' ? 0 : o.type === 'tree' ? 1 : 2);
  objects.sort((a, b) => rank(a) - rank(b));
  return { objects, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

/** Split a pack into sideband band-1 pkt-lines (each payload stays under the pkt-line limit). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

/** POST /{owner}/{repo}.git/git-upload-pack — protocol v2 (command=fetch / command=ls-refs). */
export function uploadPackV2(repo: Repo, body: Buffer): GitResponse {
  const packets = decodePktLines(body);
  const lines = packetLines(packets);
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim();
  if (command === 'ls-refs') {
    const trimmed = lines.map((l) => l.trim());
    const peel = trimmed.includes('peel');
    const symrefs = trimmed.includes('symrefs');
    const prefixes = trimmed.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim());
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const out: (string | 'flush')[] = [];
    const refs = listRefs(repo);
    if (refs.length === 0) {
      if (keep('HEAD')) {
        out.push(symrefs ? `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : 'unborn HEAD\n');
      }
    } else {
      const tip = headOid(repo);
      if (keep('HEAD') && tip !== ZERO_OID) {
        out.push(symrefs ? `${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${tip} HEAD\n`);
      }
      for (const ref of refs) {
        if (!keep(ref.name)) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
        out.push(`${line}\n`);
      }
    }
    out.push('flush');
    return { status: 200, contentType: UPLOAD_RESULT, body: pktLines(out) };
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowBefore: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      const text = line.trim();
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallowBefore.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    const selected = selectFetchObjects(repo, wants, haves, shallowBefore, depth);
    const pack = writePack(selected.objects);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktDelim());
    if (selected.shallow.length > 0 || selected.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of selected.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of selected.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
    return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
  }
  throw new Error(`unknown v2 upload-pack command ${JSON.stringify(command ?? '')}`);
}

/** POST /{owner}/{repo}.git/git-upload-pack — protocol v0 (want/have/done). */
export function uploadPackV0(repo: Repo, body: Buffer): GitResponse {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBefore: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section++;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('want ')) {
      // The first want line may carry capabilities after the oid.
      wants.push(text.slice(5).trim().split(' ')[0]);
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      shallowBefore.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  void section;
  const selected = selectFetchObjects(repo, wants, haves, shallowBefore, depth);
  const pack = writePack(selected.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selected.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selected.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body into its command list and the trailing pack bytes. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  // Commands are pkt-lines up to the first flush packet; the rest is the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line in receive-pack');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in receive-pack');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = payload.indexOf('\0');
    const line = (nul >= 0 ? payload.slice(0, nul) : payload).trim();
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
    const [oldOid, newOid, ref] = parts;
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
      throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, pack: body.subarray(offset) };
}

/**
 * Apply a push. Objects from the pack are stored first; each ref is then judged on its own:
 * a fast-forward (or a create from nothing, or a delete) applies, anything else is refused
 * per-ref with `ng <ref> non-fast-forward` and the ref does not move.
 */
export function receivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  let commands: PushCommand[];
  let pack: Buffer;
  try {
    ({ commands, pack } = parseReceivePack(body));
  } catch (err) {
    return reportResult(`unpack error ${err instanceof Error ? err.message : 'bad request'}`, []);
  }
  if (commands.length === 0) return reportResult('unpack ok', []);
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack) {
    if (pack.length === 0) return reportResult('unpack error no packfile', []);
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (hashObject(object.type, object.data) !== oid) throw new Error('pack object hash mismatch');
        repo.objects.set(oid, object);
      }
    } catch (err) {
      return reportResult(`unpack error ${err instanceof Error ? err.message : 'bad pack'}`, []);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === ZERO_OID) {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // A fast-forward: the current tip must be an ancestor of the new tip.
    if (store.isAncestor(repo, current, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  return reportResult('unpack ok', results);
}

/** The report-status answer, framed in sideband band 1 (the client demuxes it from there). */
function reportResult(unpack: string, results: Array<{ ref: string; ok: boolean; reason: string }>): GitResponse {
  const lines: (string | 'flush')[] = [`${unpack}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  lines.push('flush');
  const report = pktLines(lines);
  const banded = pktLine(Buffer.concat([Buffer.from([1]), report]));
  return { status: 200, contentType: RECEIVE_RESULT, body: Buffer.concat([banded, pktFlush()]) };
}

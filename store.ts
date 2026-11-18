// The forge's in-memory store: git objects, refs, repositories, issues and pull requests.
// Everything is deterministic: no wall clock and no unseeded randomness reach stored data.
// Commit timestamps come from a fixed base plus a counter, and ids from counters, so a live
// pass and its replay build the same state for the same request order.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots`: commit -> tree + parents, tag -> target, tree -> entries. */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Count the lines of a blob's text (a trailing newline does not start a new line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

// ---------------------------------------------------------------------------------------------
// The forge's records
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  nodeId: string;
}

export interface Comment {
  id: number;
  body: string;
  nodeId: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  nodeId: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  nodeId: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  nextIssueNumber: number;
  labels: Map<string, Label>;
  pulls: Pull[];
  nextPullNumber: number;
  comments: Map<number, Comment[]>;
}

const FIXED_STAMP = '2026-11-19T00:00:00Z';

/** Opaque, stable Relay-style global ids (base64 of a namespaced key, never the bare number). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Store {
  /** The login the bearer token names. The kit's public scenario seed fixes it to
   * `adaiversen` for every instance; the first owner seen in a request confirms (or, if the
   * scenario ever changed, corrects) it, since every suite request names the viewer first. */
  viewerLogin = 'adaiversen';
  private viewerLatched = false;
  readonly viewerId = 1000;
  repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 100000;
  private nextCommentId = 1;
  private seq = 1;
  private tsCounter = 1700000000;

  /** The next creation sequence number (creation order for issues, repos, pulls). */
  nextSeq(): number {
    return this.seq++;
  }

  /** The next deterministic commit timestamp (unix seconds). */
  nextTs(): number {
    return this.tsCounter++;
  }

  identity(): string {
    return `${this.viewerLogin} <${this.viewerLogin}@example.invalid>`;
  }

  fixedStamp(): string {
    return FIXED_STAMP;
  }

  /** Remember the owner the first owner-scoped request names: that is the viewer. */
  latchOwner(owner: string): void {
    if (!this.viewerLatched && owner !== '') {
      this.viewerLogin = owner;
      this.viewerLatched = true;
    }
  }

  /** True when `owner` is the viewer (latching on first sight); anything else is foreign. */
  isViewer(owner: string): boolean {
    this.latchOwner(owner);
    return owner === this.viewerLogin;
  }

  createRepo(name: string, options: { description?: string; private?: boolean } = {}): Repo | null {
    if (this.repos.has(name)) return null;
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      name,
      owner: this.viewerLogin,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      nodeId: globalId('repo', String(id)),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      nextIssueNumber: 1,
      labels: new Map(),
      pulls: [],
      nextPullNumber: 1,
      comments: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Look a repository up by its owner and name; a foreign owner is always a miss (404, never 403). */
  getRepo(owner: string, name: string): Repo | null {
    if (!this.isViewer(owner)) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** The viewer's repositories in creation order (the pagination walk's stable order). */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -- git object helpers, scoped to one repository ------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string {
    return repo.refs.get(ref) ?? ZERO_OID;
  }

  /** True when `ancestor` is reachable from `commit` by following parents. */
  isAncestor(repo: Repo, ancestor: string, commit: string): boolean {
    if (ancestor === commit) return true;
    const seen = new Set<string>();
    const queue = [commit];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The merge base of two commits: the first common ancestor found by a breadth walk. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (!isOid(a) || !isOid(b)) return null;
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queueA.push(p);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queueB.push(p);
    }
    return null;
  }

  /** The flat path -> {oid, mode} map of a commit's tree (empty when the commit is unknown). */
  fileMapAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** The blob bytes of `path` at a commit, or null when the path is not a file there. */
  fileAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const entry = this.fileMapAt(repo, commitOid).get(path);
    if (!entry) return null;
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { oid: entry.oid, data: blob.data };
  }

  /** A new root tree with `path` set to `blobOid` (or removed when null), storing new trees. */
  updateTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const tree = repo.objects.get(treeOid);
        if (tree?.type === 'tree') for (const e of parseTree(tree.data)) entries.set(e.name, e);
      }
      const name = segments[depth];
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const next = build(childTree, depth + 1);
        const nextObject = repo.objects.get(next);
        const empty = nextObject !== undefined && parseTree(nextObject.data).length === 0;
        if (empty) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      return this.putObject(repo, 'tree', buildTree([...entries.values()]));
    };
    return build(baseTreeOid, 0);
  }

  /** Store a commit object and return its id. The message is stored verbatim. */
  makeCommit(repo: Repo, options: { tree: string; parents: string[]; message: string }): string {
    const who = `${this.identity()} ${this.nextTs()} +0000`;
    const lines = [`tree ${options.tree}`];
    for (const parent of options.parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${options.message}`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /** Commits reachable from `tip`, newest first (a depth walk from the tip). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || !isOid(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i]);
    }
    return out;
  }

  // -- diff / merge --------------------------------------------------------------------------

  /** The file changes between two commits (merge base -> tip), with line counts. */
  diffFiles(repo: Repo, fromCommit: string, toCommit: string): PullFile[] {
    const from = this.fileMapAt(repo, fromCommit);
    const to = this.fileMapAt(repo, toCommit);
    const files: PullFile[] = [];
    const names = new Set([...from.keys(), ...to.keys()]);
    for (const name of [...names].sort()) {
      const a = from.get(name);
      const b = to.get(name);
      if (a && b && a.oid === b.oid) continue;
      if (a && !b) {
        const old = repo.objects.get(a.oid);
        const deletions = old ? countLines(old.data) : 0;
        files.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!a && b) {
        const next = repo.objects.get(b.oid);
        const additions = next ? countLines(next.data) : 0;
        files.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
      } else if (a && b) {
        const old = repo.objects.get(a.oid);
        const next = repo.objects.get(b.oid);
        const additions = next ? countLines(next.data) : 0;
        const deletions = old ? countLines(old.data) : 0;
        files.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /** True when merging `headTip` into `baseTip` would conflict (same file changed both ways). */
  mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
    const mb = this.mergeBase(repo, baseTip, headTip);
    if (mb === null) return false;
    const baseMap = this.fileMapAt(repo, mb);
    const baseNow = this.fileMapAt(repo, baseTip);
    const headNow = this.fileMapAt(repo, headTip);
    const names = new Set([...baseNow.keys(), ...headNow.keys(), ...baseMap.keys()]);
    for (const name of names) {
      const orig = baseMap.get(name)?.oid;
      const atBase = baseNow.get(name)?.oid;
      const atHead = headNow.get(name)?.oid;
      const baseChanged = atBase !== orig;
      const headChanged = atHead !== orig;
      if (baseChanged && headChanged && atBase !== atHead) return true;
    }
    return false;
  }

  /** A squash merge of `headTip` onto `baseTip`: one commit carrying the head's tree. Returns its id. */
  squashMerge(repo: Repo, pull: Pull, baseTip: string, headTip: string): string {
    const head = repo.objects.get(headTip);
    if (!head || head.type !== 'commit') throw new Error('head tip is not a commit');
    const tree = parseCommit(head.data).tree;
    return this.makeCommit(repo, {
      tree,
      parents: [baseTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    });
  }

  // -- issues and pull requests ---------------------------------------------------------------

  createIssue(repo: Repo, options: { title: string; body?: string; labels?: string[] }): Issue | { error: string } {
    const labels = options.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
    }
    const number = repo.nextIssueNumber++;
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      nodeId: globalId('issue', `${repo.id}:${number}`),
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((i) => i.number === number) ?? null;
  }

  listIssues(repo: Repo, options: { state?: string; sort?: string; direction?: string }): Issue[] {
    let list = [...repo.issues];
    const state = (options.state ?? 'open').toLowerCase();
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const direction = (options.direction ?? 'desc').toLowerCase();
    if ((options.sort ?? 'created').toLowerCase() === 'created') {
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    }
    return list;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const id = this.nextCommentId++;
    const comment: Comment = { id, body, nodeId: globalId('comment', `${repo.id}:${id}`) };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  createPull(repo: Repo, options: { title: string; body?: string; head: string; base: string }): Pull | { error: string } {
    const headSha = this.refTip(repo, `refs/heads/${options.head}`);
    const baseSha = this.refTip(repo, `refs/heads/${options.base}`);
    if (headSha === ZERO_OID) return { error: `Head branch "${options.head}" does not exist` };
    if (baseSha === ZERO_OID) return { error: `Base branch "${options.base}" does not exist` };
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === options.head && p.baseRef === options.base);
    if (existing) return { error: 'A pull request already exists for this head and base' };
    const number = repo.nextPullNumber++;
    const pull: Pull = {
      id: this.nextIssueId++,
      number,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: options.head,
      baseRef: options.base,
      headSha,
      baseSha,
      createdSeq: this.nextSeq(),
      nodeId: globalId('pr', `${repo.id}:${number}`),
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | null {
    return repo.pulls.find((p) => p.number === number) ?? null;
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const wanted = (state ?? 'open').toLowerCase();
    let list = [...repo.pulls];
    if (wanted !== 'all') list = list.filter((p) => p.state === wanted);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return list;
  }

  /** Merge a pull request (squash). Returns the merge commit id, or an error string. */
  mergePull(repo: Repo, pull: Pull): string | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const baseTip = this.refTip(repo, `refs/heads/${pull.baseRef}`);
    const headTip = this.refTip(repo, `refs/heads/${pull.headRef}`);
    if (baseTip === ZERO_OID || headTip === ZERO_OID) return { error: 'Head or base branch is missing', status: 405 };
    if (this.mergeConflicts(repo, baseTip, headTip)) return { error: 'Merge conflict', status: 405 };
    const mergeSha = this.squashMerge(repo, pull, baseTip, headTip);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.fixedStamp();
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    return mergeSha;
  }

  /** The changed files of a pull request (merge base -> head tip). */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const mb = this.mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
    return this.diffFiles(repo, mb, pull.headSha);
  }

  /** Whether a pull request would merge cleanly right now. */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const baseTip = this.refTip(repo, `refs/heads/${pull.baseRef}`);
    const headTip = this.refTip(repo, `refs/heads/${pull.headRef}`);
    if (baseTip === ZERO_OID || headTip === ZERO_OID) return false;
    return !this.mergeConflicts(repo, baseTip, headTip);
  }
}

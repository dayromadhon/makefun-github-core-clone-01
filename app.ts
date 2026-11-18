// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP, one process over
// the in-memory store. Every reply is JSON (except the git pack streams) and carries a
// non-empty X-GitHub-Request-Id; errors carry a JSON body with a string message.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  infoRefs,
  receivePack,
  uploadPackV0,
  uploadPackV2,
} from './git.ts';
import { runGraphQL } from './graphql.ts';
import {
  globalId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  Store as StoreClass,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): T[] {
  const perPage = intParam(query, 'per_page', 30);
  const page = intParam(query, 'page', 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const params = new URLSearchParams(query);
  params.set('page', String(page + 1));
  params.set('per_page', String(perPage));
  const next = `http://${host}${path}?${params.toString()}`;
  return `<${next}>; rel="next"`;
}

// ---------------------------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------------------------

function userObject(store: Store, login: string): Record<string, unknown> {
  return {
    login,
    id: login === store.viewerLogin ? store.viewerId : 0,
    node_id: globalId('user', login === store.viewerLogin ? String(store.viewerId) : login),
    avatar_url: '',
    type: 'User',
    site_admin: false,
  };
}

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(store, repo.owner),
    private: repo.private,
    html_url: `/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.fixedStamp(),
    updated_at: store.fixedStamp(),
    pushed_at: store.fixedStamp(),
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userObject(store, store.viewerLogin),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 0, node_id: globalId('label', `${repo.id}:${name}`), name, color: label?.color ?? 'ededed', description: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: store.fixedStamp(),
    updated_at: store.fixedStamp(),
    closed_at: issue.state === 'closed' ? store.fixedStamp() : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentObject(store: Store, repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userObject(store, store.viewerLogin),
    created_at: store.fixedStamp(),
    updated_at: store.fixedStamp(),
    author_association: 'OWNER',
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const mergeable = store.pullMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userObject(store, store.viewerLogin),
    created_at: store.fixedStamp(),
    updated_at: store.fixedStamp(),
    closed_at: pull.state === 'closed' ? store.fixedStamp() : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state !== 'open' ? 'unknown' : mergeable ? 'clean' : 'dirty',
    merged_by: pull.merged ? userObject(store, store.viewerLogin) : null,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userObject(store, store.viewerLogin), repo: repoObject(store, repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userObject(store, store.viewerLogin), repo: repoObject(store, repo) },
    draft: false,
    commits_url: '',
    review_comments_url: '',
    review_comment_url: '',
    comments_url: '',
    statuses_url: '',
    author_association: 'OWNER',
  };
}

function commitObject(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = store.lookup(repo, oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: store.fixedStamp() };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: globalId('commit', oid),
    commit: {
      author: ident(commit.author),
      committer: ident(commit.committer),
      message,
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: '',
    author: userObject(store, store.viewerLogin),
    committer: userObject(store, store.viewerLogin),
    parents: commit.parents.map((sha) => ({ sha, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentsFileObject(store: Store, repo: Repo, path: string, blobOid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: '',
    html_url: `/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    download_url: null,
    _links: { git: '', self: '', html: '' },
  };
  void store;
}

function treeAt(store: Store, repo: Repo, commitOid: string, path: string): { type: 'file' | 'dir'; oid: string } | null {
  const commit = store.lookup(repo, commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (path === '' || path === '/') return { type: 'dir', oid: treeOid };
  const segments = path.split('/').filter((s) => s !== '');
  for (let i = 0; i < segments.length; i++) {
    const tree = store.lookup(repo, treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { type: 'dir', oid: entry.oid } : { type: 'file', oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
];

const MCP_SERVER_INFO = { name: 'github-core-clone-01', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

// ---------------------------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  const store = new StoreClass();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  /** True when the request carries the trial's bearer token (any non-empty one when unset locally). */
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    if (expectedToken === '') return match[1].trim() !== '';
    return match[1] === expectedToken;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        if (!res.writableEnded) {
          try {
            sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
          } catch {
            // The socket is already gone; nothing left to answer.
          }
        }
      }
    })();
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const { path, query } = pathOf(req);
    const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

    // The env's boot probe: 200 {"ok":true}, no token.
    if (method === 'GET' && normalized === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(normalized);
    if (gitMatch !== null) {
      await handleGit(req, res, method, decodeSegment(gitMatch[1]), decodeSegment(gitMatch[2]), gitMatch[3] ?? '');
      return;
    }

    // MCP: POST /mcp (JSON-RPC 2.0 over Streamable HTTP).
    if (normalized === '/mcp') {
      await handleMcp(req, res, method);
      return;
    }

    // GraphQL: POST /api/graphql.
    if (normalized === '/api/graphql') {
      if (method !== 'POST') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }
      if (!authorized(req)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { errors: [{ message: 'The request body is not valid JSON.' }] });
        return;
      }
      const result = runGraphQL(store, parsed.value);
      sendJson(res, result.status, result.payload);
      return;
    }

    // REST v3 under /api/v3.
    if (normalized === '/api/v3' || normalized.startsWith('/api/v3/')) {
      await handleRest(req, res, method, normalized, query);
      return;
    }

    sendError(res, 404, 'Not Found');
  }

  // -------------------------------------------------------------------------------------------
  // git
  // -------------------------------------------------------------------------------------------

  async function handleGit(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    owner: string,
    repoName: string,
    suffix: string,
  ): Promise<void> {
    if (!authorized(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    store.latchOwner(owner);
    const repo = store.getRepo(owner, repoName);
    if (method === 'GET' && suffix === '/info/refs') {
      if (repo === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const { query } = pathOf(req);
      const service = query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendError(res, 400, 'Missing or unknown service');
        return;
      }
      const v2 = req.headers['git-protocol'] === 'version=2';
      const answer = infoRefs(repo, service, v2);
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      if (repo === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const raw = await readBody(req);
      try {
        const v2 = req.headers['git-protocol'] === 'version=2';
        const answer = v2 ? uploadPackV2(repo, raw) : uploadPackV0(repo, raw);
        sendBuffer(res, answer.status, answer.contentType, answer.body);
      } catch {
        sendError(res, 400, 'Bad request');
      }
      return;
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      if (repo === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const raw = await readBody(req);
      try {
        const answer = receivePack(store, repo, raw);
        sendBuffer(res, answer.status, answer.contentType, answer.body);
      } catch {
        sendError(res, 400, 'Bad request');
      }
      return;
    }
    sendError(res, 404, 'Not Found');
  }

  // -------------------------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------------------------

  async function handleMcp(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (method === 'GET') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    if (method === 'DELETE') {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const body = parsed.value as Record<string, unknown>;
    const id = (body.id ?? null) as string | number | null;
    const rpcMethod = typeof body.method === 'string' ? body.method : '';
    const params = (body.params ?? {}) as Record<string, unknown>;
    const hasId = body.id !== undefined;

    const result = (value: unknown): void => {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
    };
    const rpcError = (code: number, message: string): void => {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
    };

    // A notification carries no id and expects no JSON-RPC answer.
    if (!hasId) {
      res.writeHead(202, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
      res.end('{}\n');
      return;
    }

    if (rpcMethod === 'server/discover') {
      result({
        resultType: 'discover',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {}, logging: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
      return;
    }
    if (rpcMethod === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) || ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requested)
        ? requested
        : '2025-11-25';
      result({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
      return;
    }
    if (rpcMethod === 'ping') {
      result({});
      return;
    }
    if (rpcMethod === 'tools/list') {
      // The same array, byte for byte, on every call: built from one constant.
      result({ tools: MCP_TOOLS });
      return;
    }
    if (rpcMethod === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) {
        rpcError(-32602, `Unknown tool: ${name}`);
        return;
      }
      const required = (tool.inputSchema.required ?? []) as string[];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        rpcError(-32602, `Missing required argument(s): ${missing.join(', ')}`);
        return;
      }
      const outcome = callMcpTool(tool.name, args);
      if ('error' in outcome) {
        result({ content: [{ type: 'text', text: outcome.error }], isError: true });
        return;
      }
      result({
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
        isError: false,
      });
      return;
    }
    rpcError(-32601, `Method not found: ${rpcMethod}`);
  }

  function callMcpTool(name: string, args: Record<string, unknown>): { value: unknown } | { error: string } {
    const owner = String(args.owner ?? store.viewerLogin);
    const repoName = String(args.repo ?? args.name ?? '');
    const lookupRepo = (): Repo | { error: string } => {
      if (!store.isViewer(owner)) return { error: `Repository ${owner}/${repoName} not found` };
      const repo = store.repos.get(repoName) ?? null;
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      return repo;
    };
    switch (name) {
      case 'create_repo': {
        const repoNameArg = String(args.name ?? '');
        if (repoNameArg === '') return { error: 'A repository name is required' };
        const created = store.createRepo(repoNameArg, {
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === true,
        });
        if (!created) return { error: `Repository ${repoNameArg} already exists` };
        return { value: repoObject(store, created) };
      }
      case 'get_repo': {
        const repo = lookupRepo();
        if ('error' in repo) return repo;
        return { value: repoObject(store, repo) };
      }
      case 'create_issue': {
        const repo = lookupRepo();
        if ('error' in repo) return repo;
        const created = store.createIssue(repo, { title: String(args.title ?? ''), body: typeof args.body === 'string' ? args.body : '' });
        if ('error' in created) return { error: created.error };
        return { value: issueObject(store, repo, created) };
      }
      case 'list_issues': {
        const repo = lookupRepo();
        if ('error' in repo) return repo;
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = store.listIssues(repo, { state });
        const value = list.map((issue) => issueObject(store, repo, issue));
        return { value };
      }
      case 'get_issue': {
        const repo = lookupRepo();
        if ('error' in repo) return repo;
        const issue = store.getIssue(repo, Number(args.issue_number));
        if (!issue) return { error: `Issue #${String(args.issue_number)} not found` };
        return { value: issueObject(store, repo, issue) };
      }
      case 'create_pull_request': {
        const repo = lookupRepo();
        if ('error' in repo) return repo;
        const created = store.createPull(repo, {
          title: String(args.title ?? ''),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head ?? ''),
          base: String(args.base ?? ''),
        });
        if ('error' in created) return { error: created.error };
        return { value: pullObject(store, repo, created) };
      }
      case 'merge_pull_request': {
        const repo = lookupRepo();
        if ('error' in repo) return repo;
        const pull = store.getPull(repo, Number(args.pull_number));
        if (!pull) return { error: `Pull request #${String(args.pull_number)} not found` };
        const merged = store.mergePull(repo, pull);
        if (typeof merged !== 'string') return { error: merged.error };
        return { value: { number: pull.number, merged: true, state: pull.state, sha: merged, message: `Pull request #${pull.number} merged` } };
      }
      case 'list_pull_requests': {
        const repo = lookupRepo();
        if ('error' in repo) return repo;
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = store.listPulls(repo, state);
        return { value: list.map((pull) => pullObject(store, repo, pull)) };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // -------------------------------------------------------------------------------------------
  // REST
  // -------------------------------------------------------------------------------------------

  async function handleRest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: URLSearchParams,
  ): Promise<void> {
    // The API root and the meta/user routes take the token like every other REST route.
    if (path === '/api/v3' && method === 'GET') {
      if (!authorized(req)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    if (path === '/api/v3/meta' && method === 'GET') {
      if (!authorized(req)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }
      sendJson(res, 200, { installed_version: '1.0.0', versions: { git: '2.0.0', github_enterprise: '1.0.0' } });
      return;
    }
    if (path === '/api/v3/user' && method === 'GET') {
      if (!authorized(req)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }
      sendJson(res, 200, {
        login: store.viewerLogin,
        id: store.viewerId,
        node_id: globalId('user', String(store.viewerId)),
        name: store.viewerLogin,
        email: `${store.viewerLogin}@example.invalid`,
        type: 'User',
      });
      return;
    }

    // POST /user/repos and GET /user/repos (pagination).
    if (path === '/api/v3/user/repos') {
      if (!authorized(req)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name)) {
          sendError(res, 422, 'Invalid repository name');
          return;
        }
        const created = store.createRepo(name, {
          description: typeof body.description === 'string' ? body.description : '',
          private: body.private === true,
        });
        if (!created) {
          sendError(res, 422, 'Repository already exists');
          return;
        }
        sendJson(res, 201, repoObject(store, created));
        return;
      }
      if (method === 'GET') {
        const perPage = intParam(query, 'per_page', 30);
        const page = intParam(query, 'page', 1);
        const all = store.listRepos();
        const items = all.slice((page - 1) * perPage, page * perPage);
        const headers: Record<string, string> = {};
        const link = linkHeader(req, path, query, page, perPage, all.length);
        if (link !== null) headers.link = link;
        sendJson(res, 200, items.map((repo) => repoObject(store, repo)), headers);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // /repos/{owner}/{repo}[...]
    const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch !== null) {
      await handleRepoRoute(req, res, method, decodeSegment(repoMatch[1]), decodeSegment(repoMatch[2]), repoMatch[3] ?? '', query);
      return;
    }

    sendError(res, 404, 'Not Found');
  }

  async function handleRepoRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    owner: string,
    repoName: string,
    suffix: string,
    query: URLSearchParams,
  ): Promise<void> {
    if (!authorized(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === null) {
      // A missing repository is 404 even when the body would otherwise be read: the suite
      // checks the status, and a 404 here also covers the foreign-owner case.
      sendError(res, 404, 'Not Found');
      return;
    }
    const parts = suffix.split('/').filter((s) => s !== '').map(decodeSegment);

    // The repository itself.
    if (parts.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoObject(store, repo));
        return;
      }
      if (method === 'PATCH') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (body.private === true || body.private === false) repo.private = body.private;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          if (store.repos.has(body.name)) {
            sendError(res, 422, 'Repository already exists');
            return;
          }
          store.repos.delete(repo.name);
          repo.name = body.name;
          store.repos.set(repo.name, repo);
        }
        sendJson(res, 200, repoObject(store, repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo.name);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    const head = parts[0];

    // Branches and commits.
    if (head === 'branches') {
      if (method === 'GET' && parts.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? ZERO_OID, url: '' }, protected: false }));
        sendJson(res, 200, branches);
        return;
      }
      if (method === 'GET' && parts.length === 2) {
        const tip = repo.refs.get(`refs/heads/${parts[1]}`);
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: parts[1], commit: { sha: tip, url: '' }, protected: false });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (head === 'commits') {
      if (method === 'GET') {
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.refs.get(ref) ?? ZERO_OID);
        if (tip === ZERO_OID) {
          sendJson(res, 200, []);
          return;
        }
        const commits = store.commitsFrom(repo, tip);
        const items = paginate(commits, query)
          .map((oid) => commitObject(store, repo, oid))
          .filter((c): c is Record<string, unknown> => c !== null);
        sendJson(res, 200, items);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // Git Data API: refs.
    if (head === 'git' && parts[1] === 'refs') {
      if (method === 'POST' && parts.length === 2) {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
          sendError(res, 422, 'Invalid ref or sha');
          return;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Reference already exists');
          return;
        }
        if (!repo.objects.has(sha)) {
          sendError(res, 422, 'Object does not exist');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: globalId('ref', `${repo.id}:${ref}`), url: '', object: { sha, type: 'commit', url: '' } });
        return;
      }
      if (method === 'GET' && parts.length >= 3) {
        const ref = `refs/${parts.slice(2).join('/')}`;
        const tip = repo.refs.get(ref);
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref, node_id: globalId('ref', `${repo.id}:${ref}`), url: '', object: { sha: tip, type: 'commit', url: '' } });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // Contents.
    if (head === 'contents') {
      const contentPath = parts.slice(1).join('/');
      if (method === 'PUT') {
        await putContents(req, res, repo, contentPath);
        return;
      }
      if (method === 'GET') {
        const refName = query.get('ref') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${refName}`) ?? (repo.refs.get(refName) ?? ZERO_OID);
        if (tip === ZERO_OID) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const found = treeAt(store, repo, tip, contentPath);
        if (found === null) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (found.type === 'file') {
          const blob = store.lookup(repo, found.oid);
          if (!blob || blob.type !== 'blob') {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, contentsFileObject(store, repo, contentPath, found.oid, blob.data));
          return;
        }
        const tree = store.lookup(repo, found.oid);
        if (!tree || tree.type !== 'tree') {
          sendError(res, 404, 'Not Found');
          return;
        }
        const entries = parseTree(tree.data)
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((entry) => {
            const childPath = contentPath === '' ? entry.name : `${contentPath}/${entry.name}`;
            if (entry.mode === '40000') {
              return { type: 'dir', name: entry.name, path: childPath, sha: entry.oid, size: 0, url: '', git_url: '', html_url: '', download_url: null };
            }
            const blob = store.lookup(repo, entry.oid);
            return { type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: blob?.data.length ?? 0, url: '', git_url: '', html_url: '', download_url: null };
          });
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'DELETE') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        const branch = repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
        if (tip === ZERO_OID) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const current = store.fileAt(repo, tip, contentPath);
        if (!current) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== current.oid) {
          sendError(res, 409, 'Conflict: sha does not match');
          return;
        }
        const baseTree = parseCommit(store.lookup(repo, tip)!.data).tree;
        const newTree = store.updateTree(repo, baseTree, contentPath, null);
        const commitSha = store.makeCommit(repo, {
          tree: newTree,
          parents: [tip],
          message: typeof body.message === 'string' ? body.message : 'Delete file',
        });
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message: typeof body.message === 'string' ? body.message : 'Delete file' } });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // Labels.
    if (head === 'labels') {
      if (method === 'POST' && parts.length === 1) {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          sendError(res, 422, 'A label name is required');
          return;
        }
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { id: 0, node_id: globalId('label', `${repo.id}:${name}`), name, color, description: '' });
        return;
      }
      if (method === 'GET' && parts.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // Issues.
    if (head === 'issues') {
      if (parts.length === 1) {
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return;
          }
          const body = parsed.value as Record<string, unknown>;
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') {
            sendError(res, 422, 'A title is required');
            return;
          }
          const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
          const created = store.createIssue(repo, { title, body: typeof body.body === 'string' ? body.body : '', labels });
          if ('error' in created) {
            sendError(res, 422, created.error);
            return;
          }
          sendJson(res, 201, issueObject(store, repo, created));
          return;
        }
        if (method === 'GET') {
          const list = store.listIssues(repo, {
            state: query.get('state') ?? 'open',
            sort: query.get('sort') ?? 'created',
            direction: query.get('direction') ?? 'desc',
          });
          sendJson(res, 200, paginate(list, query).map((issue) => issueObject(store, repo, issue)));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(parts[1], 10);
      if (!Number.isFinite(number)) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (parts.length === 2) {
        const issue = store.getIssue(repo, number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueObject(store, repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return;
          }
          const body = parsed.value as Record<string, unknown>;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((l): l is string => typeof l === 'string');
            for (const name of labels) {
              if (!repo.labels.has(name)) {
                sendError(res, 422, `Label "${name}" does not exist`);
                return;
              }
            }
            issue.labels = labels;
          }
          sendJson(res, 200, issueObject(store, repo, issue));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (parts.length === 3 && parts[2] === 'comments') {
        const issue = store.getIssue(repo, number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return;
          }
          const body = parsed.value as Record<string, unknown>;
          const comment = store.addComment(repo, number, typeof body.body === 'string' ? body.body : '');
          if (!comment) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 201, commentObject(store, repo, number, comment));
          return;
        }
        if (method === 'GET') {
          const list = repo.comments.get(number) ?? [];
          sendJson(res, 200, list.map((comment) => commentObject(store, repo, number, comment)));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // Pull requests.
    if (head === 'pulls') {
      if (parts.length === 1) {
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return;
          }
          const body = parsed.value as Record<string, unknown>;
          const title = typeof body.title === 'string' ? body.title : '';
          const headRef = String(body.head ?? '').split(':').pop() ?? '';
          const baseRef = String(body.base ?? '').split(':').pop() ?? '';
          if (title === '' || headRef === '' || baseRef === '') {
            sendError(res, 422, 'title, head and base are required');
            return;
          }
          const created = store.createPull(repo, { title, body: typeof body.body === 'string' ? body.body : '', head: headRef, base: baseRef });
          if ('error' in created) {
            sendError(res, 422, created.error);
            return;
          }
          sendJson(res, 201, pullObject(store, repo, created));
          return;
        }
        if (method === 'GET') {
          const list = store.listPulls(repo, query.get('state') ?? 'open');
          sendJson(res, 200, paginate(list, query).map((pull) => pullObject(store, repo, pull)));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(parts[1], 10);
      if (!Number.isFinite(number)) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const pull = store.getPull(repo, number);
      if (parts.length === 2) {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullObject(store, repo, pull));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (parts.length === 3 && parts[2] === 'files') {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          const files = store.pullFiles(repo, pull);
          sendJson(res, 200, files.map((f) => ({
            sha: '',
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            blob_url: '',
            raw_url: '',
            contents_url: '',
          })));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (parts.length === 3 && parts[2] === 'merge') {
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'PUT') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendError(res, 400, 'Problems parsing JSON');
            return;
          }
          const merged = store.mergePull(repo, pull);
          if (typeof merged !== 'string') {
            sendError(res, merged.status, merged.error);
            return;
          }
          sendJson(res, 200, { sha: merged, merged: true, message: `Pull request #${pull.number} successfully merged` });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
  }

  async function putContents(req: IncomingMessage, res: ServerResponse, repo: Repo, contentPath: string): Promise<void> {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    const body = parsed.value as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    if (contentB64 === '') {
      sendError(res, 422, 'content is required');
      return;
    }
    let data: Buffer;
    try {
      data = Buffer.from(contentB64, 'base64');
    } catch {
      sendError(res, 422, 'content is not valid base64');
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
    let baseTree: string | null = null;
    let parents: string[] = [];
    if (tip !== ZERO_OID) {
      const commit = store.lookup(repo, tip);
      if (commit?.type === 'commit') {
        baseTree = parseCommit(commit.data).tree;
        parents = [tip];
      }
    } else if (branch !== repo.defaultBranch) {
      // A new branch starts from the default branch tip when the repository has one.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
      if (defaultTip !== ZERO_OID) {
        const commit = store.lookup(repo, defaultTip);
        if (commit?.type === 'commit') {
          baseTree = parseCommit(commit.data).tree;
          parents = [defaultTip];
        }
      }
    }
    const existing = tip !== ZERO_OID ? store.fileAt(repo, tip, contentPath) : null;
    if (typeof body.sha === 'string' && body.sha !== '') {
      if (!existing || existing.oid !== body.sha) {
        sendError(res, 409, 'Conflict: sha does not match the current file');
        return;
      }
    }
    const blobOid = store.putObject(repo, 'blob', data);
    const newTree = store.updateTree(repo, baseTree, contentPath, blobOid);
    const commitSha = store.makeCommit(repo, { tree: newTree, parents, message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    const status = existing ? 200 : 201;
    sendJson(res, status, {
      content: {
        name: contentPath.split('/').pop() ?? contentPath,
        path: contentPath,
        sha: blobOid,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        url: '',
        git_url: '',
        html_url: '',
        download_url: null,
      },
      commit: { sha: commitSha, message },
    });
  }

  return server;
}

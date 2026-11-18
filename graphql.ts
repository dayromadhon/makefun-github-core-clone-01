// GraphQL v4 for the documents gh and github-mcp-server actually send: a small parser for
// the query/mutation subset they use (variables, aliases, inline input objects and lists,
// inline fragments, batched operation arrays) and an executor over the forge's store.
// Unknown fields answer HTTP 200 with an errors array naming the field, exactly as GitHub does.

import {
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface Selection {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[] | null;
  fragmentType: string | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableNames: string[];
  selections: Selection[];
}

class ParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]+/.test(this.text[this.pos])) this.pos++;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
        continue;
      }
      break;
    }
  }

  peek(): string {
    const saved = this.pos;
    try {
      return this.next();
    } finally {
      this.pos = saved;
    }
  }

  next(): string {
    this.skipIgnored();
    if (this.pos >= this.text.length) return '';
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      return '...';
    }
    const ch = this.text[this.pos];
    if ('{}()[]:!=$@&|'.includes(ch)) {
      this.pos++;
      return ch;
    }
    if (ch === '"') {
      let out = '';
      this.pos++;
      while (this.pos < this.text.length && this.text[this.pos] !== '"') {
        if (this.text[this.pos] === '\\' && this.pos + 1 < this.text.length) {
          const esc = this.text[this.pos + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          this.pos += 2;
        } else {
          out += this.text[this.pos++];
        }
      }
      this.pos++;
      return JSON.stringify(out);
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(?:\.\d+)?/.exec(this.text.slice(this.pos));
    if (!match) throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
    this.pos += match[0].length;
    return match[0];
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${JSON.stringify(token)}, got ${JSON.stringify(got)}`);
  }
}

function isName(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token);
}

function parseValue(lexer: Lexer): Value {
  const token = lexer.next();
  if (token === '$') {
    const name = lexer.next();
    return { kind: 'variable', name };
  }
  if (token === '[') {
    const values: Value[] = [];
    while (lexer.peek() !== ']') values.push(parseValue(lexer));
    lexer.expect(']');
    return { kind: 'list', values };
  }
  if (token === '{') {
    const fields: Array<{ name: string; value: Value }> = [];
    while (lexer.peek() !== '}') {
      const name = lexer.next();
      lexer.expect(':');
      fields.push({ name, value: parseValue(lexer) });
    }
    lexer.expect('}');
    return { kind: 'object', fields };
  }
  if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
  if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
  if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
  if (token === 'true') return { kind: 'boolean', value: true };
  if (token === 'false') return { kind: 'boolean', value: false };
  if (token === 'null') return { kind: 'null' };
  if (isName(token)) return { kind: 'enum', value: token };
  throw new ParseError(`unexpected value token ${JSON.stringify(token)}`);
}

function parseSelectionSet(lexer: Lexer): Selection[] {
  lexer.expect('{');
  const selections: Selection[] = [];
  while (lexer.peek() !== '}') {
    if (lexer.peek() === '...') {
      lexer.next();
      let fragmentType: string | null = null;
      if (lexer.peek() === 'on') {
        lexer.next();
        fragmentType = lexer.next();
      } else {
        // A named fragment spread: not used by the suite's documents; skip its name.
        lexer.next();
      }
      const inner = parseSelectionSet(lexer);
      selections.push({ alias: null, name: '', args: [], selections: inner, fragmentType });
      continue;
    }
    const first = lexer.next();
    let alias: string | null = null;
    let name = first;
    if (lexer.peek() === ':') {
      lexer.next();
      alias = first;
      name = lexer.next();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (lexer.peek() === '(') {
      lexer.next();
      while (lexer.peek() !== ')') {
        const argName = lexer.next();
        lexer.expect(':');
        args.push({ name: argName, value: parseValue(lexer) });
      }
      lexer.expect(')');
    }
    let inner: Selection[] | null = null;
    if (lexer.peek() === '{') inner = parseSelectionSet(lexer);
    selections.push({ alias, name, args, selections: inner, fragmentType: null });
  }
  lexer.expect('}');
  return selections;
}

function parseOperation(lexer: Lexer): Operation {
  let type: 'query' | 'mutation' = 'query';
  const token = lexer.peek();
  if (token === 'query' || token === 'mutation') {
    type = lexer.next() as 'query' | 'mutation';
  }
  let name: string | null = null;
  if (isName(lexer.peek())) name = lexer.next();
  const variableNames: string[] = [];
  if (lexer.peek() === '(') {
    lexer.next();
    while (lexer.peek() !== ')') {
      if (lexer.peek() === '$') {
        lexer.next();
        variableNames.push(lexer.next());
      } else {
        lexer.next();
      }
      // Skip the variable's type: names, brackets, bangs.
      while (![')', ','].includes(lexer.peek()) && lexer.peek() !== '$' && lexer.peek() !== '') lexer.next();
      if (lexer.peek() === ',') lexer.next();
    }
    lexer.expect(')');
  }
  const selections = parseSelectionSet(lexer);
  return { type, name, variableNames, selections };
}

export function parseDocument(query: string): Operation[] {
  const lexer = new Lexer(query);
  const operations: Operation[] = [];
  while (lexer.peek() !== '') operations.push(parseOperation(lexer));
  if (operations.length === 0) throw new ParseError('empty document');
  return operations;
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

export interface GraphQLContext {
  store: Store;
}

class FieldError extends Error {
  readonly field: string;
  readonly type: string;
  constructor(field: string, type: string) {
    super(`Cannot query field "${field}" on type "${type}".`);
    this.field = field;
    this.type = type;
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of selection.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'labels', 'comments'];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRef', 'baseRef', 'files', 'url', 'createdAt', 'author',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  'url', 'createdAt',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL'];

function typeFields(type: string): string[] | null {
  switch (type) {
    case 'Issue':
      return ISSUE_FIELDS;
    case 'PullRequest':
      return PULL_REQUEST_FIELDS;
    case 'Repository':
      return REPOSITORY_FIELDS;
    case 'User':
      return ['id', 'login', 'name', 'email'];
    case 'Ref':
      return ['name'];
    case 'IssueConnection':
      return ['nodes', 'pageInfo', 'totalCount'];
    case 'PullRequestConnection':
      return ['nodes', 'pageInfo', 'totalCount'];
    case 'PullRequestChangedFileConnection':
      return ['nodes', 'pageInfo', 'totalCount'];
    case 'PullRequestChangedFile':
      return ['path'];
    case 'PageInfo':
      return ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'];
    case '__Type':
      return ['name', 'fields', 'enumValues'];
    case '__Field':
      return ['name'];
    case '__EnumValue':
      return ['name'];
    default:
      return null;
  }
}

function checkField(type: string, field: string): void {
  const fields = typeFields(type);
  if (fields !== null && !fields.includes(field)) throw new FieldError(field, type);
}

interface IssueNode {
  __type: 'Issue';
  repo: Repo;
  issue: Issue;
}

interface PullNode {
  __type: 'PullRequest';
  repo: Repo;
  pull: Pull;
}

interface RepoNode {
  __type: 'Repository';
  repo: Repo;
}

type NodeValue = IssueNode | PullNode | RepoNode | { __type: string; [key: string]: unknown } | null;

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoUrl(store: Store, repo: Repo): string {
  return `/${store.viewerLogin}/${repo.name}`;
}

function issueNodeId(store: Store, repo: Repo, issue: Issue): IssueNode {
  void store;
  return { __type: 'Issue', repo, issue };
}

function pullNodeId(store: Store, repo: Repo, pull: Pull): PullNode {
  void store;
  return { __type: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

/** The field selections under a connection's `nodes` sub-selection (null when absent). */
function nodeSubSelections(connection: Selection): Selection[] | null {
  const nodes = connection.selections?.find((s) => s.name === 'nodes' && s.fragmentType === null) ?? null;
  return nodes?.selections ?? null;
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

class Executor {
  private readonly store: Store;
  private readonly variables: Record<string, unknown>;

  constructor(store: Store, variables: Record<string, unknown>) {
    this.store = store;
    this.variables = variables;
  }

  private select(source: unknown, type: string, selections: Selection[] | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (selections === null) return out;
    for (const selection of selections) {
      if (selection.fragmentType !== null) {
        // An inline fragment applies only when its type matches the value's type.
        const valueType = (source as { __type?: string })?.__type ?? type;
        if (selection.fragmentType !== valueType) continue;
        Object.assign(out, this.select(source, type, selection.selections));
        continue;
      }
      checkField(type, selection.name);
      const key = selection.alias ?? selection.name;
      out[key] = this.field(source, type, selection);
    }
    return out;
  }

  private field(source: unknown, type: string, selection: Selection): unknown {
    const args = argsOf(selection, this.variables);
    switch (type) {
      case 'Query':
        return this.queryField(selection.name, args, selection);
      case 'Repository':
        return this.repositoryField(source as RepoNode, selection, args);
      case 'Issue':
        return this.issueField(source as IssueNode, selection, args);
      case 'PullRequest':
        return this.pullRequestField(source as PullNode, selection, args);
      case 'User':
        return this.userField(source as { login: string; id: number; name: string }, selection);
      case 'Ref':
        return (source as { name: string })[selection.name as 'name'];
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection':
        return this.connectionField(source as { nodes: unknown[]; pageInfo: unknown }, selection, type);
      case 'PageInfo':
        return (source as Record<string, unknown>)[selection.name];
      case '__Type':
        return this.introspectionField(source as { name: string; kind: string }, selection, args);
      case '__Field':
      case '__EnumValue':
        return (source as { name: string })[selection.name as 'name'];
      default:
        return null;
    }
  }

  private queryField(name: string, args: Record<string, unknown>, selection: Selection): unknown {
    if (name === '__type') {
      const typeName = args.name as string;
      if (typeName === 'Issue' || typeName === 'PullRequest' || typeName === 'Repository') {
        return this.select({ __type: '__Type', name: typeName, kind: 'object' }, '__Type', selection.selections);
      }
      if (typeName === 'SearchType') {
        return this.select({ __type: '__Type', name: typeName, kind: 'enum' }, '__Type', selection.selections);
      }
      return null;
    }
    if (name === 'viewer') {
      const viewer = { login: this.store.viewerLogin, id: this.store.viewerId, name: this.store.viewerLogin };
      return this.select({ ...viewer, __type: 'User' }, 'User', selection.selections);
    }
    if (name === 'repository') {
      const repo = this.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return this.select({ __type: 'Repository', repo } as RepoNode, 'Repository', selection.selections);
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const repo = [...this.store.repos.values()].find((r) => r.nodeId === String(args.id));
        if (!repo) return null;
        return this.select({ __type: 'Repository', repo } as RepoNode, 'Repository', selection.selections);
      }
      if (decoded.kind === 'issue') {
        const [repoId, num] = decoded.key.split(':');
        const repo = [...this.store.repos.values()].find((r) => String(r.id) === repoId);
        const issue = repo?.issues.find((i) => i.number === Number(num));
        if (!repo || !issue) return null;
        return this.select(issueNodeId(this.store, repo, issue), 'Issue', selection.selections);
      }
      if (decoded.kind === 'pr') {
        const [repoId, num] = decoded.key.split(':');
        const repo = [...this.store.repos.values()].find((r) => String(r.id) === repoId);
        const pull = repo?.pulls.find((p) => p.number === Number(num));
        if (!repo || !pull) return null;
        return this.select(pullNodeId(this.store, repo, pull), 'PullRequest', selection.selections);
      }
      return null;
    }
    throw new FieldError(name, 'Query');
  }

  private repositoryField(node: RepoNode, selection: Selection, args: Record<string, unknown>): unknown {
    const repo = node.repo;
    const store = this.store;
    switch (selection.name) {
      case 'id':
        return repo.nodeId;
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner': {
        const owner = { login: repo.owner, id: store.viewerId, name: repo.owner };
        return this.select({ ...owner, __type: 'User' }, 'User', selection.selections);
      }
      case 'defaultBranchRef': {
        const tip = store.refTip(repo, `refs/heads/${repo.defaultBranch}`);
        if (tip === '0'.repeat(40)) return null;
        return this.select({ __type: 'Ref', name: repo.defaultBranch }, 'Ref', selection.selections);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.private;
      case 'url':
        return repoUrl(store, repo);
      case 'createdAt':
        return store.fixedStamp();
      case 'issue': {
        const issue = store.getIssue(repo, Number(args.number));
        if (!issue) return null;
        return this.select(issueNodeId(store, repo, issue), 'Issue', selection.selections);
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((i) => wanted.has(issueState(i)));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const direction = String(orderBy?.direction ?? 'ASC').toUpperCase();
        list.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
        // The node fields live under the `nodes` sub-selection, not under the connection itself.
        const nodeSelections = nodeSubSelections(selection);
        return this.connection(list, args, (issue) => this.select(issueNodeId(store, repo, issue), 'Issue', nodeSelections), 'IssueConnection');
      }
      case 'pullRequests': {
        const list = [...repo.pulls].filter((p) => p.state === 'open').sort((a, b) => b.createdSeq - a.createdSeq);
        const nodeSelections = nodeSubSelections(selection);
        return this.connection(list, args, (pull) => this.select(pullNodeId(store, repo, pull), 'PullRequest', nodeSelections), 'PullRequestConnection');
      }
      case 'pullRequest': {
        const pull = store.getPull(repo, Number(args.number));
        if (!pull) return null;
        return this.select(pullNodeId(store, repo, pull), 'PullRequest', selection.selections);
      }
      default:
        throw new FieldError(selection.name, 'Repository');
    }
  }

  private connection<T>(
    list: T[],
    args: Record<string, unknown>,
    mapNode: (item: T) => Record<string, unknown>,
    connectionType: string,
  ): Record<string, unknown> {
    const first = typeof args.first === 'number' ? args.first : undefined;
    const after = numberFromCursor(args.after);
    let start = 0;
    if (after !== null) {
      const index = list.findIndex((item) => (item as { number: number }).number === after);
      start = index >= 0 ? index + 1 : 0;
    }
    const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
    const hasNextPage = start + page.length < list.length;
    const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as { number: number }).number) : null;
    return {
      __type: connectionType,
      nodes: page.map(mapNode),
      pageInfo: { hasNextPage, endCursor },
    };
  }

  private connectionField(source: { nodes: unknown[]; pageInfo: unknown }, selection: Selection, type: string): unknown {
    if (selection.name === 'nodes') return source.nodes;
    if (selection.name === 'pageInfo') {
      return this.select(source.pageInfo, 'PageInfo', selection.selections);
    }
    if (selection.name === 'totalCount') return source.nodes.length;
    throw new FieldError(selection.name, type);
  }

  private issueField(node: IssueNode, selection: Selection, args: Record<string, unknown>): unknown {
    const issue = node.issue;
    void args;
    switch (selection.name) {
      case 'id':
        return issue.nodeId;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
      case 'url':
        return `/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
      case 'createdAt':
        return this.store.fixedStamp();
      case 'author': {
        const author = { login: this.store.viewerLogin, id: this.store.viewerId, name: this.store.viewerLogin };
        return this.select({ ...author, __type: 'User' }, 'User', selection.selections);
      }
      case 'labels':
        return { nodes: issue.labels.map((name) => ({ name })) };
      case 'comments':
        return { nodes: [] };
      default:
        throw new FieldError(selection.name, 'Issue');
    }
  }

  private pullRequestField(node: PullNode, selection: Selection, args: Record<string, unknown>): unknown {
    const pull = node.pull;
    const repo = node.repo;
    switch (selection.name) {
      case 'id':
        return pull.nodeId;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'mergeable': {
        if (pull.state !== 'open') return 'UNKNOWN';
        return this.store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRef': {
        const tip = this.store.refTip(repo, `refs/heads/${pull.headRef}`);
        if (tip === '0'.repeat(40)) return null;
        return this.select({ __type: 'Ref', name: pull.headRef }, 'Ref', selection.selections);
      }
      case 'baseRef': {
        const tip = this.store.refTip(repo, `refs/heads/${pull.baseRef}`);
        if (tip === '0'.repeat(40)) return null;
        return this.select({ __type: 'Ref', name: pull.baseRef }, 'Ref', selection.selections);
      }
      case 'files': {
        const files = this.store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((f) => ({ path: f.filename }));
        return { __type: 'PullRequestChangedFileConnection', nodes, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      case 'url':
        return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'createdAt':
        return this.store.fixedStamp();
      case 'author': {
        const author = { login: this.store.viewerLogin, id: this.store.viewerId, name: this.store.viewerLogin };
        return this.select({ ...author, __type: 'User' }, 'User', selection.selections);
      }
      default:
        throw new FieldError(selection.name, 'PullRequest');
    }
  }

  private userField(source: { login: string; id: number; name: string }, selection: Selection): unknown {
    switch (selection.name) {
      case 'login':
        return source.login;
      case 'id':
        return globalId('user', String(source.id));
      case 'name':
        return source.name;
      case 'email':
        return `${source.login}@example.invalid`;
      default:
        throw new FieldError(selection.name, 'User');
    }
  }

  private introspectionField(source: { name: string; kind: string }, selection: Selection, args: Record<string, unknown>): unknown {
    void args;
    if (selection.name === 'name') return source.name;
    if (selection.name === 'fields') {
      const fields = typeFields(source.name) ?? [];
      return fields.map((name) => ({ name }));
    }
    if (selection.name === 'enumValues') {
      if (source.name === 'SearchType') return SEARCH_TYPE_VALUES.map((name) => ({ name }));
      return [];
    }
    throw new FieldError(selection.name, '__Type');
  }

  execute(operation: Operation): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
    try {
      if (operation.type === 'mutation') {
        const data = this.mutation(operation);
        return { data };
      }
      const data = this.select({ __type: 'Query' }, 'Query', operation.selections);
      return { data };
    } catch (err) {
      if (err instanceof FieldError) {
        return { data: null, errors: [{ message: err.message }] };
      }
      throw err;
    }
  }

  private mutation(operation: Operation): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of operation.selections) {
      if (selection.fragmentType !== null) continue;
      const args = argsOf(selection, this.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const key = selection.alias ?? selection.name;
      switch (selection.name) {
        case 'createIssue': {
          const repo = [...this.store.repos.values()].find((r) => r.nodeId === String(input.repositoryId));
          if (!repo) throw new Error('createIssue: unknown repository');
          const created = this.store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
          if ('error' in created) throw new Error(`createIssue: ${created.error}`);
          out[key] = this.selectPayload('issue', repo, created, selection);
          break;
        }
        case 'closeIssue': {
          const decoded = decodeGlobalId(String(input.issueId ?? ''));
          let closed: { repo: Repo; issue: Issue } | null = null;
          if (decoded?.kind === 'issue') {
            const [repoId, num] = decoded.key.split(':');
            const repo = [...this.store.repos.values()].find((r) => String(r.id) === repoId);
            const issue = repo?.issues.find((i) => i.number === Number(num)) ?? null;
            if (issue && repo) {
              issue.state = 'closed';
              closed = { repo, issue };
            }
          }
          if (!closed) throw new Error('closeIssue: unknown issue');
          out[key] = this.selectPayload('issue', closed.repo, closed.issue, selection);
          break;
        }
        case 'createPullRequest': {
          const repo = [...this.store.repos.values()].find((r) => r.nodeId === String(input.repositoryId));
          if (!repo) throw new Error('createPullRequest: unknown repository');
          const created = this.store.createPull(repo, {
            title: String(input.title ?? ''),
            body: String(input.body ?? ''),
            head: String(input.headRefName ?? ''),
            base: String(input.baseRefName ?? ''),
          });
          if ('error' in created) throw new Error(`createPullRequest: ${created.error}`);
          out[key] = this.selectPayload('pullRequest', repo, created, selection);
          break;
        }
        case 'mergePullRequest': {
          const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
          let merged: { repo: Repo; pull: Pull } | null = null;
          if (decoded?.kind === 'pr') {
            const [repoId, num] = decoded.key.split(':');
            const repo = [...this.store.repos.values()].find((r) => String(r.id) === repoId);
            const pull = repo?.pulls.find((p) => p.number === Number(num)) ?? null;
            if (pull && repo) {
              const result = this.store.mergePull(repo, pull);
              if (typeof result === 'string') merged = { repo, pull };
              else throw new Error(`mergePullRequest: ${result.error}`);
            }
          }
          if (!merged) throw new Error('mergePullRequest: unknown pull request');
          out[key] = this.selectPayload('pullRequest', merged.repo, merged.pull, selection);
          break;
        }
        case 'addComment': {
          const decoded = decodeGlobalId(String(input.subjectId ?? ''));
          let comment: { id: string; body: string } | null = null;
          if (decoded?.kind === 'issue') {
            const [repoId, num] = decoded.key.split(':');
            const repo = [...this.store.repos.values()].find((r) => String(r.id) === repoId);
            if (repo) {
              const made = this.store.addComment(repo, Number(num), String(input.body ?? ''));
              if (made) comment = { id: made.nodeId, body: made.body };
            }
          }
          if (!comment) throw new Error('addComment: unknown subject');
          out[key] = this.selectPayload('commentEdge', null, comment, selection);
          break;
        }
        default:
          throw new FieldError(selection.name, 'Mutation');
      }
    }
    return out;
  }

  /** Resolve one mutation payload field (issue / pullRequest / commentEdge) against its record. */
  private selectPayload(
    field: string,
    repo: Repo | null,
    record: Issue | Pull | { id: string; body: string },
    selection: Selection,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const inner of selection.selections ?? []) {
      const key = inner.alias ?? inner.name;
      if (field === 'issue') {
        if (inner.name !== 'issue') throw new FieldError(inner.name, 'CreateIssuePayload');
        out[key] = this.select({ __type: 'Issue', repo: repo!, issue: record as Issue } as IssueNode, 'Issue', inner.selections);
      } else if (field === 'pullRequest') {
        if (inner.name !== 'pullRequest') throw new FieldError(inner.name, 'CreatePullRequestPayload');
        out[key] = this.select({ __type: 'PullRequest', repo: repo!, pull: record as Pull } as PullNode, 'PullRequest', inner.selections);
      } else {
        if (inner.name !== 'commentEdge') throw new FieldError(inner.name, 'AddCommentPayload');
        const comment = record as { id: string; body: string };
        const nodeOut: Record<string, unknown> = {};
        for (const edge of inner.selections ?? []) {
          if (edge.name !== 'node') throw new FieldError(edge.name, 'AddCommentPayload');
          const fields: Record<string, unknown> = {};
          for (const f of edge.selections ?? []) {
            if (f.name === 'id') fields.id = comment.id;
            else if (f.name === 'body') fields.body = comment.body;
            else throw new FieldError(f.name, 'IssueComment');
          }
          nodeOut.node = fields;
        }
        out[key] = nodeOut;
      }
    }
    return out;
  }
}

/** Run one operation document (or a batch array) and answer the GraphQL envelope(s). */
export function runGraphQL(
  store: Store,
  body: unknown,
): { status: number; payload: unknown } {
  const runOne = (operation: { query?: unknown; variables?: unknown }): unknown => {
    if (typeof operation.query !== 'string' || operation.query.trim() === '') {
      return { data: null, errors: [{ message: 'A query document is required.' }] };
    }
    let operations: Operation[];
    try {
      operations = parseDocument(operation.query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
    }
    const variables = (operation.variables ?? {}) as Record<string, unknown>;
    const executor = new Executor(store, variables);
    const chosen = operations[0];
    try {
      return executor.execute(chosen);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) {
    return { status: 200, payload: body.map((entry) => runOne((entry ?? {}) as { query?: unknown; variables?: unknown })) };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, payload: { errors: [{ message: 'The request body must be a JSON object.' }] } };
  }
  return { status: 200, payload: runOne(body as { query?: unknown; variables?: unknown }) };
}

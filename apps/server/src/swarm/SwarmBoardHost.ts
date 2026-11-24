// @effect-diagnostics nodeBuiltinImport:off -- hosts the installed Antigravity swarm_board ESM sidecar via node:module registerHooks.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { renderSwarmBoardPreloadScript } from "./SwarmBoardPreload.ts";

const SIDECAR_SDK_SPECIFIER = "sidecar_sdk";
const SIDECAR_SDK_URL = "t3-swarm-board:sidecar_sdk";
const CAPTURED_APP_SYMBOL = Symbol.for("t3.swarmBoard.capturedApp");

interface SidecarResponseLike {
  readonly body: string | Uint8Array;
  readonly status?: number;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

type SidecarHandler = (data: Record<string, string>) => unknown;

interface CapturedSidecarApp {
  readonly config: { conversationId: string };
  readonly pages: Map<string, SidecarHandler>;
  readonly apis: Map<string, SidecarHandler>;
}

const SIDECAR_SDK_SOURCE = `
const CAPTURED_APP_SYMBOL = Symbol.for("t3.swarmBoard.capturedApp");
export class Response {
  constructor(body, init = {}) {
    this.body = body;
    this.status = typeof init?.status === "number" ? init.status : 200;
    this.contentType = typeof init?.contentType === "string" ? init.contentType : undefined;
    this.headers = init?.headers && typeof init.headers === "object" ? { ...init.headers } : {};
  }
}
export class SidecarApp {
  constructor() {
    this.config = { conversationId: "" };
    this.pages = new Map();
    this.apis = new Map();
    globalThis[CAPTURED_APP_SYMBOL] = this;
  }
  page(route, handler) {
    this.pages.set(route, handler);
  }
  api(route, handler, method = "GET") {
    this.apis.set(\`\${String(method).toUpperCase()} \${route}\`, handler);
  }
  run() {}
}
`;

let hookRegistered = false;

function ensureSidecarSdkHook(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  NodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === SIDECAR_SDK_SPECIFIER) {
        return { url: SIDECAR_SDK_URL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === SIDECAR_SDK_URL) {
        return { format: "module", source: SIDECAR_SDK_SOURCE, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

interface LoadedSwarmBoard {
  readonly mtimeMs: number;
  readonly app: CapturedSidecarApp;
}

const loadedBoards = new Map<string, LoadedSwarmBoard>();
let loadQueue: Promise<unknown> = Promise.resolve();

function enqueueLoad<T>(work: () => Promise<T>): Promise<T> {
  const next = loadQueue.then(work, work);
  loadQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// Use Node's native createRequire (Node 26 loads ESM synchronously via require(esm)
// and honors Module.registerHooks, bypassing Vitest's module runner and bundler transforms).
const nativeRequire = NodeModule.createRequire(import.meta.url);

async function loadSwarmBoardApp(swarmBoardDir: string): Promise<CapturedSidecarApp | null> {
  const entryPath = NodePath.join(swarmBoardDir, "main.mjs");
  const stat = await NodeFSP.stat(entryPath).catch(() => null);
  if (stat === null || !stat.isFile()) return null;

  const cached = loadedBoards.get(entryPath);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
    return cached.app;
  }

  return enqueueLoad(async () => {
    const existing = loadedBoards.get(entryPath);
    if (existing !== undefined && existing.mtimeMs === stat.mtimeMs) {
      return existing.app;
    }
    ensureSidecarSdkHook();
    const globalBag = globalThis as Record<symbol, unknown>;
    globalBag[CAPTURED_APP_SYMBOL] = undefined;

    const previousOverview = process.env.SWARM_OVERVIEW;
    const previousGraph = process.env.SWARM_GRAPH_TAB;
    const previousRaw = process.env.SWARM_RAW_TAB;
    process.env.SWARM_OVERVIEW = "true";
    process.env.SWARM_GRAPH_TAB = "true";
    process.env.SWARM_RAW_TAB = "true";
    try {
      const resolved = nativeRequire.resolve(entryPath);
      delete nativeRequire.cache[resolved];
      nativeRequire(resolved);
      // Node's ESM cache does not re-execute an already-evaluated `.mjs` module on require(esm),
      // so keep the previously captured app if `new SidecarApp()` did not run again.
      const captured =
        (globalBag[CAPTURED_APP_SYMBOL] as CapturedSidecarApp | undefined) ?? existing?.app;
      if (captured === undefined) return null;
      loadedBoards.set(entryPath, { mtimeMs: stat.mtimeMs, app: captured });
      return captured;
    } finally {
      restoreEnv("SWARM_OVERVIEW", previousOverview);
      restoreEnv("SWARM_GRAPH_TAB", previousGraph);
      restoreEnv("SWARM_RAW_TAB", previousRaw);
    }
  });
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previous;
  }
}

export function rewriteSwarmBoardIndexHtml(html: string): string {
  return html.replace(/\b(src|href)="\/(?!\/)/g, '$1="./');
}

export function rewriteSwarmBoardHiveJs(js: string): string {
  return js.replace(/`\/api\/frame\?/g, "`./api/frame?");
}

export interface SwarmBoardDispatchResult {
  readonly status: number;
  readonly body: string | Uint8Array;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
}

function isSidecarResponse(value: unknown): value is SidecarResponseLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "body" in value &&
    (typeof (value as { body: unknown }).body === "string" ||
      (value as { body: unknown }).body instanceof Uint8Array)
  );
}

const STATIC_CACHE_CONTROL = "private, max-age=3600";
const DYNAMIC_CACHE_CONTROL = "private, no-store";
const CONVERSATION_ID_PATTERN = /^[0-9a-f-]{8,}$/i;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_ROSTER_BYTES = 1024 * 1024;
const ROSTER_SCAN_CACHE_TTL_MS = 3_000;

export interface SwarmMemberSummary {
  readonly name: string;
  readonly conversationId: string;
  readonly role: string;
  readonly model: string;
  readonly wakeMode: string;
  readonly killed: boolean;
  readonly lastReadSeq: number;
}

export interface SwarmTranscriptToolCall {
  readonly name: string;
  readonly args: unknown;
}

export interface SwarmTranscriptStep {
  readonly stepIndex: number;
  readonly source: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly thinking: string | null;
  readonly content: string | null;
  readonly error: string | null;
  readonly toolCalls: ReadonlyArray<SwarmTranscriptToolCall>;
}

export interface SwarmMemberTranscriptResponse {
  readonly conversationId: string;
  readonly swarmId: string;
  readonly swarmTitle: string;
  readonly member: SwarmMemberSummary;
  readonly truncated: boolean;
  readonly steps: ReadonlyArray<SwarmTranscriptStep>;
}

interface RawRosterMember {
  readonly conversation_id?: unknown;
  readonly role?: unknown;
  readonly model?: unknown;
  readonly wake_mode?: unknown;
  readonly killed?: unknown;
  readonly last_read_seq?: unknown;
}

interface RawRosterFile {
  readonly title?: unknown;
  readonly members?: Record<string, RawRosterMember>;
}

function parseRosterFile(filePath: string): RawRosterFile | null {
  try {
    const stat = NodeFS.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_ROSTER_BYTES) return null;
    const raw = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    return raw as RawRosterFile;
  } catch {
    return null;
  }
}

interface ResolvedSwarmRoster {
  readonly swarmId: string;
  readonly title: string;
  readonly members: ReadonlyArray<SwarmMemberSummary>;
}

const rosterScanCache = new Map<
  string,
  { readonly expiresAt: number; readonly rosters: ReadonlyArray<ResolvedSwarmRoster> }
>();

async function scanBrainSwarmRosters(
  brainDir: string,
): Promise<ReadonlyArray<ResolvedSwarmRoster>> {
  const now = performance.now();
  const cached = rosterScanCache.get(brainDir);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.rosters;
  }
  const entries = await NodeFSP.readdir(brainDir, { withFileTypes: true }).catch(() => []);
  const rosters: Array<ResolvedSwarmRoster> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CONVERSATION_ID_PATTERN.test(entry.name)) continue;
    const candidatePath = NodePath.join(
      brainDir,
      entry.name,
      ".system_generated",
      "swarm",
      "members.json",
    );
    const roster = parseRosterFile(candidatePath);
    if (roster === null) continue;
    rosters.push({
      swarmId: entry.name,
      title: typeof roster.title === "string" ? roster.title : "",
      members: rosterMembersList(roster),
    });
  }
  rosterScanCache.set(brainDir, { expiresAt: now + ROSTER_SCAN_CACHE_TTL_MS, rosters });
  return rosters;
}

function sameConversationId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function rosterMembersList(roster: RawRosterFile): ReadonlyArray<SwarmMemberSummary> {
  const members = roster.members;
  if (!members || typeof members !== "object") return [];
  const out: Array<SwarmMemberSummary> = [];
  for (const [name, entry] of Object.entries(members)) {
    if (!entry || typeof entry !== "object") continue;
    const conversationId = typeof entry.conversation_id === "string" ? entry.conversation_id : "";
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) continue;
    out.push({
      name,
      conversationId,
      role: typeof entry.role === "string" ? entry.role : "worker",
      model: typeof entry.model === "string" ? entry.model : "",
      wakeMode: typeof entry.wake_mode === "string" ? entry.wake_mode : "",
      killed: entry.killed === true,
      lastReadSeq: typeof entry.last_read_seq === "number" ? entry.last_read_seq : 0,
    });
  }
  return out;
}

async function resolveSwarmRosterForConversation(
  appDataDir: string,
  conversationId: string,
): Promise<ResolvedSwarmRoster | null> {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return null;
  const brainDir = NodePath.join(appDataDir, "brain");
  const directPath = NodePath.join(
    brainDir,
    conversationId,
    ".system_generated",
    "swarm",
    "members.json",
  );
  const directRoster = parseRosterFile(directPath);
  if (directRoster !== null) {
    return {
      swarmId: conversationId,
      title: typeof directRoster.title === "string" ? directRoster.title : "",
      members: rosterMembersList(directRoster),
    };
  }
  const rosters = await scanBrainSwarmRosters(brainDir);
  return (
    rosters.find((roster) =>
      roster.members.some((member) => sameConversationId(member.conversationId, conversationId)),
    ) ?? null
  );
}

function parseTranscriptLine(line: string, fallbackIndex: number): SwarmTranscriptStep | null {
  let row: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    row = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
  const toolCalls: Array<SwarmTranscriptToolCall> = [];
  for (const call of rawCalls) {
    if (typeof call !== "object" || call === null) continue;
    const record = call as Record<string, unknown>;
    if (typeof record.name !== "string") continue;
    toolCalls.push({ name: record.name, args: record.args ?? {} });
  }
  const contentValue =
    typeof row.content === "string"
      ? row.content
      : typeof row.response === "string"
        ? row.response
        : typeof row.text === "string"
          ? row.text
          : null;
  return {
    stepIndex: typeof row.step_index === "number" ? row.step_index : fallbackIndex,
    source: typeof row.source === "string" ? row.source : "UNKNOWN",
    type: typeof row.type === "string" ? row.type : "GENERIC",
    status: typeof row.status === "string" ? row.status : "DONE",
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    model: typeof row.model === "string" ? row.model : null,
    inputTokens: typeof row.input_tokens === "number" ? row.input_tokens : null,
    outputTokens: typeof row.output_tokens === "number" ? row.output_tokens : null,
    cacheReadTokens: typeof row.cache_read_tokens === "number" ? row.cache_read_tokens : null,
    thinking: typeof row.thinking === "string" && row.thinking.length > 0 ? row.thinking : null,
    content: contentValue !== null && contentValue.length > 0 ? contentValue : null,
    error: typeof row.error === "string" && row.error.length > 0 ? row.error : null,
    toolCalls,
  };
}

async function isContainedUnderRoot(filePath: string, rootDir: string): Promise<boolean> {
  try {
    const [realFile, realRoot] = await Promise.all([
      NodeFSP.realpath(filePath),
      NodeFSP.realpath(rootDir),
    ]);
    const normalizedRoot = realRoot.endsWith(NodePath.sep)
      ? realRoot
      : `${realRoot}${NodePath.sep}`;
    return NodePath.sep === "\\"
      ? realFile.toLowerCase().startsWith(normalizedRoot.toLowerCase())
      : realFile.startsWith(normalizedRoot);
  } catch {
    return false;
  }
}

async function readBoundedTextTail(
  filePath: string,
  rootDir: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean } | null> {
  if (!(await isContainedUnderRoot(filePath, rootDir))) return null;
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(filePath, NodeFS.constants.O_RDONLY);
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size === 0) return { text: "", truncated: false };
    const truncated = stat.size > maxBytes;
    const start = truncated ? stat.size - maxBytes : 0;
    const toRead = stat.size - start;
    const buffer = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await handle.read(buffer, offset, toRead - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (truncated) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return { text, truncated };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readSwarmMemberTranscript(input: {
  readonly appDataDir: string;
  readonly threadConversationId: string;
  readonly targetConversationId: string;
}): Promise<SwarmMemberTranscriptResponse | null> {
  if (
    !CONVERSATION_ID_PATTERN.test(input.threadConversationId) ||
    !CONVERSATION_ID_PATTERN.test(input.targetConversationId)
  ) {
    return null;
  }

  const swarm = await resolveSwarmRosterForConversation(
    input.appDataDir,
    input.threadConversationId,
  );
  if (swarm === null) return null;

  const member = swarm.members.find((candidate) =>
    sameConversationId(candidate.conversationId, input.targetConversationId),
  );
  if (member === undefined) return null;

  const brainDir = NodePath.join(input.appDataDir, "brain");
  const logsDir = NodePath.join(brainDir, member.conversationId, ".system_generated", "logs");
  const fullPath = NodePath.join(logsDir, "transcript_full.jsonl");
  const compactPath = NodePath.join(logsDir, "transcript.jsonl");
  const fullTail = await readBoundedTextTail(fullPath, brainDir, MAX_TRANSCRIPT_BYTES);
  // If an oversized final line in transcript_full.jsonl left no complete lines in the 2 MiB tail,
  // fall back to compact transcript.jsonl so the viewer still shows steps.
  const tail =
    fullTail !== null && (!fullTail.truncated || fullTail.text.trim().length > 0)
      ? fullTail
      : ((await readBoundedTextTail(compactPath, brainDir, MAX_TRANSCRIPT_BYTES)) ?? fullTail);

  const steps: Array<SwarmTranscriptStep> = [];
  if (tail !== null && tail.text.length > 0) {
    const lines = tail.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = parseTranscriptLine(trimmed, index);
      if (parsed !== null) {
        steps.push(parsed);
      }
    }
  }

  return {
    conversationId: member.conversationId,
    swarmId: swarm.swarmId,
    swarmTitle: swarm.title,
    member,
    truncated: tail?.truncated ?? false,
    steps,
  };
}

export async function resolveSwarmAppDataDirectory(input: {
  readonly stateDir: string;
  readonly primaryAppDataDir: string;
  readonly conversationId: string;
  readonly fallbackProvidersRoot?: string;
}): Promise<string> {
  if (!CONVERSATION_ID_PATTERN.test(input.conversationId)) {
    return input.primaryAppDataDir;
  }
  const hasConversation = async (appDataDir: string): Promise<boolean> => {
    if (NodeFS.existsSync(NodePath.join(appDataDir, "brain", input.conversationId))) {
      return true;
    }
    return (await resolveSwarmRosterForConversation(appDataDir, input.conversationId)) !== null;
  };

  if (await hasConversation(input.primaryAppDataDir)) {
    return input.primaryAppDataDir;
  }

  const fallbackRoot =
    input.fallbackProvidersRoot ??
    NodePath.join(NodeOS.homedir(), ".t3", "userdata", "providers", "antigravity");
  const primaryProvidersRoot = NodePath.join(input.stateDir, "providers", "antigravity");
  if (NodePath.resolve(fallbackRoot) === NodePath.resolve(primaryProvidersRoot)) {
    return input.primaryAppDataDir;
  }

  const profileHash = NodePath.basename(NodePath.dirname(input.primaryAppDataDir));
  const candidates: Array<string> = [NodePath.join(fallbackRoot, profileHash, "antigravity-acp")];
  const entries = await NodeFSP.readdir(fallbackRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = NodePath.join(fallbackRoot, entry.name, "antigravity-acp");
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  for (const candidate of candidates) {
    if (await hasConversation(candidate)) {
      return candidate;
    }
  }
  return input.primaryAppDataDir;
}

export async function findSwarmBoardDirectory(
  stateDir: string,
  preferredAppDataDir: string | null,
): Promise<string | null> {
  const candidates: Array<string> = [];
  if (preferredAppDataDir !== null) {
    candidates.push(
      NodePath.join(preferredAppDataDir, "builtin", "plugins", "swarm", "sidecars", "swarm_board"),
    );
  }
  const providerRoots = [
    NodePath.join(stateDir, "providers", "antigravity"),
    // Dev servers default to ~/.t3/dev; fall back read-only to the installed UI assets under ~/.t3/userdata.
    NodePath.join(NodeOS.homedir(), ".t3", "userdata", "providers", "antigravity"),
  ];
  for (const providersRoot of providerRoots) {
    const entries = await NodeFSP.readdir(providersRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = NodePath.join(
        providersRoot,
        entry.name,
        "antigravity-acp",
        "builtin",
        "plugins",
        "swarm",
        "sidecars",
        "swarm_board",
      );
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  for (const candidate of candidates) {
    if (NodeFS.existsSync(NodePath.join(candidate, "main.mjs"))) {
      return candidate;
    }
  }
  return null;
}

export async function dispatchSwarmBoardRequest(input: {
  readonly swarmBoardDir: string;
  readonly appDataDir: string | null;
  readonly conversationId: string | null;
  readonly routePath: string;
  readonly searchParams: URLSearchParams;
}): Promise<SwarmBoardDispatchResult> {
  if (input.routePath === "/preload.js") {
    return {
      status: 200,
      body: renderSwarmBoardPreloadScript(),
      contentType: "application/javascript; charset=utf-8",
      headers: {
        "cache-control": DYNAMIC_CACHE_CONTROL,
        "x-content-type-options": "nosniff",
      },
    };
  }

  const app = await loadSwarmBoardApp(input.swarmBoardDir);
  if (app === null) {
    return {
      status: 503,
      body: "Swarm board runtime is unavailable.",
      contentType: "text/plain; charset=utf-8",
      headers: { "cache-control": DYNAMIC_CACHE_CONTROL },
    };
  }

  if (input.routePath === "/") {
    const pageHandler = app.pages.get("/");
    if (!pageHandler) {
      return {
        status: 404,
        body: "Not Found",
        contentType: "text/plain; charset=utf-8",
        headers: { "cache-control": DYNAMIC_CACHE_CONTROL },
      };
    }
    const rawHtml = String(pageHandler({}));
    return {
      status: 200,
      body: rewriteSwarmBoardIndexHtml(rawHtml),
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": DYNAMIC_CACHE_CONTROL,
        "x-content-type-options": "nosniff",
      },
    };
  }

  const apiHandler = app.apis.get(`GET ${input.routePath}`);
  if (!apiHandler) {
    return {
      status: 404,
      body: "Not Found",
      contentType: "text/plain; charset=utf-8",
      headers: { "cache-control": DYNAMIC_CACHE_CONTROL },
    };
  }

  const isDataApi = input.routePath.startsWith("/api/");
  if (isDataApi && (input.conversationId === null || input.appDataDir === null)) {
    if (input.routePath === "/api/frame") {
      return {
        status: 404,
        body: "not found",
        contentType: "text/plain; charset=utf-8",
        headers: { "cache-control": DYNAMIC_CACHE_CONTROL },
      };
    }
    const emptyPayload =
      input.routePath === "/api/swarm/messages"
        ? { conversationId: null, swarm: null, messages: [] }
        : input.routePath === "/api/swarm/raw"
          ? { conversationId: null, swarm: null, raw: null }
          : { conversationId: null, swarm: null, member: null };
    return {
      status: 200,
      body: JSON.stringify(emptyPayload),
      contentType: "application/json; charset=utf-8",
      headers: {
        "cache-control": DYNAMIC_CACHE_CONTROL,
        "x-content-type-options": "nosniff",
      },
    };
  }

  const data: Record<string, string> = {};
  for (const [key, value] of input.searchParams.entries()) {
    data[key] = value;
  }
  // Always bind data API queries to the thread's resolved Antigravity conversation.
  if (isDataApi && input.conversationId !== null) {
    data.conversationId = input.conversationId;
  }

  const previousDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (input.appDataDir !== null) {
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = NodePath.join(
      input.appDataDir,
      "sidecar_data",
      "swarm",
      "swarm_board",
      "data",
    );
  }
  let result: unknown;
  try {
    result = apiHandler(data);
  } finally {
    restoreEnv("ANTIGRAVITY_EXECUTABLE_DATA_DIR", previousDataDir);
  }

  if (isSidecarResponse(result)) {
    const body =
      input.routePath === "/hive.js" && typeof result.body === "string"
        ? rewriteSwarmBoardHiveJs(result.body)
        : result.body;
    const headers: Record<string, string> = {
      "cache-control": isDataApi ? DYNAMIC_CACHE_CONTROL : STATIC_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
      ...result.headers,
    };
    return {
      status: result.status ?? 200,
      body,
      contentType: result.contentType ?? "application/octet-stream",
      headers,
    };
  }

  return {
    status: 200,
    body: JSON.stringify(result),
    contentType: "application/json; charset=utf-8",
    headers: {
      "cache-control": DYNAMIC_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
    },
  };
}

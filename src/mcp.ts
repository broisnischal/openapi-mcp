import { dirname, join } from "node:path";
import { mkdir, access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type OpenApiParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
};

type OpenApiSpec = {
  openapi?: string;
  info?: { title?: string; version?: string };
  servers?: Array<{ url: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

type OperationEntry = {
  method: string;
  path: string;
  operationId: string;
  summary?: string;
  description?: string;
  parameters: OpenApiParameter[];
};

type SessionState = {
  variables: Record<string, Json>;
  authProfiles: Record<string, AuthProfile>;
  activeAuthProfile?: string;
  lastResponse?: {
    status: number;
    url: string;
    method: string;
    headers: Record<string, string>;
    data: Json | string;
  };
};

type ToolInput = {
  sessionId?: string;
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | null>;
  headers?: Record<string, string>;
  body?: Json;
  extractVariables?: Record<string, string>;
  authProfile?: string;
};

type AuthProfile =
  | { type: "bearer"; token: string; prefix?: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apiKey"; in: "header" | "query"; key: string; value: string }
  | { type: "oauthToken"; accessToken: string; tokenType?: string };

type ExecuteExpectations = {
  status?: number | number[];
  headers?: Record<string, string>;
  jsonPathEquals?: Record<string, Json | string | number | boolean | null>;
};

type SpecRuntime = {
  specUrl: string;
  specFile: string;
  baseUrl: string;
  operations: OperationEntry[];
  byOperationId: Map<string, OperationEntry>;
  byMethodPath: Map<string, OperationEntry>;
};

type CreateMcpServerOptions = {
  defaultSpecUrl?: string;
  specFetchHeaders?: Record<string, string>;
};

const USER_CACHE_ROOT = join(homedir(), ".openapi-mcp");
/** Default cache path when OPENAPI_SPEC_FILE is unset (user home openapi.json). */
const DEFAULT_SPEC_CACHE_FILE = join(USER_CACHE_ROOT, "openapi.json");
const OPENAPI_CACHE_DIR = join(USER_CACHE_ROOT, "cache");
const API_BASE_URL = process.env.API_BASE_URL;
const ENABLE_SERVER_FILE_CACHE =
  process.env.OPENAPI_SERVER_FILE_CACHE?.trim().toLowerCase() === "1" ||
  process.env.OPENAPI_SERVER_FILE_CACHE?.trim().toLowerCase() === "true";
const DEFAULT_SESSION_ID = "default";

function getExplicitOpenApiSpecUrl(): string | undefined {
  const raw = process.env.OPENAPI_SPEC_URL;
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Where to persist the fetched spec (env overrides default cache path). */
function resolveOpenApiSpecFilePath(): string {
  const raw = process.env.OPENAPI_SPEC_FILE?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SPEC_CACHE_FILE;
}

function isOpenApiOfflineMode(): boolean {
  const v = process.env.OPENAPI_SPEC_OFFLINE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function normalizeSpecUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v) return undefined;
  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v) ? v : `https://${v}`;
  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function cacheFileForSpecUrl(specUrl: string): string {
  const hash = createHash("sha256").update(specUrl).digest("hex");
  return join(OPENAPI_CACHE_DIR, `${hash}.openapi.json`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Short tool names stay under MCP client limits (server name + tool name ≤ ~60). */
const TOOL_SEARCH = "api_search";
const TOOL_EXECUTE = "api_execute";
const TOOL_SESSION = "session";
const TOOL_REFETCH_SPEC = "api_refetch_spec";
const TOOL_PLAN_INTEGRATION = "api_plan_integration";

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { variables: {}, authProfiles: {} });
  }
  return sessions.get(sessionId)!;
}

function scoreNeedleInHaystack(needle: string, haystack: string): number {
  const n = needle.trim().toLowerCase();
  const h = haystack.toLowerCase();
  if (!n || !h) return 0;
  if (h === n) return 100;
  if (h.startsWith(n)) return 90;
  if (h.includes(n)) return 75;
  const tokens = n.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const t of tokens) {
    if (h.includes(t)) score += 20;
  }
  return score;
}

function suggestOperations(
  operations: OperationEntry[],
  args: { operationId?: string; method?: string; path?: string },
  limit: number,
): Array<{ operationId: string; method: string; path: string; summary: string | null }> {
  const needle = [args.operationId, args.method, args.path]
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .join(" ")
    .trim();
  if (!needle) return [];
  return operations
    .map((op) => {
      const haystack = `${op.operationId} ${op.method} ${op.path} ${op.summary ?? ""}`;
      return { op, score: scoreNeedleInHaystack(needle, haystack) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ op }) => ({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      summary: op.summary ?? null,
    }));
}

function applyAuthProfile(
  auth: AuthProfile | undefined,
  headers: Record<string, string>,
  url: URL,
): void {
  if (!auth) return;
  if (auth.type === "bearer") {
    const prefix = auth.prefix?.trim() || "Bearer";
    headers.authorization = `${prefix} ${auth.token}`;
    return;
  }
  if (auth.type === "oauthToken") {
    const tokenType = auth.tokenType?.trim() || "Bearer";
    headers.authorization = `${tokenType} ${auth.accessToken}`;
    return;
  }
  if (auth.type === "basic") {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString(
      "base64",
    );
    headers.authorization = `Basic ${encoded}`;
    return;
  }
  if (auth.type === "apiKey") {
    if (auth.in === "header") {
      headers[auth.key] = auth.value;
    } else {
      url.searchParams.set(auth.key, auth.value);
    }
  }
}

function normalizeAuthProfile(input: unknown): AuthProfile | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const type = obj.type;
  if (type === "bearer" && typeof obj.token === "string") {
    return {
      type,
      token: obj.token,
      prefix: typeof obj.prefix === "string" ? obj.prefix : undefined,
    };
  }
  if (
    type === "basic" &&
    typeof obj.username === "string" &&
    typeof obj.password === "string"
  ) {
    return { type, username: obj.username, password: obj.password };
  }
  if (
    type === "apiKey" &&
    (obj.in === "header" || obj.in === "query") &&
    typeof obj.key === "string" &&
    typeof obj.value === "string"
  ) {
    return { type, in: obj.in, key: obj.key, value: obj.value };
  }
  if (type === "oauthToken" && typeof obj.accessToken === "string") {
    return {
      type,
      accessToken: obj.accessToken,
      tokenType: typeof obj.tokenType === "string" ? obj.tokenType : undefined,
    };
  }
  return undefined;
}

function evaluateAssertions(
  result: { status: number; data: Json | string; headers?: Record<string, string> },
  expect: ExecuteExpectations | undefined,
) {
  const checks: Array<{
    type: "status" | "header" | "jsonPathEquals";
    target: string;
    expected: unknown;
    actual: unknown;
    passed: boolean;
  }> = [];
  if (!expect) return { passed: true, checks };

  if (expect.status !== undefined) {
    const expectedStatuses = Array.isArray(expect.status)
      ? expect.status
      : [expect.status];
    const passed = expectedStatuses.includes(result.status);
    checks.push({
      type: "status",
      target: "status",
      expected: expectedStatuses,
      actual: result.status,
      passed,
    });
  }

  if (expect.headers) {
    for (const [headerName, expectedValue] of Object.entries(expect.headers)) {
      const actual = result.headers?.[headerName.toLowerCase()] ?? null;
      checks.push({
        type: "header",
        target: headerName,
        expected: expectedValue,
        actual,
        passed: actual === expectedValue,
      });
    }
  }

  if (expect.jsonPathEquals) {
    for (const [jsonPath, expectedValue] of Object.entries(expect.jsonPathEquals)) {
      const actual = getByPath(result.data, jsonPath);
      checks.push({
        type: "jsonPathEquals",
        target: jsonPath,
        expected: expectedValue,
        actual: actual ?? null,
        passed: actual === expectedValue,
      });
    }
  }

  return { passed: checks.every((c) => c.passed), checks };
}

function interpolateVariables<T extends Json | string>(
  value: T,
  vars: Record<string, Json>,
): T {
  const replace = (input: string): string =>
    input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
      const v = getByPath(vars, key);
      if (v === undefined || v === null) return "";
      return typeof v === "string" ? v : JSON.stringify(v);
    });

  const walk = (node: Json | string): Json | string => {
    if (typeof node === "string") return replace(node);
    if (Array.isArray(node))
      return node.map((item) => walk(item as Json)) as Json[];
    if (node && typeof node === "object") {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v as Json) as Json;
      }
      return out;
    }
    return node;
  };

  return walk(value) as T;
}

function getByPath(obj: unknown, path: string): unknown {
  const cleanPath = path.replace(/^\$\./, "").replace(/^\$/, "");
  if (!cleanPath) return obj;
  const keys = cleanPath.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function collectOperations(spec: OpenApiSpec): OperationEntry[] {
  const ops: OperationEntry[] = [];
  const paths = spec.paths ?? {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const upperMethod = method.toUpperCase();
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/i.test(method)) {
        continue;
      }
      const operationId =
        operation.operationId ??
        `${upperMethod.toLowerCase()}_${path.replace(/[{}\/]/g, "_")}`;
      ops.push({
        method: upperMethod,
        path,
        operationId,
        summary: operation.summary,
        description: operation.description,
        parameters: operation.parameters ?? [],
      });
    }
  }
  return ops;
}

function buildOperationMaps(operations: OperationEntry[]) {
  const byOperationId = new Map<string, OperationEntry>();
  const byMethodPath = new Map<string, OperationEntry>();
  for (const op of operations) {
    if (!byOperationId.has(op.operationId)) {
      byOperationId.set(op.operationId, op);
    }
    const key = `${op.method} ${op.path}`;
    if (!byMethodPath.has(key)) {
      byMethodPath.set(key, op);
    }
  }
  return { byOperationId, byMethodPath };
}

function searchOperations(
  operations: OperationEntry[],
  query: string,
  limit: number,
): OperationEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return operations.slice(0, limit);
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = operations
    .map((op) => {
      const haystack = [
        op.operationId,
        op.method,
        op.path,
        op.summary ?? "",
        op.description ?? "",
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (haystack.includes(t)) score += 3;
        else if (tokens.length === 1 && haystack.includes(q)) score += 5;
      }
      return { op, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.op);
}

async function loadOpenApiSpec(): Promise<OpenApiSpec> {
  const specFile = resolveOpenApiSpecFilePath();
  const specUrl = normalizeSpecUrl(getExplicitOpenApiSpecUrl());
  if (!specUrl) {
    throw new Error(
      "Missing OPENAPI_SPEC_URL. Set it to a valid HTTP/HTTPS OpenAPI JSON endpoint.",
    );
  }

  if (isOpenApiOfflineMode()) {
    if (!(await fileExists(specFile))) {
      throw new Error(
        `OPENAPI_SPEC_OFFLINE is set but spec file is missing: ${specFile}`,
      );
    }
    return JSON.parse(await readFile(specFile, "utf8")) as OpenApiSpec;
  }

  const specResponse = await fetch(specUrl, {
    headers: {
      accept: "application/json, */*",
      "user-agent": "openapi-proxy-mcp/0.2.0",
    },
  });

  if (specResponse.ok) {
    const spec = (await specResponse.json()) as OpenApiSpec;
    await ensureParentDirectory(specFile);
    await writeFile(specFile, JSON.stringify(spec, null, 2), "utf8");
    console.info(`Synced OpenAPI spec from ${specUrl} -> ${specFile}`);
    return spec;
  }

  if (await fileExists(specFile)) {
    console.warn(
      `OpenAPI fetch failed (${specResponse.status} ${specResponse.statusText}); using cached ${specFile}`,
    );
    return JSON.parse(await readFile(specFile, "utf8")) as OpenApiSpec;
  }

  throw new Error(
    `Failed to load OpenAPI spec: ${specResponse.status} ${specResponse.statusText}. No cache at ${specFile}. Check network or set OPENAPI_SPEC_OFFLINE=1 with a local file.`,
  );
}

async function loadSpecRuntime(
  specUrl: string,
  specFile: string,
  specFetchHeaders?: Record<string, string>,
): Promise<SpecRuntime> {
  const specResponse = await fetch(specUrl, {
    headers: {
      accept: "application/json, */*",
      "user-agent": "openapi-proxy-mcp/0.3.0",
      ...(specFetchHeaders ?? {}),
    },
  });

  let spec: OpenApiSpec;
  if (specResponse.ok) {
    spec = (await specResponse.json()) as OpenApiSpec;
    if (ENABLE_SERVER_FILE_CACHE) {
      await ensureParentDirectory(specFile);
      await writeFile(specFile, JSON.stringify(spec, null, 2), "utf8");
      console.info(`Synced OpenAPI spec from ${specUrl} -> ${specFile}`);
    }
  } else {
    if (ENABLE_SERVER_FILE_CACHE && (await fileExists(specFile))) {
      console.warn(
        `OpenAPI fetch failed (${specResponse.status} ${specResponse.statusText}); using cached ${specFile}`,
      );
      spec = JSON.parse(await readFile(specFile, "utf8")) as OpenApiSpec;
    } else {
      throw new Error(
        `Failed to load OpenAPI spec: ${specResponse.status} ${specResponse.statusText}.`,
      );
    }
  }

  const operations = collectOperations(spec);
  const { byOperationId, byMethodPath } = buildOperationMaps(operations);
  const firstServerUrl = spec.servers?.[0]?.url;
  const derivedBase = firstServerUrl ?? new URL(specUrl).origin;
  const baseUrl = (API_BASE_URL ?? derivedBase).replace(/\/$/, "");
  return {
    specUrl,
    specFile,
    baseUrl,
    operations,
    byOperationId,
    byMethodPath,
  };
}

function staticTools(): Tool[] {
  return [
    {
      name: TOOL_PLAN_INTEGRATION,
      description:
        "Generate an API integration/testing plan from a goal using matched OpenAPI operations.",
      inputSchema: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description:
              "Natural language goal, e.g. 'sign in then create order then verify status'.",
          },
          limit: {
            type: "number",
            description: "Maximum number of suggested steps (default 8).",
          },
          specUrl: {
            type: "string",
            description:
              "Optional OpenAPI URL override for this request (HTTP/HTTPS).",
          },
          sessionId: { type: "string" },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_REFETCH_SPEC,
      description:
        "Refetch OpenAPI JSON from a URL and persist it to local openapi.json cache on this machine.",
      inputSchema: {
        type: "object",
        properties: {
          specUrl: {
            type: "string",
            description:
              "OpenAPI URL override for this refetch request (HTTP/HTTPS).",
          },
          sessionId: {
            type: "string",
            description: "Optional session key where specUrl may be stored.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_SEARCH,
      description:
        "Search API operations by keywords (operationId, path, method, summary). Use before api_execute to find the right operationId.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Space-separated keywords to match against operations",
          },
          limit: {
            type: "number",
            description: "Max results (default 25)",
          },
          specUrl: {
            type: "string",
            description:
              "Optional OpenAPI URL override for this request (HTTP/HTTPS).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_EXECUTE,
      description:
        "Call one API operation by operationId (from api_search) or by exact method + path. Supports path/query/body, session variables {{var}}, and extractVariables from JSON responses.",
      inputSchema: {
        type: "object",
        properties: {
          operationId: {
            type: "string",
            description: "OpenAPI operationId from api_search",
          },
          specUrl: {
            type: "string",
            description:
              "Optional OpenAPI URL override for this request (HTTP/HTTPS).",
          },
          method: {
            type: "string",
            description:
              "HTTP method if resolving by path instead of operationId",
          },
          path: {
            type: "string",
            description:
              "OpenAPI path template e.g. /api/v1/users/{id} (use with method)",
          },
          sessionId: {
            type: "string",
            description: "Session key for token and variable memory",
          },
          pathParams: {
            type: "object",
            description: "Values for {path} placeholders",
            additionalProperties: true,
          },
          query: {
            type: "object",
            description: "Query string parameters",
            additionalProperties: true,
          },
          headers: {
            type: "object",
            description: "Extra request headers",
            additionalProperties: { type: "string" },
          },
          body: {
            type: ["object", "array", "string", "number", "boolean", "null"],
            description: "JSON request body (for non-GET)",
          },
          extractVariables: {
            type: "object",
            description:
              'Map session variable -> JSON path e.g. { "token": "$.data.token" }',
            additionalProperties: { type: "string" },
          },
          authProfile: {
            type: "string",
            description:
              "Optional saved auth profile name from session action setAuthProfile/useAuthProfile.",
          },
          expect: {
            type: "object",
            description:
              "Optional assertions for CI-like checks: status, headers, jsonPathEquals.",
            properties: {
              status: {
                oneOf: [
                  { type: "number" },
                  { type: "array", items: { type: "number" } },
                ],
              },
              headers: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              jsonPathEquals: {
                type: "object",
                additionalProperties: true,
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_SESSION,
      description:
        'Session memory: setVariables | getVariables | getLastResponse | clear (optional sessionId, default "default").',
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "setVariables",
              "getVariables",
              "getLastResponse",
              "setAuthProfile",
              "getAuthProfile",
              "listAuthProfiles",
              "useAuthProfile",
              "clearAuthProfiles",
              "clear",
            ],
            description: "Which session operation to run",
          },
          sessionId: { type: "string" },
          variables: {
            type: "object",
            description:
              "For setVariables: key/value map to merge into session",
            additionalProperties: true,
          },
          profileName: {
            type: "string",
            description: "Auth profile name for set/get/use actions.",
          },
          auth: {
            type: "object",
            description:
              "Auth profile payload. Types: bearer, basic, apiKey, oauthToken.",
            additionalProperties: true,
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  ];
}

function parseResponseData(
  contentType: string | null,
  text: string,
): Json | string {
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text) as Json;
    } catch {
      return text;
    }
  }
  return text;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function resolveOperation(
  byOperationId: Map<string, OperationEntry>,
  byMethodPath: Map<string, OperationEntry>,
  args: {
    operationId?: string;
    method?: string;
    path?: string;
  },
): OperationEntry | undefined {
  if (args.operationId) {
    const op = byOperationId.get(args.operationId);
    if (op) return op;
  }
  if (args.method && args.path) {
    const key = `${args.method.toUpperCase()} ${args.path}`;
    return byMethodPath.get(key);
  }
  return undefined;
}

async function runApiCall(
  op: OperationEntry,
  args: ToolInput,
  session: SessionState,
  baseUrl: string,
) {
  const interpolatedPath = interpolateVariables(
    (args.path ?? {}) as Record<string, Json>,
    session.variables,
  );
  const interpolatedQuery = interpolateVariables(
    args.query ?? {},
    session.variables,
  );
  const interpolatedHeaders = interpolateVariables(
    args.headers ?? {},
    session.variables,
  );
  const interpolatedBody = interpolateVariables(
    (args.body ?? null) as Json,
    session.variables,
  );

  let resolvedPath = op.path;
  for (const [key, value] of Object.entries(interpolatedPath)) {
    resolvedPath = resolvedPath.replace(
      `{${key}}`,
      encodeURIComponent(String(value)),
    );
  }

  const url = new URL(`${baseUrl}${resolvedPath}`);
  for (const [k, v] of Object.entries(interpolatedQuery)) {
    if (v === null || v === undefined) continue;
    url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...Object.fromEntries(
      Object.entries(interpolatedHeaders).map(([k, v]) => [k, String(v)]),
    ),
  };
  if (!headers.authorization && typeof session.variables.token === "string") {
    headers.authorization = `Bearer ${session.variables.token}`;
  }
  const authProfileName = args.authProfile ?? session.activeAuthProfile;
  const authProfile = authProfileName
    ? session.authProfiles[authProfileName]
    : undefined;
  applyAuthProfile(authProfile, headers, url);

  const requestInit: RequestInit = {
    method: op.method,
    headers,
  };
  if (!["GET", "HEAD"].includes(op.method)) {
    requestInit.body =
      interpolatedBody === null ? undefined : JSON.stringify(interpolatedBody);
  }

  const response = await fetch(url.toString(), requestInit);
  const responseText = await response.text();
  const parsed = parseResponseData(
    response.headers.get("content-type"),
    responseText,
  );

  session.lastResponse = {
    status: response.status,
    url: url.toString(),
    method: op.method,
    headers: headersToObject(response.headers),
    data: parsed,
  };

  if (args.extractVariables) {
    for (const [variableName, valuePath] of Object.entries(
      args.extractVariables,
    )) {
      const extracted = getByPath(parsed, valuePath);
      if (extracted !== undefined) {
        session.variables[variableName] = extracted as Json;
      }
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    url: url.toString(),
    data: parsed,
    isError: !response.ok,
  };
}

type SharedRuntimeState = {
  runtimeCache: Map<string, SpecRuntime>;
};

let sharedRuntimeStatePromise: Promise<SharedRuntimeState> | undefined;

async function getSharedRuntimeState(): Promise<SharedRuntimeState> {
  if (sharedRuntimeStatePromise) return sharedRuntimeStatePromise;
  sharedRuntimeStatePromise = (async () => {
    return { runtimeCache: new Map<string, SpecRuntime>() };
  })();
  return sharedRuntimeStatePromise;
}

export async function createMcpServer(
  options: CreateMcpServerOptions = {},
): Promise<Server> {
  const runtimeState = await getSharedRuntimeState();
  const { runtimeCache } = runtimeState;
  const defaultSpecUrl = normalizeSpecUrl(options.defaultSpecUrl);
  const specFetchHeaders = options.specFetchHeaders ?? {};
  const server = new Server(
    {
      name: "openapi-proxy-mcp",
      version: "0.3.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: staticTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const raw = (request.params.arguments ?? {}) as Record<string, unknown>;
    const requestedSpecUrl = normalizeSpecUrl(raw.url ?? raw.specUrl);
    if ((raw.url !== undefined || raw.specUrl !== undefined) && !requestedSpecUrl) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error:
                  "Invalid url. Expected a valid OpenAPI URL (http/https). You can also pass host-only values like api.example.com/openapi.json.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const runtimeFor = async (sessionId?: string): Promise<SpecRuntime> => {
      const session = getSession(sessionId ?? DEFAULT_SESSION_ID);
      const sessionSpecUrl = normalizeSpecUrl(session.variables.specUrl);
      const specUrl =
        requestedSpecUrl ??
        sessionSpecUrl ??
        defaultSpecUrl ??
        normalizeSpecUrl(getExplicitOpenApiSpecUrl());
      if (!specUrl) {
        throw new Error(
          "Missing OpenAPI URL. Provide `url` in the tool call, set session.variables.specUrl, or set OPENAPI_SPEC_URL.",
        );
      }
      const cached = runtimeCache.get(specUrl);
      if (cached) return cached;
      const runtime = await loadSpecRuntime(
        specUrl,
        cacheFileForSpecUrl(specUrl),
        specFetchHeaders,
      );
      runtimeCache.set(specUrl, runtime);
      return runtime;
    };

    try {
      if (name === TOOL_REFETCH_SPEC) {
        const sessionId = (raw.sessionId as string) ?? DEFAULT_SESSION_ID;
        const session = getSession(sessionId);
        const sessionSpecUrl = normalizeSpecUrl(session.variables.specUrl);
        const specUrl =
          requestedSpecUrl ??
          sessionSpecUrl ??
          defaultSpecUrl ??
          normalizeSpecUrl(getExplicitOpenApiSpecUrl());
        if (!specUrl) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    error:
                      "Missing OpenAPI URL. Set OPENAPI_SPEC_URL, set session.specUrl, or pass url.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const runtime = await loadSpecRuntime(
          specUrl,
          cacheFileForSpecUrl(specUrl),
          specFetchHeaders,
        );
        runtimeCache.set(specUrl, runtime);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  specUrl: runtime.specUrl,
                  cacheMode: ENABLE_SERVER_FILE_CACHE ? "server-file" : "memory-only",
                  operationCount: runtime.operations.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === TOOL_SEARCH) {
        const runtime = await runtimeFor(raw.sessionId as string | undefined);
        const query = String(raw.query ?? "");
        const limit = Math.min(100, Math.max(1, Number(raw.limit ?? 25) || 25));
        const hits = searchOperations(runtime.operations, query, limit);
        const payload = hits.map((op) => ({
          operationId: op.operationId,
          method: op.method,
          path: op.path,
          summary: op.summary ?? null,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  specUrl: runtime.specUrl,
                  count: payload.length,
                  operations: payload,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === TOOL_PLAN_INTEGRATION) {
        const runtime = await runtimeFor(raw.sessionId as string | undefined);
        const goal = String(raw.goal ?? "").trim();
        const limit = Math.min(20, Math.max(1, Number(raw.limit ?? 8) || 8));
        const suggested = searchOperations(runtime.operations, goal, limit).map(
          (op, index) => ({
            step: index + 1,
            operationId: op.operationId,
            method: op.method,
            path: op.path,
            summary: op.summary ?? null,
            why:
              op.summary ??
              `Matches goal keywords in ${op.method} ${op.path} / ${op.operationId}`,
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  goal,
                  specUrl: runtime.specUrl,
                  suggestedSteps: suggested,
                  usageHint:
                    "Execute steps with api_execute. Use extractVariables + {{var}} between steps.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === TOOL_SESSION) {
      const action = raw.action as string;
      const sessionId = (raw.sessionId as string) ?? DEFAULT_SESSION_ID;
      const session = getSession(sessionId);

      if (action === "setVariables") {
        const vars = (raw.variables ?? {}) as Record<string, Json>;
        session.variables = { ...session.variables, ...vars };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, sessionId, variables: session.variables },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (action === "getVariables") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { sessionId, variables: session.variables },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (action === "getLastResponse") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { sessionId, lastResponse: session.lastResponse ?? null },
                null,
              ),
            },
          ],
        };
      }
      if (action === "setAuthProfile") {
        const profileName = String(raw.profileName ?? "").trim();
        const auth = normalizeAuthProfile(raw.auth);
        if (!profileName || !auth) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    error:
                      "setAuthProfile requires profileName and valid auth payload (bearer/basic/apiKey/oauthToken).",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        session.authProfiles[profileName] = auth;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  sessionId,
                  profileName,
                  activeAuthProfile: session.activeAuthProfile ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (action === "getAuthProfile") {
        const profileName = String(raw.profileName ?? "").trim();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sessionId,
                  profileName: profileName || null,
                  authProfile: profileName
                    ? (session.authProfiles[profileName] ?? null)
                    : null,
                  activeAuthProfile: session.activeAuthProfile ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (action === "listAuthProfiles") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sessionId,
                  activeAuthProfile: session.activeAuthProfile ?? null,
                  profiles: Object.keys(session.authProfiles),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (action === "useAuthProfile") {
        const profileName = String(raw.profileName ?? "").trim();
        if (!profileName || !session.authProfiles[profileName]) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    error: "Unknown auth profile. Use setAuthProfile first.",
                    profileName: profileName || null,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        session.activeAuthProfile = profileName;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, sessionId, activeAuthProfile: profileName },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (action === "clearAuthProfiles") {
        session.authProfiles = {};
        session.activeAuthProfile = undefined;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, sessionId, clearedAuthProfiles: true },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (action === "clear") {
        sessions.set(sessionId, { variables: {}, authProfiles: {} });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, sessionId, cleared: true },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Unknown session action: ${action}`,
          },
        ],
      };
      }

      if (name === TOOL_EXECUTE) {
      const sessionId = (raw.sessionId as string) ?? DEFAULT_SESSION_ID;
      const session = getSession(sessionId);
      const runtime = await runtimeFor(sessionId);

      const op = resolveOperation(runtime.byOperationId, runtime.byMethodPath, {
        operationId: raw.operationId as string | undefined,
        method: raw.method as string | undefined,
        path: raw.path as string | undefined,
      });

      if (!op) {
        const suggestions = suggestOperations(
          runtime.operations,
          {
            operationId: raw.operationId as string | undefined,
            method: raw.method as string | undefined,
            path: raw.path as string | undefined,
          },
          5,
        );
        const hint =
          runtime.operations.length > 0
            ? " Use api_search with keywords from the path or summary."
            : "";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    `Unknown operation. Pass operationId from api_search, or method + path (OpenAPI template).${hint}`.trim(),
                  didYouMean: suggestions,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const pathParams = (raw.pathParams ?? {}) as Record<
        string,
        string | number
      >;
      const toolArgs: ToolInput = {
        sessionId,
        path: pathParams,
        query: raw.query as ToolInput["query"],
        headers: raw.headers as ToolInput["headers"],
        body: raw.body as Json,
        extractVariables: raw.extractVariables as ToolInput["extractVariables"],
        authProfile: raw.authProfile as string | undefined,
      };
      const expect = (raw.expect ?? undefined) as ExecuteExpectations | undefined;

        const result = await runApiCall(op, toolArgs, session, runtime.baseUrl);
        const assertions = evaluateAssertions(
          { status: result.status, data: result.data, headers: session.lastResponse?.headers },
          expect,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: result.ok,
                  status: result.status,
                  operationId: result.operationId,
                  method: result.method,
                  path: result.path,
                  url: result.url,
                  specUrl: runtime.specUrl,
                  data: result.data,
                  assertions,
                },
                null,
                2,
              ),
            },
          ],
          isError: result.isError || !assertions.passed,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error: message,
                hint:
                  "Provide a valid url (tool argument/header/session/env) and ensure it serves OpenAPI JSON over HTTP/HTTPS.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  });

  return server;
}

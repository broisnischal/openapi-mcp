import { dirname, join } from "node:path";
import { mkdir, access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
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
};

type SpecRuntime = {
  specUrl: string;
  specFile: string;
  baseUrl: string;
  operations: OperationEntry[];
  byOperationId: Map<string, OperationEntry>;
  byMethodPath: Map<string, OperationEntry>;
};

const DEFAULT_SPEC_URL = "https://ag.nischal-dahal.com.np/api-docs-json";
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Default cache path when OPENAPI_SPEC_FILE is unset (project root openapi.json). */
const DEFAULT_SPEC_CACHE_FILE = process.env.VERCEL
  ? "/tmp/openapi.json"
  : join(PROJECT_ROOT, "openapi.json");
const OPENAPI_CACHE_DIR = process.env.VERCEL
  ? "/tmp/openapi-cache"
  : join(PROJECT_ROOT, ".openapi-cache");
const API_BASE_URL = process.env.API_BASE_URL;
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
  try {
    const parsed = new URL(v);
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

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { variables: {} });
  }
  return sessions.get(sessionId)!;
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
  const specUrl = getExplicitOpenApiSpecUrl() ?? DEFAULT_SPEC_URL;

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
    console.error(`Synced OpenAPI spec from ${specUrl} -> ${specFile}`);
    return spec;
  }

  if (await fileExists(specFile)) {
    console.error(
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
): Promise<SpecRuntime> {
  const specResponse = await fetch(specUrl, {
    headers: {
      accept: "application/json, */*",
      "user-agent": "openapi-proxy-mcp/0.3.0",
    },
  });

  let spec: OpenApiSpec;
  if (specResponse.ok) {
    spec = (await specResponse.json()) as OpenApiSpec;
    await ensureParentDirectory(specFile);
    await writeFile(specFile, JSON.stringify(spec, null, 2), "utf8");
    console.error(`Synced OpenAPI spec from ${specUrl} -> ${specFile}`);
  } else {
    if (await fileExists(specFile)) {
      console.error(
        `OpenAPI fetch failed (${specResponse.status} ${specResponse.statusText}); using cached ${specFile}`,
      );
      spec = JSON.parse(await readFile(specFile, "utf8")) as OpenApiSpec;
    } else {
      throw new Error(
        `Failed to load OpenAPI spec: ${specResponse.status} ${specResponse.statusText}. No cache at ${specFile}.`,
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
            enum: ["setVariables", "getVariables", "getLastResponse", "clear"],
            description: "Which session operation to run",
          },
          sessionId: { type: "string" },
          variables: {
            type: "object",
            description:
              "For setVariables: key/value map to merge into session",
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
  defaultRuntime: SpecRuntime;
  runtimeCache: Map<string, SpecRuntime>;
};

let sharedRuntimeStatePromise: Promise<SharedRuntimeState> | undefined;

async function getSharedRuntimeState(): Promise<SharedRuntimeState> {
  if (sharedRuntimeStatePromise) return sharedRuntimeStatePromise;
  sharedRuntimeStatePromise = (async () => {
    const specUrlForOrigin = getExplicitOpenApiSpecUrl() ?? DEFAULT_SPEC_URL;
    const specFile = resolveOpenApiSpecFilePath();
    const defaultSpec = await loadOpenApiSpec();
    const defaultOperations = collectOperations(defaultSpec);
    const defaultMaps = buildOperationMaps(defaultOperations);
    const defaultBaseUrl = (
      API_BASE_URL ??
      defaultSpec.servers?.[0]?.url ??
      new URL(specUrlForOrigin).origin
    ).replace(/\/$/, "");
    const defaultRuntime: SpecRuntime = {
      specUrl: specUrlForOrigin,
      specFile,
      baseUrl: defaultBaseUrl,
      operations: defaultOperations,
      byOperationId: defaultMaps.byOperationId,
      byMethodPath: defaultMaps.byMethodPath,
    };
    const runtimeCache = new Map<string, SpecRuntime>();
    runtimeCache.set(defaultRuntime.specUrl, defaultRuntime);
    return { defaultRuntime, runtimeCache };
  })();
  return sharedRuntimeStatePromise;
}

export async function createMcpServer(): Promise<Server> {
  const { defaultRuntime, runtimeCache } = await getSharedRuntimeState();
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
    const requestedSpecUrl = normalizeSpecUrl(raw.specUrl);

    const runtimeFor = async (sessionId?: string): Promise<SpecRuntime> => {
      const session = getSession(sessionId ?? DEFAULT_SESSION_ID);
      const sessionSpecUrl = normalizeSpecUrl(session.variables.specUrl);
      const specUrl =
        requestedSpecUrl ?? sessionSpecUrl ?? defaultRuntime.specUrl;
      if (specUrl === defaultRuntime.specUrl) return defaultRuntime;
      const cached = runtimeCache.get(specUrl);
      if (cached) return cached;
      const runtime = await loadSpecRuntime(
        specUrl,
        cacheFileForSpecUrl(specUrl),
      );
      runtimeCache.set(specUrl, runtime);
      return runtime;
    };

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
      if (action === "clear") {
        sessions.set(sessionId, { variables: {} });
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
        const hint =
          runtime.operations.length > 0
            ? " Use api_search with keywords from the path or summary."
            : "";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown operation. Pass operationId from api_search, or method + path (OpenAPI template).${hint}`,
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
      };

      const result = await runApiCall(op, toolArgs, session, runtime.baseUrl);
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
              },
              null,
              2,
            ),
          },
        ],
        isError: result.isError,
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  });

  return server;
}

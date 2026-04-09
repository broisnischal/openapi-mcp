import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./mcp.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "mcp-session-id",
      "Last-Event-ID",
      "mcp-protocol-version",
      "url",
      "x-openapi-url",
      "x-openapi-spec-url",
      "authorization",
    ],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  }),
);

app.get("/", (c) => {
  return c.json({
    name: "openapi-proxy-mcp",
    status: "ok",
    mcpEndpoint: "/mcp",
    healthEndpoint: "/health",
  });
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.all("/mcp", async (c) => {
  const headerSpecUrl =
    c.req.header("url") ??
    c.req.header("x-openapi-url") ??
    c.req.header("x-openapi-spec-url");
  const headerAuth = c.req.header("authorization");
  const specFetchHeaders: Record<string, string> = {};
  if (headerAuth) {
    specFetchHeaders.authorization = headerAuth;
  }

  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = await createMcpServer({
    defaultSpecUrl: headerSpecUrl,
    specFetchHeaders,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

const port = Number(process.env.PORT ?? 3000);
console.log(`MCP server listening on http://localhost:${port}`);

serve({ fetch: app.fetch, port });

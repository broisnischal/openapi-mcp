import { Hono } from "hono";
import { cors } from "hono/cors";
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
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = await createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

const port = Number(Bun.env.PORT ?? 3000);
console.log(`MCP server listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};

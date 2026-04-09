# OpenAPI MCP Server (Hono + Node.js)

This project exposes an MCP server over HTTP using Hono at `/mcp`.

It gives three tools:

- `api_search`: find operations from an OpenAPI spec
- `api_execute`: call one operation by `operationId` (or `method + path`)
- `session`: store and read session variables (token, ids, etc.)

## Requirements

- Node.js 18+ installed

## Install

```sh
npm install
```

## Run

```sh
npm run dev
```

Server endpoints:

- `http://localhost:3000/`
- `http://localhost:3000/health`
- `http://localhost:3000/mcp`

## Configure environment (optional)

- `OPENAPI_SPEC_URL`: OpenAPI JSON URL (default: `https://ag.nischal-dahal.com.np/api-docs-json`)
- `OPENAPI_SERVER_FILE_CACHE=1`: optional, enable server-side file cache (disabled by default)
- `API_BASE_URL`: override API base URL used for execution
- `PORT`: HTTP server port (default `3000`)

If the spec URL is temporarily unavailable (for example `502`), the MCP server stays alive and returns a structured tool error with recovery hints instead of crashing.

### Set OpenAPI URL via request headers (recommended)

You can provide spec configuration from MCP HTTP headers (instead of env). Use one simple header:

- `url`: OpenAPI JSON URL to use as default for this request
- `authorization`: optional auth header used when fetching the spec URL

Example:

```http
POST /mcp
url: api.example.com/openapi.json
authorization: Bearer YOUR_TOKEN
```

## Use with an MCP client

Add an MCP server entry that points to this URL:

```json
{
  "mcpServers": {
    "openapi-hono": {
      "url": "https://dx.lexicon.website/mcp",
      "env": {
        "OPENAPI_SPEC_URL": "https://ag.nischal-dahal.com.np/api-docs-json"
      }
    }
  }
}
```

### Where to set the OpenAPI spec URL

You can set the spec URL in two ways:

1. **Server default (recommended):** set `OPENAPI_SPEC_URL` before starting server.

```sh
OPENAPI_SPEC_URL="https://your-api.com/openapi.json" npm run dev
```

2. **Per request override:** pass `specUrl` in `api_search` or `api_execute` arguments.

```json
{
  "name": "api_search",
  "arguments": {
    "query": "users list",
    "url": "api.example.com/openapi.json"
  }
}
```

## Typical usage flow

1. Find operations:

```json
{
  "name": "api_search",
  "arguments": {
    "query": "login auth token",
    "limit": 10
  }
}
```

2. Execute operation:

```json
{
  "name": "api_execute",
  "arguments": {
    "operationId": "auth_login",
    "body": {
      "email": "user@example.com",
      "password": "secret"
    },
    "extractVariables": {
      "token": "$.data.token"
    }
  }
}
```

3. Reuse stored session token automatically (or inspect with `session` tool):

```json
{
  "name": "session",
  "arguments": {
    "action": "getVariables"
  }
}
```

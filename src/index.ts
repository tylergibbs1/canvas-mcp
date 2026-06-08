#!/usr/bin/env node
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasClient } from "./client.js";
import { registerReadTools } from "./tools/read.js";
import { registerSubmitTool } from "./tools/submit.js";
import { registerCommunicateTools } from "./tools/communicate.js";

// Auto-load a project-local .env (dist/ → ../.env) so the token never has to
// be passed on a command line or stored in the MCP client config. Real env
// vars still win — loadEnvFile does not overwrite existing process.env.
try {
  process.loadEnvFile(resolve(import.meta.dirname, "..", ".env"));
} catch {
  // No .env file — fall back to whatever is already in the environment.
}

/** Parse and validate config at the boundary, then hand typed values inward. */
function loadConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_TOKEN;
  if (!baseUrl || !token) {
    const missing = [!baseUrl && "CANVAS_BASE_URL", !token && "CANVAS_TOKEN"].filter(Boolean).join(", ");
    console.error(
      `[canvas-mcp] Missing required env var(s): ${missing}.\n` +
        `  CANVAS_BASE_URL  e.g. https://canvas.okstate.edu\n` +
        `  CANVAS_TOKEN     a personal access token from Account → Settings → New Access Token`,
    );
    process.exit(1);
  }
  return { baseUrl, token };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);
  const server = new McpServer({ name: "canvas-mcp", version: "0.1.0" });

  registerReadTools(server, client);
  registerSubmitTool(server, client);
  registerCommunicateTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[canvas-mcp] ready on stdio");
}

main().catch((err) => {
  console.error("[canvas-mcp] fatal:", err);
  process.exit(1);
});

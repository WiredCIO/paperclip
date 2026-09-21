import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

// Re-exported so a downstream server can compose this tool set with its own
// instead of forking this file. Adding tools here is constrained on purpose:
// every entry in tools.ts is a `legacy_mcp_alias` in the capability ledger,
// frozen at 42 rows and required to fold into a capability, so the supported
// way to extend the surface is to wrap it, not to grow it.
export { createToolDefinitions, type ToolDefinition } from "./tools.js";
export { PaperclipApiClient } from "./client.js";
export { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

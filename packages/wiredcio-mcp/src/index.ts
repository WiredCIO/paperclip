import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  PaperclipApiClient,
  createToolDefinitions,
  readConfigFromEnv,
  type PaperclipMcpConfig,
} from "@paperclipai/mcp-server";
import { createWiredcioToolDefinitions } from "./tools.js";

export { createWiredcioToolDefinitions } from "./tools.js";

/**
 * Paperclip's MCP server plus the tools it does not ship.
 *
 * Upstream's tool list is composed, never edited: it is a frozen surface in the
 * runner's capability ledger, so wrapping it keeps this fork's divergence to a
 * single re-export and leaves upstream merges clean.
 */
export function createWiredcioMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip-wiredcio",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = [...createToolDefinitions(client), ...createWiredcioToolDefinitions(client)];

  const seen = new Set<string>();
  for (const tool of tools) {
    // If upstream ever ships a tool of the same name, theirs is already
    // registered and this would be a silent duplicate — fail loudly instead,
    // because the winner would otherwise depend on array order.
    if (seen.has(tool.name)) {
      throw new Error(
        `Duplicate MCP tool "${tool.name}": upstream now ships this tool, so the local one in `
          + `@wiredcio/paperclip-mcp should be removed.`,
      );
    }
    seen.add(tool.name);
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return { server, tools, client };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createWiredcioMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

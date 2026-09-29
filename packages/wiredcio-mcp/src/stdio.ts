#!/usr/bin/env node
import { runServer } from "./index.js";

void runServer().catch((error) => {
  console.error("Failed to start Paperclip MCP server (WiredCIO):", error);
  process.exit(1);
});

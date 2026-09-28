#!/usr/bin/env node
// Launcher for MCP hosts (Claude Desktop, Claude Code, Cursor): runs the TypeScript source through tsx so no build
// step is needed. Usage: node <repo>/packages/mcp/bin/hush-mcp.mjs
import { register } from "tsx/esm/api";

register();
await import("../src/index.ts");

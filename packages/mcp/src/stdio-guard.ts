// stdout is the MCP JSON-RPC channel. Dependencies (the eERC SDK logs "[EERC] …" with console.log) must never write
// there, so every console method is routed to stderr. Imported first so it runs before anything else can log.
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

export {};

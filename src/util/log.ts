/**
 * All diagnostics go to stderr: stdout is reserved for the MCP stdio protocol.
 */
export function log(message: string): void {
  console.error(message);
}

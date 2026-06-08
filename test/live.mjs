// Live validation against the real Canvas API through the running MCP server.
// Read-only tools only. Usage: node test/live.mjs [toolName] [jsonArgs]
import { spawn } from "node:child_process";

const tool = process.argv[2] ?? "canvas_list_courses";
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
    } else if (msg.id === 2) {
      if (msg.error) {
        console.error("TOOL ERROR:", JSON.stringify(msg.error, null, 2));
        child.kill();
        process.exit(1);
      }
      console.log(msg.result.content.map((c) => c.text).join("\n"));
      child.kill();
      process.exit(0);
    }
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live", version: "0" } },
});
setTimeout(() => {
  console.error("timed out");
  child.kill();
  process.exit(1);
}, 20000);

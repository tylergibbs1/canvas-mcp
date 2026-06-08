// Boot smoke test: starts the server with a dummy token (no API calls happen at
// startup), runs the MCP handshake, and asserts every tool registers cleanly.
import { spawn } from "node:child_process";

const EXPECTED = [
  "canvas_list_courses",
  "canvas_deadlines",
  "canvas_list_assignments",
  "canvas_get_assignment",
  "canvas_get_grades",
  "canvas_list_announcements",
  "canvas_submit_assignment",
  "canvas_get_discussion",
  "canvas_post_reply",
  "canvas_find_person",
  "canvas_send_message",
];

const child = spawn("node", ["dist/index.js"], {
  env: { ...process.env, CANVAS_BASE_URL: "https://example.invalid", CANVAS_TOKEN: "dummy" },
  stdio: ["pipe", "pipe", "inherit"],
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
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
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    } else if (msg.id === 2) {
      const names = msg.result.tools.map((t) => t.name).sort();
      const missing = EXPECTED.filter((n) => !names.includes(n));
      const extra = names.filter((n) => !EXPECTED.includes(n));
      if (missing.length || extra.length) {
        console.error("FAIL — missing:", missing, "extra:", extra);
        process.exit(1);
      }
      console.log(`PASS — ${names.length} tools registered:\n  ${names.join("\n  ")}`);
      child.kill();
      process.exit(0);
    }
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});

setTimeout(() => {
  console.error("FAIL — timed out waiting for server");
  child.kill();
  process.exit(1);
}, 5000);

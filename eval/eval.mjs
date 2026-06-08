// Contract + regression eval suite. Runs every read tool against the live
// Canvas API through the MCP server and asserts INVARIANTS — properties that
// hold regardless of the (constantly changing) account data — plus a live test
// that the write-safety dry-run guardrail never actually submits.
//
// Usage: node eval/eval.mjs
import { spawn } from "node:child_process";

const VALID_STATUSES = new Set(["graded", "submitted", "submitted (late)", "missing", "not submitted", "unknown"]);

// --- Minimal JSON-RPC-over-stdio client for one server session ---
class Rpc {
  constructor() {
    this.child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
  }
  #onData(chunk) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    }
  }
  #send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  #request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async init() {
    await this.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "eval", version: "0" },
    });
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  // Returns the parsed JSON the tool produced, or throws on tool error.
  async call(name, args = {}) {
    const result = await this.#request("tools/call", { name, arguments: args });
    const text = result.content.map((c) => c.text).join("\n");
    if (result.isError) throw new Error(`tool ${name} errored: ${text}`);
    return JSON.parse(text);
  }
  close() {
    this.child.kill();
  }
}

// --- Tiny assertion tracker ---
let passed = 0;
const failures = [];
function check(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const rpc = new Rpc();
  await rpc.init();
  try {
    // 1. list_courses: at least one course, well-formed ids and names.
    console.log("\n[canvas_list_courses]");
    const courses = await rpc.call("canvas_list_courses");
    check("returns ≥1 course", courses.count >= 1, `count=${courses.count}`);
    check(
      "every course has numeric id + non-empty name",
      courses.courses.every((c) => Number.isInteger(c.course_id) && typeof c.name === "string" && c.name.length > 0),
    );
    const graded = courses.courses.find((c) => c.current_grade !== "n/a");

    // 2. deadlines: sorted ascending, valid statuses, course name resolved.
    console.log("\n[canvas_deadlines]");
    const dl = await rpc.call("canvas_deadlines", { days: 30 });
    const dueAts = dl.deadlines.map((d) => d.due_at ?? "");
    check(
      "sorted ascending by due_at",
      dueAts.every((v, i) => i === 0 || dueAts[i - 1] <= v),
    );
    check(
      "every status is from the allowed set",
      dl.deadlines.every((d) => VALID_STATUSES.has(d.status)),
      dl.deadlines.map((d) => d.status).find((s) => !VALID_STATUSES.has(s)) ?? "",
    );
    check(
      "every deadline resolves a course name (planner→course map works)",
      dl.deadlines.every((d) => typeof d.course === "string" && d.course.length > 0),
    );

    // 3 + 4. assignments and assignment detail for a real course.
    const courseId = (graded ?? courses.courses[0]).course_id;
    console.log(`\n[canvas_list_assignments] course ${courseId}`);
    const asg = await rpc.call("canvas_list_assignments", { course_id: courseId });
    check("assignments have numeric assignment_id", asg.assignments.every((a) => Number.isInteger(a.assignment_id)));

    if (asg.assignments.length > 0) {
      const aid = asg.assignments[0].assignment_id;
      console.log(`\n[canvas_get_assignment] ${courseId}/${aid}`);
      const detail = await rpc.call("canvas_get_assignment", { course_id: courseId, assignment_id: aid });
      check("instructions are HTML-stripped (no raw tags)", !/<[a-z][^>]*>/i.test(detail.instructions ?? ""));
      check("accepted_submission_types is an array", Array.isArray(detail.accepted_submission_types));
    }

    // 5. REGRESSION: get_grades overall must match list_courses for the SAME course.
    //    (This is the exact cross-tool inconsistency that was fixed.)
    if (graded) {
      console.log(`\n[regression] grade consistency for course ${graded.course_id}`);
      const g = await rpc.call("canvas_get_grades", { course_id: graded.course_id });
      check(
        `get_grades overall (${g.overall_grade}) == list_courses (${graded.current_grade})`,
        g.overall_grade === graded.current_grade,
      );
    } else {
      console.log("\n[regression] skipped — no course currently shows a grade");
    }

    // 6. WRITE SAFETY (live): dry-run must preview, never execute.
    console.log("\n[write-safety] dry-run guardrails");
    // post_reply on a real discussion topic if one exists.
    const disc = await rpc.call("canvas_get_discussion", { course_id: courseId }).catch(() => ({ topics: [] }));
    if (disc.topics?.length) {
      const reply = await rpc.call("canvas_post_reply", {
        course_id: courseId,
        topic_id: disc.topics[0].topic_id,
        message: "EVAL dry-run — must not post",
      });
      check("post_reply confirm-omitted returns dry_run, does not post", reply.dry_run === true && !reply.posted);
    } else {
      console.log("  · no discussion topics to test post_reply against (skipped)");
    }
    // send_message dry-run (no real recipient is contacted without confirm).
    const msg = await rpc.call("canvas_send_message", {
      recipient_ids: [1],
      body: "EVAL dry-run — must not send",
    });
    check("send_message confirm-omitted returns dry_run, does not send", msg.dry_run === true && !msg.sent);
    // submit dry-run against a real not-submitted assignment, using its accepted type.
    const candidate = dl.deadlines.find((d) => d.type === "assignment" && d.status === "not submitted" && d.url);
    if (candidate) {
      const m = candidate.url.match(/courses\/(\d+)\/assignments\/(\d+)/);
      if (m) {
        const [cid, sid] = [Number(m[1]), Number(m[2])];
        const det = await rpc.call("canvas_get_assignment", { course_id: cid, assignment_id: sid });
        const types = det.accepted_submission_types ?? [];
        // For file uploads, use an extension the assignment actually accepts so
        // we exercise the dry-run path itself (the extension check is validated
        // separately and correctly rejects disallowed types before any dry-run).
        const ext = det.allowed_extensions?.[0] ?? "txt";
        const plan = types.includes("online_text_entry")
          ? { submission_type: "text", text: "EVAL dry-run" }
          : types.includes("online_url")
            ? { submission_type: "url", url: "https://example.com" }
            : types.includes("online_upload")
              ? { submission_type: "file", file_path: `/tmp/eval-dry-run.${ext}` }
              : null;
        if (plan) {
          const sub = await rpc
            .call("canvas_submit_assignment", { course_id: cid, assignment_id: sid, ...plan })
            .catch((e) => ({ error: e.message }));
          check(
            "submit_assignment confirm-omitted returns dry_run, does not submit",
            sub.dry_run === true && !sub.submitted,
            sub.error ?? "",
          );
        } else {
          console.log(`  · assignment ${sid} accepts only ${types.join(",")} — submit dry-run skipped`);
        }
      }
    } else {
      console.log("  · no not-submitted assignment to test submit dry-run against (skipped)");
    }
  } finally {
    rpc.close();
  }

  console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("eval harness error:", e);
  process.exit(1);
});

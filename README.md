# canvas-mcp

[![CI](https://github.com/tylergibbs1/canvas-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tylergibbs1/canvas-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Model Context Protocol](https://img.shields.io/badge/MCP-server-000000.svg)](https://modelcontextprotocol.io)

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents structured access to [Canvas LMS](https://www.instructure.com/canvas) — coursework, deadlines, grades, submissions, discussions, and messages — over the official REST API.

Works with any Instructure-hosted Canvas instance. Built and validated against `canvas.okstate.edu`.

## Contents

- [Why the REST API](#why-the-rest-api)
- [Features](#features)
- [Tools](#tools)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Write safety](#write-safety)
- [Development](#development)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Why the REST API

Canvas exposes a stable, versioned API at `/api/v1/`. Wrapping it — rather than scraping the web UI — yields:

- **Single-call actions** instead of multi-page navigation.
- **Resilience** to UI redesigns; the API is versioned.
- **Compact, structured JSON** that doesn't flood an agent's context with rendered HTML.
- **Simple auth** via one bearer token.

Browser automation is reserved for things genuinely *outside* Canvas — embedded LTI tools such as zyBooks, Cengage, or Coursera quizzes, whose contents Canvas itself cannot see.

## Features

- **11 workflow-oriented tools** spanning the full student workflow, designed for agent ergonomics (human-readable names over opaque IDs, consolidated multi-step actions).
- **Dry-run safety** on every write — nothing is submitted, posted, or sent without an explicit `confirm: true`.
- **Cross-course planner** — one call returns everything due across all courses.
- **Zero-config secrets** — the server auto-loads a local `.env`, so no token ever appears on a command line or in client config.
- **Tested** — offline boot check in CI plus a live contract/regression suite.

## Tools

| Tool | Description | Access |
|---|---|:---:|
| `canvas_list_courses` | Active courses with code, term, and current grade | read |
| `canvas_deadlines` | Everything due soon across all courses (via the planner) | read |
| `canvas_list_assignments` | Assignments in a course with due dates and submission status | read |
| `canvas_get_assignment` | Full detail: instructions, rubric, accepted types, your status | read |
| `canvas_get_grades` | Course grade summary, or per-assignment feedback and rubric | read |
| `canvas_list_announcements` | Recent announcements, all courses or one | read |
| `canvas_get_discussion` | List discussion topics, or read a full thread | read |
| `canvas_find_person` | Resolve a name to a user ID for messaging | read |
| `canvas_submit_assignment` | Submit a text entry, URL, or uploaded file | **write** |
| `canvas_post_reply` | Reply to a discussion topic | **write** |
| `canvas_send_message` | Send a Canvas inbox message | **write** |

## Installation

**Requirements:** Node.js ≥ 22.

```bash
git clone https://github.com/tylergibbs1/canvas-mcp.git
cd canvas-mcp
npm install
npm run build
```

## Configuration

Generate a token in Canvas: **Account → Settings → "+ New Access Token"**. Treat it like a password.

```bash
cp .env.example .env   # then set CANVAS_TOKEN
```

| Variable | Required | Description |
|---|:---:|---|
| `CANVAS_BASE_URL` | yes | Your Canvas origin, e.g. `https://canvas.okstate.edu` (no trailing slash). |
| `CANVAS_TOKEN` | yes | A personal access token. |

The server reads `.env` automatically. Real environment variables take precedence, so you may also pass these inline if you prefer.

## Usage

### Claude Code

The server auto-loads `.env`, so no secret is needed on the command line:

```bash
claude mcp add --scope user canvas -- node /absolute/path/to/canvas-mcp/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "node",
      "args": ["/absolute/path/to/canvas-mcp/dist/index.js"],
      "env": {
        "CANVAS_BASE_URL": "https://your-school.instructure.com",
        "CANVAS_TOKEN": "your_token_here"
      }
    }
  }
}
```

Any MCP-compatible client works — point it at `node dist/index.js` with the two environment variables set.

## Write safety

Every write tool defaults to a **dry run**: it validates inputs and returns a preview of exactly what *would* be sent, but performs no action. You must re-call with `confirm: true` to actually submit, post, or send. An accidental or hallucinated call cannot change anything in Canvas.

## Development

```bash
npm run dev       # run from source with tsx
npm run build     # compile TypeScript to dist/
npm test          # offline: boot the server and verify all tools register (no token)
npm run eval      # live: contract/regression suite (requires a token)
npm run inspect   # interactive MCP Inspector (requires a token)
```

**Evaluation**

- `eval/eval.mjs` (`npm run eval`) asserts data-independent invariants against the live API — deadline ordering, valid status values, HTML stripping, cross-tool grade consistency, and that every write tool's `confirm:false` path returns a dry run and never executes.
- `eval/tasks.md` provides realistic agent task prompts (happy path, multi-step, write safety, scope boundary) for behavioral evaluation, each with "what good looks like."

## Security

- **Tokens are secrets.** `.env` is git-ignored; never commit it. Anyone with your token can act as you in Canvas.
- **Scoped to your account.** The server can only do what your Canvas account can do.
- **Revocation.** Remove a token anytime in Canvas under **Account → Settings → Approved Integrations**.
- Tokens are sent only to your configured `CANVAS_BASE_URL` over HTTPS.

## Contributing

Issues and pull requests are welcome. Please run `npm run build` and `npm test` before opening a PR; if you have a Canvas token available, `npm run eval` is encouraged.

## License

[MIT](LICENSE) © Tyler Gibbs

# canvas-mcp

An MCP server that lets an AI agent work with [Canvas LMS](https://www.instructure.com/canvas) over its **REST API** — no browser scraping. Built and tested against `canvas.okstate.edu`, but works with any Instructure-hosted Canvas.

## Why the REST API (not browser automation)

Canvas exposes a stable, versioned API at `/api/v1/`. Wrapping it gives single-call actions, clean JSON, and resilience to UI redesigns — everything DOM scraping doesn't. Reserve browser automation for things genuinely outside Canvas (e.g. embedded LTI tools like zyBooks/Cengage).

## Tools

| Tool | What it does | Risk |
|---|---|---|
| `canvas_list_courses` | Active courses + code + term + current grade | read |
| `canvas_deadlines` | Everything due soon across all courses (planner) | read |
| `canvas_list_assignments` | Assignments in a course + due + submission status | read |
| `canvas_get_assignment` | Full detail: instructions, rubric, accepted types, your status | read |
| `canvas_get_grades` | Course grade summary, or per-assignment feedback + rubric | read |
| `canvas_list_announcements` | Recent announcements (all courses or one) | read |
| `canvas_get_discussion` | List topics, or read a full thread | read |
| `canvas_find_person` | Resolve a name → user id for messaging | read |
| `canvas_submit_assignment` | Submit text / URL / uploaded file | **write** |
| `canvas_post_reply` | Reply to a discussion | **write** |
| `canvas_send_message` | Send a Canvas inbox message | **write** |

### Write safety

Every write tool defaults to a **dry run**: it validates inputs and returns a preview of exactly what would be sent, but performs no action. You must re-call with `confirm: true` to actually submit/post/send. An accidental call can't change anything.

## Setup

```bash
npm install
npm run build
```

Get a token: Canvas → **Account → Settings → "+ New Access Token"**. Treat it like a password.

```bash
cp .env.example .env   # then fill in CANVAS_TOKEN
```

## Connect to Claude Code

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

## Develop / test

```bash
npm run dev               # run from source with tsx
node test/smoke.mjs       # boot + verify all tools register (no token needed)
npm run inspect           # interactive MCP Inspector (needs a real token in env)
```

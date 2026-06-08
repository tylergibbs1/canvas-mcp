import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CanvasClient } from "../client.js";
import { formatDue, htmlToText, jsonResult } from "../format.js";

interface DiscussionTopic {
  id: number;
  title: string;
  message?: string | null;
  posted_at?: string | null;
  html_url?: string;
}
interface DiscussionEntry {
  id: number;
  user_name?: string;
  message?: string | null;
  created_at?: string | null;
  replies?: DiscussionEntry[];
}
interface CourseUser {
  id: number;
  name: string;
  email?: string;
  enrollments?: { type: string }[];
}

export function registerCommunicateTools(server: McpServer, client: CanvasClient): void {
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

  server.registerTool(
    "canvas_get_discussion",
    {
      title: "List or read discussions",
      description:
        "Without topic_id: list discussion topics in the course. With topic_id: read the topic's prompt and all " +
        "reply entries (nested). Use this before canvas_post_reply. Read-only.",
      inputSchema: {
        course_id: z.number().int().describe("Numeric Canvas course id."),
        topic_id: z.number().int().optional().describe("Optional: a discussion topic id to read its full thread."),
      },
      annotations: readOnly,
    },
    async ({ course_id, topic_id }) => {
      if (topic_id == null) {
        const topics = await client.getAll<DiscussionTopic>(`/courses/${course_id}/discussion_topics`);
        return jsonResult({
          course_id,
          count: topics.length,
          topics: topics.map((t) => ({ topic_id: t.id, title: t.title, posted: formatDue(t.posted_at), url: t.html_url })),
        });
      }
      const [topic, view] = await Promise.all([
        client.get<DiscussionTopic>(`/courses/${course_id}/discussion_topics/${topic_id}`),
        client.get<{ view?: DiscussionEntry[] }>(`/courses/${course_id}/discussion_topics/${topic_id}/view`),
      ]);
      const flatten = (entries: DiscussionEntry[] | undefined, depth = 0): unknown[] =>
        (entries ?? []).flatMap((e) => [
          { entry_id: e.id, depth, from: e.user_name, at: e.created_at, message: htmlToText(e.message, 1500) },
          ...flatten(e.replies, depth + 1),
        ]);
      return jsonResult({
        topic_id,
        title: topic.title,
        prompt: htmlToText(topic.message),
        entries: flatten(view.view),
      });
    },
  );

  server.registerTool(
    "canvas_post_reply",
    {
      title: "Reply to a discussion",
      description:
        "Post a reply to a discussion topic (or to a specific entry for a threaded reply). " +
        "SAFETY: defaults to a dry run — shows what would be posted but does NOT post. Re-call with confirm=true to post. " +
        "Replies are visible to the class and the instructor.",
      inputSchema: {
        course_id: z.number().int().describe("Numeric Canvas course id."),
        topic_id: z.number().int().describe("Discussion topic id (from canvas_get_discussion)."),
        message: z.string().min(1).describe("The reply text (plain text or simple HTML)."),
        parent_entry_id: z
          .number()
          .int()
          .optional()
          .describe("Optional: reply under this existing entry instead of the top level."),
        confirm: z.boolean().default(false).describe("Must be true to actually post. Default false previews only."),
      },
      annotations: write,
    },
    async ({ course_id, topic_id, message, parent_entry_id, confirm }) => {
      if (!confirm) {
        return jsonResult({
          dry_run: true,
          would_post_to: { course_id, topic_id, parent_entry_id: parent_entry_id ?? "top level" },
          message,
          next_step: "Re-call canvas_post_reply with confirm=true to post.",
        });
      }
      const path =
        parent_entry_id != null
          ? `/courses/${course_id}/discussion_topics/${topic_id}/entries/${parent_entry_id}/replies`
          : `/courses/${course_id}/discussion_topics/${topic_id}/entries`;
      const entry = await client.postForm<DiscussionEntry>(path, { message });
      return jsonResult({ posted: true, entry_id: entry.id, at: entry.created_at });
    },
  );

  server.registerTool(
    "canvas_find_person",
    {
      title: "Find a person in a course",
      description:
        "Search the people enrolled in a course by name to get their numeric user id and role. " +
        "Use this to resolve recipient ids before calling canvas_send_message. Read-only.",
      inputSchema: {
        course_id: z.number().int().describe("Numeric Canvas course id."),
        name: z.string().min(2).describe("Full or partial name to search for (e.g. 'Smith')."),
      },
      annotations: readOnly,
    },
    async ({ course_id, name }) => {
      const users = await client.getAll<CourseUser>(`/courses/${course_id}/users`, {
        search_term: name,
        include: ["enrollments", "email"],
      });
      return jsonResult({
        count: users.length,
        people: users.map((u) => ({
          user_id: u.id,
          name: u.name,
          role: u.enrollments?.[0]?.type ?? "unknown",
          email: u.email,
        })),
      });
    },
  );

  server.registerTool(
    "canvas_send_message",
    {
      title: "Send a Canvas inbox message",
      description:
        "Send a Canvas Conversations (inbox) message to one or more people. Resolve recipient_ids with " +
        "canvas_find_person first. SAFETY: defaults to a dry run — shows what would be sent but does NOT send. " +
        "Re-call with confirm=true to send. This delivers a real message on your behalf.",
      inputSchema: {
        recipient_ids: z
          .array(z.number().int())
          .min(1)
          .describe("Canvas user ids of recipients (from canvas_find_person)."),
        body: z.string().min(1).describe("Message body."),
        subject: z.string().optional().describe("Optional subject line."),
        course_id: z
          .number()
          .int()
          .optional()
          .describe("Optional course context so the message is associated with that course."),
        confirm: z.boolean().default(false).describe("Must be true to actually send. Default false previews only."),
      },
      annotations: write,
    },
    async ({ recipient_ids, body, subject, course_id, confirm }) => {
      if (!confirm) {
        return jsonResult({
          dry_run: true,
          would_send_to_user_ids: recipient_ids,
          subject: subject ?? "(none)",
          body,
          next_step: "Re-call canvas_send_message with confirm=true to send.",
        });
      }
      const fields: Record<string, string | string[]> = {
        "recipients[]": recipient_ids.map(String),
        body,
      };
      if (subject) fields.subject = subject;
      if (course_id != null) fields.context_code = `course_${course_id}`;
      const result = await client.postForm<unknown>("/conversations", fields);
      return jsonResult({ sent: true, recipients: recipient_ids, result });
    },
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CanvasClient, CanvasError } from "../client.js";
import { formatDue, jsonResult } from "../format.js";

interface AssignmentLite {
  id: number;
  name: string;
  due_at?: string | null;
  submission_types?: string[];
  allowed_extensions?: string[];
}

interface SubmissionResult {
  workflow_state?: string;
  submitted_at?: string | null;
  preview_url?: string;
}

const TYPE_MAP = {
  text: "online_text_entry",
  url: "online_url",
  file: "online_upload",
} as const;

export function registerSubmitTool(server: McpServer, client: CanvasClient): void {
  server.registerTool(
    "canvas_submit_assignment",
    {
      title: "Submit an assignment",
      description:
        "Submit work to an assignment as a text entry, a URL, or an uploaded local file. " +
        "SAFETY: defaults to a dry run — it validates and shows exactly what will be submitted but does NOT submit. " +
        "Call again with confirm=true to actually submit. Submissions are visible to the instructor and hard to undo. " +
        "Read canvas_get_assignment first to confirm the accepted submission type.",
      inputSchema: {
        course_id: z.number().int().describe("Numeric Canvas course id."),
        assignment_id: z.number().int().describe("Numeric assignment id."),
        submission_type: z
          .enum(["text", "url", "file"])
          .describe("text = typed entry, url = a web link, file = upload a local file."),
        text: z.string().optional().describe("Required when submission_type='text'. The text-entry body."),
        url: z.string().url().optional().describe("Required when submission_type='url'. The URL to submit."),
        file_path: z
          .string()
          .optional()
          .describe("Required when submission_type='file'. Absolute path to a local file to upload."),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to actually submit. Default false returns a preview only."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ course_id, assignment_id, submission_type, text, url, file_path, confirm }) => {
      // Validate the right payload field is present for the chosen type.
      const provided = { text, url, file: file_path }[submission_type];
      if (!provided) {
        throw new CanvasError(
          `submission_type='${submission_type}' requires the '${submission_type === "file" ? "file_path" : submission_type}' field.`,
        );
      }

      const assignment = await client.get<AssignmentLite>(
        `/courses/${course_id}/assignments/${assignment_id}`,
      );
      const canvasType = TYPE_MAP[submission_type];
      if (assignment.submission_types && !assignment.submission_types.includes(canvasType)) {
        throw new CanvasError(
          `This assignment doesn't accept '${canvasType}'. Accepted: ${assignment.submission_types.join(", ")}.`,
        );
      }
      if (submission_type === "file" && assignment.allowed_extensions?.length) {
        const ext = file_path!.split(".").pop()?.toLowerCase() ?? "";
        if (!assignment.allowed_extensions.map((e) => e.toLowerCase()).includes(ext)) {
          throw new CanvasError(
            `File .${ext} not allowed. Accepted extensions: ${assignment.allowed_extensions.join(", ")}.`,
          );
        }
      }

      if (!confirm) {
        return jsonResult({
          dry_run: true,
          would_submit_to: { course_id, assignment_id, name: assignment.name, due: formatDue(assignment.due_at) },
          submission_type: canvasType,
          content_preview:
            submission_type === "text" ? `${text!.slice(0, 300)}${text!.length > 300 ? "…" : ""}` : provided,
          next_step: "Re-call canvas_submit_assignment with confirm=true to actually submit.",
        });
      }

      // Execute.
      const base = `/courses/${course_id}/assignments/${assignment_id}/submissions`;
      let result: SubmissionResult;
      if (submission_type === "text") {
        result = await client.postForm<SubmissionResult>(base, {
          "submission[submission_type]": "online_text_entry",
          "submission[body]": text!,
        });
      } else if (submission_type === "url") {
        result = await client.postForm<SubmissionResult>(base, {
          "submission[submission_type]": "online_url",
          "submission[url]": url!,
        });
      } else {
        const file = await client.uploadSubmissionFile(course_id, assignment_id, file_path!);
        result = await client.postForm<SubmissionResult>(base, {
          "submission[submission_type]": "online_upload",
          "submission[file_ids][]": String(file.id),
        });
        return jsonResult({
          submitted: true,
          assignment: assignment.name,
          uploaded_file: file.filename,
          workflow_state: result.workflow_state,
          submitted_at: result.submitted_at,
          preview_url: result.preview_url,
        });
      }
      return jsonResult({
        submitted: true,
        assignment: assignment.name,
        submission_type: canvasType,
        workflow_state: result.workflow_state,
        submitted_at: result.submitted_at,
        preview_url: result.preview_url,
      });
    },
  );
}

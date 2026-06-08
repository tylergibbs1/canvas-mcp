import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CanvasClient } from "../client.js";
import { formatDue, htmlToText, jsonResult } from "../format.js";

// --- Minimal Canvas response shapes (only the fields we surface) ---

interface Enrollment {
  type: string;
  enrollment_state: string;
  computed_current_score?: number | null;
  computed_current_grade?: string | null;
}
interface Course {
  id: number;
  name?: string | null;
  course_code?: string;
  enrollments?: Enrollment[];
  term?: { name?: string } | null;
}
interface Submission {
  workflow_state?: string;
  score?: number | null;
  grade?: string | null;
  submitted_at?: string | null;
  graded_at?: string | null;
  late?: boolean;
  missing?: boolean;
  submission_comments?: { author_name?: string; comment?: string; created_at?: string }[];
}
interface Assignment {
  id: number;
  name: string;
  due_at?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  allowed_extensions?: string[];
  html_url?: string;
  description?: string | null;
  rubric?: { description: string; points: number }[];
  submission?: Submission;
}
interface PlannerItem {
  plannable_type: string;
  plannable_date?: string | null;
  course_id?: number;
  context_name?: string;
  html_url?: string;
  submissions?: false | { submitted?: boolean; graded?: boolean; missing?: boolean };
  plannable?: { title?: string; due_at?: string | null; points_possible?: number | null };
}
interface Announcement {
  id: number;
  title: string;
  posted_at?: string | null;
  message?: string | null;
  html_url?: string;
  context_code?: string;
}

function studentEnrollment(course: Course): Enrollment | undefined {
  return course.enrollments?.find((e) => e.type === "StudentEnrollment" || e.type === "student");
}

function submissionStatus(s: Submission | undefined): string {
  if (!s) return "unknown";
  if (s.missing) return "missing";
  if (s.workflow_state === "graded") return "graded";
  if (s.submitted_at) return s.late ? "submitted (late)" : "submitted";
  return "not submitted";
}

export function registerReadTools(server: McpServer, client: CanvasClient): void {
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "canvas_list_courses",
    {
      title: "List active courses",
      description:
        "List the user's currently active courses with course code, term, and current overall grade. " +
        "Start here to get the numeric course_id needed by every other course-scoped tool. Read-only.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const courses = await client.getAll<Course>("/courses", {
        enrollment_state: "active",
        include: ["total_scores", "term"],
      });
      const rows = courses
        .filter((c) => c.name)
        .map((c) => {
          const e = studentEnrollment(c);
          return {
            course_id: c.id,
            name: c.name,
            code: c.course_code,
            term: c.term?.name,
            current_grade:
              e?.computed_current_score != null
                ? `${e.computed_current_score}%${e.computed_current_grade ? ` (${e.computed_current_grade})` : ""}`
                : "n/a",
          };
        });
      return jsonResult({ count: rows.length, courses: rows });
    },
  );

  server.registerTool(
    "canvas_deadlines",
    {
      title: "Upcoming deadlines across all courses",
      description:
        "Everything due in the next `days` days across ALL courses, in one call (uses Canvas's planner). " +
        "Each item shows the course, title, due date with a relative hint, points, and your submission status. " +
        "This is the tool to answer 'what's due / what do I have coming up'. Read-only.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(14)
          .describe("Look-ahead window in days from now (default 14)."),
      },
      annotations: readOnly,
    },
    async ({ days }) => {
      const now = new Date();
      const end = new Date(now.getTime() + days * 86_400_000);
      const [items, courses] = await Promise.all([
        client.getAll<PlannerItem>(
          "/planner/items",
          { start_date: now.toISOString(), end_date: end.toISOString() },
          100,
        ),
        client.getAll<Course>("/courses", { enrollment_state: "active" }),
      ]);
      const courseName = new Map(courses.map((c) => [c.id, c.name ?? c.course_code ?? `course ${c.id}`]));
      const rows = items
        .filter((i) => i.plannable?.due_at)
        .map((i) => {
          const sub = i.submissions;
          return {
            course: i.context_name ?? (i.course_id ? courseName.get(i.course_id) : undefined),
            type: i.plannable_type,
            title: i.plannable?.title,
            due: formatDue(i.plannable?.due_at),
            due_at: i.plannable?.due_at,
            points: i.plannable?.points_possible ?? null,
            status:
              sub === false || !sub
                ? "not submitted"
                : sub.graded
                  ? "graded"
                  : sub.submitted
                    ? "submitted"
                    : sub.missing
                      ? "missing"
                      : "not submitted",
            url: i.html_url,
          };
        })
        .sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""));
      return jsonResult({ window_days: days, count: rows.length, deadlines: rows });
    },
  );

  server.registerTool(
    "canvas_list_assignments",
    {
      title: "List assignments in a course",
      description:
        "List assignments for one course with due date, points, and your submission status. " +
        "Use canvas_list_courses first to get the course_id. Read-only.",
      inputSchema: {
        course_id: z.number().int().describe("Numeric Canvas course id (from canvas_list_courses)."),
        include_past: z
          .boolean()
          .default(true)
          .describe("Include assignments whose due date has passed (default true)."),
      },
      annotations: readOnly,
    },
    async ({ course_id, include_past }) => {
      const assignments = await client.getAll<Assignment>(`/courses/${course_id}/assignments`, {
        include: ["submission"],
        order_by: "due_at",
      });
      const now = Date.now();
      const rows = assignments
        .filter((a) => include_past || !a.due_at || new Date(a.due_at).getTime() >= now)
        .map((a) => ({
          assignment_id: a.id,
          name: a.name,
          due: formatDue(a.due_at),
          points: a.points_possible ?? null,
          status: submissionStatus(a.submission),
          score: a.submission?.score ?? null,
          url: a.html_url,
        }));
      return jsonResult({ course_id, count: rows.length, assignments: rows });
    },
  );

  server.registerTool(
    "canvas_get_assignment",
    {
      title: "Get full assignment detail",
      description:
        "Full detail for one assignment: instructions (HTML stripped to text), accepted submission types, " +
        "allowed file extensions, rubric, due date, and your current submission status + instructor comments. " +
        "Read this before submitting so you know what format is required. Read-only.",
      inputSchema: {
        course_id: z.number().int().describe("Numeric Canvas course id."),
        assignment_id: z.number().int().describe("Numeric assignment id (from canvas_list_assignments)."),
      },
      annotations: readOnly,
    },
    async ({ course_id, assignment_id }) => {
      const a = await client.get<Assignment>(`/courses/${course_id}/assignments/${assignment_id}`, {
        include: ["submission", "submission_comments"],
      });
      return jsonResult({
        assignment_id: a.id,
        name: a.name,
        due: formatDue(a.due_at),
        points: a.points_possible ?? null,
        accepted_submission_types: a.submission_types ?? [],
        allowed_extensions: a.allowed_extensions ?? [],
        instructions: htmlToText(a.description),
        rubric: a.rubric?.map((r) => ({ criterion: r.description, points: r.points })),
        your_submission: {
          status: submissionStatus(a.submission),
          score: a.submission?.score ?? null,
          grade: a.submission?.grade ?? null,
          submitted_at: a.submission?.submitted_at ?? null,
          instructor_comments:
            a.submission?.submission_comments?.map((c) => ({
              from: c.author_name,
              comment: c.comment,
              at: c.created_at,
            })) ?? [],
        },
        url: a.html_url,
      });
    },
  );

  server.registerTool(
    "canvas_get_grades",
    {
      title: "Get grades and feedback",
      description:
        "Without assignment_id: all graded assignments in the course plus your overall current grade. " +
        "With assignment_id: detailed feedback for that one — score, grade, instructor comments, and rubric assessment. " +
        "Read-only.",
      inputSchema: {
        course_id: z.number().int().describe("Numeric Canvas course id."),
        assignment_id: z
          .number()
          .int()
          .optional()
          .describe("Optional: get detailed feedback for a single assignment instead of the course summary."),
      },
      annotations: readOnly,
    },
    async ({ course_id, assignment_id }) => {
      if (assignment_id != null) {
        const s = await client.get<Submission & { assignment_id: number; rubric_assessment?: unknown }>(
          `/courses/${course_id}/assignments/${assignment_id}/submissions/self`,
          { include: ["submission_comments", "rubric_assessment"] },
        );
        return jsonResult({
          course_id,
          assignment_id,
          score: s.score ?? null,
          grade: s.grade ?? null,
          status: submissionStatus(s),
          instructor_comments:
            s.submission_comments?.map((c) => ({ from: c.author_name, comment: c.comment, at: c.created_at })) ?? [],
          rubric_assessment: s.rubric_assessment ?? null,
        });
      }
      // Read the overall grade from the same endpoint+field as canvas_list_courses
      // (course include=total_scores → enrollment.computed_current_score). The
      // /enrollments endpoint exposes it under a different shape (grades.current_score),
      // so using one source keeps the two tools consistent.
      const [assignments, course] = await Promise.all([
        client.getAll<Assignment>(`/courses/${course_id}/assignments`, { include: ["submission"] }),
        client.get<Course>(`/courses/${course_id}`, { include: ["total_scores"] }),
      ]);
      const e = studentEnrollment(course);
      const graded = assignments
        .filter((a) => a.submission?.workflow_state === "graded" && a.submission.score != null)
        .map((a) => ({
          name: a.name,
          score: a.submission?.score ?? null,
          out_of: a.points_possible ?? null,
        }));
      return jsonResult({
        course_id,
        overall_grade:
          e?.computed_current_score != null
            ? `${e.computed_current_score}%${e.computed_current_grade ? ` (${e.computed_current_grade})` : ""}`
            : "n/a",
        graded_count: graded.length,
        graded_assignments: graded,
      });
    },
  );

  server.registerTool(
    "canvas_list_announcements",
    {
      title: "List recent announcements",
      description:
        "Recent announcements. Omit course_id to gather announcements across all active courses, or pass a " +
        "course_id to scope to one. Covers the last `days` days (default 21). Read-only.",
      inputSchema: {
        course_id: z.number().int().optional().describe("Optional: limit to one course."),
        days: z.number().int().min(1).max(120).default(21).describe("Look-back window in days (default 21)."),
      },
      annotations: readOnly,
    },
    async ({ course_id, days }) => {
      const start = new Date(Date.now() - days * 86_400_000).toISOString();
      let announcements: Announcement[];
      if (course_id != null) {
        announcements = await client.getAll<Announcement>(`/courses/${course_id}/discussion_topics`, {
          only_announcements: true,
        });
      } else {
        const courses = await client.getAll<Course>("/courses", { enrollment_state: "active" });
        const contextCodes = courses.filter((c) => c.name).map((c) => `course_${c.id}`);
        announcements =
          contextCodes.length === 0
            ? []
            : await client.getAll<Announcement>("/announcements", {
                context_codes: contextCodes,
                start_date: start,
              });
      }
      const rows = announcements
        .map((a) => ({
          title: a.title,
          posted: formatDue(a.posted_at),
          posted_at: a.posted_at,
          message: htmlToText(a.message, 1200),
          url: a.html_url,
        }))
        .sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? ""));
      return jsonResult({ count: rows.length, announcements: rows });
    },
  );
}

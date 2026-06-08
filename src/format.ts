/**
 * Response-shaping helpers. Canvas payloads are large and HTML-laden; agents
 * pay for every token, so we strip noise and surface human-readable fields.
 */

/** Collapse Canvas HTML into readable plain text, capped to avoid context bloat. */
export function htmlToText(html: string | null | undefined, maxChars = 4000): string {
  if (!html) return "";
  const text = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

/** ISO timestamp → "Mon Jun 8, 11:59 PM" with a relative hint, or "no due date". */
export function formatDue(iso: string | null | undefined): string {
  if (!iso) return "no due date";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const abs = date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const diffMs = date.getTime() - Date.now();
  const diffDays = Math.round(diffMs / 86_400_000);
  const rel =
    diffMs < 0
      ? `${Math.abs(diffDays)}d ago`
      : diffDays === 0
        ? "today"
        : diffDays === 1
          ? "tomorrow"
          : `in ${diffDays}d`;
  return `${abs} (${rel})`;
}

/** Wrap any JSON-serializable value as an MCP text result. */
export function jsonResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Wrap a markdown/plain string as an MCP text result. */
export function textResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

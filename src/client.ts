import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Thin, typed wrapper over the Canvas LMS REST API.
 *
 * Hides three things callers should never reimplement:
 *  - bearer auth + base-URL joining
 *  - cursor pagination via the RFC-5988 `Link` header
 *  - the 3-step file-upload handshake required to submit a file
 *
 * Every failure path throws `CanvasError` with a message an agent can act on.
 */
export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

export interface CanvasConfig {
  /** e.g. "https://canvas.okstate.edu" — no trailing slash, no /api/v1. */
  baseUrl: string;
  /** Personal access token (Account → Settings → New Access Token). */
  token: string;
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

export class CanvasClient {
  private readonly apiBase: string;
  private readonly token: string;

  constructor(config: CanvasConfig) {
    this.apiBase = `${config.baseUrl.replace(/\/+$/, "")}/api/v1`;
    this.token = config.token;
  }

  /** Build a full API URL with query params (arrays use Canvas's `key[]` form). */
  private url(path: string, query?: Query): string {
    const u = new URL(`${this.apiBase}${path.startsWith("/") ? "" : "/"}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) u.searchParams.append(`${key}[]`, v);
      } else {
        u.searchParams.set(key, String(value));
      }
    }
    return u.toString();
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async parseError(res: Response, url: string): Promise<CanvasError> {
    let detail = "";
    try {
      const body = (await res.json()) as { errors?: unknown; message?: string };
      detail = body.message ?? JSON.stringify(body.errors ?? body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    const hint =
      res.status === 401
        ? " — token is missing, invalid, or expired. Regenerate it at Account → Settings → New Access Token and update CANVAS_TOKEN."
        : res.status === 403
          ? " — token lacks permission for this resource, or the action isn't allowed for your role."
          : res.status === 404
            ? " — the course/assignment/resource id doesn't exist or you're not enrolled in it."
            : "";
    return new CanvasError(
      `Canvas API ${res.status} ${res.statusText}: ${detail}${hint}`,
      res.status,
      url,
    );
  }

  /** GET a single resource (object response). */
  async get<T>(path: string, query?: Query): Promise<T> {
    const url = this.url(path, query);
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw await this.parseError(res, url);
    return (await res.json()) as T;
  }

  /**
   * GET a paginated list, following `Link: rel="next"` until exhausted or
   * `maxItems` is reached. Defaults to 100/page (Canvas max).
   */
  async getAll<T>(path: string, query?: Query, maxItems = 200): Promise<T[]> {
    let next: string | null = this.url(path, { per_page: 100, ...query });
    const items: T[] = [];
    while (next && items.length < maxItems) {
      const res: Response = await fetch(next, { headers: this.authHeaders() });
      if (!res.ok) throw await this.parseError(res, next);
      const page = (await res.json()) as T[];
      items.push(...page);
      next = parseNextLink(res.headers.get("link"));
    }
    return items.slice(0, maxItems);
  }

  /** POST with form-encoded body (Canvas's native content type). */
  async postForm<T>(path: string, fields: Record<string, string | string[]>): Promise<T> {
    const url = this.url(path);
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) for (const v of value) form.append(key, v);
      else form.append(key, value);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) throw await this.parseError(res, url);
    return (await res.json()) as T;
  }

  /**
   * Upload a local file to a Canvas assignment submission slot and return the
   * resulting Canvas file id. Implements the required 3-step handshake:
   *   1. tell Canvas the filename/size → get a one-time upload target
   *   2. POST the bytes to that target
   *   3. confirm and read back the file id
   */
  async uploadSubmissionFile(
    courseId: number,
    assignmentId: number,
    filePath: string,
  ): Promise<{ id: number; filename: string }> {
    const info = await stat(filePath).catch(() => {
      throw new CanvasError(`Local file not found: ${filePath}`);
    });
    const filename = basename(filePath);

    // Step 1: request an upload slot.
    const slot = await this.postForm<{ upload_url: string; upload_params: Record<string, string> }>(
      `/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`,
      { name: filename, size: String(info.size) },
    );

    // Step 2: POST the bytes (params first, file last — Canvas requires this order).
    const bytes = await readFile(filePath);
    const upload = new FormData();
    for (const [k, v] of Object.entries(slot.upload_params)) upload.append(k, v);
    upload.append("file", new Blob([new Uint8Array(bytes)]), filename);
    const uploadRes = await fetch(slot.upload_url, { method: "POST", body: upload, redirect: "manual" });

    // Step 3: confirm. Success is 201 (body has the file) or 3xx → follow once.
    if (uploadRes.status >= 300 && uploadRes.status < 400) {
      const confirmUrl = uploadRes.headers.get("location");
      if (!confirmUrl) throw new CanvasError("File upload confirmation redirect had no Location header.");
      const confirmed = await fetch(confirmUrl, { method: "GET", headers: this.authHeaders() });
      if (!confirmed.ok) throw await this.parseError(confirmed, confirmUrl);
      const file = (await confirmed.json()) as { id: number; filename: string };
      return { id: file.id, filename: file.filename ?? filename };
    }
    if (!uploadRes.ok) {
      throw new CanvasError(`File upload failed: ${uploadRes.status} ${uploadRes.statusText}`, uploadRes.status);
    }
    const file = (await uploadRes.json()) as { id: number; filename?: string };
    return { id: file.id, filename: file.filename ?? filename };
  }
}

/** Extract the `rel="next"` URL from a Canvas `Link` header, or null. */
function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1] ?? null;
  }
  return null;
}

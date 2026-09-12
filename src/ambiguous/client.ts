import { setTimeout as delay } from 'node:timers/promises';
import { renderDoc } from './render.ts';

// Deliberately narrow projections of the verified OpenAPI schemas. Extra response
// fields are allowed; additions belong here only after checking the live contract.
export type DocumentResult = { id: string; title: string; type: string; import_warnings?: string[] };
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled' | 'blocked';
export type TaskResult = {
  id: string;
  title: string;
  status: TaskStatus;
  assignee_id: string | null;
  completed_at: string | null;
};
export type TaskComment = {
  id: string;
  task_id: string;
  content: string;
  created_at: string | null;
  updated_at: string | null;
  author: { id: string; display_name: string | null; primary_email: string | null } | null;
  replies: TaskComment[];
};
export type Page<T> = { data: T[]; total: number; has_more: boolean };
export type TaskInput = {
  title: string;
  description?: string;
  assignee_id: string;
  status?: TaskStatus;
  due_date?: string;
};
export type CalendarEventInput = {
  title: string;
  start_at: string;
  end_at: string;
  description?: string;
  attendees?: string[];
  meeting_notes_doc_id?: string;
};
export type CalendarEventResult = { id: string; calendar_id: string; title: string; start_at: string; end_at: string };
export type MailInput = {
  to: string[];
  subject: string;
  body_markdown: string;
  in_reply_to?: string;
  thread_id?: string;
};
export type MailParticipant = { email: string; id?: string; type?: 'human' | 'agent' | null };
export type MailResult = {
  id: string;
  read: boolean;
  subject?: string;
  from?: MailParticipant | null;
  body_text?: string | null;
  body_html?: string | null;
  thread_id?: string | null;
  received_at?: string | null;
  message_id?: string | null;
  delivery_status?: string;
};
export type RequestLog = {
  service: 'reeve';
  operation: string;
  method: 'GET' | 'POST';
  attempt: number;
  status: number | null;
  duration_ms: number;
};
export type ClientOptions = {
  baseUrl: string;
  agentKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (entry: RequestLog) => void;
};

export class AmbiguousApiError extends Error {
  readonly status: number | null;
  readonly operation: string;
  constructor(operation: string, status: number | null) {
    // Never surface the response body, fetch error, URL, or credentials in logs.
    super(`Ambiguous ${operation} failed (${status ?? 'transport/timeout'})`);
    this.name = 'AmbiguousApiError';
    this.status = status;
    this.operation = operation;
  }
}

export class AmbiguousClient {
  readonly #base: URL;
  readonly #key: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #log: (entry: RequestLog) => void;
  readonly #timeout: number;
  readonly #retries: number;

  constructor(options: ClientOptions) {
    this.#base = new URL(options.baseUrl);
    if (!['https:', 'http:'].includes(this.#base.protocol) || this.#base.username || this.#base.password ||
        this.#base.pathname !== '/' || this.#base.search || this.#base.hash) {
      throw new Error('AMBIGUOUS_BASE must be an HTTP(S) origin without credentials');
    }
    if (this.#base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.#base.hostname)) {
      throw new Error('AMBIGUOUS_BASE must use HTTPS except for local development');
    }
    if (!options.agentKey.trim()) throw new Error('AMBIGUOUS_AGENT_KEY is required');
    this.#key = options.agentKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? (async (ms) => { await delay(ms); });
    this.#log = options.log ?? ((entry) => console.info(JSON.stringify(entry)));
    this.#timeout = options.timeoutMs ?? 10_000;
    this.#retries = options.maxRetries ?? 2;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || !Number.isSafeInteger(this.#retries) ||
        this.#retries < 0 || this.#retries > 5) throw new Error('Invalid Ambiguous timeout/retry configuration');
  }

  documentUrl(id: string): string {
    // UI path verified in the official coworker recipe, not inferred from REST.
    return new URL(`/docs/${encodeURIComponent(id)}`, this.#base).href;
  }

  createDocument(input: { title: string; content: string }): Promise<DocumentResult> {
    return this.#request('createDocument', '/api/documents', 'POST', { ...input, type: 'doc', content: renderDoc(input.content) });
  }

  async createTask(input: TaskInput): Promise<TaskResult> {
    const result = await this.#request<{ task: TaskResult }>('createTask', '/api/tasks', 'POST', input);
    return result.task;
  }

  async getTask(id: string): Promise<TaskResult> {
    const result = await this.#request<{ task: TaskResult }>('getTask', `/api/tasks/${encodeURIComponent(id)}`, 'GET');
    return result.task;
  }

  getTaskComments(id: string, page: { limit?: number; offset?: number } = {}): Promise<Page<TaskComment>> {
    const params = new URLSearchParams();
    if (page.limit !== undefined) params.set('limit', String(page.limit));
    if (page.offset !== undefined) params.set('offset', String(page.offset));
    const query = params.size ? `?${params}` : '';
    return this.#request('getTaskComments', `/api/tasks/${encodeURIComponent(id)}/comments${query}`, 'GET');
  }

  createCalendarEvent(calendarId: string, input: CalendarEventInput): Promise<CalendarEventResult> {
    return this.#request('createCalendarEvent', `/api/calendars/${encodeURIComponent(calendarId)}/events`, 'POST', input);
  }

  sendMail(input: MailInput, idempotencyKey: string): Promise<MailResult> {
    if (!idempotencyKey.trim() || idempotencyKey.length > 255) throw new Error('Mail requires a stable idempotency key of 1–255 characters');
    return this.#request('sendMail', '/api/mail/send', 'POST', input, idempotencyKey);
  }

  getEmail(id: string): Promise<MailResult> {
    return this.#request('getEmail', `/api/mail/${encodeURIComponent(id)}`, 'GET');
  }

  getWebhookEventTypes(): Promise<Page<{ type: string; description: string }>> {
    return this.#request('getWebhookEventTypes', '/api/webhooks/event-types', 'GET');
  }

  async #request<T>(operation: string, path: string, method: 'GET' | 'POST', body?: unknown, idempotencyKey?: string): Promise<T> {
    const safeToRetry = method === 'GET' || (path === '/api/mail/send' && Boolean(idempotencyKey));
    const attempts = safeToRetry ? this.#retries + 1 : 1;
    // Serialize once: idempotent sends must use identical parameters on retry.
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeout);
      const started = Date.now();
      let status: number | null = null;
      let retryAfter: string | null = null;
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.#key}`, 'API-Version': '1', Accept: 'application/json' };
        if (serialized !== undefined) headers['Content-Type'] = 'application/json';
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        const response = await this.#fetch(new URL(path, this.#base), {
          method, headers, ...(serialized === undefined ? {} : { body: serialized }),
          signal: controller.signal, redirect: 'error',
        });
        status = response.status;
        retryAfter = response.headers.get('Retry-After');
        if (response.ok) return await response.json() as T;
        await response.body?.cancel();
      } catch {
        // Transport errors can contain secrets; discard them. A response whose
        // successful body cannot be decoded is ambiguous and is not replayed.
        if (status !== null && status >= 200 && status < 300) throw new AmbiguousApiError(operation, status);
      } finally {
        clearTimeout(timer);
        this.#log({ service: 'reeve', operation, method, attempt, status, duration_ms: Date.now() - started });
      }
      if (attempt === attempts || (status !== null && status !== 429 && status < 500)) {
        throw new AmbiguousApiError(operation, status);
      }
      const requestedDelay = retryAfter === null ? NaN : (/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
      // Avoid holding the process for an unbounded server-supplied interval.
      if (Number.isFinite(requestedDelay) && requestedDelay > 30_000) throw new AmbiguousApiError(operation, status);
      await this.#sleep(Number.isFinite(requestedDelay) ? Math.max(0, requestedDelay) : 250 * 2 ** (attempt - 1));
    }
    throw new AmbiguousApiError(operation, null);
  }
}

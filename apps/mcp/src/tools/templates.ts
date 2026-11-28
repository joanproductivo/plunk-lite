import * as z from 'zod';

import type {PlunkClient} from '../client.js';
import {EMAIL_TYPES} from '../schemas.js';

import {errorResult, jsonResult, OPT_OUT_TOPIC, pageHint, register, runTool, type ToolContext} from './shared.js';

/** `GET /templates` is page-based, like `GET /workflows`. */
interface TemplateList {
  data: unknown[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function registerTemplateTools(ctx: ToolContext, client: PlunkClient): void {
  register(
    ctx,
    'plunk_list_templates',
    {
      title: 'List templates',
      description: [
        '**Purpose:** List reusable email templates in the project.',
        '',
        '**NOT for:** Listing campaigns (use `plunk_list_campaigns`). A template is reusable content;',
        'a campaign is one send to an audience.',
        '',
        '**Returns:** A page of templates with their IDs, names, subjects and types, and (Plunk Lite) their',
        'opt-out topic in `optOutSegmentId`.',
        '',
        '**When to use:** Before `plunk_send_email` with a `template`, to find the right template ID.',
        '',
        '**Key trigger phrases:** "what templates do I have", "list my templates"',
      ].join('\n'),
      inputSchema: z.object({
        search: z.string().optional().describe('Substring match on the template name.'),
        type: z.enum(EMAIL_TYPES).optional().describe('Filter by template type.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Items per page (max 100).'),
        page: z.number().int().min(1).default(1).describe('Page number, starting at 1.'),
      }),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({search, type, limit, page}) =>
      runTool(async () => {
        const result = await client.request<TemplateList>({
          path: '/templates',
          query: {search, type, page, pageSize: limit},
        });

        return jsonResult(
          `Found ${result.total} template(s); showing ${result.data.length}.` +
            pageHint(result.page, result.totalPages),
          result,
        );
      }),
  );

  register(
    ctx,
    'plunk_create_template',
    {
      title: 'Create template',
      description: [
        '**Purpose:** Create a reusable email template. Templates can be rendered by `plunk_send_email`',
        'and reused by automation workflows.',
        '',
        '**NOT for:** Sending anything. Creating a template sends no email to anyone.',
        '',
        '**Returns:** The created template including its ID.',
        '',
        '**Body:** HTML. Use `{{variable}}` placeholders to interpolate contact data at send time —',
        'for example `{{name}}` or `{{data.plan}}`.',
        '',
        '**Requirements:** `from` must be on a domain verified for this project, or sending will fail later.',
        '',
        ...OPT_OUT_TOPIC,
        "The type defaults to MARKETING, so a template with a topic needs `type: 'TRANSACTIONAL'`.",
        '',
        '**Key trigger phrases:** "create a template", "save this email for reuse"',
      ].join('\n'),
      inputSchema: z.object({
        name: z.string().describe('Internal name for the template. Not shown to recipients.'),
        subject: z.string().describe('Subject line. May contain {{variable}} placeholders.'),
        body: z.string().describe('HTML body. May contain {{variable}} placeholders.'),
        from: z.string().describe('Sender address. Must be on a verified domain.'),
        fromName: z.string().optional().describe('Sender display name.'),
        replyTo: z.string().optional().describe('Reply-to address.'),
        description: z.string().optional().describe('Internal note. Not sent to recipients.'),
        type: z.enum(EMAIL_TYPES).default('MARKETING').describe('Template type.'),
        optOutSegmentId: z
          .string()
          .uuid()
          .optional()
          .describe('Opt-out topic: a static segment id. TRANSACTIONAL templates only (Plunk Lite).'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async (input) =>
      runTool(async () => {
        const template = await client.request<Record<string, unknown>>({
          method: 'POST',
          path: '/templates',
          body: input,
        });
        if (input.optOutSegmentId && !Object.hasOwn(template, 'optOutSegmentId')) {
          return errorResult(
            `The template was created (${String(template.id)}), but WITHOUT its opt-out topic: this installation ` +
              'does not support opt-out topics yet.',
          );
        }
        return jsonResult('Template created:', template);
      }),
  );

  register(
    ctx,
    'plunk_update_template',
    {
      title: 'Update template',
      description: [
        '**Purpose:** Change a template: its name, description, subject, body, sender, reply-to, type or',
        '(Plunk Lite) opt-out topic. Only the fields given change.',
        '',
        '**NOT for:** Sending anything, or editing a campaign (use `plunk_update_campaign`).',
        '',
        '**Note:** a changed `body` or `subject` reaches the active workflows that use the template at once.',
        'Moving a template with an opt-out topic to a type other than TRANSACTIONAL needs',
        '`optOutSegmentId: null` in the same call.',
        '',
        ...OPT_OUT_TOPIC,
        'Setting it means whoever opts out stops getting this template; `null` removes it, and then the',
        'contacts who opted out get the template again.',
        '',
        '**Requirements:** `from` must be on a domain verified for this project.',
        '',
        '**Returns:** The updated template.',
        '',
        '**Key trigger phrases:** "edit the template", "change the subject of", "add an unsubscribe to"',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().min(1).describe('The template ID.'),
        name: z.string().min(1).max(100).optional().describe('New internal name.'),
        description: z.string().max(500).optional().describe('New internal note.'),
        subject: z.string().min(1).optional().describe('New subject line. May contain {{variable}} placeholders.'),
        body: z.string().min(1).optional().describe('New HTML body. May contain {{variable}} placeholders.'),
        from: z.string().email().optional().describe('New sender address, on a verified domain.'),
        fromName: z.string().max(100).nullable().optional().describe('New sender display name; null removes it.'),
        replyTo: z.string().email().nullable().optional().describe('New reply-to address; null removes it.'),
        type: z.enum(EMAIL_TYPES).optional().describe('New template type.'),
        optOutSegmentId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe('Opt-out topic: a static segment id, or null to remove it. TRANSACTIONAL only (Plunk Lite).'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, ...fields}) =>
      runTool(async () => {
        const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
        if (Object.keys(body).length === 0) {
          return errorResult(
            'Nothing to update: pass name, description, subject, body, from, fromName, replyTo, type or optOutSegmentId.',
          );
        }

        const path = `/templates/${encodeURIComponent(id)}`;

        // An installation without opt-out topics ignores the field and answers 200, having written the
        // rest: check before writing anything
        if (fields.optOutSegmentId !== undefined) {
          const current = await client.request<Record<string, unknown>>({path});
          if (!Object.hasOwn(current, 'optOutSegmentId')) {
            return errorResult('Nothing was changed: this installation does not support opt-out topics yet.');
          }
        }

        const template = await client.request({method: 'PATCH', path, body});
        return jsonResult('Template updated:', template);
      }),
  );
}

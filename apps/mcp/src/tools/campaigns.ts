import * as z from 'zod';

import type {PlunkClient} from '../client.js';
import {EMAIL_TYPES, FILTER_HELP, filterCondition} from '../schemas.js';

import {
  errorResult,
  jsonResult,
  OPT_OUT_TOPIC,
  pageHint,
  register,
  requireConfirmation,
  runTool,
  type ToolContext,
} from './shared.js';

/** `GET /campaigns` is page-based, like `GET /workflows`. */
interface CampaignList {
  data: unknown[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface Campaign {
  id: string;
  name?: string;
  subject?: string;
  status?: string;
  audienceType?: string;
  /** What the API actually returns. `recipientCount` is accepted as a fallback. */
  totalRecipients?: number;
  recipientCount?: number;
  type?: string;
  /** Plunk Lite: the opt-out topic; absent on an installation without it */
  optOutSegmentId?: string | null;
}

/**
 * Plunk Lite: how many of a TRANSACTIONAL campaign's recipients are unsubscribed -- such a campaign
 * reaches them too -- or undefined when the API cannot say. 0 for any other campaign.
 */
async function unsubscribedRecipients(client: PlunkClient, campaign: Campaign): Promise<number | undefined> {
  if (campaign.type !== 'TRANSACTIONAL') {
    return 0;
  }
  try {
    const audience = unwrap(
      await client.request<{unsubscribed: number} | {success: boolean; data: {unsubscribed: number}}>({
        path: `/campaigns/${encodeURIComponent(campaign.id)}/audience`,
      }),
    );
    return typeof audience?.unsubscribed === 'number' ? audience.unsubscribed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The single-campaign routes wrap their payload as `{success, data}` while
 * `GET /campaigns` returns the page unwrapped. Reading through the envelope in
 * one place keeps that inconsistency out of the individual tools — and matters
 * for more than tidiness: the send confirmation reads the recipient count off
 * this object, and silently showed "its SEGMENT audience" for every campaign
 * while it was reading the envelope instead of the campaign.
 */
async function getCampaign(client: PlunkClient, id: string): Promise<Campaign> {
  const response = await client.request<Campaign | {success: boolean; data: Campaign}>({
    path: `/campaigns/${encodeURIComponent(id)}`,
  });

  return response && 'data' in response ? response.data : (response as Campaign);
}

/**
 * Plunk Lite: up to 20 segments a campaign leaves out (CAMPAIGN_EXCLUDED_SEGMENTS_MAX in
 * @plunk/shared, which this package cannot import: schemas.ts)
 */
const excludedSegmentIds = z.array(z.string()).max(20).optional();

/** What a campaign write is missing for its audience type, before anything is sent to the API */
function audienceInputError(input: {audienceType?: string; segmentId?: string; audienceCondition?: unknown}) {
  if (input.audienceType === 'SEGMENT' && !input.segmentId) {
    return errorResult(
      'audienceType is SEGMENT but no segmentId was given. Call plunk_list_segments to find the segment ID.',
    );
  }
  if (input.audienceType === 'FILTERED' && !input.audienceCondition) {
    return errorResult('audienceType is FILTERED but no audienceCondition was given.');
  }
  return undefined;
}

/** Unwraps the same `{success, data}` envelope for any single-campaign payload. */
function unwrap<T>(response: T | {success: boolean; data: T}): T {
  return response && typeof response === 'object' && 'data' in response
    ? (response as {data: T}).data
    : (response as T);
}

export function registerCampaignTools(ctx: ToolContext, client: PlunkClient): void {
  register(
    ctx,
    'plunk_list_campaigns',
    {
      title: 'List campaigns',
      description: [
        '**Purpose:** List campaigns and their status (draft, scheduled, sending, sent).',
        '',
        '**NOT for:** Listing templates (use `plunk_list_templates`).',
        '',
        '**Returns:** A page of campaigns with IDs, names, subjects, audience and status.',
        '',
        '**When to use:** To find a campaign ID before sending, or to report on what has gone out.',
        '',
        '**Key trigger phrases:** "my campaigns", "what did I send", "is the campaign scheduled"',
      ].join('\n'),
      inputSchema: z.object({
        search: z.string().optional().describe('Substring match on campaign name.'),
        status: z.string().optional().describe('Filter by status, e.g. DRAFT or SENT.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Items per page (max 100).'),
        page: z.number().int().min(1).default(1).describe('Page number, starting at 1.'),
      }),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({search, status, limit, page}) =>
      runTool(async () => {
        const result = await client.request<CampaignList>({
          path: '/campaigns',
          query: {search, status, page, pageSize: limit},
        });

        return jsonResult(
          `Found ${result.total} campaign(s); showing ${result.data.length}.` +
            pageHint(result.page, result.totalPages),
          result,
        );
      }),
  );

  register(
    ctx,
    'plunk_create_campaign',
    {
      title: 'Create campaign',
      description: [
        '**Purpose:** Create a campaign — one email addressed to a whole audience. Creating it does',
        '**not** send it; it starts as a draft and goes out only via `plunk_send_campaign`.',
        '',
        '**NOT for:** Emailing one or a few named people (use `plunk_send_email`).',
        '',
        '**Returns:** The created campaign including its ID and resolved audience size.',
        '',
        '**Audience:**',
        '- `ALL` — every subscribed contact',
        '- `SEGMENT` — one existing segment; requires `segmentId` (find one with `plunk_list_segments`)',
        '- `FILTERED` — an inline filter tree; requires `audienceCondition`',
        '',
        'Any of them can leave out the contacts of some segments with `excludedSegmentIds`: they never',
        'get the campaign, even when they are also in the audience.',
        '',
        ...OPT_OUT_TOPIC,
        "The type defaults to MARKETING, so a campaign with a topic needs `type: 'TRANSACTIONAL'`; its audience",
        'cannot be the topic segment itself. Change it later with `plunk_update_campaign`, while it is a draft.',
        '',
        FILTER_HELP,
        '',
        '**Key trigger phrases:** "create a campaign", "draft a newsletter", "email my whole list"',
      ].join('\n'),
      inputSchema: z.object({
        name: z.string().describe('Internal campaign name.'),
        subject: z.string().describe('Subject line.'),
        body: z.string().describe('HTML body.'),
        from: z.string().describe('Sender address. Must be on a verified domain.'),
        fromName: z.string().optional().describe('Sender display name.'),
        replyTo: z.string().optional().describe('Reply-to address.'),
        description: z.string().optional().describe('Internal note.'),
        type: z.enum(EMAIL_TYPES).default('MARKETING').describe('Content type.'),
        audienceType: z.enum(['ALL', 'SEGMENT', 'FILTERED']).describe('Who receives this campaign.'),
        segmentId: z.string().optional().describe('Segment ID. Required when audienceType is SEGMENT.'),
        audienceCondition: z
          .optional(filterCondition)
          .describe('Inline filter tree. Required when audienceType is FILTERED.'),
        excludedSegmentIds: excludedSegmentIds.describe(
          'Segment IDs whose contacts never get this campaign, whatever the audience. Find them with plunk_list_segments.',
        ),
        optOutSegmentId: z
          .string()
          .uuid()
          .optional()
          .describe('Opt-out topic: a static segment id. TRANSACTIONAL campaigns only (Plunk Lite).'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async (input) =>
      runTool(async () => {
        const audienceError = audienceInputError(input);
        if (audienceError) {
          return audienceError;
        }

        const campaign = unwrap(
          await client.request<Campaign | {success: boolean; data: Campaign}>({
            method: 'POST',
            path: '/campaigns',
            body: input,
          }),
        );
        if (input.optOutSegmentId && !Object.hasOwn(campaign, 'optOutSegmentId')) {
          return errorResult(
            `The campaign was created as a draft (${campaign.id}), but WITHOUT its opt-out topic: this installation ` +
              'does not support opt-out topics in campaigns yet. It has not been sent.',
          );
        }

        return jsonResult(
          `Campaign created as a draft (id: ${campaign.id}). It has NOT been sent — send yourself a ` +
            'copy with plunk_test_campaign first, then use plunk_send_campaign to send it.',
          campaign,
        );
      }),
  );

  register(
    ctx,
    'plunk_send_campaign',
    {
      title: 'Send or schedule campaign',
      description: [
        '**Purpose:** Send an existing campaign to its entire audience, now or at a scheduled time.',
        '',
        '**NOT for:** Testing what a campaign looks like — that reaches every recipient. Use',
        '`plunk_test_campaign` to send a single copy to a project member first.',
        '',
        '**Before calling this,** it is worth confirming the audience is what the user expects:',
        '`plunk_get_campaign` reports `totalRecipients`, and cancelling afterwards only stops whatever',
        'has not gone out yet.',
        '',
        '**Returns:** The campaign with its updated status and recipient count.',
        '',
        "Addresses on the project's suppression list (permanent bounces and spam complaints) are",
        'unsubscribed and never emailed, so they are left out even if the audience matches them.',
        'A campaign with an opt-out topic (`optOutSegmentId`) is not sent to the members of that segment, and',
        'its emails carry the one-click opt-out.',
        '',
        '**This is irreversible.** Once sending starts the email cannot be recalled. This tool always',
        'asks the user to confirm before it proceeds, and will report the recipient count in that prompt.',
        '',
        '**Key trigger phrases:** "send the campaign", "send it now", "schedule the newsletter"',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().describe('The campaign ID to send.'),
        scheduledFor: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp to schedule the send. Omit to send immediately.'),
        includeUnsubscribed: z
          .boolean()
          .optional()
          .describe(
            'Only for a TRANSACTIONAL campaign, which reaches unsubscribed contacts too: set true to send it ' +
              'when the number of them cannot be checked, and only once the user has said to.',
          ),
      }),
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true},
    },
    async ({id, scheduledFor, includeUnsubscribed}, context) =>
      runTool(async () => {
        // Read the campaign first so the confirmation names the real audience
        // size — "send to 43,812 people" is a very different decision from
        // "send campaign abc123", and the user should see which one this is.
        const campaign = await getCampaign(client, id);

        const recipients = campaign.totalRecipients ?? campaign.recipientCount;

        const audience =
          typeof recipients === 'number'
            ? `${recipients.toLocaleString()} recipients`
            : `its ${campaign.audienceType ?? 'configured'} audience`;

        const when = scheduledFor ? `scheduled for ${scheduledFor}` : 'sent immediately';

        // Plunk Lite: a TRANSACTIONAL campaign also reaches whoever asked to receive nothing, so the
        // confirmation says how many; without the number, the user has to say so explicitly
        const unsubscribed = await unsubscribedRecipients(client, campaign);
        if (unsubscribed === undefined && !includeUnsubscribed) {
          return errorResult(
            'This is a TRANSACTIONAL campaign, which reaches unsubscribed contacts too, and how many of them it ' +
              'includes could not be checked. Ask the user first; only if they say to send it anyway, call again ' +
              'with includeUnsubscribed: true.',
          );
        }
        const unsubscribedNote = unsubscribed
          ? ` It includes ${unsubscribed.toLocaleString()} unsubscribed contacts, since a TRANSACTIONAL campaign reaches them too.`
          : '';

        const pending = requireConfirmation(
          context as {mcpReq?: {inputResponses?: unknown}},
          'confirm_campaign_send',
          `Send campaign "${campaign.name ?? id}" (subject: "${campaign.subject ?? '—'}") to ${audience}? ` +
            `It will be ${when}.${unsubscribedNote} This cannot be undone.`,
        );

        if (pending) {
          return pending;
        }

        const result = await client.request({
          method: 'POST',
          path: `/campaigns/${encodeURIComponent(id)}/send`,
          body: scheduledFor ? {scheduledFor} : {},
        });

        return jsonResult(scheduledFor ? `Campaign scheduled for ${scheduledFor}.` : 'Campaign sending.', result);
      }),
  );

  register(
    ctx,
    'plunk_get_campaign',
    {
      title: 'Get campaign',
      description: [
        '**Purpose:** Fetch one campaign in full — its subject, body, sender, audience configuration',
        'and current status.',
        '',
        '**NOT for:** Delivery numbers on a campaign that has already gone out — use',
        '`plunk_get_campaign_stats` for opens, clicks and bounces.',
        '',
        '**Returns:** The campaign record, including `status` (DRAFT, SCHEDULED, SENDING, SENT,',
        'CANCELLED) and `totalRecipients`. With an opt-out topic (`optOutSegmentId`, Plunk Lite), the',
        "campaign is not sent to that segment's members and its emails carry the one-click opt-out.",
        '',
        '**When to use:**',
        '- Before sending, to check what the campaign actually says and who it targets',
        '- To read the current status after scheduling or cancelling',
        '',
        '**Key trigger phrases:** "show me the campaign", "what does it say", "is it scheduled"',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().describe('The campaign ID, as returned by plunk_list_campaigns.'),
      }),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id}) =>
      runTool(async () => {
        const campaign = await getCampaign(client, id);
        return jsonResult('Campaign:', campaign);
      }),
  );

  register(
    ctx,
    'plunk_update_campaign',
    {
      title: 'Update campaign',
      description: [
        '**Purpose:** Change a draft campaign: its name, description, subject, body, sender, reply-to,',
        'type, audience, excluded segments or (Plunk Lite) opt-out topic. Only the fields given change.',
        '',
        '**NOT for:** Sending anything (that is `plunk_send_campaign`), or editing a template (use',
        '`plunk_update_template`).',
        '',
        '**Only drafts.** A scheduled campaign has to be cancelled back to a draft first with',
        '`plunk_cancel_campaign`; one that is sending or sent cannot be changed.',
        '',
        '**Audience:** `audienceType: SEGMENT` needs `segmentId`, and `FILTERED` needs `audienceCondition`, in',
        'the same call; `segmentId` alone only works on a campaign already sent to a segment. Moving to another',
        'audience type lets go of the old segment.',
        '',
        ...OPT_OUT_TOPIC,
        'Moving a campaign with an opt-out topic to a type other than TRANSACTIONAL needs',
        '`optOutSegmentId: null` in the same call; `null` removes it, and then the contacts who opted out',
        'get the campaign again.',
        '',
        '**Requirements:** `from` must be on a domain verified for this project.',
        '',
        '**Returns:** The updated campaign. Its `totalRecipients` is recalculated when the audience, the',
        'type, the excluded segments or the topic change.',
        '',
        '**Key trigger phrases:** "edit the campaign", "change the subject of the campaign", "add an opt-out to"',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().min(1).describe('The campaign ID, as returned by plunk_list_campaigns.'),
        name: z.string().min(1).optional().describe('New internal name.'),
        description: z.string().optional().describe('New internal note.'),
        subject: z.string().min(1).optional().describe('New subject line.'),
        body: z.string().min(1).optional().describe('New HTML body.'),
        from: z.string().email().optional().describe('New sender address, on a verified domain.'),
        fromName: z.string().max(100).nullable().optional().describe('New sender display name; null removes it.'),
        replyTo: z.string().email().nullable().optional().describe('New reply-to address; null removes it.'),
        type: z.enum(EMAIL_TYPES).optional().describe('New content type.'),
        audienceType: z.enum(['ALL', 'SEGMENT', 'FILTERED']).optional().describe('Who receives this campaign.'),
        segmentId: z.string().optional().describe('Segment ID. Required when audienceType is SEGMENT.'),
        audienceCondition: z
          .optional(filterCondition)
          .describe('Inline filter tree. Required when audienceType is FILTERED.'),
        excludedSegmentIds: excludedSegmentIds.describe(
          'The full new list of segment IDs whose contacts never get this campaign.',
        ),
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
        const body: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(([, value]) => value !== undefined),
        );
        if (Object.keys(body).length === 0) {
          return errorResult(
            'Nothing to update: pass name, description, subject, body, from, fromName, replyTo, type, audienceType, ' +
              'segmentId, audienceCondition, excludedSegmentIds or optOutSegmentId.',
          );
        }

        const audienceError = audienceInputError(fields);
        if (audienceError) {
          return audienceError;
        }
        // Otherwise the old segment stays attached, and cannot be deleted while the draft lives
        if (fields.audienceType !== undefined && fields.audienceType !== 'SEGMENT') {
          body.segmentId = null;
        }

        // Read first: the API also edits scheduled campaigns, and this tool only drafts, like the
        // dashboard. An installation without opt-out topics ignores the field and answers 200, having
        // written the rest: checked here too, before writing anything
        const current = await getCampaign(client, id);
        if (current.status !== 'DRAFT') {
          return errorResult(
            `Only drafts can be edited, and this campaign is ${current.status ?? 'not a draft'}: cancel it back to ` +
              'a draft with plunk_cancel_campaign first (one already sending or sent cannot be changed).',
          );
        }
        if (fields.optOutSegmentId !== undefined && !Object.hasOwn(current, 'optOutSegmentId')) {
          return errorResult('Nothing was changed: this installation does not support opt-out topics yet.');
        }
        // A segment on another audience would stay attached unused, and could not be deleted
        const audienceType = fields.audienceType ?? current.audienceType;
        if (fields.segmentId !== undefined && audienceType !== 'SEGMENT') {
          return errorResult(
            `Nothing was changed: segmentId only applies to a SEGMENT audience, and this one would be ` +
              `${audienceType ?? 'another type'}. Pass audienceType: 'SEGMENT' with it to send the campaign to that segment.`,
          );
        }

        const campaign = unwrap(
          await client.request<Campaign | {success: boolean; data: Campaign}>({
            method: 'PUT',
            path: `/campaigns/${encodeURIComponent(id)}`,
            body,
          }),
        );
        return jsonResult('Campaign updated. It is still a draft: nothing was sent.', campaign);
      }),
  );

  register(
    ctx,
    'plunk_test_campaign',
    {
      title: 'Send campaign test',
      description: [
        '**Purpose:** Send one copy of a campaign to a project member so a human can check it before',
        'it reaches the real audience. This is the safe pre-flight step before `plunk_send_campaign`.',
        '',
        '**NOT for:** Reaching the campaign audience (that is `plunk_send_campaign`), and not a way to',
        'email an arbitrary address — see the restriction below.',
        '',
        '**Returns:** Confirmation that the test was sent.',
        '',
        '**The recipient must be a member of the Plunk project.** Any other address is rejected with a',
        '403. Ask the user which of their project addresses to send to rather than guessing.',
        '',
        '**This sends a real email** and counts toward the project send quota, so send one test and',
        'wait for the user to review it rather than firing several.',
        '',
        '**Key trigger phrases:** "send me a test", "preview it first", "check it before sending"',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().describe('The campaign ID to test.'),
        email: z
          .string()
          .describe('Address to send the test to. Must belong to a member of this Plunk project.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async ({id, email}) =>
      runTool(async () => {
        await client.request({
          method: 'POST',
          path: `/campaigns/${encodeURIComponent(id)}/test`,
          body: {email},
        });

        return jsonResult(
          `Test email sent to ${email}. Ask the user to review it before calling plunk_send_campaign.`,
          {id, testSentTo: email},
        );
      }),
  );

  register(
    ctx,
    'plunk_cancel_campaign',
    {
      title: 'Cancel campaign',
      description: [
        '**Purpose:** Stop a campaign that is scheduled or currently sending.',
        '',
        '**NOT for:** Deleting a campaign, or for a campaign that has already finished — only',
        'SCHEDULED and SENDING campaigns can be cancelled, anything else returns a 400.',
        '',
        '**Returns:** The campaign with `status: CANCELLED`.',
        '',
        '**Cancelling is one-way.** A cancelled campaign cannot be un-cancelled or resumed; it has to',
        'be duplicated and sent again. For a campaign already SENDING, email that has gone out stays',
        'out — cancelling only stops the remainder.',
        '',
        '**Key trigger phrases:** "cancel the campaign", "stop the send", "call it off", "unschedule it"',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().describe('The campaign ID to cancel.'),
      }),
      // Deliberately not behind requireConfirmation: this is the emergency stop
      // for a send in flight, and every second spent on an elicitation round
      // trip is more email delivered. It is marked destructive so clients can
      // still prompt if they want to.
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true},
    },
    async ({id}) =>
      runTool(async () => {
        const result = unwrap(
          await client.request<Campaign | {success: boolean; data: Campaign}>({
            method: 'POST',
            path: `/campaigns/${encodeURIComponent(id)}/cancel`,
          }),
        );

        return jsonResult('Campaign cancelled. It cannot be resumed.', result);
      }),
  );

  register(
    ctx,
    'plunk_get_campaign_stats',
    {
      title: 'Get campaign stats',
      description: [
        '**Purpose:** Read delivery and engagement numbers for a campaign that has been sent.',
        '',
        '**NOT for:** Project-wide reporting across campaigns — this covers one campaign only.',
        '',
        '**Returns:** `totalRecipients`, `sentCount`, `deliveredCount`, `openedCount`, `clickedCount`,',
        '`bouncedCount`, `complainedCount`, `unsubscribedCount`, `lostCount`, plus `openRate`, `clickRate`,',
        '`bounceRate`, `deliveryRate`, `complaintRate` and `unsubscribeRate` as percentages.',
        '',
        '**Interpreting it:** rates are percentages of `sentCount`, not of `totalRecipients`, so a',
        'campaign still sending will show rates against the portion sent so far. A campaign that has',
        'not been sent returns zeroes rather than an error. `unsubscribedCount` counts the opt-outs',
        'traced to this campaign, including the unsubscribe a bounce or complaint causes when the',
        'contact was subscribed or snoozed, which `bouncedCount` or `complainedCount` count as well.',
        '`lostCount` is the recipients lost to any of the three, each counted once: use it, not the',
        'sum, for how many the campaign lost.',
        '',
        '**Key trigger phrases:** "how did it do", "open rate", "did it bounce", "campaign performance"',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().describe('The campaign ID to report on.'),
      }),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id}) =>
      runTool(async () => {
        const stats = unwrap(
          await client.request<unknown>({path: `/campaigns/${encodeURIComponent(id)}/stats`}),
        );

        return jsonResult('Campaign stats:', stats);
      }),
  );
}

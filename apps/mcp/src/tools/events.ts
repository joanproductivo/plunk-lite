import * as z from 'zod';

import type {PlunkClient} from '../client.js';

import {jsonResult, register, runTool, type ToolContext} from './shared.js';

export function registerEventTools(ctx: ToolContext, client: PlunkClient): void {
  register(
    ctx,
    'plunk_track_event',
    {
      title: 'Track event',
      description: [
        '**Purpose:** Record that a contact did something ("user.signup", "order.placed"). Events are',
        'what trigger automation workflows, so this is how you start an automated sequence for someone.',
        'The contact is created if they do not exist yet, unsubscribed unless you pass `subscribed: true`.',
        '',
        '**NOT for:** Sending an email directly (use `plunk_send_email`). Tracking an event only',
        'records it — any email that follows comes from a workflow triggered by the event.',
        '',
        '**Returns:** The recorded event and the contact it was attached to.',
        '',
        'A new contact whose domain does not exist, takes no email, is disposable or is a slip of a large',
        "provider's (gmial.com) is refused with INVALID_EMAIL and the likely correction, and the event is not recorded.",
        '',
        "If the address is on the project's suppression list (it bounced permanently, kept bouncing or reported spam),",
        'the event is still recorded but the contact stays unsubscribed, and no email reaches it — not',
        'even from the workflows the event starts. Only the Plunk dashboard can lift a suppression.',
        '',
        "With the project's double opt-in on (Plunk Lite), a sign-up (`subscribed: true`) does not subscribe the",
        'contact: it gets a confirmation email and stays "Pending confirmation" until it clicks the link;',
        '`pendingConfirmation` in the result says so. Workflows on `contact.subscribed` start then. If this server',
        'is set up with a public key, no confirmation email goes out and the contact stays unsubscribed',
        '(`optIn: "held"`).',
        '',
        '**When to use:**',
        '- The user wants to trigger a workflow for a specific person',
        '- Recording a lifecycle action against a contact',
        '',
        '**Key trigger phrases:** "track an event", "trigger the workflow", "mark them as signed up"',
      ].join('\n'),
      inputSchema: z.object({
        event: z.string().describe('Event name, e.g. "user.signup". Reused names group together.'),
        email: z.string().describe('Email address of the contact the event belongs to.'),
        subscribed: z
          .boolean()
          .optional()
          .describe(
            '`true` subscribes the contact and `false` unsubscribes it. Leave it out to keep the current ' +
              'state; a new contact is then created unsubscribed.',
          ),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Custom fields to store on the contact, e.g. {"plan":"pro"}.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async ({event, email, subscribed, data}) =>
      runTool(async () => {
        // Plunk Lite: `/v1/track` takes an email, upserts the contact and records the event in one
        // call, with either key: the public one when this server has it, otherwise the secret one.
        const result = await client.request({
          method: 'POST',
          path: '/v1/track',
          body: {event, email, subscribed, data},
          usePublicKey: client.hasPublicKey,
        });

        return jsonResult(`Tracked "${event}" for ${email}.`, result);
      }),
  );
}

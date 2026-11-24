import type {TemplateType} from '@plunk/db';

import {DASHBOARD_URI} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';

/**
 * Plunk Lite: opt-out topics, the sending side. A TRANSACTIONAL template can name a static segment
 * (its "opt-out topic"): its emails carry a one-click `List-Unsubscribe` that puts the contact in
 * that segment, and are not sent to its members. Other transactional emails still reach them.
 *
 * Kept free of service imports: EmailService, the email processor, /v1/send and workflows use it, and
 * SegmentService would close an import cycle through ContactService and OptInService. Managing
 * topics lives in TemplateOptOutAdmin.
 */

/** The fields of a template that decide its opt-out topic */
export interface OptOutTemplate {
  id: string;
  type: TemplateType;
  optOutSegmentId: string | null;
}

/** The error of an email skipped because its contact opted out of its template's topic */
export const OPTED_OUT_EMAIL_ERROR = 'Contact opted out of this kind of email';

/** The error of an email not sent because its template's topic is gone, naming the template to fix */
export function missingTopicError(templateName: string): string {
  return `The opt-out segment of template "${templateName}" no longer exists, so it was not sent. Pick another segment in the template, or remove it`;
}

/**
 * The segment an email of `template` must skip and offers to join: its topic, when the template is
 * TRANSACTIONAL and the email goes to its contact. A workflow's custom recipient is someone else, so
 * the topic does not apply to them.
 */
export function optOutTopic(
  template: Pick<OptOutTemplate, 'type' | 'optOutSegmentId'> | null | undefined,
  hasRecipientOverride: boolean,
): string | null {
  if (!template || hasRecipientOverride || template.type !== 'TRANSACTIONAL') return null;
  return template.optOutSegmentId || null;
}

/** The opt-out link of a contact for a template, on `base` (the API for headers, the dashboard for bodies) */
export function optOutLink(base: string, contactId: string, templateId: string): string {
  return `${base}/opt-out/${encodeURIComponent(contactId)}?t=${encodeURIComponent(templateId)}`;
}

/** The `optOutUrl` variable: the dashboard's opt-out page, or empty when the email has no topic */
export function optOutUrl(
  contactId: string,
  template: OptOutTemplate | null | undefined,
  hasRecipientOverride: boolean,
): string {
  return template && optOutTopic(template, hasRecipientOverride)
    ? optOutLink(DASHBOARD_URI, contactId, template.id)
    : '';
}

/**
 * Whether the topic `segmentId` is gone: no static segment of the project has that id. The template
 * keeps it without a foreign key, and the API refuses to delete a segment a template uses, so it
 * goes only by SQL, from an earlier image, or deleted while it was being chosen. Its emails then
 * reach no one, with an alert, rather than reaching those who opted out.
 */
export async function isTopicMissing(projectId: string, segmentId: string): Promise<boolean> {
  const segment = await prisma.segment.findFirst({where: {id: segmentId, projectId}, select: {type: true}});
  return segment?.type !== 'STATIC';
}

/**
 * What keeps an email with the topic `segmentId` from its contact: `opted-out` for a current member
 * of the segment, `missing-topic` while the segment is gone (`isTopicMissing`), and null when it can
 * be sent. A database error is thrown, so the email fails rather than reaching someone who opted out.
 */
export async function optOutBlock(
  projectId: string,
  segmentId: string,
  contactId: string,
): Promise<'opted-out' | 'missing-topic' | null> {
  if (await isTopicMissing(projectId, segmentId)) {
    return 'missing-topic';
  }
  const membership = await prisma.segmentMembership.findUnique({
    where: {contactId_segmentId: {contactId, segmentId}},
    select: {exitedAt: true},
  });
  return membership && membership.exitedAt === null ? 'opted-out' : null;
}

/** The 422 of /v1/send for a contact who opted out of the template's topic */
export function optedOutError(contactEmail: string): HttpException {
  return new HttpException(
    422,
    `${contactEmail} opted out of this kind of email (its template's opt-out segment), so it was not sent. Other transactional emails still reach it.`,
    ErrorCode.CONTACT_OPTED_OUT,
  );
}

/**
 * The 422 of /v1/send for a template whose opt-out segment is gone: nothing goes until it is fixed.
 * Not a 409, which on /v1/send means an Idempotency-Key already used.
 */
export function missingTopicHttpError(templateName: string): HttpException {
  return new HttpException(422, `${missingTopicError(templateName)}.`, ErrorCode.OPT_OUT_SEGMENT_MISSING);
}

/** The template id an opt-out link carries in `t`: a non-empty string, or undefined (absent, or repeated) */
export function readTemplateParam(query: Record<string, unknown>): string | undefined {
  const value = query.t;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

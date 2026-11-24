import {Prisma, type TemplateType} from '@plunk/db';
import {TemplateSchemas} from '@plunk/shared';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';

import {SegmentMembershipService} from './SegmentMembershipService.js';
import {optOutTopic} from './TemplateOptOut.js';

/**
 * Plunk Lite: opt-out topics, the managing side (see TemplateOptOut). Apart from it because
 * SegmentMembershipService reaches EmailService through EventService and workflows: only the
 * Templates and OptOut controllers import this file.
 */

function invalidTopic(message: string): HttpException {
  return new HttpException(400, message, ErrorCode.VALIDATION_ERROR, {field: 'optOutSegmentId'});
}

/**
 * Check a template write's opt-out topic before saving. `value` is the `optOutSegmentId` sent
 * (undefined: not sent; null: none), `type` the type sent, and `templateId` the template being
 * updated (none when creating). With a topic, the template must end up TRANSACTIONAL (the type
 * sent, else the saved one), so moving a template with a topic to another type needs
 * `optOutSegmentId: null` in the same request. A new topic must be a static segment of the project;
 * one already saved is not checked again, so a segment deleted behind Plunk's back does not block
 * other edits.
 */
export async function assertValidTopic(
  projectId: string,
  value: unknown,
  type: TemplateType | undefined,
  templateId?: string,
): Promise<void> {
  if (value !== undefined && !TemplateSchemas.update.shape.optOutSegmentId.safeParse(value).success) {
    throw invalidTopic('The opt-out topic (optOutSegmentId) must be a segment id or null');
  }
  const sent = value as string | null | undefined;

  if (templateId && sent === undefined && type === undefined) return;

  const saved = templateId
    ? await prisma.template.findFirst({where: {id: templateId, projectId}, select: {type: true, optOutSegmentId: true}})
    : null;
  // A missing template is the update's own 404
  if (templateId && !saved) return;

  const topic = sent !== undefined ? sent : (saved?.optOutSegmentId ?? null);
  const finalType = type ?? saved?.type ?? 'MARKETING';

  if (topic && finalType !== 'TRANSACTIONAL') {
    throw invalidTopic(
      sent === undefined
        ? 'This template has an opt-out topic, which only TRANSACTIONAL templates can have: send optOutSegmentId: null with the new type to remove it'
        : 'Only TRANSACTIONAL templates can have an opt-out topic',
    );
  }

  if (sent && sent !== saved?.optOutSegmentId) {
    try {
      await SegmentMembershipService.getStaticSegment(projectId, sent, 'add contacts to');
    } catch (error) {
      if (error instanceof HttpException && error.code < 500) {
        throw invalidTopic('The opt-out topic must be a STATIC segment of this project');
      }
      throw error;
    }
  }
}

/**
 * Put a contact in the topic of the template an opt-out link names. 'opted-out' when the template
 * is of the contact's project, TRANSACTIONAL and has a topic; else 'unavailable'. A contact already
 * in it does not enter again (providers retry, people click twice), so its workflows do not restart.
 * A contact or segment deleted meanwhile is 'unavailable', and the link answers 200 either way. Any
 * other failure (the database down) is thrown, so the link answers 500 and the provider or the page
 * tries again, rather than taking an opt-out that was never written as done.
 */
export async function optOut(contactId: string, templateId: string): Promise<'opted-out' | 'unavailable'> {
  try {
    const contact = await prisma.contact.findUnique({where: {id: contactId}, select: {projectId: true}});
    if (!contact) return 'unavailable';

    const template = await prisma.template.findFirst({
      where: {id: templateId, projectId: contact.projectId},
      select: {id: true, type: true, optOutSegmentId: true},
    });
    const topic = optOutTopic(template, false);
    if (!topic) return 'unavailable';

    await SegmentMembershipService.addMembers(contact.projectId, topic, [contactId], {
      mode: 'background',
      reenter: false,
    });
    return 'opted-out';
  } catch (error) {
    const gone =
      (error instanceof HttpException && error.code < 500) ||
      (error instanceof Prisma.PrismaClientKnownRequestError && ['P2003', 'P2025'].includes(error.code));
    if (!gone) throw error;
    signale.warn(`[OPT-OUT] Could not opt contact ${contactId} out with template ${templateId}:`, error);
    return 'unavailable';
  }
}

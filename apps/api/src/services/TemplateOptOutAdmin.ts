import {Prisma, type TemplateType} from '@plunk/db';
import {TemplateSchemas} from '@plunk/shared';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';

import {SegmentMembershipService} from './SegmentMembershipService.js';
import {type OptOutSource, optOutTopic} from './TemplateOptOut.js';

/**
 * Plunk Lite: opt-out topics, the managing side (see TemplateOptOut). Apart from it because
 * SegmentMembershipService reaches EmailService through EventService and workflows: only the
 * Templates, Campaigns and OptOut controllers import this file.
 */

function invalidTopic(message: string): HttpException {
  return new HttpException(400, message, ErrorCode.VALIDATION_ERROR, {field: 'optOutSegmentId'});
}

/** The type and topic of the template or campaign `source` names, in `projectId`; null when it is not there */
function readTopicOwner(projectId: string, source: OptOutSource) {
  const select = {type: true, optOutSegmentId: true} as const;
  return 'campaignId' in source
    ? prisma.campaign.findFirst({where: {id: source.campaignId, projectId}, select})
    : prisma.template.findFirst({where: {id: source.templateId, projectId}, select});
}

/**
 * Check a template's or campaign's write of its opt-out topic before saving. `value` is the
 * `optOutSegmentId` sent (undefined: not sent; null: none), `type` the type sent, and `owner` the
 * template or campaign being updated (none when creating). With a topic, it must end up
 * TRANSACTIONAL (the type sent, else the saved one), so moving one with a topic to another type needs
 * `optOutSegmentId: null` in the same request. A new topic must be a static segment of the project;
 * one already saved is not checked again, so a segment deleted behind Plunk's back does not block
 * other edits.
 */
export async function assertValidTopic(
  projectId: string,
  value: unknown,
  type: TemplateType | undefined,
  owner?: OptOutSource,
): Promise<void> {
  if (value !== undefined && !TemplateSchemas.update.shape.optOutSegmentId.safeParse(value).success) {
    throw invalidTopic('The opt-out topic (optOutSegmentId) must be a segment id or null');
  }
  const sent = value as string | null | undefined;

  if (owner && sent === undefined && type === undefined) return;

  const saved = owner ? await readTopicOwner(projectId, owner) : null;
  // A missing template or campaign is the update's own 404
  if (owner && !saved) return;

  const topic = sent !== undefined ? sent : (saved?.optOutSegmentId ?? null);
  const finalType = type ?? saved?.type ?? 'MARKETING';

  if (topic && finalType !== 'TRANSACTIONAL') {
    throw invalidTopic(
      sent === undefined
        ? 'This template or campaign has an opt-out topic, which only TRANSACTIONAL ones can have: send optOutSegmentId: null with the new type to remove it'
        : 'Only TRANSACTIONAL templates and campaigns can have an opt-out topic',
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
 * Put a contact in the topic of the template or campaign an opt-out link names (`source`). 'opted-out'
 * when it is of the contact's project, TRANSACTIONAL and has a topic; else 'unavailable'. A campaign
 * with any email sent can no longer be edited, so its topic is the one its emails were sent with. A contact already
 * in it does not enter again (providers retry, people click twice), so its workflows do not restart.
 * A contact or segment deleted meanwhile is 'unavailable', and the link answers 200 either way. Any
 * other failure (the database down) is thrown, so the link answers 500 and the provider or the page
 * tries again, rather than taking an opt-out that was never written as done.
 */
export async function optOut(contactId: string, source: OptOutSource): Promise<'opted-out' | 'unavailable'> {
  try {
    const contact = await prisma.contact.findUnique({where: {id: contactId}, select: {projectId: true}});
    if (!contact) return 'unavailable';

    const topic = optOutTopic(await readTopicOwner(contact.projectId, source), false);
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
    signale.warn(`[OPT-OUT] Could not opt contact ${contactId} out with ${JSON.stringify(source)}:`, error);
    return 'unavailable';
  }
}

/**
 * Campaign service types
 */

import type {Campaign, CampaignAudienceType, Segment, TemplateType} from '@plunk/db';
import type {PaginatedResponse} from '../common/pagination.js';
import type {FilterCondition} from '../segments/index.js';

/** A campaign as the list endpoint returns it: with its segment, so the list can name the audience. */
export type CampaignListItem = Campaign & {segment: Segment | null};

/**
 * Data for creating a new campaign
 */
export interface CreateCampaignData {
  name: string;
  description?: string;
  subject: string;
  body: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  type?: TemplateType;
  audienceType: CampaignAudienceType;
  audienceCondition?: FilterCondition;
  segmentId?: string;
}

/**
 * Data for updating an existing campaign
 */
export interface UpdateCampaignData {
  name?: string;
  description?: string;
  subject?: string;
  body?: string;
  from?: string;
  fromName?: string | null;
  replyTo?: string | null;
  type?: TemplateType;
  audienceType?: CampaignAudienceType;
  audienceCondition?: FilterCondition;
  segmentId?: string;
}

/**
 * Response shape of GET /campaigns.
 *
 * The list is scoped to unarchived campaigns unless `?archived=true` is passed, so the
 * page needs a second number to decide whether to offer the Archived toggle at all (and
 * what count to put on it). It rides along here rather than widening the shared
 * `PaginatedResponse`, which every other list endpoint returns unchanged.
 */
export type CampaignListResponse = PaginatedResponse<CampaignListItem> & {
  /** Archived campaigns in the project, independent of the current page, search or status filter. */
  archivedCount: number;
};

/**
 * The ways a campaign can lose a recipient that are stamped on the email row, and so
 * answerable as a list rather than only as a count: a bounce, a spam complaint, or an
 * opt-out (unsubscribe or snooze) made from the campaign email. Plunk Lite: and the emails
 * with no confirmed delivery, which are in none of the three.
 */
export type CampaignRecipientType = 'bounced' | 'complained' | 'unsubscribed' | 'not_delivered';

/**
 * Plunk Lite: why an email has no confirmed delivery. `not_sent` never left: it is not in `sentCount`.
 * `pending` and `no_answer` are the same silence from SES, before and after SES should have given up.
 */
export type CampaignDeliveryState = 'soft_bounce' | 'pending' | 'no_answer' | 'suppressed' | 'failed' | 'not_sent';

/**
 * One recipient in a campaign's bounce, complaint, unsubscribe or not delivered list.
 *
 * Deliberately narrow: this feeds a list whose job is to answer "who", so it carries the
 * address, when it happened, and the ids needed to open the contact. The email body and
 * headers are not part of that question and would make every page far heavier to ship.
 */
export interface CampaignRecipient {
  emailId: string;
  contactId: string;
  email: string;
  /** ISO 8601. The bounce, complaint or opt-out timestamp, whichever list this is; when the email was created in `not_delivered`. */
  occurredAt: string;
  /** Only in `not_delivered`. `detail` is the bounce's subtype, or the error of a failed email. */
  delivery?: {state: CampaignDeliveryState; detail: string | null};
}

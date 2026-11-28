import {CampaignStatus, EmailSourceType, EmailStatus, SegmentType, TemplateType} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {API_URI, DASHBOARD_URI} from '../../app/constants';
import {prisma as appPrisma} from '../../database/prisma';
import {CampaignService} from '../../services/CampaignService';
import {RECIPIENT_OVERRIDE_HEADER} from '../../services/EmailHeaderService';
import {FailureAlertService} from '../../services/FailureAlertService';
import {ProjectFooterService} from '../../services/ProjectFooterService';
import {sendRawEmail} from '../../services/SESService';
import {MISSING_CAMPAIGN_TOPIC, OPTED_OUT_EMAIL_ERROR} from '../../services/TemplateOptOut';
import {type EmailJob, processEmailJob} from '../email-processor';

vi.mock('../../services/SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService')>()),
  sendRawEmail: vi.fn(),
}));

vi.mock('../../services/SesSendGate.js', () => ({
  holdSending: vi.fn(async () => undefined),
  pauseSending: vi.fn(async () => undefined),
  refusalMeansPause: vi.fn(async () => false),
  noteQuotaHeld: vi.fn(async () => undefined),
  noteSent: vi.fn(async () => undefined),
  SES_RATE_WAIT_MS: 1000,
  SES_DAILY_QUOTA_WAIT_MS: 15 * 60_000,
}));

vi.mock('../../services/MeterService.js', () => ({
  MeterService: {recordEmailSent: vi.fn().mockResolvedValue(undefined)},
}));

function makeJob(emailId: string) {
  return {
    data: {emailId} as SendEmailJobData,
    attemptsMade: 0,
    opts: {attempts: 8},
    updateData: vi.fn(async () => undefined),
  } as unknown as EmailJob;
}

/**
 * Plunk Lite: the send of a transactional template with an opt-out topic. It skips a contact who
 * opted out after it was queued, fails with an alert while the topic's segment is gone, and otherwise
 * carries the one-click header to its opt-out link, the bulk headers and the notices footer.
 */
describe('processEmailJob with an opt-out topic', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let segmentId: string;
  let templateId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject({}, {name: 'Acme'});
    projectId = project.id;
    segmentId = (await factories.createSegment(projectId, {type: SegmentType.STATIC})).id;
    templateId = (
      await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL, optOutSegmentId: segmentId})
    ).id;
    ProjectFooterService.clearCache();
    vi.mocked(sendRawEmail).mockReset();
    vi.mocked(sendRawEmail).mockResolvedValue({messageId: 'ses-1'});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function pendingEmail(
    options: {body?: string; headers?: Record<string, string>; template?: string; sourceType?: EmailSourceType} = {},
  ) {
    const contact = await factories.createContact({projectId, subscribed: false});
    const email = await prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        subject: 'Day 5',
        body: options.body ?? '<p>Your class is today</p>',
        from: 'hello@plunk.test',
        sourceType: options.sourceType ?? EmailSourceType.TRANSACTIONAL,
        templateId: options.template ?? templateId,
        headers: options.headers,
        status: EmailStatus.PENDING,
      },
    });
    return {contact, email};
  }

  it('skips a contact who opted out since it was queued, without sending', async () => {
    const {contact, email} = await pendingEmail();
    await prisma.segmentMembership.create({data: {segmentId, contactId: contact.id}});

    await processEmailJob(makeJob(email.id));

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.status).toBe(EmailStatus.FAILED);
    expect(row?.error).toBe('Contact opted out of this kind of email');
    expect(sendRawEmail).not.toHaveBeenCalled();
  });

  it('fails with an alert, sending nothing, while the segment of the topic is gone', async () => {
    const {email} = await pendingEmail();
    await prisma.template.update({where: {id: templateId}, data: {name: 'Workshop day'}});
    await prisma.segment.delete({where: {id: segmentId}});
    const record = vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);

    await processEmailJob(makeJob(email.id));

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.status).toBe(EmailStatus.FAILED);
    expect(row?.error).toContain('The opt-out segment of template "Workshop day" no longer exists');
    expect(sendRawEmail).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(projectId, {
      sourceKey: `template:${templateId}`,
      label: 'Workshop day',
      error: row?.error,
    });
  });

  it('sends the one-click header to the opt-out link, the bulk headers and the notices footer', async () => {
    const {contact, email} = await pendingEmail({body: '<p>Day 5 <a href="{{unsubscribeUrl}}">x</a></p>'});

    await processEmailJob(makeJob(email.id));

    const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
    expect(params.headers).toMatchObject({
      'List-Unsubscribe': `<${API_URI}/opt-out/${contact.id}?t=${templateId}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Precedence': 'bulk',
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
    });
    expect(params.headers!['List-Unsubscribe']).not.toContain('e=');
    expect(params.content.html).toContain(`href="${DASHBOARD_URI}/opt-out/${contact.id}?t=${templateId}"`);
    expect(params.content.html).toContain("I don't want any more notices like this");
  });

  it("uses the project's own notices footer in the contact's language", async () => {
    await ProjectFooterService.save(
      projectId,
      {es: {text: 'Avisos de {projectName}.', linkText: 'Ya no quiero'}},
      'optOut',
    );
    const {contact, email} = await pendingEmail();
    await prisma.contact.update({where: {id: contact.id}, data: {data: {locale: 'es'}}});

    await processEmailJob(makeJob(email.id));

    const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
    expect(params.content.html).toContain('Avisos de Acme.');
    expect(params.content.html).toContain('Ya no quiero');
  });

  it('leaves the footer out when the body already links the opt-out page', async () => {
    const {contact, email} = await pendingEmail();
    await prisma.email.update({
      where: {id: email.id},
      data: {body: `<p><a href="${DASHBOARD_URI}/opt-out/${contact.id}?t=${templateId}">Stop</a></p>`},
    });

    await processEmailJob(makeJob(email.id));

    const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
    expect(params.content.html).not.toContain("I don't want any more notices like this");
  });

  it('ignores the topic for a custom recipient: no skip, no header, no footer', async () => {
    const {contact, email} = await pendingEmail({headers: {[RECIPIENT_OVERRIDE_HEADER]: 'team@example.com'}});
    await prisma.segmentMembership.create({data: {segmentId, contactId: contact.id}});

    await processEmailJob(makeJob(email.id));

    const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
    expect(params.headers).not.toHaveProperty('List-Unsubscribe');
    expect(params.headers).not.toHaveProperty('Precedence');
    expect(params.content.html).not.toContain('/opt-out/');
  });

  it('changes nothing for a transactional template without a topic', async () => {
    const plain = await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL});
    const {email} = await pendingEmail({template: plain.id});

    await processEmailJob(makeJob(email.id));

    const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
    expect(params.headers).not.toHaveProperty('List-Unsubscribe');
    expect(params.headers).not.toHaveProperty('Precedence');
    expect(params.content.html).not.toContain('/opt-out/');
  });

  it('fails the attempt, sending nothing, when the membership cannot be read', async () => {
    const {email} = await pendingEmail();
    vi.spyOn(appPrisma.segmentMembership, 'findUnique').mockRejectedValueOnce(new Error('database down'));

    await expect(processEmailJob(makeJob(email.id))).rejects.toThrow('database down');

    expect(sendRawEmail).not.toHaveBeenCalled();
    expect((await prisma.email.findUnique({where: {id: email.id}}))?.status).toBe(EmailStatus.PENDING);
  });

  it('leaves an email queued as marketing as it was, though its template has a topic now', async () => {
    const {contact, email} = await pendingEmail({sourceType: EmailSourceType.WORKFLOW});
    await prisma.contact.update({where: {id: contact.id}, data: {subscribed: true}});
    await prisma.segmentMembership.create({data: {segmentId, contactId: contact.id}});

    await processEmailJob(makeJob(email.id));

    const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
    expect(params.headers!['List-Unsubscribe']).toContain('/unsubscribe/');
    expect(params.content.html).not.toContain("I don't want any more notices like this");
  });
});

/** Plunk Lite: the same for an email of a TRANSACTIONAL campaign with an opt-out topic (`?c=`) */
describe('processEmailJob with a campaign opt-out topic', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let segmentId: string;
  let campaignId: string;
  let generation: number;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject({}, {name: 'Acme'});
    projectId = project.id;
    segmentId = (await factories.createSegment(projectId, {type: SegmentType.STATIC})).id;
    const campaign = await factories.createCampaign({
      projectId,
      name: 'Workshop reminder',
      type: TemplateType.TRANSACTIONAL,
      status: CampaignStatus.SENDING,
      optOutSegmentId: segmentId,
    });
    const sentAt = new Date();
    await prisma.campaign.update({where: {id: campaign.id}, data: {sentAt, totalRecipients: 1}});
    campaignId = campaign.id;
    generation = sentAt.getTime();
    ProjectFooterService.clearCache();
    vi.mocked(sendRawEmail).mockReset();
    vi.mocked(sendRawEmail).mockResolvedValue({messageId: 'ses-1'});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function campaignEmail(body = '<p>Your workshop starts soon</p>') {
    const contact = await factories.createContact({projectId, subscribed: false});
    const email = await prisma.email.create({
      data: {
        id: CampaignService.emailIdFor(campaignId, generation, contact.id),
        projectId,
        contactId: contact.id,
        campaignId,
        subject: 'Reminder',
        body,
        from: 'hello@plunk.test',
        sourceType: EmailSourceType.TRANSACTIONAL,
        status: EmailStatus.PENDING,
      },
    });
    return {contact, email};
  }

  it("sends the one-click header to the campaign's opt-out link, the bulk headers and the notices footer", async () => {
    const {contact, email} = await campaignEmail();

    await processEmailJob(makeJob(email.id));

    const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
    expect(params.headers).toMatchObject({
      'List-Unsubscribe': `<${API_URI}/opt-out/${contact.id}?c=${campaignId}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Precedence': 'bulk',
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
    });
    expect(params.content.html).toContain(`href="${DASHBOARD_URI}/opt-out/${contact.id}?c=${campaignId}"`);
    expect(params.content.html).toContain("I don't want any more notices like this");
  });

  it('leaves the footer out when the body already links the opt-out page', async () => {
    const {email} = await campaignEmail();
    await prisma.email.update({
      where: {id: email.id},
      data: {body: `<p><a href="${DASHBOARD_URI}/opt-out/${email.contactId}?c=${campaignId}">Stop</a></p>`},
    });

    await processEmailJob(makeJob(email.id));

    const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
    expect(params.content.html).not.toContain("I don't want any more notices like this");
  });

  it('skips a contact who opted out after the batch, without sending, and closes the campaign', async () => {
    const {contact, email} = await campaignEmail();
    await prisma.segmentMembership.create({data: {segmentId, contactId: contact.id}});
    const finalize = vi.spyOn(CampaignService, 'finalizeIfDone').mockResolvedValue();

    await processEmailJob(makeJob(email.id));

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row).toMatchObject({status: EmailStatus.FAILED, error: OPTED_OUT_EMAIL_ERROR});
    expect(sendRawEmail).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(campaignId);
  });

  it('fails with an alert on the campaign, sending nothing, while the segment of the topic is gone', async () => {
    const {email} = await campaignEmail();
    await prisma.segment.delete({where: {id: segmentId}});
    const alert = vi.spyOn(FailureAlertService, 'recordCampaignJob').mockResolvedValue();

    await processEmailJob(makeJob(email.id));

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row).toMatchObject({status: EmailStatus.FAILED, error: MISSING_CAMPAIGN_TOPIC});
    expect(sendRawEmail).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(campaignId, MISSING_CAMPAIGN_TOPIC);
  });
});

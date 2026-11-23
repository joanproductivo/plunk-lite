import {EmailSourceType, EmailStatus, SegmentType, TemplateType} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {API_URI, DASHBOARD_URI} from '../../app/constants';
import {RECIPIENT_OVERRIDE_HEADER} from '../../services/EmailHeaderService';
import {SegmentService} from '../../services/SegmentService';
import {ProjectFooterService} from '../../services/ProjectFooterService';
import {sendRawEmail} from '../../services/SESService';
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
 * opted out after it was queued, and otherwise carries the one-click header to its opt-out link, the
 * bulk headers and the notices footer.
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
    vi.spyOn(SegmentService, 'isMember').mockRejectedValueOnce(new Error('database down'));

    await expect(processEmailJob(makeJob(email.id))).rejects.toThrow('database down');

    expect(sendRawEmail).not.toHaveBeenCalled();
    expect((await prisma.email.findUnique({where: {id: email.id}}))?.status).toBe(EmailStatus.PENDING);
    vi.restoreAllMocks();
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

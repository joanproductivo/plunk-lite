import {
  EmailStatus,
  SegmentType,
  StepExecutionStatus,
  TemplateType,
  WorkflowExecutionStatus,
  WorkflowStepType,
} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {DASHBOARD_URI} from '../../app/constants';
import {prisma as appPrisma} from '../../database/prisma';
import {ErrorCode, HttpException} from '../../exceptions/index.js';
import {BillingLimitService} from '../BillingLimitService';
import {EmailService} from '../EmailService';
import {FailureAlertService} from '../FailureAlertService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';

vi.mock('../QueueService', () => ({
  QueueService: {
    queueWithoutWaiting: vi.fn(async (add: Promise<unknown>) => {
      await add.catch(() => undefined);
    }),
    queueEmail: vi.fn(async () => ({id: 'mock-email-job-id'})),
    queueWorkflowTimeout: vi.fn(async () => ({id: 'mock-timeout-job-id'})),
    cancelWorkflowTimeout: vi.fn(async () => true),
  },
}));

/**
 * Plunk Lite: a transactional template with an opt-out topic is not queued for a contact who opted
 * out. /v1/send is told (422); a workflow step completes with a FAILED email saying why. While the
 * topic's segment is gone it is queued for no one, with an alert: /v1/send gets a 422
 * OPT_OUT_SEGMENT_MISSING.
 */
describe('EmailService with an opt-out topic', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let segmentId: string;
  let templateId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    segmentId = (await factories.createSegment(projectId, {type: SegmentType.STATIC})).id;
    templateId = (
      await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL, optOutSegmentId: segmentId})
    ).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function optedOutContact() {
    const contact = await factories.createContact({projectId, subscribed: false});
    await prisma.segmentMembership.create({data: {segmentId, contactId: contact.id}});
    return contact;
  }

  const params = (contactId: string, extra: Record<string, unknown> = {}) => ({
    projectId,
    contactId,
    subject: 'Day 5',
    body: '<p>Hi</p>',
    from: 'hello@example.com',
    templateId,
    ...extra,
  });

  it('refuses /v1/send with 422 CONTACT_OPTED_OUT, creating and counting nothing', async () => {
    const contact = await optedOutContact();
    const usage = vi.spyOn(BillingLimitService, 'incrementUsage');

    const error = await EmailService.sendTransactionalEmail(params(contact.id)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).code).toBe(422);
    expect((error as HttpException).errorCode).toBe(ErrorCode.CONTACT_OPTED_OUT);
    expect((error as HttpException).message).toContain(contact.email);
    expect(await prisma.email.count({where: {contactId: contact.id}})).toBe(0);
    expect(usage).not.toHaveBeenCalled();
    usage.mockRestore();
  });

  it('sends to a contact outside the topic, and another template to one inside it', async () => {
    const outside = await factories.createContact({projectId, subscribed: false});
    const inside = await optedOutContact();
    const plain = await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL});

    await expect(EmailService.sendTransactionalEmail(params(outside.id))).resolves.toMatchObject({
      status: EmailStatus.PENDING,
    });
    await expect(EmailService.sendTransactionalEmail(params(inside.id, {templateId: plain.id}))).resolves.toMatchObject(
      {status: EmailStatus.PENDING},
    );
  });

  it('creates a FAILED workflow email with the reason, and leaves the marketing skip as it was', async () => {
    const contact = await optedOutContact();
    const marketing = await factories.createTemplate({projectId});

    const skipped = await EmailService.sendWorkflowEmail(params(contact.id));
    expect(skipped.status).toBe(EmailStatus.FAILED);
    expect(skipped.error).toBe('Contact opted out of this kind of email');

    const unsubscribed = await EmailService.sendWorkflowEmail(params(contact.id, {templateId: marketing.id}));
    expect(unsubscribed.status).toBe(EmailStatus.FAILED);
    expect(unsubscribed.error).toBe('Contact is unsubscribed from marketing emails');
  });

  describe('while the segment of the topic is gone', () => {
    let record: ReturnType<typeof vi.spyOn<typeof FailureAlertService, 'record'>>;

    beforeEach(async () => {
      await prisma.template.update({where: {id: templateId}, data: {name: 'Workshop day'}});
      await prisma.segment.delete({where: {id: segmentId}});
      record = vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);
    });

    it('refuses the send with 422 OPT_OUT_SEGMENT_MISSING and an alert, creating nothing', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});

      const error = await EmailService.sendTransactionalEmail(params(contact.id)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).code).toBe(422);
      expect((error as HttpException).errorCode).toBe(ErrorCode.OPT_OUT_SEGMENT_MISSING);
      expect((error as HttpException).message).toContain('template "Workshop day"');
      expect(await prisma.email.count({where: {contactId: contact.id}})).toBe(0);
      expect(record).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({sourceKey: `template:${templateId}`, label: 'Workshop day'}),
      );
    });

    it('creates a FAILED workflow email with the reason, alerted against the template', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});

      const email = await EmailService.sendWorkflowEmail(params(contact.id));

      expect(email.status).toBe(EmailStatus.FAILED);
      expect(email.error).toContain('The opt-out segment of template "Workshop day" no longer exists');
      expect(record).toHaveBeenCalledWith(projectId, {
        sourceKey: `template:${templateId}`,
        label: 'Workshop day',
        error: email.error,
      });
    });
  });

  it('sends nothing when the membership cannot be read, from the API or a workflow', async () => {
    const contact = await factories.createContact({projectId, subscribed: false});
    vi.spyOn(appPrisma.segmentMembership, 'findUnique').mockRejectedValue(new Error('database down'));

    await expect(EmailService.sendTransactionalEmail(params(contact.id))).rejects.toThrow('database down');
    await expect(EmailService.sendWorkflowEmail(params(contact.id))).rejects.toThrow('database down');

    expect(await prisma.email.count({where: {contactId: contact.id}})).toBe(0);
  });

  it('still sends a workflow email to a custom recipient', async () => {
    const contact = await optedOutContact();

    const email = await EmailService.sendWorkflowEmail(params(contact.id, {recipientEmail: 'team@example.com'}));

    expect(email.status).toBe(EmailStatus.PENDING);
  });

  describe('in a SEND_EMAIL step', () => {
    /** Runs a workflow whose trigger leads to a SEND_EMAIL of the template, then one of `nextTemplateId` */
    async function runSendStep(contactId: string, body: string, nextTemplateId?: string) {
      await prisma.template.update({where: {id: templateId}, data: {body}});
      const workflow = await factories.createWorkflow({projectId});
      const trigger = await prisma.workflowStep.findFirstOrThrow({
        where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
      });
      const send = await factories.createWorkflowStep({
        workflowId: workflow.id,
        type: WorkflowStepType.SEND_EMAIL,
        templateId,
        config: {templateId},
      });
      await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: send.id}});
      if (nextTemplateId) {
        const next = await factories.createWorkflowStep({
          workflowId: workflow.id,
          type: WorkflowStepType.SEND_EMAIL,
          templateId: nextTemplateId,
          config: {templateId: nextTemplateId},
        });
        await prisma.workflowTransition.create({data: {fromStepId: send.id, toStepId: next.id}});
      }
      const execution = await prisma.workflowExecution.create({
        data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
      });

      await WorkflowExecutionService.processStepExecution(execution.id, trigger.id);

      const step = await prisma.workflowStepExecution.findFirstOrThrow({
        where: {executionId: execution.id, stepId: send.id},
      });
      const email = await prisma.email.findFirstOrThrow({where: {workflowExecutionId: execution.id, templateId}});
      return {step, email};
    }

    it('fills {{optOutUrl}} with the opt-out page of the template', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});

      const {email} = await runSendStep(contact.id, '<p><a href="{{optOutUrl}}">Stop</a></p>');

      expect(email.status).toBe(EmailStatus.PENDING);
      expect(email.body).toContain(`${DASHBOARD_URI}/opt-out/${contact.id}?t=${templateId}`);
    });

    it('completes the step with the FAILED email of a contact who opted out', async () => {
      const contact = await optedOutContact();

      const {step, email} = await runSendStep(contact.id, '<p>Hi</p>');

      expect(step.status).toBe(StepExecutionStatus.COMPLETED);
      expect(email.status).toBe(EmailStatus.FAILED);
      expect(email.error).toBe('Contact opted out of this kind of email');
    });

    it('completes the step with a FAILED email and one alert while the topic is gone, and goes on', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await prisma.segment.delete({where: {id: segmentId}});
      const record = vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);
      const plain = await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL});

      const {step, email} = await runSendStep(contact.id, '<p>Hi</p>', plain.id);

      expect(step.status).toBe(StepExecutionStatus.COMPLETED);
      expect(email.status).toBe(EmailStatus.FAILED);
      expect(email.error).toContain('no longer exists');
      expect(record).toHaveBeenCalledTimes(1);
      const execution = await prisma.workflowExecution.findUniqueOrThrow({where: {id: email.workflowExecutionId!}});
      expect(execution.status).toBe(WorkflowExecutionStatus.COMPLETED);
      const next = await prisma.email.findFirstOrThrow({
        where: {workflowExecutionId: execution.id, templateId: plain.id},
      });
      expect(next.status).toBe(EmailStatus.PENDING);
    });
  });
});

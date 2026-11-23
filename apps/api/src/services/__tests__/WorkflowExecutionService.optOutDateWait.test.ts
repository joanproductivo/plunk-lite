import {EmailStatus, SegmentType, TemplateType, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {DASHBOARD_URI} from '../../app/constants';
import {WorkflowExecutionService} from '../WorkflowExecutionService';

vi.mock('../QueueService', () => ({
  QueueService: {
    queueWithoutWaiting: vi.fn(async (add: Promise<unknown>) => {
      await add.catch(() => undefined);
    }),
    queueWorkflowDelayEnd: vi.fn(async () => ({id: 'mock-delay-end-job-id'})),
    rescheduleWorkflowDelayEnd: vi.fn(async () => undefined),
    queueDateWaitReschedule: vi.fn(async () => ({id: 'mock-reschedule-job-id'})),
    queueEmail: vi.fn(async () => ({id: 'mock-email-job-id'})),
    queueWorkflowTimeout: vi.fn(async () => ({id: 'mock-timeout-job-id'})),
    cancelWorkflowTimeout: vi.fn(async () => true),
  },
}));

const MINUTE = 60_000;

/**
 * Plunk Lite: the chain of a workshop day. Contacts wait until a date (spread over a window, where
 * the image has spreads), then a SEND_EMAIL of a transactional template with an opt-out topic sends
 * to each when they leave: its link to whoever is outside the topic, a FAILED email with the reason
 * to whoever joined it while waiting.
 */
describe('a wait until a date before a SEND_EMAIL with an opt-out topic', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let segmentId: string;
  let templateId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    segmentId = (await factories.createSegment(projectId, {type: SegmentType.STATIC})).id;
    templateId = (
      await factories.createTemplate({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        optOutSegmentId: segmentId,
        body: '<p>Day 5 <a href="{{optOutUrl}}">Stop these notices</a></p>',
      })
    ).id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends with the opt-out link to who is outside the topic, and skips who joined it while waiting', async () => {
    const workflow = await factories.createWorkflow({projectId, enabled: true});
    const trigger = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
    });
    const wait = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.DELAY,
      config: {
        until: new Date(Date.now() + 30 * MINUTE).toISOString().slice(0, 16),
        timezone: 'UTC',
        spreadMinutes: 60,
      },
    });
    const send = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.SEND_EMAIL,
      templateId,
      config: {templateId},
    });
    await prisma.workflowTransition.createMany({
      data: [
        {fromStepId: trigger.id, toStepId: wait.id},
        {fromStepId: wait.id, toStepId: send.id},
      ],
    });

    const start = async (contactId: string) => {
      const execution = await prisma.workflowExecution.create({
        data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
      });
      await WorkflowExecutionService.processStepExecution(execution.id, trigger.id);
      expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: execution.id}})).status).toBe(
        WorkflowExecutionStatus.WAITING,
      );
      return execution.id;
    };

    const stays = await factories.createContact({projectId, subscribed: false});
    const leaves = await factories.createContact({projectId, subscribed: false});
    const staysRun = await start(stays.id);
    const leavesRun = await start(leaves.id);

    // While waiting, one of them opts out
    await prisma.segmentMembership.create({data: {segmentId, contactId: leaves.id}});

    // Past the date and the whole spread, so every contact's own instant has come
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(Date.now() + 2 * 60 * MINUTE);
    expect(await WorkflowExecutionService.processDelayEnd(staysRun, wait.id)).toBe(0);
    expect(await WorkflowExecutionService.processDelayEnd(leavesRun, wait.id)).toBe(0);

    const sent = await prisma.email.findFirstOrThrow({where: {workflowExecutionId: staysRun}});
    expect(sent.status).toBe(EmailStatus.PENDING);
    expect(sent.body).toContain(`${DASHBOARD_URI}/opt-out/${stays.id}?t=${templateId}`);

    const skipped = await prisma.email.findFirstOrThrow({where: {workflowExecutionId: leavesRun}});
    expect(skipped.status).toBe(EmailStatus.FAILED);
    expect(skipped.error).toBe('Contact opted out of this kind of email');
  });
});

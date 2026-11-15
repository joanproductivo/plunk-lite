import {Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label} from '@plunk/ui';
import type {WorkflowStep} from '@plunk/db';
import {WALL_TIME, WorkflowSchemas} from '@plunk/shared';
import type {UpdateContactSegmentChanges} from '@plunk/types';
import {useState} from 'react';
import {toast} from 'sonner';

import {network} from '../../lib/network';

export const STEP_TYPE_LABELS: Record<WorkflowStep['type'], string> = {
  TRIGGER:        'Trigger',
  SEND_EMAIL:     'Send Email',
  DELAY:          'Delay',
  WAIT_FOR_EVENT: 'Wait for Event',
  CONDITION:      'Condition',
  EXIT:           'Exit',
  WEBHOOK:        'Webhook',
  UPDATE_CONTACT: 'Update Contact',
};

export const STEP_TYPE_DESCRIPTIONS: Record<WorkflowStep['type'], string> = {
  TRIGGER:        'Starts the workflow when a specific event is received.',
  SEND_EMAIL:     'Sends an email to the contact using a template you choose.',
  // Plunk Lite: also until a date and time
  DELAY:          'Pauses the workflow for a set amount of time, or until a date and time, before continuing.',
  WAIT_FOR_EVENT: 'Waits until the contact triggers a specific event, then continues.',
  CONDITION:      'Splits the flow based on contact data or segment membership — each path leads to different steps.',
  EXIT:           'Ends the workflow for the contact.',
  WEBHOOK:        "Makes an HTTP request to an external URL with the contact's data.",
  UPDATE_CONTACT: "Sets fields on the contact's profile, its subscription, or the static segments it is in.",
};

export type StepWithTemplate = WorkflowStep & {
  template?: {id: string; name: string} | null;
};

export interface EditStepDialogProps {
  step: StepWithTemplate;
  workflowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Plunk Lite: contacts waiting at this step now (a delay's dialog warns before moving them) */
  waiting?: number;
}

/**
 * Plunk Lite: what a delay step waits for, as its node shows it: "Wait 2 days", or "Wait until
 * 22 Nov 2026, 14:00 (Europe/Madrid)" -- the date as written, in its time zone. Null if not set up.
 */
export function delayLabel(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const {amount, unit, until, timezone} = config as Record<string, unknown>;
  if (typeof until === 'string' && typeof timezone === 'string') {
    const match = WALL_TIME.exec(until);
    if (!match) {
      return null;
    }
    const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
    const written = new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'}).format(
      Date.UTC(year, month - 1, day, hour, minute),
    );
    return `Wait until ${written} (${timezone})`;
  }
  return amount && typeof unit === 'string' ? `Wait ${String(amount)} ${unit}` : null;
}

export interface UpdateStepInput {
  name: string;
  config: Record<string, unknown>;
  templateId?: string;
}

export function useStepUpdate(workflowId: string, stepId: string) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const update = async (input: UpdateStepInput): Promise<boolean> => {
    setIsSubmitting(true);
    try {
      await network.fetch<WorkflowStep, typeof WorkflowSchemas.updateStep>(
        'PATCH',
        `/workflows/${workflowId}/steps/${stepId}`,
        input as Parameters<typeof network.fetch>[2],
      );
      toast.success('Step updated');
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the step. Try again.');
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  return {update, isSubmitting};
}

/** Whether an Update contact step's config changes anything: data, subscription or segments */
export function hasUpdateContactAction(config: {updates?: unknown; subscriptionAction?: unknown; segments?: unknown}) {
  const hasUpdates = !!config.updates && typeof config.updates === 'object' && Object.keys(config.updates).length > 0;
  const hasSubscriptionAction =
    typeof config.subscriptionAction === 'string' &&
    config.subscriptionAction !== 'none' &&
    config.subscriptionAction !== '';
  const segments = (config.segments ?? {}) as Partial<UpdateContactSegmentChanges>;
  const hasSegmentChanges = [segments.add, segments.remove].some(ids => Array.isArray(ids) && ids.length > 0);
  return hasUpdates || hasSubscriptionAction || hasSegmentChanges;
}

export function getStepConfig(step: {config: unknown}): Record<string, unknown> {
  return step.config && typeof step.config === 'object' && !Array.isArray(step.config)
    ? (step.config as Record<string, unknown>)
    : {};
}

interface StepDialogShellProps {
  step: StepWithTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  isSubmitting: boolean;
  children: React.ReactNode;
}

export function StepDialogShell({
  step,
  open,
  onOpenChange,
  name,
  onNameChange,
  onSubmit,
  isSubmitting,
  children,
}: StepDialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {STEP_TYPE_LABELS[step.type] ?? step.type}</DialogTitle>
          {STEP_TYPE_DESCRIPTIONS[step.type] && (
            <p className="text-sm text-neutral-500 mt-1">{STEP_TYPE_DESCRIPTIONS[step.type]}</p>
          )}
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <Label htmlFor="editStepName">Step name</Label>
            <Input
              id="editStepName"
              type="text"
              value={name}
              onChange={e => onNameChange(e.target.value)}
              required
              placeholder="e.g., Send Welcome Email"
              className="mt-1.5"
            />
          </div>

          {children}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import {Alert, AlertDescription, AlertTitle, Button, ConfirmDialog} from '@plunk/ui';
import type {ParkedGroup} from '@plunk/types';
import {Hourglass, Play} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {network} from '../lib/network';

interface ParkedContactsBannerProps {
  workflowId: string;
  enabled: boolean;
  parked: ParkedGroup[];
  /** How fast they continue, as the API lets them */
  pace: {perRound: number; everyMinutes: number};
  /** The page's own check of the workflow, as enabling it runs it */
  validation: {valid: boolean; errors: string[]};
  onContinued: () => void;
}

const contacts = (count: number) => `${count} ${count === 1 ? 'contact' : 'contacts'}`;

/** Where a group waits: the step, and the condition's branch it took */
function place(group: ParkedGroup): string {
  const step = group.stepName ? `"${group.stepName}"` : 'a deleted step';
  return group.branchName ? `${step}, "${group.branchName}" branch` : step;
}

/** What it takes for a group to continue */
function outlook(group: ParkedGroup): string {
  if (group.canContinue) {
    return ': can continue now';
  }
  if (!group.stepName) {
    return ': its step was deleted';
  }
  if (!group.branchExists && group.fallbackBranchName) {
    return `: that branch no longer exists, so they go by "${group.fallbackBranchName}"; connect it to continue`;
  }
  return group.branchExists ? ': add a step after it to continue' : ': that branch no longer exists';
}

/**
 * Plunk Lite: the contacts waiting at the end of a workflow that keeps them until an Exit step, and
 * letting them continue into the steps added after where they wait
 */
export function ParkedContactsBanner({
  workflowId,
  enabled,
  parked,
  pace,
  validation,
  onContinued,
}: ParkedContactsBannerProps) {
  const [confirming, setConfirming] = useState(false);
  // How many could continue when it was pressed: until that changes (the rounds took them), the
  // press is under way, and one press runs at a time
  const [pressedAt, setPressedAt] = useState<number | null>(null);

  const total = parked.reduce((sum, group) => sum + group.count, 0);
  const ready = parked.filter(group => group.canContinue);
  const continuable = ready.reduce((sum, group) => sum + group.count, 0);
  const unsubscribed = ready.reduce((sum, group) => sum + group.unsubscribed, 0);
  const continuing = pressedAt === continuable;

  if (total === 0) {
    return null;
  }

  const handleContinueClick = () => {
    if (!validation.valid) {
      toast.error(
        <div>
          <div className="font-semibold mb-1">Fix the workflow first</div>
          <ul className="list-disc list-inside text-sm">
            {validation.errors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>,
        {duration: 8000},
      );
      return;
    }
    setConfirming(true);
  };

  const handleContinue = async () => {
    try {
      const result = await network.fetch<{continuable: number; perRound: number; everyMinutes: number}>(
        'POST',
        `/workflows/${workflowId}/parked/continue`,
      );
      toast.success(
        result.continuable > result.perRound
          ? `${contacts(result.continuable)} are continuing, ${result.perRound} every ${result.everyMinutes} minutes`
          : `${contacts(result.continuable)} ${result.continuable === 1 ? 'is' : 'are'} continuing`,
      );
      setConfirming(false);
      setPressedAt(continuable);
      onContinued();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t let them continue. Try again.');
    }
  };

  return (
    <Alert>
      <Hourglass className="h-4 w-4" />
      <AlertTitle>
        {contacts(total)} reached the end and {total === 1 ? 'is' : 'are'} waiting for new steps
      </AlertTitle>
      <AlertDescription>
        <ul className="list-disc list-inside space-y-1">
          {parked.map(group => (
            <li key={`${group.stepId}:${group.branch ?? ''}`}>
              {contacts(group.count)} after {place(group)}
              {outlook(group)}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {continuable > 0 && continuing && (
            <span className="text-sm text-neutral-500">
              Continuing, {pace.perRound} every {pace.everyMinutes} minutes…
            </span>
          )}
          {continuable > 0 && !continuing && (
            <Button size="sm" onClick={handleContinueClick} disabled={!enabled}>
              <Play className="h-3.5 w-3.5" />
              Continue {contacts(continuable)}
            </Button>
          )}
          {continuable > 0 && !enabled && (
            <span className="text-sm text-neutral-500">Enable the workflow to let them continue</span>
          )}
          <span className="text-sm text-neutral-500">
            To let them leave instead, turn off &ldquo;Keep contacts until an Exit step&rdquo; in Settings.
          </span>
        </div>
      </AlertDescription>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={handleContinue}
        title={`Continue ${contacts(continuable)}?`}
        description={
          <>
            They go through the new steps now, {pace.perRound} every {pace.everyMinutes} minutes, and any email among
            them goes out as they reach it.
            {unsubscribed > 0 &&
              ` ${unsubscribed} of them ${unsubscribed === 1 ? 'is' : 'are'} unsubscribed: marketing emails skip them.`}
          </>
        }
        confirmText="Continue"
        loadingText="Continuing…"
        icon={Play}
      />
    </Alert>
  );
}

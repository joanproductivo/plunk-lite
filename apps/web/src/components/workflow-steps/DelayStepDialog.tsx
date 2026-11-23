import {
  type DateWaitConfig,
  dateWaitProblem,
  dateWaitSpreadMs,
  isDateWait,
  spreadOverlap,
  wallTimeToInstant,
} from '@plunk/shared';
import {ConfirmDialog, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@plunk/ui';
import {CalendarClock} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {DateWaitFields, defaultDateWait, formatHere} from './DateWaitFields';
import {type EditStepDialogProps, getStepConfig, StepDialogShell, useStepUpdate} from './shared';

type DelayUnit = 'minutes' | 'hours' | 'days';
type DelayMode = 'duration' | 'date';

const MAX_DELAY_BY_UNIT: Record<DelayUnit, number> = {
  minutes: 525600,
  hours:   8760,
  days:    365,
};

function isDelayUnit(value: unknown): value is DelayUnit {
  return value === 'minutes' || value === 'hours' || value === 'days';
}

/** An instant here: only its time if it is today */
const timeHere = (at: Date) =>
  at.toDateString() === new Date().toDateString()
    ? new Intl.DateTimeFormat(undefined, {timeStyle: 'short'}).format(at)
    : formatHere(at);

export function DelayStepDialog({
  step,
  workflowId,
  open,
  onOpenChange,
  onSuccess,
  waiting = 0,
  steps = [],
}: EditStepDialogProps) {
  const config = getStepConfig(step);
  // Plunk Lite: a wait for a duration, or until a date and time in a time zone
  const savedDate = isDateWait(step.config) ? step.config : null;

  const [name, setName] = useState(step.name);
  const [mode, setMode] = useState<DelayMode>(savedDate ? 'date' : 'duration');
  const [delayAmount, setDelayAmount] = useState(String(config.amount ?? '24'));
  const [delayUnit, setDelayUnit] = useState<DelayUnit>(isDelayUnit(config.unit) ? config.unit : 'hours');
  const [dateWait, setDateWait] = useState<DateWaitConfig>(
    savedDate
      ? {
          until: savedDate.until,
          timezone: savedDate.timezone,
          ifLate: savedDate.ifLate ?? 'skip',
          // Kept, or saving a rename would drop it and let everyone still waiting go at once
          spreadMinutes: savedDate.spreadMinutes ?? 0,
        }
      : defaultDateWait(),
  );
  // Plunk Lite: asking before moving the contacts waiting here, saying what happens to them
  const [confirming, setConfirming] = useState<{description: string} | null>(null);

  const {update, isSubmitting} = useStepUpdate(workflowId, step.id);

  const save = async () => {
    const ok = await update({
      name,
      config:
        mode === 'date'
          ? {
              until: dateWait.until,
              timezone: dateWait.timezone,
              ifLate: dateWait.ifLate,
              ...(dateWait.spreadMinutes ? {spreadMinutes: dateWait.spreadMinutes} : {}),
            }
          : {amount: parseInt(delayAmount, 10), unit: delayUnit},
    });
    if (ok) {
      setConfirming(null);
      onOpenChange(false);
      onSuccess();
    }
  };

  // Whether the date or spread differs from the saved one (or there was no date wait)
  const timesChange =
    savedDate === null ||
    savedDate.until !== dateWait.until ||
    savedDate.timezone !== dateWait.timezone ||
    (savedDate.spreadMinutes ?? 0) !== (dateWait.spreadMinutes ?? 0);
  // Contacts waiting here move with a new date or spread: they are told so before it is saved
  const movesWaiting = mode === 'date' && savedDate !== null && waiting > 0 && timesChange;

  const contacts = `${waiting} ${waiting === 1 ? 'contact' : 'contacts'} waiting here`;

  /** What happens to the contacts waiting here with the new date and spread */
  const moveDescription = (): string => {
    const at = wallTimeToInstant(dateWait.until, dateWait.timezone)?.getTime() ?? 0;
    const end = at + dateWaitSpreadMs(dateWait);
    const now = Date.now();
    const shortened =
      at <= now && end > now && (dateWait.spreadMinutes ?? 0) < (savedDate?.spreadMinutes ?? 0)
        ? ' The spread has started: shortening it lets everyone whose new time has passed go at once.'
        : '';
    if (end <= now) {
      return `${contacts} will continue right away.`;
    }
    if (at <= now) {
      return `${contacts}: those whose time has passed continue right away, the rest by ${timeHere(new Date(end))}.${shortened}`;
    }
    return dateWait.spreadMinutes
      ? `${contacts} will move to their new times.`
      : `${contacts} will move to the new date.`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (mode === 'date') {
      const problem = dateWaitProblem(dateWait, new Date());
      if (problem) {
        toast.error(problem);
        return;
      }
      // A spread that reaches the next date wait would make some contacts late for it. Checked when
      // the date or spread changes, so that a rename still saves
      const overlap = timesChange ? spreadOverlap(steps, step.id, dateWait) : null;
      if (overlap) {
        const next = steps.find(other => other.id === overlap.stepId);
        const where = `("${next?.name ?? 'Wait'}" at ${formatHere(overlap.at)})`;
        if (overlap.severity === 'error') {
          toast.error(
            `The spread reaches the next date wait ${where}: late contacts would skip it. Use a shorter spread.`,
          );
          return;
        }
        toast.warning(
          `The spread may reach the next date wait ${where}, which goes on right away when late, or a wait for ` +
            'an event with no time limit lies before it.',
        );
      }
      if (movesWaiting) {
        setConfirming({description: moveDescription()});
        return;
      }
    } else {
      const amount = parseInt(delayAmount, 10);
      if (amount > MAX_DELAY_BY_UNIT[delayUnit]) {
        toast.error(`Delay cannot exceed 365 days (${MAX_DELAY_BY_UNIT[delayUnit]} ${delayUnit})`);
        return;
      }
    }

    await save();
  };

  return (
    <>
      <StepDialogShell
        step={step}
        open={open}
        onOpenChange={onOpenChange}
        name={name}
        onNameChange={setName}
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
      >
        <div>
          <Label htmlFor="editDelayMode">Wait</Label>
          <Select value={mode} onValueChange={value => setMode(value as DelayMode)}>
            <SelectTrigger id="editDelayMode" className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="duration">For a duration</SelectItem>
              <SelectItem value="date">Until a date</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === 'date' ? (
          <DateWaitFields value={dateWait} onChange={setDateWait} />
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="editDelayAmount">Amount</Label>
              <Input
                id="editDelayAmount"
                type="number"
                value={delayAmount}
                onChange={e => setDelayAmount(e.target.value)}
                required
                min="1"
                max={MAX_DELAY_BY_UNIT[delayUnit]}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="editDelayUnit">Unit</Label>
              <Select value={delayUnit} onValueChange={value => setDelayUnit(value as DelayUnit)}>
                <SelectTrigger id="editDelayUnit" className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Minutes</SelectItem>
                  <SelectItem value="hours">Hours</SelectItem>
                  <SelectItem value="days">Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </StepDialogShell>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={value => !value && setConfirming(null)}
        onConfirm={save}
        icon={CalendarClock}
        title="Move the waiting contacts?"
        description={confirming?.description ?? ''}
        confirmText="Save changes"
        status={isSubmitting ? 'loading' : 'idle'}
      />
    </>
  );
}

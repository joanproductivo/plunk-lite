import {type DateWaitConfig, dateWaitProblem, isDateWait, wallTimeToInstant} from '@plunk/shared';
import {ConfirmDialog, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@plunk/ui';
import {CalendarClock} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {DateWaitFields, defaultDateWait} from './DateWaitFields';
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

export function DelayStepDialog({step, workflowId, open, onOpenChange, onSuccess, waiting = 0}: EditStepDialogProps) {
  const config = getStepConfig(step);
  // Plunk Lite: a wait for a duration, or until a date and time in a time zone
  const savedDate = isDateWait(step.config) ? step.config : null;

  const [name, setName] = useState(step.name);
  const [mode, setMode] = useState<DelayMode>(savedDate ? 'date' : 'duration');
  const [delayAmount, setDelayAmount] = useState(String(config.amount ?? '24'));
  const [delayUnit, setDelayUnit] = useState<DelayUnit>(isDelayUnit(config.unit) ? config.unit : 'hours');
  const [dateWait, setDateWait] = useState<DateWaitConfig>(
    savedDate
      ? {until: savedDate.until, timezone: savedDate.timezone, ifLate: savedDate.ifLate ?? 'skip'}
      : defaultDateWait(),
  );
  // Plunk Lite: asking before moving the contacts waiting here; `past` if the new date has passed
  const [confirming, setConfirming] = useState<{past: boolean} | null>(null);

  const {update, isSubmitting} = useStepUpdate(workflowId, step.id);

  const save = async () => {
    const ok = await update({
      name,
      config:
        mode === 'date'
          ? {until: dateWait.until, timezone: dateWait.timezone, ifLate: dateWait.ifLate}
          : {amount: parseInt(delayAmount, 10), unit: delayUnit},
    });
    if (ok) {
      setConfirming(null);
      onOpenChange(false);
      onSuccess();
    }
  };

  // Contacts waiting here move with a new date: they are told so before it is saved
  const movesWaiting =
    mode === 'date' &&
    savedDate !== null &&
    waiting > 0 &&
    (savedDate.until !== dateWait.until || savedDate.timezone !== dateWait.timezone);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (mode === 'date') {
      const problem = dateWaitProblem(dateWait, new Date());
      if (problem) {
        toast.error(problem);
        return;
      }
      if (movesWaiting) {
        setConfirming({past: (wallTimeToInstant(dateWait.until, dateWait.timezone)?.getTime() ?? 0) <= Date.now()});
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

  const contacts = `${waiting} ${waiting === 1 ? 'contact is' : 'contacts are'} waiting here`;

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
        description={
          confirming?.past ? `${contacts} and continue right away.` : `${contacts} and move to the new date.`
        }
        confirmText="Save new date"
        status={isSubmitting ? 'loading' : 'idle'}
      />
    </>
  );
}

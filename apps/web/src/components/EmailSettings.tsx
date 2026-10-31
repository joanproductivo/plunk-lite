import {Input, Label} from '@plunk/ui';
import {EmailDomainInput} from './EmailDomainInput';

interface EmailSettingsProps {
  from: string;
  fromName: string;
  replyTo: string;
  onFromChange: (value: string) => void;
  onFromNameChange: (value: string) => void;
  onReplyToChange: (value: string) => void;
  fromPlaceholder?: string;
  fromNamePlaceholder?: string;
  layout?: 'vertical' | 'grid';
}

export function EmailSettings({
  from,
  fromName,
  replyTo,
  onFromChange,
  onFromNameChange,
  onReplyToChange,
  fromPlaceholder = 'hello',
  fromNamePlaceholder = 'Your Company',
  layout = 'grid',
}: EmailSettingsProps) {
  const GridWrapper = layout === 'grid' ? 'div' : 'div';
  const gridClassName = layout === 'grid' ? 'grid gap-4 md:grid-cols-2' : 'space-y-4';

  return (
    <div className="space-y-4">
      <GridWrapper className={gridClassName}>
        <div>
          <EmailDomainInput
            id="from"
            label="From email"
            value={from}
            onChange={onFromChange}
            required
            placeholder={fromPlaceholder}
          />
        </div>

        <div>
          <Label htmlFor="fromName">From name</Label>
          <Input
            id="fromName"
            type="text"
            value={fromName}
            onChange={e => onFromNameChange(e.target.value)}
            placeholder={fromNamePlaceholder}
          />
          <p className="text-xs text-neutral-500 mt-1">
            The sender name that appears in the recipient&apos;s inbox. Defaults to your project name if not set.
          </p>
        </div>
      </GridWrapper>

      <GridWrapper className={layout === 'grid' ? 'grid gap-4 md:grid-cols-2' : ''}>
        <div>
          <Label htmlFor="replyTo">Reply-To email</Label>
          <Input
            id="replyTo"
            type="email"
            autoComplete="off"
            value={replyTo}
            onChange={e => onReplyToChange(e.target.value)}
            placeholder={from.includes('@') ? from : 'Same as From email'}
          />
          <p className="text-xs text-neutral-500 mt-1">
            Where replies go. It can be on any domain. Leave it empty to use the From email.
          </p>
        </div>
      </GridWrapper>
    </div>
  );
}

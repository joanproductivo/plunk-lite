import type {TemplateType} from '@plunk/db';
import {usesVariable} from '@plunk/shared';
import {Label} from '@plunk/ui';
import {TriangleAlert} from 'lucide-react';
import type {ReactNode} from 'react';

import {SegmentChip, SegmentSelect, useSegmentName} from '../segments/SegmentPicker';

/** The description of the "Template type" card: transactional templates with a topic get its footer */
export function templateTypeDescription(hasTopic: boolean): string {
  return hasTopic
    ? 'Transactional templates skip the subscription check and the footer, except the notices footer of their opt-out topic.'
    : 'Transactional templates skip the subscription check and the footer.';
}

function Warning({children}: {children: ReactNode}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
      <p className="text-xs leading-relaxed text-amber-800">{children}</p>
    </div>
  );
}

interface OptOutTopicFieldProps {
  type: TemplateType | undefined;
  /** The topic chosen, a static segment's id, or null */
  value: string | null;
  /** The topic saved, to warn while it is being removed; none when creating */
  saved?: string | null;
  body: string;
  onChange: (id: string | null) => void;
}

/**
 * Plunk Lite: the opt-out topic of a TRANSACTIONAL template, a static segment. Its emails carry a
 * one-click unsubscribe that puts the contact in that segment, and are not sent to its members.
 * Outside TRANSACTIONAL only the warnings show: removing a saved topic, and an `{{optOutUrl}}` that
 * would be empty.
 */
export function OptOutTopicField({type, value, saved, body, onChange}: OptOutTopicFieldProps) {
  const nameOf = useSegmentName();
  const removing = Boolean(saved) && value !== saved;
  const emptyLink = usesVariable(body, 'optOutUrl') && (type !== 'TRANSACTIONAL' || !value);

  const warnings = (
    <>
      {removing && (
        <Warning>Contacts who opted out of {nameOf(saved!)} will get this template again once you save.</Warning>
      )}
      {emptyLink && (
        <Warning>
          This link is empty without an opt-out topic: <code className="font-mono">{'{{optOutUrl}}'}</code> only works
          in a transactional template with one.
        </Warning>
      )}
    </>
  );

  if (type !== 'TRANSACTIONAL') {
    return removing || emptyLink ? <div className="mt-3 space-y-2">{warnings}</div> : null;
  }

  return (
    <div className="mt-4 space-y-2 border-t border-neutral-200 pt-4">
      <Label>Opt-out topic</Label>
      {value ? (
        <div className="flex flex-wrap gap-1.5">
          <SegmentChip
            name={nameOf(value)}
            href={`/segments/${value}`}
            onRemove={() => onChange(null)}
            removeLabel={`Remove the opt-out topic ${nameOf(value)}`}
          />
        </div>
      ) : (
        <SegmentSelect
          exclude={[]}
          onSelect={segment => onChange(segment.id)}
          placeholder="Choose a static segment…"
          staticOnly
        />
      )}
      {value ? (
        <>
          <Warning>
            Contacts who opt out join {nameOf(value)} and stop getting this template — from workflows and from the API.
            Other transactional emails still reach them. Use it only for notices, never for receipts or access emails,
            and pick a segment kept for this: joining it also fires its entry event and adds them to whatever uses it.
          </Warning>
          <p className="text-xs text-neutral-500">
            Plunk adds the notices footer (Settings → Brand) at the end. Put{' '}
            <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">{'{{optOutUrl}}'}</code> in the body
            only if you want your own link; then the footer is left out.
          </p>
        </>
      ) : (
        <p className="text-xs text-neutral-500">
          Optional. For notices only: a one-click unsubscribe that stops this template for whoever uses it.
        </p>
      )}
      {warnings}
    </div>
  );
}

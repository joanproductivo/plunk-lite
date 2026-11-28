import type {TemplateType} from '@plunk/db';
import {usesVariable} from '@plunk/shared';
import {Label} from '@plunk/ui';
import {TriangleAlert} from 'lucide-react';
import type {ReactNode} from 'react';

import {SegmentChip, SegmentSelect, useSegmentName, useSegments} from '../segments/SegmentPicker';

/** What has the opt-out topic: a template, or (Plunk Lite) a campaign */
type OptOutOwner = 'template' | 'campaign';

/** The description of the "Template type" (or "Campaign type") card: transactional ones with a topic get its footer */
export function templateTypeDescription(hasTopic: boolean, owner: OptOutOwner = 'template'): string {
  const subject = owner === 'campaign' ? 'Transactional campaigns' : 'Transactional templates';
  return hasTopic
    ? `${subject} skip the subscription check and the footer, except the notices footer of their opt-out topic.`
    : `${subject} skip the subscription check and the footer.`;
}

/** What a campaign editor says when the segment chosen as its audience was its opt-out topic */
export const TOPIC_DROPPED = 'Opt-out topic removed: a campaign cannot be sent to its own opt-out segment.';

/** How to use a topic, the same for templates and campaigns */
const TOPIC_USE =
  'Use it only for notices, never for receipts or access emails, and pick a segment kept for this: joining it also fires its entry event and adds them to whatever uses it.';

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
  /** What has the topic, for the texts; a template by default */
  owner?: OptOutOwner;
  /** Segments that cannot be the topic (a campaign's audience) */
  exclude?: string[];
}

/**
 * Plunk Lite: the opt-out topic of a TRANSACTIONAL template or campaign, a static segment. Its emails
 * carry a one-click unsubscribe that puts the contact in that segment, and are not sent to its members.
 * Outside TRANSACTIONAL only the warnings show: removing a saved topic, and an `{{optOutUrl}}` that
 * would be empty.
 */
export function OptOutTopicField({
  type,
  value,
  saved,
  body,
  onChange,
  owner = 'template',
  exclude = [],
}: OptOutTopicFieldProps) {
  const nameOf = useSegmentName();
  const {data: segments} = useSegments();
  const campaign = owner === 'campaign';
  // A topic whose segment is gone (by SQL, or from an earlier image): the template reaches no one, and
  // the campaign cannot be sent
  const gone = Boolean(value && segments && !segments.some(segment => segment.id === value));
  const removing = Boolean(saved) && value !== saved;
  const emptyLink = usesVariable(body, 'optOutUrl') && (type !== 'TRANSACTIONAL' || !value);

  const warnings = (
    <>
      {removing && (
        <Warning>
          Contacts who opted out of {nameOf(saved!)} will get this {campaign ? 'campaign' : 'template again'} once you
          save.
        </Warning>
      )}
      {emptyLink && (
        <Warning>
          This link is empty without an opt-out topic: <code className="font-mono">{'{{optOutUrl}}'}</code> only works
          in a transactional {owner} with one.
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
          exclude={exclude}
          onSelect={segment => onChange(segment.id)}
          placeholder="Choose a static segment…"
          staticOnly
        />
      )}
      {gone ? (
        <Warning>
          {campaign
            ? 'This segment no longer exists, so this campaign cannot be sent: pick another segment, or remove it.'
            : 'This segment no longer exists, so this template is sent to no one: pick another segment, or remove it.'}
        </Warning>
      ) : value ? (
        <>
          <Warning>
            {campaign
              ? `Contacts who opt out join ${nameOf(value)}. This campaign is not sent to its members, and neither is any other email with this topic.`
              : `Contacts who opt out join ${nameOf(value)} and stop getting this template — from workflows and from the API. Other transactional emails still reach them.`}{' '}
            {TOPIC_USE}
          </Warning>
          <p className="text-xs text-neutral-500">
            Plunk adds the notices footer (Settings → Brand) at the end. Put{' '}
            <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">{'{{optOutUrl}}'}</code> in the body
            only if you want your own link; then the footer is left out.
          </p>
        </>
      ) : (
        <p className="text-xs text-neutral-500">
          {campaign
            ? 'Optional. For notices only: a one-click unsubscribe that stops this kind of email for whoever opts out.'
            : 'Optional. For notices only: a one-click unsubscribe that stops this template for whoever uses it.'}
        </p>
      )}
      {warnings}
    </div>
  );
}

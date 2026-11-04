import {CAMPAIGN_EXCLUDED_SEGMENTS_MAX} from '@plunk/shared';
import {Label} from '@plunk/ui';

import {SegmentChip, SegmentSelect, useSegmentName} from '../segments/SegmentPicker';

/** Most excluded segments a summary line names before it just counts them */
const NAMED_IN_SUMMARY = 3;

interface ExcludedSegmentsFieldProps {
  value: string[];
  onChange: (ids: string[]) => void;
  /** The segment the campaign is sent to, which it cannot exclude */
  audienceSegmentId?: string;
}

/**
 * Plunk Lite: the segments whose contacts never get a campaign, whatever its audience. An id that no
 * longer matches a segment shows as deleted and can be removed: until it is, the campaign does not
 * send.
 */
export function ExcludedSegmentsField({value, onChange, audienceSegmentId}: ExcludedSegmentsFieldProps) {
  const nameOf = useSegmentName();

  return (
    <div className="space-y-2">
      <Label>Don&apos;t send to</Label>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map(id => (
            <SegmentChip
              key={id}
              name={nameOf(id)}
              onRemove={() => onChange(value.filter(other => other !== id))}
              removeLabel={`Stop leaving out ${nameOf(id)}`}
            />
          ))}
        </div>
      )}
      {value.length < CAMPAIGN_EXCLUDED_SEGMENTS_MAX && (
        <SegmentSelect
          exclude={audienceSegmentId ? [...value, audienceSegmentId] : value}
          onSelect={segment => onChange([...value, segment.id])}
          placeholder="Leave out a segment…"
        />
      )}
      <p className="text-xs text-neutral-500">
        Contacts in these segments won&apos;t get this campaign, even if they are in the audience. Checked again when it
        sends.
      </p>
    </div>
  );
}

/** « except A, B» after a campaign's audience in its summary lines; nothing when it excludes none */
export function ExcludedSegmentsSuffix({ids}: {ids: string[]}) {
  const nameOf = useSegmentName();
  if (ids.length === 0) {
    return null;
  }
  return <> except {ids.length > NAMED_IN_SUMMARY ? `${ids.length} segments` : ids.map(nameOf).join(', ')}</>;
}

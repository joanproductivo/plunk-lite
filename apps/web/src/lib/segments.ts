import type {Segment} from '@plunk/db';
import type {FilterCondition, FilterGroup, SegmentFilter} from '@plunk/types';

/** A segment's name by id: '…' while the segments load, 'Deleted segment' when it is gone */
export function segmentName(segments: Pick<Segment, 'id' | 'name'>[] | undefined, id: string): string {
  return segments ? (segments.find(segment => segment.id === id)?.name ?? 'Deleted segment') : '…';
}

/** Plunk Lite: whether an operator leaves out the contacts without the field it compares ("≠", "doesn't contain") */
export function leavesOutMissing(operator: string): boolean {
  return operator === 'notEquals' || operator === 'notContains';
}

/**
 * Plunk Lite: whether a workflow condition field may be missing: custom data (offered as
 * `contact.data.<key>`) and event fields. The contact's own fields are always set.
 */
export function conditionFieldMayBeMissing(field: string): boolean {
  return ['contact.data.', 'data.', 'event.', 'workflow.'].some(prefix => field.startsWith(prefix));
}

/** Plunk Lite: whether a segment filter leaves out the contacts without its custom field */
export function leavesOutMissingField(filter: SegmentFilter): boolean {
  return filter.field.startsWith('data.') && leavesOutMissing(filter.operator);
}

/** Plunk Lite: the fields an OR condition already lets in when missing: its groups that are just "<field> has no value" */
export function fieldsIncludedWhenMissing(condition: FilterCondition): Set<string> {
  const fields = new Set<string>();
  if (condition.logic !== 'OR') return fields;
  for (const group of condition.groups) {
    const [only] = group.filters;
    if (group.filters.length === 1 && !group.conditions && only?.operator === 'notExists') {
      fields.add(only.field);
    }
  }
  return fields;
}

/**
 * Plunk Lite: the group with filter `index` turned into "(that filter OR its field has no value)". Filters in a
 * group are always ANDed, so the OR goes in the group's nested condition: a new OR group at the top
 * would also let in contacts the group's other filters leave out. A group that already has a
 * nested condition is returned as it is.
 */
export function includeMissingField(group: FilterGroup, index: number): FilterGroup {
  const filter = group.filters[index];
  if (!filter || group.conditions) return group;
  return {
    ...group,
    filters: group.filters.filter((_, i) => i !== index),
    conditions: {
      logic: 'OR',
      groups: [{filters: [filter]}, {filters: [{field: filter.field, operator: 'notExists'}]}],
    },
  };
}

/** Plunk Lite: the filter of a condition that is exactly what includeMissingField nests, or null */
export function filterIncludingMissing(condition: FilterCondition): SegmentFilter | null {
  const [first, second, ...rest] = condition.groups;
  const only = (group?: FilterGroup) =>
    group && group.filters.length === 1 && !group.conditions ? group.filters[0] : undefined;
  const filter = only(first);
  const missing = only(second);
  if (condition.logic !== 'OR' || rest.length > 0 || !filter || !missing) return null;
  return missing.operator === 'notExists' && missing.field === filter.field ? filter : null;
}

import {describe, expect, it} from 'vitest';

import {getSuggestionFields, setAvailableVariables} from '../VariableMention';

/** Plunk Lite: `{{optOutUrl}}` is offered in every editor, templates and campaigns alike */
describe('getSuggestionFields', () => {
  it('offers optOutUrl among the runtime variables, once', () => {
    setAvailableVariables([{field: 'optOutUrl', type: 'string', coverage: 3}]);

    const fields = getSuggestionFields().filter(field => field.field === 'optOutUrl');

    expect(fields).toEqual([{field: 'optOutUrl', type: 'string', coverage: 100}]);
    setAvailableVariables([]);
  });
});

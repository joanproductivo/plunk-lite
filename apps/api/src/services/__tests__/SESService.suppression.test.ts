import {beforeEach, describe, expect, it, vi} from 'vitest';

import {removeFromAccountSuppressionList} from '../SESService';

const deleteSuppressedDestination = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2: class {
    public deleteSuppressedDestination = deleteSuppressedDestination;
  },
}));

const named = (name: string) => Object.assign(new Error(`${name} message`), {name});

describe('removeFromAccountSuppressionList', () => {
  beforeEach(() => {
    deleteSuppressedDestination.mockReset();
  });

  it('removes the address', async () => {
    deleteSuppressedDestination.mockResolvedValue({});

    expect(await removeFromAccountSuppressionList('ana@example.com')).toBe('removed');
    expect(deleteSuppressedDestination).toHaveBeenCalledWith(
      {EmailAddress: 'ana@example.com'},
      {abortSignal: expect.any(AbortSignal)},
    );
  });

  it.each([
    ['NotFoundException', 'not_listed'],
    ['BadRequestException', 'not_listed'],
    ['AccessDenied', 'not_allowed'],
    ['AccessDeniedException', 'not_allowed'],
    ['TooManyRequestsException', 'unavailable'],
    ['TimeoutError', 'unavailable'],
    ['AbortError', 'unavailable'],
    ['CredentialsProviderError', 'unavailable'],
  ])('reads %s as %s', async (name, outcome) => {
    deleteSuppressedDestination.mockRejectedValue(named(name));

    expect(await removeFromAccountSuppressionList('ana@example.com')).toBe(outcome);
  });

  it('reads a 403 that names nothing more precise as not allowed', async () => {
    deleteSuppressedDestination.mockRejectedValue(
      Object.assign(new Error('forbidden'), {$metadata: {httpStatusCode: 403}}),
    );

    expect(await removeFromAccountSuppressionList('ana@example.com')).toBe('not_allowed');
  });
});

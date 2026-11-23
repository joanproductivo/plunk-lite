import {Button, IconSpinner} from '@plunk/ui';
import {Check} from 'lucide-react';
import {useRouter} from 'next/router';
import React, {useState} from 'react';

import {
  CardIntro,
  ErrorCard,
  InlineError,
  LoadingCard,
  NoticeState,
  RecipientShell,
  ResultState,
  RichText,
  useRecipient,
} from '../../components/list-management/ListManagement';
import {network} from '../../lib/network';

/**
 * Plunk Lite: the page an opt-out link opens, `/opt-out/<contactId>?t=<templateId>`: stop getting
 * the notices of that template's opt-out topic. Other transactional emails still arrive.
 *
 * Loading the page does nothing; the contact opts out by pressing the button. Mail scanners open
 * every link in an email, and would otherwise opt out people who never asked.
 */
export default function OptOutPage() {
  const router = useRouter();
  const {id} = router.query;
  const {state} = useRecipient(id);

  const [optingOut, setOptingOut] = useState(false);
  const [result, setResult] = useState<'opted-out' | 'unavailable' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The query is empty on the first render of a static page: wait for it before reading `t`
  if (!router.isReady || state.status === 'loading') {
    return (
      <RecipientShell loading>
        <LoadingCard />
      </RecipientShell>
    );
  }

  if (state.status === 'error') {
    return (
      <RecipientShell>
        <ErrorCard translator={state.translator} message={state.message} />
      </RecipientShell>
    );
  }

  const {contact, translator} = state;
  const templateId = typeof router.query.t === 'string' ? router.query.t : '';
  const values = {projectName: contact.projectName, email: contact.email};

  if (result === 'opted-out') {
    return (
      <RecipientShell>
        <ResultState icon={Check} title={translator.t('pages.optOut.successTitle')}>
          <RichText template={translator.t('pages.optOut.successDescription')} values={values} />
        </ResultState>
      </RecipientShell>
    );
  }

  if (result === 'unavailable' || !templateId) {
    return (
      <RecipientShell>
        <NoticeState title={translator.t('pages.optOut.unavailableTitle')}>
          {translator.t('pages.optOut.unavailableDescription')}
        </NoticeState>
      </RecipientShell>
    );
  }

  const handleOptOut = async () => {
    try {
      setOptingOut(true);
      setActionError(null);
      const {status} = await network.fetch<{status: 'opted-out' | 'unavailable'}>(
        'POST',
        `/opt-out/${encodeURIComponent(contact.id)}?t=${encodeURIComponent(templateId)}`,
      );
      setResult(status);
    } catch {
      // Translated copy rather than the server's English message; see useRecipient
      setActionError(translator.t('pages.common.actionFailed'));
    } finally {
      setOptingOut(false);
    }
  };

  return (
    <RecipientShell>
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <CardIntro title={translator.t('pages.optOut.title', {projectName: contact.projectName})}>
          <RichText template={translator.t('pages.optOut.description')} values={values} />
        </CardIntro>

        <InlineError message={actionError} />

        <Button
          size="lg"
          className="w-full"
          disabled={optingOut}
          aria-busy={optingOut || undefined}
          onClick={() => void handleOptOut()}
        >
          {optingOut ? (
            <>
              <IconSpinner size="sm" />
              {translator.t('pages.optOut.buttonLoading')}
            </>
          ) : (
            translator.t('pages.optOut.button')
          )}
        </Button>
      </div>
    </RecipientShell>
  );
}

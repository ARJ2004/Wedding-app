import { getIntl, type MessageId } from '@mehfil/i18n';
import { useCallback } from 'react';

/** App strings come from packages/i18n (English now; Hindi/Kannada in L10N). */
export function useT() {
  const intl = getIntl('en');
  return useCallback(
    (id: MessageId, values?: Record<string, string | number | Date>) => intl.formatMessage({ id }, values),
    [intl],
  );
}

/** Formats an instant in the wedding's timezone, e.g. "Fri 12 Feb, 7:30 pm". */
export function formatInZone(iso: string, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-IN', { timeZone, ...opts }).format(new Date(iso));
}

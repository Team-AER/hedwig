import 'dotenv/config';
import * as Sentry from '@sentry/node';

if (process.env.GLITCHTIP_DSN || process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.GLITCHTIP_DSN || process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    release: process.env.SENTRY_RELEASE || 'hedwig@3.5.2',
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      for (const value of event.exception?.values || []) value.value = value.type || 'Error';
      return event;
    },
  });
}

export function reportError(error) {
  if (process.env.GLITCHTIP_DSN || process.env.SENTRY_DSN) return Sentry.captureException(error);
}

# Error monitoring

## Browser errors

Build with `VITE_GLITCHTIP_DSN`, `VITE_SENTRY_ENVIRONMENT`, and `VITE_SENTRY_RELEASE`. Empty DSNs disable reporting. The official browser SDK captures unhandled errors and React render failures; tracing, sessions, replay, request context, user identity, breadcrumbs, and extras are disabled. Exception messages are reduced to their type. Use the browser network panel and the event ID in GlitchTip to verify the deployed build.

Use `VITE_GLITCHTIP_TUNNEL` for Vite builds, or `GLITCHTIP_TUNNEL` for static site builds, to route browser events through a configured same-origin ingest proxy. This also lets a strict `connect-src self` policy stay in place. Restrict the proxy to the configured project and GlitchTip upstream; strip cookies and authorization headers, and bound request size. The proxy must supply the project public ingest key to GlitchTip when the installed server requires it.

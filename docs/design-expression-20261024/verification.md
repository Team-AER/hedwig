# Mail source continuity

EX-H1: a thread keeps its sender, subject and excerpt when opened in Ask. The source sheet travels into the Ask layout; citations connect to the actual reader destination, including phone navigation. Requests and usable answers start before cosmetic movement. Thread/user scoping, keyboard focus, dock/float and failure paths remain intact.

Validation: 3209 existing frontend tests and 3 focused source/motion tests passed; lint and production build passed. Applied 1440/390/320 checks covered the real thread excerpt, request-before-motion ordering, citation→reader connection, dock movement, initial/live reduced motion, restoration and future actions, animation API failure and navigation cleanup. Safe built-in mail fixtures and controlled Ask responses were used; no real email was sent or modified. Local visual evidence and receipts stay outside Git at `/Volumes/Store/Developer/AER/output/design-expression-implementation-20261024/workspace-apps/`.

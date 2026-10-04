# Contributing to Hedwig

Thanks for helping improve Hedwig. Open issues and pull requests in [Team-AER/hedwig](https://github.com/Team-AER/hedwig), rather than sending fork-specific changes to MailFlow.

## Before starting

Search existing issues. For a substantial feature, refactor, or new dependency, open an issue describing the problem and proposed approach before investing in implementation. Keep fixes focused and preserve mail reliability, ownership checks, and recoverable actions.

Hedwig builds on MailFlow. Preserve upstream copyright and license notices; read the retained [Contributor License Agreement](CLA.md) and the repository’s PR template when contributing. This guide does not replace those documents.

## Development

Follow [Setup](docs/hedwig/SETUP.md#local-development) for Node.js 22, PostgreSQL with pgvector, Redis, and the two frontend/backend processes. See [Architecture](docs/hedwig/ARCHITECTURE.md) for the separate worker and module contracts, and [Plugins](docs/hedwig/PLUGINS.md) for extension development.

Match surrounding React/Express style and existing CSS tokens. Add settings through the Hedwig configuration schema rather than hard-coding endpoints, models, or schedules. Avoid model calls in mail synchronization paths, and preserve user confirmation for mutating agent tools.

## Checks

Run the checks appropriate to your change from each package directory:

```bash
# backend/
npm test
npm run lint
npm run lint:plugins

# frontend/
npm test
npm run lint
npm run build
```

Database integration tests need the separate development database and environment described in [Setup](docs/hedwig/SETUP.md#local-development): `npm run test:hedwig-it` in `backend/`. Keep tests independent of live mailbox accounts and model gateways. Documentation changes should verify links, source paths, setup commands, diagram syntax, and the distinction between implemented and planned behavior.

## Pull requests

1. Create a branch from the current `main` in your fork.
2. Keep the scope focused and use a descriptive commit, such as `fix: correct sender sorting` or `docs: explain worker setup`.
3. Open a PR against **Team-AER/hedwig:main**, completing the repository template.
4. Describe the problem, resulting behavior, checks run, and any checks you could not run.
5. Wait for maintainer review and required CI checks before merging.

For bugs, include reproduction steps, expected/actual behavior, and relevant versions. Remove credentials, message contents, and other private information from logs or screenshots. For feature requests, describe the user problem and how the proposal fits the mail, context, or plugin workflows.

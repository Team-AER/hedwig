// Hello Hedwig — the smallest useful external (tier 2) plugin. Everything it does goes through the
// `hedwig` facade passed to activate(); it imports nothing (the install-time boundary check would
// refuse node built-ins such as fs, net or child_process, packages, and globals such as process or
// fetch).
import { greet } from './greet.js';

export default function activate(hedwig) {
  const router = hedwig.router();

  router.get('/hello', async (req) => {
    const { greeting } = await hedwig.settings.get(req.userId);
    const count = (await hedwig.storage.get(req.userId, 'indexed')) || 0;
    return { message: greet(greeting, count), count };
  });

  return {
    hooks: {
      // Fires in the worker for every new message. ctx: { userId, messageId, accountId }.
      onMessageIndexed: async (ctx) => {
        const count = (await hedwig.storage.get(ctx.userId, 'indexed')) || 0;
        await hedwig.storage.set(ctx.userId, 'indexed', count + 1);
      },
    },
    router,
    tools: [{
      name: 'say_hello',
      description: 'Greets the user and says how many messages Hedwig has indexed since Hello Hedwig was enabled.',
      permission: 'storage',
      parameters: { type: 'object', properties: {} },
      handler: async (_args, { userId }) => {
        const { greeting } = await hedwig.settings.get(userId);
        return { message: greet(greeting, (await hedwig.storage.get(userId, 'indexed')) || 0) };
      },
    }],
  };
}

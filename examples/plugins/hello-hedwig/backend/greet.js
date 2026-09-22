export function greet(greeting, count) {
  const word = count === 1 ? 'message' : 'messages';
  return `${greeting || 'Hello'}! Hedwig has indexed ${count} ${word} since you enabled this plugin.`;
}

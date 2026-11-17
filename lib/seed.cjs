const rows = [
  ['openai', 'OpenAI GPT', 'subscription', 'O', '#a5b8aa', true],
  ['claude', 'Anthropic Claude', 'subscription', 'C', '#d8a081', true],
  ['grok', 'xAI Grok', 'subscription', 'X', '#bcbcc9', false],
  ['antigravity', 'Antigravity', 'subscription', 'A', '#9bbff5', true],
  ['zai', 'Z.ai', 'subscription', 'Z', '#9cafeb', true],
  ['ollama', 'Ollama', 'subscription', 'O', '#c9c3b9', true],
  ['openrouter', 'OpenRouter', 'api', '↗', '#9caaf7', true],
  ['deepseek', 'DeepSeek Platform', 'api', 'D', '#8aaaff', true],
  ['runinfra', 'RunInfra', 'api', 'R', '#efa793', false],
];

function createSeed() {
  return {
    version: 1,
    providers: rows.map(([id, name, type, monogram, color, favorite]) => ({
      id, name, type, amount: null, renewalDate: null, monogram, color, favorite,
      currency: 'USD', billingCycle: 'unknown', plan: id === 'claude' ? 'Claude Pro' : '', active: true,
      ...(type === 'subscription' ? { subscriptionStatus: 'active' } : {}),
      snapshot: null, error: null, lastAttempt: null,
    })),
    settings: { autoRefresh: true, notifications: false, lowBalance: 5, theme: 'system' },
    apiCooldowns: {},
    connectorHealth: {},
    history: [],
  };
}
module.exports = { createSeed };

const { accounts } = require('./subscription-accounts.cjs');
const connectors = {
  antigravity: {
    mode: 'account', localAccount: true,
    description: 'Quotas Antigravity : Gemini et Claude/GPT sur cinq heures et la semaine, et Gemini 4 Argon sur la semaine.',
    instructions: 'Garde Antigravity 2.0 ouvert et connecté à ton compte Google. Clique sur Connecter Antigravity pour lire ses quotas locaux. Aucune CLI à installer.',
    scope: 'Antigravity · Gemini, Claude/GPT et Argon · quotas distincts',
  },
  ...Object.fromEntries(Object.entries(accounts).filter(([id]) => id !== 'gemini').map(([id, config]) => [id, {
    mode: 'account', browserAccount: id !== 'openai' && id !== 'claude', codexAccount: id === 'openai', localAccount: id === 'claude',
    description: id === 'openai' ? 'Limites réelles et dates de remise à zéro, lues par l’interface officielle de Codex.' : id === 'claude' ? 'Quotas de ton abonnement Claude (Horaire, Hebdo, Hebdo Fable), lus via la connexion officielle de Claude Code.' : 'Connexion au compte et lecture des pourcentages de quota affichés dans les réglages d’utilisation.',
    instructions: id === 'openai' ? config.hint : id === 'claude' ? 'Clique sur Connecter Claude : la connexion officielle de Claude Code s’ouvre dans ton navigateur, connecte-toi avec ton compte Claude (abonnement Pro ou Max). Lasmium TOKENS-HUB lit ensuite tes quotas toutes les 5 minutes, toujours sur ton abonnement, et renouvelle la connexion seul. Les valeurs affichées sont les pourcentages restants.' : `Connecte-toi sur le site officiel dans Chrome ou Edge. ${config.hint} La détection est automatique lorsque les quotas sont lisibles.`,
    scope: config.scope,
  }])),
  ollama: {
    mode: 'account',
    description: 'Crédits mensuels inclus et réserve supplémentaire en dollars, suivis séparément.',
    instructions: 'Connecte-toi sur le site officiel Ollama dans la fenêtre Chrome ou Edge qui s’ouvre, puis ferme cette fenêtre pour lancer la vérification. Lasmium TOKENS-HUB lit les crédits mensuels et, si affiché, le solde de crédits supplémentaires, sans utiliser de clé API.',
    scope: 'Abonnement en crédits · connexion au compte · USD',
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/credits',
    keyLabel: 'Clé de gestion OpenRouter',
    description: 'Crédits achetés, consommés et restants sur le compte.',
    instructions: 'Utilise une clé de gestion OpenRouter (Management key). Une clé d’inférence ordinaire ne donne pas accès au solde global.',
    scope: 'Solde du compte · USD',
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/user/balance',
    keyLabel: 'Clé API DeepSeek',
    description: 'Solde disponible du compte, dans sa devise d’origine.',
    instructions: 'Utilise une clé API de DeepSeek Platform pour lire le solde de ton compte.',
    scope: 'Solde du compte · USD / CNY',
  },
  runinfra: {
    endpoint: 'https://api.runinfra.ai/v1/credits',
    keyLabel: 'Clé API d’espace de travail RunInfra',
    description: 'Solde de l’espace de travail, crédits réservés et dépenses de la période.',
    instructions: 'Utilise une clé API d’espace de travail RunInfra créée dans Settings, sans restriction à un déploiement ou à un endpoint. Une clé limitée à un déploiement ne peut pas consulter les crédits.',
    scope: 'Solde de l’espace de travail · USD',
  },
  orcarouter: {
    mode: 'account',
    endpoint: 'https://api.orcarouter.ai/v1/dashboard/billing/subscription',
    keyLabel: 'Clé API OrcaRouter',
    description: 'Solde réel du portefeuille, lu avec ta session OrcaRouter.',
    instructions: 'Le site officiel s’ouvre dans Chrome ou Edge : connecte-toi (GitHub, Google, Microsoft ou e-mail), sélectionne ton espace de travail, puis ferme la fenêtre. Lasmium TOKENS-HUB récupère alors automatiquement le portefeuille. La clé API seule ne donne pas accès au portefeuille.',
    scope: 'Portefeuille · connexion au compte · USD',
  },
};

function connectionInfo(id) {
  if (!Object.hasOwn(connectors, id)) return null;
  const descriptor = connectors[id];
  if (!descriptor) return null;
  const { endpoint, ...info } = descriptor;
  return info;
}
module.exports = { connectors, connectionInfo };

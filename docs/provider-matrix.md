# Matrice des fournisseurs et des stratégies

Chaque fournisseur déclare **une chaîne de stratégies** explicite. Une stratégie
non implémentée n'est jamais inventée : le repli affiché est celui qui existe
réellement dans le code. La santé persistée enregistre la stratégie utilisée
lors de la dernière tentative.

| Fournisseur | Mode | Chaîne de stratégies | Santé / erreurs typiques | Pack signé |
| --- | --- | --- | --- | --- |
| Claude | Abonnement | `claude-direct` (Claude Code, abonnement) | auth, rate, drift, down | — |
| OpenAI / Codex | Abonnement | `openai-codex` | auth, rate, drift, down | — |
| Antigravity | Abonnement | `antigravity-local` | auth, down, drift | — |
| Grok / SuperGrok | Abonnement navigateur | `browser-session` | auth, rate, drift, down | — |
| Z.ai / GLM | Abonnement navigateur | `browser-session` | auth, rate, drift, down | — |
| Ollama | Compte navigateur | `ollama-browser` | auth, down, drift | — |
| OpenRouter | Clé API | `api-key` | auth, rate, réseau, drift | oui |
| DeepSeek | Clé API | `api-key` | auth, rate, réseau, drift | oui |
| RightNow (ex-RunInfra) | Clé API | `api-key` | auth, rate, réseau, drift | oui |

## Codes d'erreur

| Code | État santé | Sens | Nouvelle tentative automatique |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` | `auth` | Reconnexion nécessaire | Immédiate après reconnexion (pas de disjoncteur) |
| `AUTH_RATE_LIMITED` / `RATE_LIMITED` | `rate` | Limite fournisseur | 1 min → 30 min (ou `Retry-After`) |
| `NETWORK` / `TIMEOUT` / `UPSTREAM` | `down` | Panne réseau ou service | 30 s → 30 min |
| `SCHEMA_DRIFT` / `PARSER_EMPTY` | `drift` | Réponse incohérente ; dernier relevé conservé | 15 min |
| `CONFLICT` | `error` | Conflit de compte/session | 15 min |
| `UNKNOWN` | `error` | Erreur non classée | 5 min |
| `NOT_CONFIGURED` | `idle` | Rien à lire | — |

Une action manuelle (**Tester**, **Synchroniser**, menu du tray) force une
tentative ; l'actualisation automatique respecte le disjoncteur. Un succès
remet le compteur d'échecs à zéro.

## Packs de connecteurs

Les packs signés couvrent aujourd'hui les **endpoints API** et les métadonnées
de parseur des fournisseurs à clé. Les lecteurs DOM (abonnements navigateur)
restent dans l'application : un changement de sélecteur nécessite encore une
version de l'application. Voir le [runbook](runbook-connectors.md).

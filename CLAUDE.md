# bb-polza — плагин bb «Polza» (провайдер polza.ai)

Публичный плагин для [bb](https://getbb.app), который добавляет провайдер агентов **Polza**:
вход в polza.ai через OAuth PKCE, белый список моделей каталога Пользы в селекторе моделей bb,
баланс и лимит ключа в футере сайдбара и настройках, оценка расхода в рублях по треду.
Движок агента — Claude Code CLI через `@anthropic-ai/claude-agent-sdk`, направленный на
Anthropic-совместимый `/v1/messages` Пользы. Пакет: `bb-plugin-polza`, id плагина `polza`.

Дизайн и принятые решения: `docs/DESIGN.md`. Бридж в `src/` — форк встроенного провайдера
`provider-claude-code` из репозитория bb (MIT, `LICENSE.bb-upstream`); наши правки помечены
комментариями `// polza:`. Исходник апстрима для сравнения: `git clone --depth 1 https://github.com/get-bb/bb`
→ `plugins/provider-claude-code`.

## Стек и команды
- TypeScript, ESM, zod 4, React 19 (frontend шимится bb), vitest.
- `npm install` → сборка → `bb plugin install . --yes`. `bb plugin build` из обёртки `~/.bb/npm` падает
  («Cannot find module 'npm/package.json'»): собирать бинарём приложения без переопределения `BB_CLI`:
  `env -u BB_CLI /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb plugin build .`
- `bb plugin dev` — пересборка и reload при изменениях; `bb plugin logs polza` — лог сервера плагина.
- `npx vitest run` — тесты.
- API Пользы: база `https://polza.ai/api`; `/v1/models` без ключа, `/v2/balance`, `/v1/key`,
  `/api/auth/authorize|token|userinfo` (PKCE, без client_id; результат — бессрочный ключ `pza_`).

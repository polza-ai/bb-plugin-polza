# Дизайн плагина Polza для bb

Решения приняты 2026-11-09 (Илья): свой провайдер, публичный плагин, OAuth-коллбэк на
localhost сервера bb плюс ручная вставка кода, бэкенд Пользы не меняем, движок — Claude Code
через Agent SDK, плагин сам ставит/обновляет Claude CLI, белый список моделей в настройках со
стартовым набором, баланс в футере сайдбара и настройках (баланс организации и лимит ключа
отдельно), расход в рублях по треду, цены моделей в описании пикера.

## Слои
1. **server.ts** (процесс сервера bb)
   - `bb.settings.define`: `apiKey` (secret), `baseUrl` (default `https://polza.ai/api`),
     `models` (multiline JSON — белый список слагов), `defaultModel`, `subagentModel`, `haikuModel`.
   - OAuth PKCE: RPC `login.start` → authorize URL; `bb.http.route GET /oauth/callback` (auth
     `none`, защищён `state`) принимает `code`, меняет на ключ в `/api/auth/token`, сохраняет
     через `settings.experimental_set({apiKey})`, отдаёт HTML «готово». RPC `login.complete`
     принимает вставленный `code` или полный URL (запасной путь для удалённого сервера).
     `callback_url` = `${bb.server.loopbackBaseUrl}/api/v1/plugins/polza/http/oauth/callback`.
   - RPC `account.get`: `/api/auth/userinfo`, `/v2/balance`, `/v1/key` (кэш 20 с); `account.logout`.
   - RPC `catalog.list`: `/v1/models?type=chat` (кэш 5 мин) для редактора белого списка.
   - `bb.providers.register({id:"polza", …})`: `maintenance {health, installation}`, `usage:false`,
     `models:{scope:"host"}`, `extensionKinds: { cost: {state} }`,
     `deriveProviderOptions` → `{polzaApiKey, polzaBaseUrl, polzaModels, …}` (ключ кэшируется в
     памяти сервера из секрета; попадает в бридж только внутри providerOptions, не в env-события).
   - `bb.providers.experimental_contributeEnv("polza")`: `POLZA_BASE_URL`, `POLZA_MODELS`
     (JSON белого списка), `POLZA_SIGNED_IN` — несекретное; нужны `model/list` и `provider/health`,
     которые не получают providerOptions. Смена белого списка меняет fingerprint → кэш списка
     моделей сбрасывается.
2. **src/host.ts → src/bridge** (host daemon). Форк бриджа Claude Code с правками:
   - `model/list`: каталог Пользи (`GET {base}/v1/models?type=chat`, публичный) ∩ белый список из
     `envVars.POLZA_MODELS`; описание = `short_description · ₽in/₽out за Mtok`; reasoning efforts
     из `reasoning.supported_efforts` (иначе `low/medium/high`); `isDefault` — первый из списка.
   - Сессия: в env Claude CLI добавляем `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
     `ANTHROPIC_API_KEY=""`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`,
     `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, `ENABLE_TOOL_SEARCH`.
     Фичи, требующие логина claude.ai (Chrome, Artifacts, usage-пробы), отключены.
   - `provider/health`: `not_installed` без CLI; `unauthenticated` без `POLZA_SIGNED_IN`; иначе `ready`.
   - `provider/installation/*`: без изменений (установка/обновление Claude CLI).
   - Расход: на каждом usage-дельте считаем ₽ = токены × цены модели из каталога
     (prompt/completion/cache read/cache write per million) и публикуем `extension.state`
     `polza/cost` `{rub, tokens, model, approximate:true}`. Это оценка, не биллинг.
3. **app.tsx** (frontend)
   - `settingsSection`: вход/выход, аккаунт, баланс и лимит ключа, редактор белого списка с
     поиском по каталогу и ценами.
   - `experimental_sidebarFooter.register({kind:"disclosure"})`: баланс `available` и остаток
     лимита ключа, кнопка «Пополнить» (dashboard polza.ai).
   - Composer banner `chrome:"bare"` с `experimental_CollapsibleStackCard`: расход треда в ₽ из
     `experimental_useThreadExtensionState(threadId, "cost")`.

## Ограничения
- Ключ Пользи бессрочный, refresh нет: при 401 бридж шлёт `provider/recovery authRequired`,
  UI предлагает войти заново (повторный вход ротирует ключ).
- Лимит на экране согласия по умолчанию 100 ₽/день — показываем в настройках `limit_remaining`.
- Коллбэк на localhost работает, когда браузер и сервер bb на одной машине; иначе — вставка кода.

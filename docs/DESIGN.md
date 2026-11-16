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
   - AI-сервис `polza` (`bb.experimental_aiServices`): заголовки тредов и commit-сообщения через
     `/v1/chat/completions` дешёвой моделью из настроек (`aiServiceModel`, по умолчанию Haiku); выключатель `aiServiceEnabled`.
   - AI-сервис `polza-voice`: голосовой ввод (`transcribe`) через `POST /v1/audio/transcriptions`, JSON с
     `file` = data-URL base64, модель из `voiceModel` (по умолчанию `ai-sage/gigaam-v3`), выключатель `voiceEnabled`.
     Отдельный id, чтобы выключатели заголовков и голоса не зависели друг от друга. Ответ синхронный; на
     `status: "processing"` (асинхронные модели `aiesa/*`) опрашиваем `GET …/transcriptions/{id}` до отмены
     сигналом bb (10 с). `hint` идёт в `prompt`, язык не задаём. Второй шаг (`voiceCleanupEnabled`):
     модель заголовков правит термины, записанные на слух; бюджет — остаток от 8,5 с, при ошибке,
     таймауте или неправдоподобном ответе (длина вне 0,5–1,6× исходной) возвращается сырой текст.
   - Инструменты агента (`bb.agents.registerTool`, для тредов любого провайдера) и команды `bb polza`:
     `polza_generate_image` (`POST /v2/images/generations`, при `id`/`requestId` без `data` — опрос
     `GET /v1/media/{id}`; легаси `/v1/images/generations` отдаёт голый `requestId`),
     `polza_transcribe_recording` (`ai-sage/gigaam-v3-diarize`, `response_format: diarized_json`, при 400
     повтор без формата; файл >10 МБ сначала уходит в `/v1/storage/upload`), `polza_docs`
     (`GET /v1/docs/export`, публичный, кэш 6 ч, поиск по словам). Пути резолвятся в окружении треда
     (`sdk.threads.get` → `sdk.environments.get`), файлы читаются и пишутся через `sdk.files` на его хосте.
   - Сторож баланса: `bb.background.schedule` раз в 10 минут; уведомление через RPC
     `notifications.send` плагина push-notifications, один раз на каждое падение ниже `balanceAlertRub`
     (кошелёк `amount`, не `available` — тот обрезан лимитом ключа) или ниже 10% лимита ключа;
     активные алерты хранятся в `bb.storage.kv`. Менять лимит ключа из bb нельзя: `PATCH /v1/api-keys`
     принимает только JWT кабинета.
   - Снятые модели: `GET /v1/models/replacements` (публичный, кэш 1 ч) ∩ белый список → `status.retired`;
     RPC `models.replaceRetired` подставляет преемников.
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
     Точная сумма: id сообщения ассистента — `msg_<id генерации>`; после каждого хода бридж
     запрашивает `GET /v1/history/generations/{id}` (ключ из env сессии) с задержками 1,5/6/20 с
     и добавляет в состояние `billed {rub, requests, pending}`; `clientCost` берётся только после
     `finalizedAt`. Фоновые запросы Claude Code (без сообщения в ленте) в эту сумму не попадают.
3. **app.tsx** (frontend)
   - `settingsSection`: вход/выход, аккаунт, баланс и лимит ключа, редактор белого списка с
     поиском по каталогу и ценами.
   - `experimental_sidebarFooter.register({kind:"disclosure"})`: баланс `available` и остаток
     лимита ключа, кнопка «Пополнить» (dashboard polza.ai).
   - Сегмент строки контекста над композером (`experimental_threadContextSegment`): расход треда в ₽ и доля кэша из
     `experimental_useThreadExtensionState(threadId, "cost")`.

## Ограничения
- Ключ Пользи бессрочный, refresh нет: при 401 бридж шлёт `provider/recovery authRequired`,
  UI предлагает войти заново (повторный вход ротирует ключ).
- Лимит на экране согласия по умолчанию 100 ₽/день — показываем в настройках `limit_remaining`.
- Коллбэк на localhost работает, когда браузер и сервер bb на одной машине; иначе — вставка кода.

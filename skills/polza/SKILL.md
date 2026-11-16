---
name: polza
description: Polza provider for bb — check the Polza sign-in, balance, key limit and the models offered in the picker; change the picker models. Use when a thread runs on the Polza provider or the user asks about Polza balance, models or sign-in.
---

# Polza provider

`bb polza status [--json]` prints the sign-in state, the organisation balance
(`available` is what a request may spend), the key's spend limit and the
models offered in bb's model picker. Signing in and topping up happen in the
bb UI (Settings → Plugins → Polza) and on https://polza.ai/dashboard; do not
ask the user for the key.

`bb polza models [--json]` lists the picker models in order; the first is the
default. `bb polza models set <slug>…` replaces that list with catalog slugs
such as `anthropic/claude-sonnet-5.5` or `openai/gpt-5.4`. The full catalog is
public: `curl -s https://polza.ai/api/v1/models?type=chat`.

Costs: every Polza thread shows its ruble spend above the composer. Right after
a turn it is an estimate from token counts and catalog prices (marked `≈`); a
few seconds later it becomes the amount Polza billed for the thread's requests.
`bb polza spend [--json]` prints what the key was billed today, this week and
this month; `bb polza spend <generation-id>` prints one request. A 402 means
the balance or the key's spend limit is exhausted. The plugin notifies once
when the balance drops under the `Low balance alert` setting (100 ₽ by
default, 0 turns it off) or under a tenth of the key limit is left.

`bb polza status` also lists picker models Polza has retired and their
successors; the settings page swaps them in one click.

Agent tools, available in threads of any provider once signed in:
- `polza_generate_image` saves a generated image into the workspace
  (`bb polza image <prompt> --out <path> [--size 1024x1024] [--model <slug>]`).
  An image costs a few rubles and takes 10–30 seconds.
- `polza_transcribe_recording` transcribes a call, meeting or voice memo of
  any length (mp3, wav, m4a, flac, ogg, webm up to 50 MB), split by speaker
  (`bb polza transcribe <file> [--no-speakers] [--out <text-file>] [--model <slug>] [--json]`).
- `polza_docs` searches and reads the current Polza API documentation
  (`bb polza docs <query>`, `bb polza docs --page <path> [--offset <n>]`).
  Use it instead of guessing when writing code against the Polza API.

Voice input: the plugin registers the AI service `polza-voice`, which
transcribes dictation through Polza's `/v1/audio/transcriptions` with
`ai-sage/gigaam-v3` (Russian speech) by default. Select it with
`bb settings ai-services set voice polza-voice` or leave Automatic; the
model and the on/off switch are on the Polza settings page (`Voice input`).
bb waits 10 seconds for a transcript. With `Correct code terms` on, a chat
model then fixes terms spelled by ear ("сервер тэ эс" → server.ts); when it
fails or would be late the recognized text is used as it is.

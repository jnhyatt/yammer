# yammer-client

The thin half of Yammer. Runs wake-word detection locally, captures microphone
audio, streams utterances to the server, plays back synthesized speech, and
produces the earcons that are the system's only status channel.

No STT, no TTS, no LLM calls happen here — that's deliberate, so a future client
(mobile, say) only has to reimplement audio capture, wake-word detection, and
earcons.

## Requirements

- **Python 3.11.** Not newer: `openwakeword` declares an unconditional
  `tflite-runtime` dependency on Linux and that package publishes no wheels past
  cp311. We run ONNX inference regardless, but the dependency still resolves.
- PortAudio (for `sounddevice`) — `libportaudio2` on Debian/Ubuntu,
  `portaudio` on Arch.
- **Headphones.** v1 does no acoustic echo cancellation and does not gate the
  microphone during playback. Through a speaker, synthesized speech will be
  picked up by the mic and can trigger the client's own wake words.

## Install

```sh
uv venv --python 3.11
uv pip install -e .
```

On first run, openWakeWord downloads its shared feature-extractor models and the
bundled wake words. To do that ahead of time:

```sh
.venv/bin/python -c "import openwakeword.utils as u; u.download_models()"
```

## Run

```sh
cp .env.example .env     # fill in YAMMER_TOKEN — must match the server
.venv/bin/yammer-client
```

Say the start wake word (default **"hey jarvis"**), speak, then say the stop
wake word (default **"alexa"**). The bundled models are v1 placeholders; custom
`hey yammer` / `yammer stop` models are a drop-in ONNX swap via
`YAMMER_WAKE_START_MODEL` / `YAMMER_WAKE_STOP_MODEL`.

## Earcons

| Sound | Meaning |
|---|---|
| Two rising tones | Listening — buffering your utterance |
| Two falling tones | Got it, sent to the server |
| Low double blip | Busy: a turn is still in flight, buffer discarded |
| Descending buzz | Something failed; a spoken explanation follows |
| Three rising notes | A command needs your approval — answer it |

## Answering a permission prompt

When the agent tries something destructive, a **second voice** interrupts and
asks. Answer with one word: **approve** (just this once), **always** (allow the
whole pattern from now on — it says which), or **deny**.

Two things differ from an ordinary utterance:

- **No wake words.** The window opens by itself and closes when you stop
  talking. "Hey jarvis approve alexa" is not the interaction, and the stop-word
  trim would eat a one-word answer anyway.
- **You can talk over it.** Start answering and the question stops playing. This
  is the only speech in Yammer you can interrupt; agent replies play out.

Say anything it doesn't recognize and it asks again. Say nothing at all and it
denies the command and stops the agent, on the assumption you walked away — the
session is untouched, so ask "what were you in the middle of?" when you return.

## Fixture generators

`tools/` holds two scripts that are **not part of the client** — they live here
only because they need this venv, and they write to the repo-root `fixtures/`
directory that other implementations are checked against.

```sh
.venv/bin/python tools/dump_protocol_frames.py    # after any protocol change
.venv/bin/python tools/make_golden_vectors.py     # after any wake-pipeline change
```

Both are deterministic: regenerating should produce no diff. A diff means
something changed, which is the point — see [`fixtures/README.md`](../fixtures/README.md).

## Configuration

Everything is an environment variable. A `.env` file populates the environment
at startup, so in practice the variables live there rather than in your shell.

Search order — **the first file found is used, and files are never merged**, so
a variable's meaning never depends on which of two files it appears in:

1. `$YAMMER_ENV_FILE`, if set (a missing file here is a hard error — you named it)
2. `client/.env`
3. the repository root `.env`
4. `.env` in the working directory

**Anything already set in the real environment wins over the file**, so
`YAMMER_LOG_LEVEL=DEBUG .venv/bin/yammer-client` does what you'd expect. The
file that was loaded is logged at startup; if a token doesn't seem to be taking
effect, that line tells you where to look.

Format is `KEY=value`, one per line: `#` starts a comment, a leading `export` is
ignored, and values may be wrapped in `"`, `'`, or backticks if they contain a
`#` or need leading/trailing spaces. It matches Node's built-in `.env` parser
exactly, so one file means the same thing to both halves of the system.

| Variable | Default | Notes |
|---|---|---|
| `YAMMER_TOKEN` | *(required)* | Shared secret; must match the server |
| `YAMMER_ENV_FILE` | *(search order above)* | Explicit `.env` path |
| `YAMMER_SERVER_URL` | `ws://127.0.0.1:8765` | |
| `YAMMER_WAKE_START_MODEL` | `hey_jarvis` | Bundled name or path to a `.onnx` |
| `YAMMER_WAKE_STOP_MODEL` | `alexa` | Bundled name or path to a `.onnx` |
| `YAMMER_WAKE_START_THRESHOLD` | `0.5` | |
| `YAMMER_WAKE_STOP_THRESHOLD` | `0.5` | |
| `YAMMER_WAKE_STOP_TRIM_SECONDS` | `1.0` | Audio dropped from the tail so the stop word doesn't reach OpenCode |
| `YAMMER_WAKE_REFRACTORY_SECONDS` | `1.5` | Suppresses repeat fires of one spoken wake word |
| `YAMMER_VAD_THRESHOLD` | `0.5` | Speech probability that counts as voiced, in the answer window only |
| `YAMMER_VAD_ONSET_BLOCKS` | `2` | Consecutive voiced 80 ms blocks needed to start capturing |
| `YAMMER_VAD_SILENCE_SECONDS` | `0.8` | Trailing silence that ends an answer |
| `YAMMER_VAD_PREROLL_SECONDS` | `0.4` | Audio kept from *before* onset — without it a one-word answer loses its first syllable |
| `YAMMER_VAD_ANSWER_SECONDS` | `10` | No speech at all for this long reports "no answer" (the server's own deadline is the backstop) |
| `YAMMER_INPUT_DEVICE` | *(system default)* | Index or name substring |
| `YAMMER_OUTPUT_DEVICE` | *(system default)* | Index or name substring |
| `YAMMER_LOG_LEVEL` | `INFO` | |

List audio devices with:

```sh
.venv/bin/python -c "import sounddevice; print(sounddevice.query_devices())"
```

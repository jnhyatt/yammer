"""`.env` loading.

The client needs the transport token, and exporting it by hand every time is
exactly the friction that leads to it ending up in shell history. A `.env`
beside the package is the ergonomic alternative.

Two rules, both deliberate:

- **The real environment always wins.** A variable already set in the process
  environment is never overwritten by the file, so
  ``YAMMER_LOG_LEVEL=DEBUG yammer-client`` behaves the way you'd expect even
  with a `.env` present.
- **The first file found wins; files are not merged.** Search order is
  ``$YAMMER_ENV_FILE``, then ``client/.env``, then the repository root `.env`,
  then `.env` in the working directory. Layering would mean a variable's value
  depends on which of two files it appears in, which is a bad thing to have to
  reason about at 3am with a baby on your shoulder.

The parser deliberately matches Node's built-in ``process.loadEnvFile``, which
is what the server uses, so one `.env` file means the same thing to both halves.
That means: ``KEY=value`` one per line; a leading ``export`` is ignored; keys
and unquoted values are stripped of surrounding whitespace; values may be
wrapped in ``"``, ``'``, or backticks, and a quoted value may span lines and may
contain ``#``; outside quotes a ``#`` begins a comment; escape sequences are
*not* interpreted; and a line without ``=`` is skipped rather than being an
error. See ``../../.env.example``.
"""

from __future__ import annotations

import os
from pathlib import Path

_QUOTES = "\"'`"

# .../client/src/yammer_client/env.py -> client/ -> repo root
_PACKAGE_ROOT = Path(__file__).resolve().parents[2]
_REPO_ROOT = _PACKAGE_ROOT.parent


class EnvError(Exception):
    """An explicitly requested `.env` file could not be used."""


def load_env_file() -> Path | None:
    """Load a `.env` into ``os.environ``, without clobbering what's there.

    Returns the file that was used, or None if no candidate existed. An explicit
    ``YAMMER_ENV_FILE`` that doesn't exist is an error — you asked for that file
    by name. A missing default `.env` is not; the environment may well be
    populated some other way.
    """
    explicit = os.environ.get("YAMMER_ENV_FILE", "")
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not path.is_file():
            raise EnvError(f"YAMMER_ENV_FILE points at {path}, which does not exist")
        _apply(path)
        return path

    candidates = [
        _PACKAGE_ROOT / ".env",
        _REPO_ROOT / ".env",
        Path.cwd() / ".env",
    ]
    for candidate in candidates:
        if candidate.is_file():
            _apply(candidate)
            return candidate

    return None


def _apply(path: Path) -> None:
    for key, value in parse_env(path.read_text(encoding="utf-8")).items():
        os.environ.setdefault(key, value)


def parse_env(text: str) -> dict[str, str]:
    """Parse `.env` text into a mapping, matching Node's `loadEnvFile`.

    Exposed separately from file handling so the format can be tested directly
    against the server's parser.
    """
    result: dict[str, str] = {}
    i = 0
    n = len(text)

    while i < n:
        char = text[i]

        # Between entries: skip blank space and whole-line comments.
        if char.isspace():
            i += 1
            continue
        if char == "#":
            i = _end_of_line(text, i)
            continue

        eq = text.find("=", i)
        line_end = _end_of_line(text, i)
        if eq == -1 or eq >= line_end:
            # No assignment on this line. Node skips it silently; a hard error
            # here would turn a stray note in the file into a failure to boot.
            i = line_end
            continue

        key = text[i:eq].strip()
        if key.startswith("export ") or key.startswith("export\t"):
            key = key[len("export") :].strip()
        i = eq + 1

        # Leading spaces before the value are padding, not content.
        while i < n and text[i] in " \t":
            i += 1

        if i < n and text[i] in _QUOTES:
            quote = text[i]
            i += 1
            close = text.find(quote, i)
            if close == -1:
                # Unterminated quote: take the rest of the file, as Node does.
                value, i = text[i:], n
            else:
                value, i = text[i:close], close + 1
            i = _end_of_line(text, i)
        else:
            # An unquoted value runs to the end of the line, or to a `#` if one
            # comes first. Either way the next entry starts on the next line —
            # advancing to `stop` instead would re-scan the comment tail.
            after_line = _end_of_line(text, i)
            stop = after_line
            hash_at = text.find("#", i)
            if hash_at != -1 and hash_at < stop:
                stop = hash_at
            value = text[i:stop].strip()
            i = after_line

        if key:
            result[key] = value

    return result


def _end_of_line(text: str, start: int) -> int:
    newline = text.find("\n", start)
    return len(text) if newline == -1 else newline + 1

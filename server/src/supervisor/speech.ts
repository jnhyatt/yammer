/**
 * Turning a permission request into a sentence worth hearing.
 *
 * This is the one place in Yammer where the TTS rules bend. Everywhere else the
 * agent is told never to speak a path, a flag, or a symbol, because they are
 * miserable to listen to. Here they are the entire point: the user is being
 * asked to authorise a specific command, and "the agent wants to run a git
 * command" is not something anyone can consent to. So the command is spoken in
 * full, with its symbols expanded into words rather than dropped.
 *
 * The other thing this has to convey is that **"always" is broader than the
 * command being asked about.** OpenCode's `always` field generalizes — reply
 * "always" to `git push origin main --force` and what gets saved is `git push *`.
 * A user who thinks they approved one push has approved every future one, so the
 * pattern is said out loud on the first ask.
 */

import type { PermissionRequest } from "../opencode/permissions.ts";

/**
 * Symbol → word. Shell punctuation is either silent or gibberish through a TTS
 * model, and at an approval gate silent is the dangerous one: `rm -rf ./build`
 * and `rm -rf /` must not sound the same.
 */
const SYMBOLS: Array<[RegExp, string]> = [
  [/&&/g, " and then "],
  [/\|\|/g, " or else "],
  [/\|/g, " piped into "],
  [/>>/g, " appended to "],
  [/>/g, " redirected into "],
  [/;/g, " then "],
  // "tilde" rather than "home": `~` means the home directory in a path but not
  // in `HEAD~3`, and guessing wrong at an approval gate is worse than being
  // literal.
  [/~/g, " tilde "],
  [/\*/g, " star "],
  // Before the bare-slash rule. A lone "." would otherwise be synthesized as a
  // sentence break — the command would sound like it had ended.
  [/\.\//g, " dot slash "],
  [/\//g, " slash "],
  [/=/g, " equals "],
  [/\$/g, " dollar "],
];

/** Speak one shell command. Long, deliberately — accuracy beats brevity here. */
export function describeCommand(command: string): string {
  const spoken = command
    .split(/\s+/)
    .filter((token) => token !== "")
    .map(speakToken)
    .join(" ");

  let text = spoken;
  for (const [pattern, replacement] of SYMBOLS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Flags read as noise otherwise: "-rf" comes out as "arf" or is swallowed
 * whole, and "--force" loses its dashes and blends into the previous word.
 */
function speakToken(token: string): string {
  if (token.startsWith("--")) {
    return `flag ${token.slice(2).replace(/-/g, " ")}`;
  }
  if (/^-[a-zA-Z]+$/.test(token)) {
    const letters = token.slice(1).split("").join(" ");
    return `flag ${letters}`;
  }
  return token;
}

/** What the request is asking to do, as a spoken clause. */
export function describeRequest(request: PermissionRequest): string {
  if (request.permission === "bash") {
    const command = request.metadata["command"];
    if (typeof command === "string" && command.trim() !== "") {
      return `run ${describeCommand(command)}`;
    }
  }

  const target = request.patterns[0];
  if (typeof target === "string" && target !== "") {
    return `use ${request.permission} on ${describeCommand(target)}`;
  }
  return `use ${request.permission}`;
}

/**
 * The first ask. Names the three answers, and spells out what "always" widens
 * to when that is broader than the command itself.
 */
export function askQuestion(request: PermissionRequest): string {
  const action = describeRequest(request);
  const always = request.always[0];
  const specific = request.patterns[0];

  const lines = [`The agent wants to ${action}.`];
  if (typeof always === "string" && always !== "" && always !== specific) {
    lines.push(`Saying always allows anything matching ${describeCommand(always)} from now on.`);
  }
  lines.push("Say approve, always, or deny.");
  return lines.join(" ");
}

/**
 * A reprompt. Short on purpose — by now the user knows what is being asked, and
 * the only new information is that the last thing they said didn't land.
 */
export function repromptQuestion(match: "silence" | "unrecognized"): string {
  if (match === "silence") {
    return "I didn't hear an answer. Say approve, always, or deny.";
  }
  return "I didn't understand that. Say approve, always, or deny.";
}

/** Spoken confirmation of the outcome. */
export function outcomeSentence(response: "once" | "always" | "reject" | "timeout"): string {
  switch (response) {
    case "once":
      return "Approved.";
    case "always":
      return "Approved, and allowed from now on.";
    case "reject":
      // OpenCode ends the turn on a rejection rather than letting the agent
      // adapt, so this sentence is the whole of what the user hears back.
      return "Denied. Nothing ran, and the agent stopped there.";
    case "timeout":
      return "No answer, so I denied it and stopped.";
  }
}

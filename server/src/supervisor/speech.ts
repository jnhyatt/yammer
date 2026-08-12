/**
 * Turning an approval request into a sentence worth hearing.
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
 *
 * Every sentence the supervisor speaks is assembled here, for both sources. The
 * wording differs between them — "the agent wants to" is a lie about a workspace
 * delete, and "approved" is a strange thing to hear about something Yammer is
 * doing itself — but *which answers are offered* is decided in one place, so a
 * request with no "always" cannot end up inviting one.
 */

import type { ApprovalRequest, ApprovalSource } from "./approval.ts";
import type { PermissionRequest } from "../opencode/permissions.ts";
import type { PermissionResponse } from "../protocol.ts";

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
 * The first ask: what is happening, what "always" would widen to, what is at
 * stake, and how to answer — in that order.
 *
 * `stakes` comes from Yammer's own look at the host directory (`git.ts`) and is
 * null when there is nothing to say. It goes immediately before the menu
 * because it is the last thing heard before answering, and it is the part most
 * likely to change the answer.
 */
export function askQuestion(request: ApprovalRequest, stakes: string | null): string {
  const lines = [request.description];
  if (request.always !== null) {
    lines.push(
      `Saying always allows anything matching ${describeCommand(request.always)} from now on.`,
    );
  }
  if (stakes !== null) lines.push(stakes);
  lines.push(answerMenu(request.always !== null));
  return lines.join(" ");
}

/**
 * A reprompt. Short on purpose — by now the user knows what is being asked, and
 * the only new information is that the last thing they said didn't land.
 */
export function repromptQuestion(
  match: "silence" | "unrecognized",
  offersAlways: boolean,
): string {
  const lead = match === "silence" ? "I didn't hear an answer." : "I didn't understand that.";
  return `${lead} ${answerMenu(offersAlways)}`;
}

/** Never offer an answer that has nowhere to go. */
function answerMenu(offersAlways: boolean): string {
  return offersAlways ? "Say approve, always, or deny." : "Say approve or deny.";
}

/**
 * Spoken confirmation of the outcome.
 *
 * The two sources need genuinely different words. A denied tool call is the end
 * of the agent's turn and the user hears nothing else about it, so that sentence
 * has to carry the consequence; a denied workspace delete is just Yammer not
 * doing something, and "the agent stopped there" would be a fiction.
 */
export function outcomeSentence(source: ApprovalSource, response: PermissionResponse): string {
  if (source === "yammer") {
    switch (response) {
      case "once":
      case "always":
        return "Okay, doing it.";
      case "reject":
        return "Okay, leaving it alone.";
      case "timeout":
        return "No answer, so I left it alone.";
    }
  }
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

/** What the client is told when the prompt itself broke. Always a refusal. */
export function failureSentence(source: ApprovalSource): string {
  return source === "yammer"
    ? "The approval prompt failed, so I didn't do it."
    : "The approval prompt failed, so I denied it.";
}

import { createInterface, type Interface } from "node:readline/promises";

let rl: Interface | undefined;

/** Reads one line from the terminal; one readline instance serves the whole process. */
export async function prompt(text: string): Promise<string> {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return (await rl.question(text)).trim();
}

export function closeTerminal() {
  rl?.close();
  rl = undefined;
}

/** One question of the AskUserQuestion tool. */
export interface Question {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

/** Asks AskUserQuestion questions in the terminal; returns the answers keyed by question text. */
export async function askQuestions(questions: Question[]): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    console.log(`\n── ${q.header} ──\n${q.question}`);
    q.options.forEach((option, i) => {
      console.log(`  ${i + 1}. ${option.label}${option.description ? ` – ${option.description}` : ""}`);
      if (option.preview) console.log(option.preview.replace(/^/gm, "       "));
    });
    const how = q.multiSelect ? "Numbers separated by commas" : "A number";
    let answer: string | null = null;
    while (answer === null) answer = parseAnswer(await prompt(`  ${how}, or your own answer > `), q);
    answers[q.question] = answer;
  }
  return answers;
}

/**
 * Turns terminal input into an answer: valid option numbers become their labels, anything
 * else – including a number that isn't an option, like "50" – is the user's own answer.
 * Returns null for empty input.
 */
export function parseAnswer(input: string, question: Pick<Question, "options" | "multiSelect">): string | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^\d+(\s*,\s*\d+)*$/.test(text)) return text;
  const numbers = [...new Set(text.split(",").map((n) => Number(n.trim())))];
  const valid = (question.multiSelect || numbers.length === 1) &&
    numbers.every((n) => n >= 1 && n <= question.options.length);
  return valid ? numbers.map((n) => question.options[n - 1].label).join(", ") : text;
}

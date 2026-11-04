import { AxGenerateError, AxMockAIService, ax, type AxChatRequest } from "@ax-llm/ax";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { Block, End as Answered } from "./AskAI.ts";
import { Memory } from "./Memory.ts";

const NODE = 512;

const RETRIES = 4;

const SIGNATURE = 'chat:string "the chat so far, as one-line summaries", task:string "the compaction to do", source:string "what to compress, in <input> tags" -> summary:string "the one line"';

type Sent = { blocks: string; by: string; text: string; ms: number; ok: boolean };

type Compacted = { line: string | null; by: string; tries: string[]; end: Answered | null };

export namespace Compact {

  export async function run(mem: Memory, l: number, i: number, chat: string, task: string, source: string): Promise<Compacted> {
    const system = mem.share().system;
    const program = ax(SIGNATURE);
    program.setInstruction(system);
    program.addAssert(({ summary }) => summary === undefined ? undefined : Compact.fits(summary));
    const sent: Sent[] = [];
    const stop: { end: Answered | null } = { end: null };
    const ai = new AxMockAIService<string>({
      features: { functions: false, streaming: false },
      chatResponse: async (req: Readonly<AxChatRequest<unknown>>) => {
        if (mem.done && sent.length > 0) {
          throw new Error("compactor: stopped");
        }
        const blocks = Compact.blocks(req);
        const ran = { by: "" };
        const at = Date.now();
        const end = await Memory.compact(mem, l, i, Memory.ask(mem, l, i, blocks, ran, req.chatPrompt[0]?.role === "system" ? req.chatPrompt[0].content : system));
        sent.push({ blocks: blocks.map((b) => b.text).join(""), by: ran.by, text: end.text, ms: Date.now() - at, ok: end.ok });
        if (!end.ok || end.text.trim() === "") {
          stop.end = end;
          throw new Error(end.text);
        }
        return { results: [{ index: 0, content: end.text, finishReason: "stop" }] };
      },
    });
    let line: string | null = null;
    try {
      line = Memory.flat((await program.forward(ai, { chat, task, source }, { maxRetries: RETRIES })).summary.trim());
    } catch (err) {
      if (!(err instanceof AxGenerateError)) {
        throw err;
      }
    }
    const answers = sent.filter((s) => s.ok && s.text.trim() !== "");
    const tries = answers.map((s) => Memory.flat(s.text.trim().replace(/^summary:\s*/i, "")));
    const kept = line ?? (tries.length === 0 ? null : Memory.cut(Memory.shortest(tries)));
    const by = line !== null ? (answers.at(-1)?.by ?? "") : kept === null ? "" : (answers[tries.indexOf(Memory.shortest(tries))]?.by ?? "");
    Compact.capture(mem, { l, i, system, sent, line: kept, by, fits: line !== null });
    return { line: kept, by, tries, end: stop.end };
  }

  export function fits(summary: string): true | string {
    const line = summary.trim();
    if (line.includes("\n")) {
      return "Write the summary as one line, without line breaks.";
    }
    return Memory.bytes(line) <= NODE || Memory.over(line);
  }

  export function blocks(req: Readonly<AxChatRequest<unknown>>): Block[] {
    return req.chatPrompt.flatMap((m): Block[] => {
      if (m.role === "system" || m.role === "function") {
        return [];
      }
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
      return [{ text: m.role === "assistant" ? "\nYour answer was:\n" + text + "\n\n" : text, mark: false }];
    });
  }

  export function capture(mem: Memory, rec: { l: number; i: number; system: string; sent: Sent[]; line: string | null; by: string; fits: boolean }): void {
    const dir = mem.dir + "/capture";
    const sha = createHash("sha256").update(rec.system).digest("hex").slice(0, 16);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(dir + "/system-" + sha + ".txt")) {
      fs.writeFileSync(dir + "/system-" + sha + ".txt", rec.system, { mode: 0o600 });
    }
    const at = new Date().toISOString();
    Memory.append(dir + "/" + at.slice(0, 10) + ".jsonl", [JSON.stringify({ ...rec, system: sha, at })]);
  }
}

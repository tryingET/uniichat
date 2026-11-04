// Print the messages Ax sends for a signature, using a mock model.
// bun .agents/skills/ax/scripts/preview.mjs 'source:string -> summary:string "one line"' '{"source":"x"}'
import { ax, AxMockAIService } from '@ax-llm/ax';

const [signature, values = '{}'] = process.argv.slice(2);
if (!signature) {
  console.error('usage: preview.mjs SIGNATURE [JSON_INPUT_VALUES]');
  process.exit(2);
}
const program = ax(signature);
const input = JSON.parse(values);
for (const field of program.getSignature().getInputFields()) {
  input[field.name] ??= `<${field.name}>`;
}
let prompt = [];
const mock = new AxMockAIService({
  features: { functions: false, streaming: false },
  chatResponse: async (req) => {
    prompt = req.chatPrompt;
    const out = program.getSignature().getOutputFields().map((f) => `${f.name}: x`).join('\n');
    return { results: [{ index: 0, content: out, finishReason: 'stop' }] };
  },
});
await program.forward(mock, input);
for (const m of prompt) {
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  console.log(`--- ${m.role}\n${text}`);
}

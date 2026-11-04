# The compactor as an Ax program

## Contents

1. Signature
2. Byte and line asserts
3. Adapter to UniiChat's routes
4. Fallback on exhaustion
5. Demos
6. Testing with a mock

All snippets ran under Bun 1.4.4 with @ax-llm/ax 25.4.6 against `AxMockAIService`.

## 1. Signature

String DSL (`ax`, src/ax/dsp/template.ts) or fluent builder (`f`, dsp/sig.ts):

```ts
import { ax, f, AxGen } from '@ax-llm/ax';

const compact = ax('context:string "earlier summaries", source:string "text to compress" -> summary:string "one line"');

const sig = f()
  .input('context', f.string('earlier summaries'))
  .input('source', f.string('text to compress'))
  .output('summary', f.string('one line'))
  .build();
const compact2 = new AxGen(sig);
```

- Field descriptions become `Context: Earlier summaries.` lines in the system prompt; `getInstruction()` is `undefined` until an optimizer or `setInstruction` sets one.
- Leaf and merge are one program with the same fields; say which in the input (for example a `kind` input, or the source's own markers). Two programs double the optimization work.

## 2. Byte and line asserts

```ts
const bytes = (t: string) => Buffer.byteLength(t, 'utf8');
compact.addAssert(({ summary }) => summary === undefined ? undefined : !summary.includes('\n'), 'summary must be one line');
compact.addAssert(({ summary }) => {
  if (summary === undefined) return undefined;
  const n = bytes(summary);
  return n <= 512 || `summary was ${n} bytes; rewrite it to at most 512 UTF-8 bytes, cutting the least valuable items`;
});
```

- `addAssert(fn, message?)` (dsp/generate.ts:876; `AxAssertion`, dsp/asserts.ts:3): return `true` to pass, `undefined` to skip (field not there yet), `false` to fail with `message`, or a string to fail with that string. A failure sends `Follow these instructions: <message>.` as a new user turn and retries.
- The message is all the model sees on a retry: return a string with the measured size, as above.
- Measured on 100 Luna nodes: a byte count alone gets 5-15% cuts per retry (42% exhausted). Asking for a word count scaled to ~400 bytes (`words * 400 / bytes`) dropped exhaustion to 4%, tries from 3.1 to 1.95.
- `maxRetries` (default 3, dsp/generate.ts:1968) counts extra tries: `maxRetries: 4` is 5 calls at most. Pass it per call: `forward(ai, values, { maxRetries: 4 })`.

## 3. Adapter to UniiChat's routes

`AxMockAIService` (src/ax/ai/mock/api.ts:67, config :23) takes `chatResponse: async (req, options) => AxChatResponse`. `req.chatPrompt` (ai/types.ts:617) is a list of `{ role: 'system', content }`, `{ role: 'user', content: string | parts[] }` and `{ role: 'assistant', content }`; user parts are `{ type: 'text', text }`.

```ts
import { AxMockAIService, type AxChatRequest } from '@ax-llm/ax';

function route(mem: Memory, l: number, i: number, ran: { by: string }, tries: string[], stop: { end?: Answered }) {
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async (req: Readonly<AxChatRequest<unknown>>) => {
      const blocks = req.chatPrompt.map(toBlock);          // system -> system text, user/assistant -> blocks
      const end = await Memory.compact(mem, l, i, Memory.ask(mem, l, i, blocks, ran));
      if (!end.ok) { stop.end = end; throw new Error(end.text); }  // stop, busy, fail: rethrown by the caller
      tries.push(end.text.trim());
      return { results: [{ index: 0, content: end.text, finishReason: 'stop' }] };
    },
  });
}
```

- `l` and `i` reach the adapter through the closure; Ax does not pass them.
- Map Ax's system message onto UniiChat's system prompt and keep the cached context view as a cached block, so prompt caching still works.
- Build one service per node: `tries` and `ran` are per node.
- The result shape (`AxChatResponse`, ai/types.ts:565) needs only `results[0].content`; `finishReason: 'stop'`.

## 4. Fallback on exhaustion

```ts
import { AxGenerateError } from '@ax-llm/ax';

const tries: string[] = [];
const stop: { end?: Answered } = {};
let line: string;
try {
  line = (await compact.forward(route(mem, l, i, ran, tries, stop), { context, source }, { maxRetries: 4 })).summary;
} catch (e) {
  if (stop.end || !(e instanceof AxGenerateError) || tries.length === 0) throw e;
  line = Memory.cut(Memory.flat(Memory.shortest(tries)));   // the attempts survive in the adapter, not in the error
}
```

- `AxGenerateError` (dsp/generate.ts:4052) wraps both failures: exhausted validation (`Generate failed: Unable to fix validation error: …`) and an error thrown by the adapter (`Generate failed: route stopped`, after 1 call, no retry). Tell them apart by your own `stop` record, not by the class.
- Stored `tries` are raw answers including the `Summary:` prefix if the model wrote one; parse or strip it before measuring.
- `ran.by` must name the model of the kept answer (see `ask_till_fits`).

## 5. Demos

```ts
compact.setDemos([{ programId: 'root', traces: [{ context: '…', source: '…', summary: '…' }] }]);
```

- `programId` is required; a single `AxGen` is `'root'` (dsp/program.ts:224 lists valid IDs). Each trace needs at least one input and one output value (:259).
- Demos ride every call: each costs context bytes and latency. Prefer few, short, real ones.

## 6. Testing with a mock

Script the replies and count calls:

```ts
const replies = ['Summary: ' + 'ä'.repeat(300), 'Summary: short'];
const mock = new AxMockAIService({ features: { functions: false, streaming: false },
  chatResponse: async () => ({ results: [{ index: 0, content: replies.shift()!, finishReason: 'stop' }] }) });
```

Observed: the 600-byte answer fails the byte assert, the second call returns `short`; with all answers too long and `maxRetries: 2`, 3 calls then `AxGenerateError`. A reply without the `Summary:` prefix is accepted as the field value for a single-output signature; `Summary: a\nb` comes back as `a\nb`.

This repository has no unit tests (AGENTS.md): run such mocks in a scratch directory, then test the real app like a user.

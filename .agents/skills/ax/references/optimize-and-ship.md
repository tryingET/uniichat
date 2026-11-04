# Optimize and ship

## Contents

1. Metric first
2. Running the optimizer
3. Saving and loading
4. Budgets and authorization
5. Comparing against the current prompt

## 1. Metric first

- `AxMetricFn = ({ prediction, example }) => number | Promise<number>` and `AxMultiMetricFn` returning `Record<string, number>` (src/ax/dsp/common_types.ts:16, :21). Both may be async, so an LLM judge works.
- Gate before judging: empty, multi-line or over 512 bytes scores 0 without a judge call.
- A judge is a typed `AxGen` (for example `source, summary -> kept:number, invented:number, criticalError:boolean`) on a different model than the student. A critical error (status, negation, identifier or authorization changed) scores 0.
- Use objectives (`{ fits, fidelity, brevity }`) when the trade-off matters; GEPA returns a Pareto front.
- Check the judge against a human-graded sample before trusting it. Never use stored oversized summaries as gold.

## 2. Running the optimizer

```ts
import { optimize } from '@ax-llm/ax';

const result = await optimize(compact, train, metric, {
  studentAI, teacherAI,              // adapters over UniiChat routes; a stronger teacher writes instructions
  validationExamples: heldOut,       // split by conversation, not adjacent tree nodes
  numTrials: 12, minibatch: true, minibatchSize: 4,
  maxMetricCalls: 200,
  bootstrap: false,                  // required when examples carry no gold summary
});
```

- `optimize` (dsp/optimize.ts:37) runs `AxBootstrapFewShot` then `AxGEPA` for small sets. Bootstrap turns examples into demos and refuses examples without an output value ("Demo trace[0] … has no output field values"); pass `bootstrap: false` for unlabeled inputs.
- Direct use: `new AxGEPA({ studentAI, teacherAI, numTrials, minibatch })` (dsp/optimizers/gepa.ts:139, :175) then `.compile(program, examples, metric, { maxMetricCalls, validationExamples })` (:266); `maxMetricCalls` is required (:276-282).
- GEPA rewrites `root::instruction` (from `getOptimizableComponents()`); the teacher is asked for a `feedbackSummary` and then a new instruction.
- `result.bestScore`, `result.paretoFront`, `result.optimizedProgram`; `result.baselineScore` can be `undefined`, so measure the baseline yourself on the same held-out set.
- Observed with mocks: 6 train, 4 validation, `numTrials: 3`, budget 60: 16 student calls, 2 teacher calls. Real runs add judge calls per metric call.

## 3. Saving and loading

```ts
import { axSerializeOptimizedProgram, axDeserializeOptimizedProgram } from '@ax-llm/ax';

await Bun.write('compactor.json', JSON.stringify(axSerializeOptimizedProgram(result.optimizedProgram!), null, 2));

const program = ax('…same signature…');
program.applyOptimization(axDeserializeOptimizedProgram(JSON.parse(text)));
```

- `AxOptimizedProgram` (dsp/optimizer.ts:822) holds `componentMap` (`root::instruction` → text), `demos`, `modelConfig`, scores and run metadata; serialize/deserialize at :938/:946; `applyOptimization` (dsp/program.ts:370) sets demos and components.
- The saved instruction is applied to the same signature only: a changed field name or description needs a new run.
- Record beside it: model route and effort, dataset version, metric version, budget, baseline and best score.

## 4. Budgets and authorization

- Every metric call is a student call plus any judge call; reflection adds teacher calls. `maxMetricCalls` bounds metric calls, not tokens or money.
- Live calls through UniiChat's subscription routes need the operator's go-ahead with a route and a call budget. Develop with mocks.

## 5. Comparing against the current prompt

- Run the current compactor and the Ax program on the same held-out inputs, same model and effort, and compare stored outputs: fit rate, calls per node, judge scores, human sample.
- `scripts/preview.mjs` shows Ax's messages; diff them against `Memory.task` and the system prompt to see what changed besides the instruction.

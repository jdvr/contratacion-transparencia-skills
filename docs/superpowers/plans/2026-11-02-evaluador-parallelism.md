# Parallel Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review all `claim × role` pairs concurrently with a bounded worker pool, without changing the evidence contract, the deterministic state/issues, or the declared budget semantics.

**Architecture:** `runEval` first builds a per-claim accumulator and a queue of driver-needed pairs in `claim → role` order (state/cache hits are filled immediately). A pool of `jobs` workers pops pairs, checks the soft budget before launching, runs each pair with the existing timeout/abort seam, and writes verdicts into the claim's role-indexed slots. State and issues are materialized in deterministic order after every completion.

**Tech Stack:** TypeScript strict, Node 22 built-ins only (zero runtime deps), Vitest, esbuild bundle.

**Spec:** `docs/superpowers/specs/2026-11-02-evaluador-parallelism-design.md`

## Global Constraints

- Zero runtime dependencies; `node:` built-ins only.
- English code/comments; Spanish human-facing docs and CLI content where already Spanish.
- No real network, no real `opencode` binary, no real report data in tests; fixtures are generated and labelled «DATOS GENERADOS».
- `runEval` default `jobs: 1` (backward compatible); the CLI default is 4; `--jobs 1` reproduces the sequential behavior.
- Budget is a **soft cap**: check `spent >= budget` before launching; in-flight calls finish. Without retries the overshoot is at most `jobs-1` calls; a retry can add one per in-flight call.
- State/issues stay deterministic: claims in gate order, verdicts in role order (carried non-requested roles first, then requested roles).
- Every task ends with the full suite green (`npx vitest run`), `npx tsc --noEmit`, `npm run build`, and `bash scripts/check-skills.sh` from the repo root.
- Conventional commits; one commit per task.

## Review Focus

1. **Out-of-order completions must not reorder state/issues** — a parallel run and a sequential run with the same verdicts produce the same claim/verdict/issue order (ignoring `updatedAt`).
2. **No new task after the budget is exhausted** — in-flight calls finish; the state declares `presupuesto-agotado` and the exit code is 1.
3. **SIGINT with N calls in flight** — all children are aborted, the pool drains, the state carries `interrumpido`, and no call remains in flight.
4. **I/O failure while N calls are in flight** — abort, drain with `allSettled`, rethrow (CLI exit 3); no orphan `opencode run`.
5. **Real backend concurrency** — 4 simultaneous `opencode run` clients on the same cwd/model do not corrupt each other; if the provider limits, document `--jobs 2` instead of changing the default.

---

### Task 1: `--jobs` flag and API plumbing

**Files:**
- Modify: `evaluador/src/cli.ts:26-55, 67-166, 168-225, 248-258`
- Modify: `evaluador/src/adversarial.ts:224-270` (`RunEvalOptions`)
- Test: `evaluador/test/cli.test.ts:36-130`

**Interfaces:**
- Consumes: `parseEvalArgs(argv): EvalArgsResult`; `main(argv, deps: MainDeps)`.
- Produces: `EvalArgs.jobs?: number`; `MainDeps.jobs?: number`; `RunEvalOptions.jobs?: number`; CLI passes `jobs: jobs ?? deps.jobs ?? 4`; `runEval` defaults to `opts.jobs ?? 1`.

- [ ] **Step 1: Write the failing parser tests**

Add to `describe("parseEvalArgs")`:

```ts
it("parses --jobs as a positive integer", () => {
  const parsed = parseEvalArgs(["reporte.md", "--jobs", "3"]);
  expect(parsed).toMatchObject({ ok: true, args: { jobs: 3 } });
});

it("rejects a missing, zero, negative or non-numeric --jobs", () => {
  for (const argv of [
    ["reporte.md", "--jobs"],
    ["reporte.md", "--jobs", "0"],
    ["reporte.md", "--jobs", "-1"],
    ["reporte.md", "--jobs", "tres"],
  ]) {
    expect(parseEvalArgs(argv)).toEqual({
      ok: false,
      message: "--jobs requires a positive integer",
    });
  }
});
```

- [ ] **Step 2: Run RED**

Run: `cd evaluador && npx vitest run test/cli.test.ts`
Expected: FAIL (`--jobs` is an unknown flag; `jobs` absent).

- [ ] **Step 3: Implement the plumbing**

In `cli.ts`:
- `EvalArgs`: add `jobs?: number` with a comment: `// Concurrent claim×role workers (--jobs); CLI default 4.`
- `MainDeps`: add `jobs?: number`.
- `parseEvalArgs`: add a `case "--jobs"` using `/^[1-9]\d*$/`; on failure return `{ ok: false, message: "--jobs requires a positive integer" }`; set `jobs = Number(value)`.
- Return `jobs` in `args`.
- `runEvalCommand`: destructure `jobs`; pass `jobs: jobs ?? deps.jobs ?? 4` to `runEval`.
- Usage line: add `[--jobs N]` after `[--timeout seconds]`.

In `adversarial.ts`:
- `RunEvalOptions`: add
```ts
// Concurrent claim×role workers. Library default 1 (sequential); the CLI
// passes 4 unless --jobs overrides it.
jobs?: number;
```
- In `runEval`, compute `const jobs = opts.jobs ?? 1;` and use it in the progress header (`jobs: ${jobs}`). Do not change the scheduler yet; the loop is still sequential until Task 2.
- Guard: if `!Number.isInteger(jobs) || jobs < 1`, return a code-3 result with `freshState(...)` and zero spending, mirroring the empty-roles guard (the CLI already rejects it; this protects embedded callers).

- [ ] **Step 4: Run GREEN + full suite**

Run: `cd evaluador && npx vitest run test/cli.test.ts && npx vitest run`
Expected: PASS; existing CLI tests still pass because `runEval` remains sequential.

- [ ] **Step 5: Commit**

```bash
git add evaluador/src/cli.ts evaluador/src/adversarial.ts evaluador/test/cli.test.ts
git commit -m "feat(evaluador): --jobs flag and API plumbing"
```

---

### Task 2: Scheduler core (plan + accumulator + worker pool)

**Files:**
- Modify: `evaluador/src/adversarial.ts` (replace the sequential claim/role loop in `runEval`; add internal `ClaimAccumulator`/`PairTask`/`buildPlan`/`materializeClaims`)
- Test: `evaluador/test/adversarial.test.ts` (new `describe("parallel scheduler")`)

**Interfaces:**
- Consumes: `RunEvalOptions.jobs` (Task 1), `Budget`, `VerdictCache`, `invokeDriver`, `claimHash`, `resolveFetch`, `rubricFor`, `materialFor`.
- Produces: internal `ClaimAccumulator` and `PairTask` types; `materializeClaims(accs, roles): RecordedClaim[]`; the same `runEval` return shape.

**Data structures (exact):**

```ts
interface ClaimAccumulator {
  claim: Claim;
  hash: string;
  verdictsByRole: Verdict[][]; // indexed by the roles array
  prior: Verdict[];            // verdicts carried from state (all roles)
  retryClaim: boolean;         // recheck === "sin-re-verificar"
  pendingSinReverificar: boolean;
  budgetGap: boolean;
  interrupted: boolean;
  started: boolean; // a role was adopted or a pair was popped for this claim
}

interface PairTask {
  acc: ClaimAccumulator;
  role: RoleId;
  roleIndex: number;
  pairIndex: number; // stable [i/total] label
}
```

- [ ] **Step 1: Write the failing concurrency test**

Add a barrier driver helper and test:

```ts
function barrierDriver(expected: number): {
  driver: Driver;
  calls: AgentCall[];
  get maxActive(): number;
} {
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: AgentCall[] = [];
  const driver: Driver = async (call) => {
    calls.push(call);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === expected) release();
    await gate;
    active -= 1;
    return { verdicts: [okVerdict(call)], calls: 1 };
  };
  return { driver, calls, get maxActive() { return maxActive; } };
}

it("runs up to jobs claim×role pairs concurrently", async () => {
  const session = newSession(); // 3 claims × 4 roles = 12 pairs
  const barrier = barrierDriver(3);
  const lines: string[] = [];

  const result = await runEval(
    evalOpts(session, barrier.driver, {
      jobs: 3,
      logger: (line) => lines.push(line),
      heartbeatMs: 0,
    }),
  );

  expect(result.code).toBe(0);
  expect(barrier.calls).toHaveLength(12);
  expect(barrier.maxActive).toBe(3);
  expect(lines[0]).toContain("jobs: 3");
});
```

Add a sequential control:

```ts
it("jobs: 1 keeps the sequential concurrency ceiling", async () => {
  const session = newSession();
  const barrier = barrierDriver(1);
  const result = await runEval(evalOpts(session, barrier.driver, { jobs: 1 }));
  expect(result.code).toBe(0);
  expect(barrier.maxActive).toBe(1);
});

it("the CLI defaults to 4 workers", async () => {
  const session = newSession();
  const barrier = barrierDriver(4);
  const code = await quietly(() =>
    main(["eval", session.reportPath], { driver: barrier.driver, cwd: session.cwd }),
  );
  expect(code).toBe(0);
  expect(barrier.maxActive).toBe(4);
});

it("serves a second parallel run entirely from cache", async () => {
  const session = newSession();
  const first = okDriver();
  await runEval(evalOpts(session, first.driver, { jobs: 4, heartbeatMs: 0 }));
  expect(first.calls).toHaveLength(12);

  const second = okDriver();
  const result = await runEval(evalOpts(session, second.driver, { jobs: 4, heartbeatMs: 0 }));
  expect(result.code).toBe(0);
  expect(second.calls).toHaveLength(0);
});
```

Add the determinism test:

```ts
it("produces the same state and issues regardless of completion order", async () => {
  const makeDriver = (): Driver => async (call) => {
    // Different delays force out-of-order completions under jobs: 4.
    const delay = call.role === "contadores" ? 8 : call.role === "segunda-fuente" ? 4 : 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const id = call.material.match(/"id": "([^"]+)"/)?.[1] ?? "?";
    const isProblem = call.role === "falsificador";
    return {
      verdicts: [okVerdict(call, {
        resultado: isProblem ? "problema" : "ok",
        severidad: "aviso",
        hallazgo: `${id}/${call.role}`,
      })],
      calls: 1,
    };
  };
  const sequentialSession = newSession();
  const parallelSession = newSession();

  const sequential = await runEval(
    evalOpts(sequentialSession, makeDriver(), { jobs: 1, heartbeatMs: 0 }),
  );
  const parallel = await runEval(
    evalOpts(parallelSession, makeDriver(), { jobs: 4, heartbeatMs: 0 }),
  );

  const shape = (state: EvaluatorState) => state.claims.map((rc) => ({
    id: rc.claim.id,
    recheck: rc.recheck,
    verdicts: rc.verdicts.map((v) => ({ role: v.role, hallazgo: v.hallazgo })),
  }));
  expect(shape(parallel.state)).toEqual(shape(sequential.state));

  const issues = (dir: string) => readdirSync(join(dir, ".evaluador", "issues"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, ".evaluador", "issues", file), "utf8")));
  expect(issues(parallelSession.cwd)).toEqual(issues(sequentialSession.cwd));
});
```

- [ ] **Step 2: Run RED**

Run: `cd evaluador && npx vitest run test/adversarial.test.ts -t "parallel scheduler"`
Expected: FAIL (`jobs` ignored; `maxActive` is 1; the header has no `jobs`).

- [ ] **Step 3: Implement the plan and pool**

In `runEval`, after the header and `previous`/`cache` setup:

1. **Build accumulators** in `gate.claims` order. For each claim compute `hash = claimHash(claim, opts.model)`, `recorded = previousById.get(claim.id)`, `reusable` with the same hash check, `recheck = reusable?.recheck`, `retryClaim`, `pendingSinReverificar`, `prior = reusable?.verdicts ?? []`, and `verdictsByRole = roles.map(() => [])`.
2. **Build tasks** in `claim → role` order with a monotonically increasing `pairIndex`. For each role:
   - `priorForRole = acc.prior.filter((v) => v.role === role)`.
   - `retryRole = acc.retryClaim && (priorForRole.length === 0 || priorForRole.some((v) => v.resultado === "sin-re-verificar"))`.
   - `canAdopt = !opts.noCache && !retryRole`.
   - If `canAdopt && priorForRole.length > 0`: `acc.verdictsByRole[roleIndex] = priorForRole`, `cacheHits += 1`, `emit("... reused from state")`, continue.
   - Else if `canAdopt`: `cached = cache.get(acc.hash, role)`; if defined, fill the slot, `cacheHits += 1`, `emit("... cache hit")`, continue.
   - Else `cacheMisses += 1` and push a `PairTask`.
3. **Run the pool**:

```ts
let cursor = 0;
let firstError: unknown;
const worker = async (): Promise<void> => {
  while (firstError === undefined && !runController.signal.aborted && cursor < tasks.length) {
    const task = tasks[cursor];
    cursor += 1;
    task.acc.started = true;
    if (budget.exhausted) {
      task.acc.budgetGap = true;
      emit(`${tagFor(task)}: budget exhausted -> presupuesto-agotado`);
      continue;
    }
    try {
      await runPair(task);
    } catch (error) {
      firstError = error;
      runController.abort();
    }
  }
};
const workerCount = Math.min(jobs, tasks.length);
await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
if (firstError !== undefined) throw firstError;
for (let i = cursor; i < tasks.length; i += 1) {
  if (!tasks[i].acc.started) continue; // never reached: omit from state
  if (runController.signal.aborted) tasks[i].acc.interrupted = true;
  else tasks[i].acc.budgetGap = true;
}
```

Set `acc.started = true` when a role is adopted from state/cache too. A claim
that was never reached keeps `started: false` and is omitted from the state,
exactly like the old sequential loop omitted claims it never processed.

4. **`runPair(task)`** is the old loop body: emit `reviewing`, start/clear the heartbeat, `await invokeDriver`, on `"aborted"` set `acc.interrupted = true` (and charge 1 as today), otherwise assign `claimId`/`role`, write `cache.put` for each verdict, `budget.take(result.calls)`, `petitions += result.calls`, `acc.verdictsByRole[roleIndex].push(...assigned)`, `checkpoint()`, and emit the outcome line. Keep the timeout/TIMEOUT wording.
5. **`materializeClaims(accs, roles)`**:

```ts
const requested = new Set<RoleId>(roles);
return accs.flatMap((acc) => {
  const carried = acc.prior.filter((v) => !requested.has(v.role as RoleId));
  const verdicts = [...carried, ...acc.verdictsByRole.flat()];
  if (verdicts.length === 0 && !acc.budgetGap && !acc.interrupted) return [];
  let recheck: RecordedClaim["recheck"];
  if (acc.interrupted) {
    recheck = acc.pendingSinReverificar ? "sin-re-verificar" : "interrumpido";
  } else if (
    verdicts.some((v) => v.resultado === "sin-re-verificar") ||
    (acc.budgetGap && acc.pendingSinReverificar)
  ) {
    recheck = "sin-re-verificar";
  } else if (acc.budgetGap) {
    recheck = "presupuesto-agotado";
  }
  return [{ claim: acc.claim, hash: acc.hash, verdicts, ...(recheck ? { recheck } : {}) }];
});
```

6. Replace `snapshot()` and the final `state` with `materializeClaims(accs, roles)`; keep `reporte`, `rubricVersion`, `petitions`, `updatedAt`, `roles`.
7. Remove the old sequential `for (const claim of gate.claims)` loop and the per-claim `budgetGap`/`claimInterrupted` locals; their semantics now live in the accumulator.
8. Add `jobs: ${jobs}` to the progress header and to the final `done:` line.

**Ordering rule:** final `verdicts` = carried non-requested roles in prior order, then requested roles in the `roles` array order. This preserves the existing subset behavior.

- [ ] **Step 4: Run GREEN**

Run: `cd evaluador && npx vitest run test/adversarial.test.ts && npx vitest run`
Expected: PASS, including all pre-existing sequential tests (`runEval` default 1).

- [ ] **Step 5: Commit**

```bash
git add evaluador/src/adversarial.ts evaluador/test/adversarial.test.ts
git commit -m "feat(evaluador): parallel claim-by-role scheduler"
```

---

### Task 3: Budget, interruption and I/O drain under concurrency

**Files:**
- Modify: `evaluador/src/adversarial.ts` (budget/abort/error paths in the pool)
- Test: `evaluador/test/adversarial.test.ts`
- Test: `evaluador/test/adversarial.test.ts:1058-1073` (pin the config-budget CLI test to `--jobs 1`)

**Interfaces:**
- Consumes: `barrierDriver` (Task 2), `loadState`, `recordedClaim`, `gapPairs`, `DEFAULT_ROLES`.
- Produces: the same `RunEvalResult`; no new public API.

- [ ] **Step 1: Write the failing budget test**

```ts
it("budget is a soft cap: in-flight pairs finish, no new pair is launched", async () => {
  const session = newSession(); // 12 pairs
  const barrier = barrierDriver(4);

  const result = await runEval(
    evalOpts(session, barrier.driver, { budget: 2, jobs: 4, heartbeatMs: 0 }),
  );

  expect(result.code).toBe(1);
  expect(barrier.calls).toHaveLength(5); // 2 budget + 3 in-flight (jobs-1)
  expect(result.spentThisRun).toBe(5);
  const saved = loadState(stateDir(session));
  if (saved === null) throw new Error("state.json should exist");
  expect(saved.petitions).toBe(5);
  expect(gapPairs(saved, DEFAULT_ROLES)).toHaveLength(7);
});
```

Add the resume test:

```ts
it("resumes a parallel budget pause by driving only the missing pairs", async () => {
  const session = newSession();
  const first = barrierDriver(4);
  await runEval(evalOpts(session, first.driver, { budget: 2, jobs: 4, heartbeatMs: 0 }));

  const second = okDriver();
  const resumed = await runEval(
    evalOpts(session, second.driver, { budget: 20, jobs: 4, heartbeatMs: 0 }),
  );

  expect(resumed.code).toBe(0);
  expect(second.calls).toHaveLength(7);
  for (const rc of resumed.state.claims) {
    expect(rc.recheck).toBeUndefined();
    expect(rc.verdicts).toHaveLength(4);
  }
});
```

Add the parallel SIGINT test (adapt the existing one):

```ts
it("SIGINT drains two in-flight calls and saves an interrumpido state", async () => {
  const session = newSession([baseClaim("claim-c1"), baseClaim("claim-c2")]);
  let calls = 0;
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const driver: Driver = (call) => {
    calls += 1;
    if (calls === 2) reached();
    return new Promise<AgentResult>(() => {});
  };

  const pending = runEval(evalOpts(session, driver, { jobs: 2, heartbeatMs: 0 }));
  await started;
  process.emit("SIGINT", "SIGINT");
  const paused = await pending;

  expect(paused.code).toBe(1);
  const saved = loadState(stateDir(session));
  if (saved === null) throw new Error("state.json should exist");
  expect(saved.claims).toHaveLength(1);
  expect(saved.claims[0]?.claim.id).toBe("claim-c1");
  expect(saved.claims[0]?.recheck).toBe("interrumpido");
  expect(saved.claims[0]?.verdicts).toHaveLength(0);

  const resumed = okDriver();
  const second = await runEval(evalOpts(session, resumed.driver, { jobs: 2, heartbeatMs: 0 }));
  expect(second.code).toBe(0);
  expect(resumed.calls).toHaveLength(8); // both claims × 4 roles
});
```

Add the I/O drain test:

```ts
it("drains in-flight calls and rethrows when a checkpoint write fails", async () => {
  const session = newSession([baseClaim("claim-c1"), baseClaim("claim-c2")]);
  mkdirSync(join(stateDir(session), "cache.json"), { recursive: true }); // save() will fail
  let seenSignal: AbortSignal | undefined;
  let secondStarted!: () => void;
  const started = new Promise<void>((resolve) => { secondStarted = resolve; });
  let calls = 0;
  const driver: Driver = (call) => {
    calls += 1;
    if (calls === 2) {
      seenSignal = call.signal;
      secondStarted();
      return new Promise<AgentResult>(() => {});
    }
    return Promise.resolve({ verdicts: [okVerdict(call)], calls: 1 });
  };

  const running = runEval(evalOpts(session, driver, { jobs: 2, heartbeatMs: 0 }));
  await started; // the second in-flight call exists before the checkpoint throw
  await expect(running).rejects.toThrow();
  expect(seenSignal?.aborted).toBe(true);
});
```

- [ ] **Step 2: Run RED**

Run: `cd evaluador && npx vitest run test/adversarial.test.ts -t "budget is a soft cap|resumes a parallel|SIGINT drains|drains in-flight"`
Expected: FAIL with the old counts/behavior (or a hang on the I/O test until the drain is implemented).

- [ ] **Step 3: Implement the budget/abort/error rules**

The Task 2 pool already checks `budget.exhausted` before launching; keep it. Add/confirm:
- After `await Promise.allSettled(...)`, if `firstError !== undefined`, `throw firstError` **after** marking nothing and before any final state/artifacts. The `runController.abort()` in the worker catch is what drains the others.
- For unpopped tasks: if the run signal is aborted, `acc.interrupted = true`; otherwise `acc.budgetGap = true`.
- On `invokeDriver` returning `"aborted"`, set `acc.interrupted = true` and charge 1 (as today).
- The final `recheck` priority in `materializeClaims` is exactly the Task 2 code (interrupted > sin-re-verificar > presupuesto-agotado).
- `checkpoint()` is called inside `runPair` after each completion; a throw propagates to the worker catch, which aborts the run controller and lets the other in-flight calls settle.

Update the config-budget CLI test to preserve its sequential intent:

```ts
main(["eval", session.reportPath, "--jobs", "1"], { driver, cwd: session.cwd })
```

Pin the `--budget 5` CLI test to `--jobs 1` as well: its exact 5-call/7-gap
assertion is the sequential contract, while the runEval-level parallel budget
test is the new soft-cap coverage.

- [ ] **Step 4: Run GREEN**

Run: `cd evaluador && npx vitest run test/adversarial.test.ts && npx vitest run`
Expected: PASS; the full suite stays green.

- [ ] **Step 5: Commit**

```bash
git add evaluador/src/adversarial.ts evaluador/test/adversarial.test.ts
git commit -m "feat(evaluador): budget and interruption semantics for parallel runs"
```

---

### Task 4: Docs, exact-count CLI tests and real concurrency smoke

**Files:**
- Modify: `evaluador/README.md`
- Modify: `evaluador/ROLES.md`
- Test: `evaluador/test/adversarial.test.ts` (only if a CLI exact-count test still needs `--jobs 1`)

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing docs; a verified real-backend smoke result.

- [ ] **Step 1: Update README**

Add `[--jobs N]` to the `eval` command line and a paragraph:
- default 4 in the CLI; `--jobs 1` = sequential;
- soft budget: no new pair after `spent >= budget`, in-flight pairs finish, overshoot `jobs-1` (+ retries), declared in `spentThisRun`/`petitions`;
- provider limits: `--jobs 2` for free/flaky models;
- the worker pool is over claim×role pairs, so a slow role does not block other claims.

- [ ] **Step 2: Update ROLES.md**

Add a bullet in «Cómo se ejecutan»:
- `--jobs N` runs up to N pairs concurrently (default CLI 4); the role order and verdict order do not change; `--jobs 1` is the sequential mode; the budget overshoot is declared.

- [ ] **Step 3: Real smoke with 4 concurrent calls**

Use a fresh temp dir, the generated fixture, and a fast model:

```bash
SMOKE=$(mktemp -d)
cd "$SMOKE"
node /Users/juanvegadev/workspace/contratacion-transparencia-skills/evaluador/dist/cli.js init
cp /Users/juanvegadev/workspace/contratacion-transparencia-skills/evaluador/test/fixtures.reporte.md reporte.md
node /Users/juanvegadev/workspace/contratacion-transparencia-skills/evaluador/dist/cli.js eval reporte.md \
  --jobs 4 --roles contadores,segunda-fuente,falsificador,metodico \
  --model opencode-go/deepseek-v4.1-flash --budget 20
```

Check: exit 0/1, four artifacts written, progress shows `jobs: 4`, no `opencode run` left (`pgrep -fl "opencode run --model"`), and the run is visibly faster than the sequential baseline. If the provider rate-limits, record it and use `--jobs 2`; do not change the default without evidence.

- [ ] **Step 4: Full verification**

Run:

```bash
cd evaluador
npx vitest run
npx tsc --noEmit
npm run build
cd ..
bash scripts/check-skills.sh
bash scripts/test-check-skills.sh
```

Expected: all tests green, tsc/build clean, `check-skills: 7 skills, 0 errores`, `TEST GREEN (26 casos)`.

- [ ] **Step 5: Commit**

```bash
git add evaluador/README.md evaluador/ROLES.md
git commit -m "docs(evaluador): document --jobs and the parallel budget overshoot"
```

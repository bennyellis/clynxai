// A minimal helper shared by the standalone test scripts in this folder (no test framework; see scripts/run-tests.cjs).
let passed = 0;
let failed = 0;

export function check(description: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${description}`);
  } else {
    failed++;
    console.log(`  FAIL  ${description}${detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
}

export function section(title: string): void {
  console.log(`\n-- ${title}`);
}

/** Prints the totals and exits non-zero when anything failed. Call it last. */
export function finish(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/** Runs a test body; an exception counts as a failure. */
export async function run(body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
  } catch (err) {
    failed++;
    console.log(`  FAIL  test threw: ${(err as Error).stack ?? err}`);
  }
  finish();
}

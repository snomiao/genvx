#!/usr/bin/env node
// Which parity cases does the Rust binary answer itself?
//
// The parity runner compares what two implementations do. A case the Rust
// binary hands back to the JavaScript passes that comparison by construction,
// so "all cases behave the same" alone does not show that anything was ported.
// This script closes that gap. It runs the same cases with a stand-in package
// whose "JavaScript" only prints a marker; an invocation that was handed back
// is then recognisable, and the list is compared with what rs/parity.json
// says: a case carries `"handback": "<why>"` exactly when the JavaScript is
// meant to answer it.
//
//   node rs/parity-native.mjs --runner <rustify>/templates/parity/parity.mjs \
//        [--rs rs/target/release/genvx] [--cases rs/parity.json] [--filter <text>]
//
// In the rustify pipeline the runner's path is in $RUSTIFY_PARITY.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const runner = opts.runner || process.env.RUSTIFY_PARITY;
const binary = path.resolve(opts.rs || path.join(HERE, "target/release/genvx"));
const casesFile = path.resolve(opts.cases || path.join(HERE, "parity.json"));
if (!runner || !fs.existsSync(runner)) {
  console.error("usage: parity-native.mjs --runner <parity.mjs> [--rs <binary>] [--cases <parity.json>] [--filter <text>]");
  process.exit(2);
}

const MARKER = "<<handed back to the JavaScript>>";
const standIn = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "genvx-standin-"));
let output;
try {
  fs.mkdirSync(path.join(standIn, "src"));
  fs.writeFileSync(path.join(standIn, "package.json"), '{ "name": "genvx-standin", "type": "module" }\n');
  fs.writeFileSync(path.join(standIn, "src/cli.ts"), `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(MARKER)});\n`);
  const run = spawnSync(
    process.execPath,
    [
      runner,
      ...["--cases", casesFile, "--ts", `bun ${path.join(standIn, "src/cli.ts")}`],
      ...["--rs", `env GENVX_PACKAGE_ROOT=${standIn} ${binary}`],
      ...(opts.filter ? ["--filter", opts.filter] : []),
    ],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  );
  output = run.stdout || "";
  if (run.error || !output) {
    console.error(`could not run the parity runner: ${run.error?.message || run.stderr}`);
    process.exit(2);
  }
} finally {
  fs.rmSync(standIn, { recursive: true, force: true });
}

// One verdict line per case, in order. Against the stand-in, "same" means the
// marker came back (handed back) and "DIFFER" means Rust answered itself.
const verdicts = output.split("\n").filter((line) => /^ {2}(same {4}|DIFFER {2}|BROKEN {2})/.test(line));
const cases = JSON.parse(fs.readFileSync(casesFile, "utf8")).cases.filter((c) => !opts.filter || c.name.includes(opts.filter));
if (verdicts.length !== cases.length) {
  console.error(`expected ${cases.length} verdicts from the runner, got ${verdicts.length}`);
  process.exit(2);
}

const wrong = [];
let native = 0;
let handedBack = 0;
cases.forEach((testCase, i) => {
  const verdict = verdicts[i].slice(2, 8).trim();
  const expected = testCase.handback ? "same" : "DIFFER";
  if (verdict === "DIFFER") native++;
  if (verdict === "same") handedBack++;
  if (verdict !== expected) {
    const got = verdict === "same" ? "was handed back" : verdict === "DIFFER" ? "was answered by Rust" : "could not be run";
    const want = testCase.handback ? `should be handed back (${testCase.handback})` : "should be answered by Rust";
    wrong.push(`  ${testCase.name}: ${got}, ${want}`);
  }
});

if (wrong.length) {
  console.log(wrong.join("\n"));
  console.log(`${wrong.length} of ${cases.length} case(s) are not answered by the side rs/parity.json names`);
  process.exit(1);
}
console.log(`${native} case(s) answered by the Rust binary, ${handedBack} handed back to the JavaScript, as rs/parity.json says`);

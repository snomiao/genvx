#!/usr/bin/env node
// Writes rs/parity.json, the parity cases for genvx (Rust against TypeScript).
//
//   node rs/parity.gen.mjs          # rewrite rs/parity.json
//   node rs/parity.gen.mjs --check  # fail if rs/parity.json is out of date
//
// The cases are generated because nearly every one needs the same scenery: a
// project repository with a remote, a local bare repository standing in for
// the gitstore, and a config file pointing at it. Everything is local; no case
// touches the network.
//
// Layout of one run (the runner gives every case its own directories):
//   <ROOT>/cwd         the project; the command runs here
//   <ROOT>/home        HOME
//   <ROOT>/store.git   the gitstore (a bare repository)
//   <ROOT>/seed-*      scratch used to fill a store before the command runs
//   <ROOT>/dec.mjs     decrypts a store file, so `after` can compare plaintext
//
// Encrypted output differs from run to run (random salt and IV), so no case
// compares ciphertext. Reading is proven with fixed ciphertexts written by
// the TypeScript (FIX below); writing is proven by decrypting what was pushed
// with node:crypto in an `after` probe and comparing the plaintext.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The store branch of a project: sha256 of "host/owner/repo", cut to 16 hex digits. */
const branchOf = (projectId) => "env/" + createHash("sha256").update(projectId).digest("hex").slice(0, 16);
const BRANCH = branchOf("github.com/acme/app"); // env/98d9fc12e0202ede
const REMOTE = "https://github.com/Acme/App.git";
const KEY = "test-key-1";

// Ciphertexts written once by the TypeScript `encrypt` (src/index.ts) for the
// project id github.com/acme/app. Plaintext and key are in the name/comment.
const FIX = {
  // "A=1\nB=two\n", key test-key-1
  env: "v2:17:Ly8B/efWVs6osRF6K0vaKexFpHIEZn57TD1iKcuLZEY=:zCnVWAbKhaYiHPrhWx/e+Q==:NxIJF9H+c8c/1/NhNGTtHA==:mdzyox9o8qc7FQ==",
  // "C=3\n", key test-key-1
  envLocal: "v2:17:KoHF1z7Mg8yGPATKR2E3gjXr7gI7DlrwqMfliaDNqgI=:xXDUIVTARbs8DUZLDZ2TTg==:TILyn4LrA7SQklqsJyjbJA==:qzqyMA==",
  // "D=4\n# note\nE = spaced \n", key test-key-1
  sub: "v2:17:W4J4qCy8MT1W5mn9gReBXN5w/6Uq7iSAJYxVmG34A3o=:JV00TWplj7TZGdx1m2cNNg==:V13WoXTFwxq0c6DH6UiChg==:VApQExpbaYB76Nr2MYHHpXjRzScbXmY=",
  // "A=1\nB=two\n", key test-key-1, scrypt N = 2^10
  envLogN10: "v2:10:wbPFJUoY/ji7cbdemk/M5vPTRmSXKdrui9n9dngzlzs=:42C/mKJI9X5EX4PGqw4Wqw==:EtrWy+GHC4D7Ze77vkKA0A==:RFXgrw5Ot/+mqQ==",
  // "A=1\nB=two\n", key test-key-1, the old v1 format (key derived from the project id)
  envV1: "bc4b0f705acc788635888c31d6025392:cc4aabfc052762ea2bc238c1a8e7179a:3b7a19544bc98adf27dd",
  // "A=1\nB=two\n", key other-key-2
  envOtherKey: "v2:17:14AeRvPnTOzyna2COTmpc6YPmKIEg7nWq3tPW15Gw1c=:WLKnSmQBeIkghUk1+18YiQ==:qEszZtKqn3mAJvOSq3nRmA==:l/BTX1ynRuLbvw==",
  // "", key test-key-1
  empty: "v2:17:yh8n2nxVb7ryVWXydDBh5N6h2fei1Trc5fcXvnbFhdg=:W3sNXUnTwAFxfG9KmkNCZg==:iTLPiMO6DkHSF2gsLgiH2Q==:",
  // "NAME=héllo→世界\nEMOJI=🚀\n", key test-key-1
  unicode: "v2:17:feYKdjiahPftK4NNP4DUQLYUwF+8zkTdRjoZLnbSg/s=:+5zQPX1r1uqaTPc1RGpZlA==:MwKUYUpL4W0ZcrBjE8fvzg==:MjOu3UvYdr5qL//8f4e8YdR2cdVyC0RB1tpIjSZXZWM=",
};

// Decrypts one store file read from stdin and prints the plaintext as JSON.
// It refuses anything that is not exactly what the TypeScript writes: v2,
// logN 17, canonical base64, a 32-byte salt, 16-byte IV and tag, no newline.
const DEC = `import { scryptSync, createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
const text = readFileSync(0, "utf8");
const parts = text.split(":");
const bad = (why) => { console.log("NOT THE EXPECTED FORMAT: " + why); process.exit(1); };
if (parts.length !== 6 || parts[0] !== "v2" || parts[1] !== "17") bad("header " + JSON.stringify(parts.slice(0, 2)));
const [salt, iv, tag, body] = parts.slice(2).map((p) => Buffer.from(p, "base64"));
parts.slice(2).forEach((p, i) => { if ([salt, iv, tag, body][i].toString("base64") !== p) bad("base64 of part " + (i + 2)); });
if (salt.length !== 32 || iv.length !== 16 || tag.length !== 16) bad("lengths " + [salt.length, iv.length, tag.length]);
const key = scryptSync(process.argv[2], salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const d = createDecipheriv("aes-256-gcm", key, iv);
d.setAuthTag(tag);
console.log(JSON.stringify(Buffer.concat([d.update(body), d.final()]).toString("utf8")));
`;

// ── scenery ────────────────────────────────────────────────────────────────

const IDENT = "git config --global user.name Parity && git config --global user.email parity@example.com";
const NO_IDENT = "git config --global user.useConfigOnly true";
const SEEDER = "git -c user.name=Seed -c user.email=seed@example.com";

/** The project repository in the case directory. */
const repo = (remote = REMOTE) => ["git init -q -b main", ...(remote ? [`git remote add origin ${remote}`] : [])];

/** A bare store at <ROOT>/<name>.git holding `tree` on `branch` (nothing if tree is null). */
function store(tree, { name = "store", branch = BRANCH } = {}) {
  const files = {};
  const setup = [`git init -q --bare ../${name}.git`];
  if (tree) {
    for (const [file, content] of Object.entries(tree)) files[`../seed-${name}/${file}`] = content;
    setup.push(
      `cd ../seed-${name} && git init -q && git checkout -q --orphan ${branch} && git add -A && ${SEEDER} commit -q -m seed && git push -q ../${name}.git ${branch}`,
    );
  }
  return { files, setup };
}

/** One more commit on top of a seeded store: `sh` runs in the seed directory. */
const storeCommit = (sh, { name = "store", branch = BRANCH } = {}) =>
  `cd ../seed-${name} && ${sh} && git add -A && ${SEEDER} commit -q -m "seed again" && git push -q ../${name}.git ${branch}`;

/** ~/.genvx/.env.local naming the store by absolute path, plus the key. */
const homeConfig = ({ name = "store", key = KEY } = {}) =>
  `mkdir -p ~/.genvx && printf 'GENVX_STORE=%s\\n${key === null ? "" : `GENVX_KEY=${key}\\n`}' "$(cd .. && pwd)/${name}.git" > ~/.genvx/.env.local`;

// ── probes ─────────────────────────────────────────────────────────────────

/** Everything in the project except the inside of .git directories. */
const TREE = "find . -name .git -prune -o -print | sort";
/** Everything in HOME except the JavaScript runtime's own cache (bun writes one; a native binary does not). */
const HOME_TREE = "find ~ -name .cache -prune -o -print | sort";
const perms = (...files) => `stat -c '%a %n' ${files.join(" ")}`;
const cat = (...files) => `for f in ${files.join(" ")}; do echo "== $f"; cat "$f"; echo "=="; done`;
const storeRefs = (name = "store") => `git -C ../${name}.git for-each-ref --format='%(refname)'`;
const storeLog = (name = "store", branch = BRANCH) => `git -C ../${name}.git log --format=%s ${branch}`;
const storeTree = (name = "store", branch = BRANCH) => `git -C ../${name}.git ls-tree -r --name-only ${branch}`;
const storeShow = (file, name = "store", branch = BRANCH) => `git -C ../${name}.git show ${branch}:${file}`;
const storeDec = (file, key = KEY, name = "store", branch = BRANCH) =>
  `git -C ../${name}.git show ${branch}:${file} | bun ../dec.mjs ${key}`;

const TIMING = ["\\[\\d+ms\\]", "[<N>ms]"];
const STAMP = ["\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-\\d{3}Z", "<STAMP>"];
const GENERATED_KEY = ["GENVX_KEY=[A-Za-z0-9+/]{43}=", "GENVX_KEY=<GENERATED>"];

// ── case builder ───────────────────────────────────────────────────────────

const cases = [];
/**
 * add(name, args, parts...) — each part is { files, setup, after, env, stdin,
 * normalize }; they are merged in order.
 */
function add(name, args, ...parts) {
  const c = { name, args, files: {}, setup: [], after: [], env: {}, normalize: [] };
  for (const part of parts.flat()) {
    if (!part) continue;
    Object.assign(c.files, part.files || {});
    c.setup.push(...(part.setup || []));
    c.after.push(...(part.after || []));
    Object.assign(c.env, part.env || {});
    c.normalize.push(...(part.normalize || []));
    if (part.stdin !== undefined) c.stdin = part.stdin;
  }
  for (const key of ["files", "setup", "after", "env", "normalize"]) {
    if (!Object.keys(c[key]).length) delete c[key];
  }
  if (cases.some((other) => other.name === name)) throw new Error(`duplicate case name: ${name}`);
  cases.push(c);
}
const files = (map) => ({ files: map });
const setup = (...lines) => ({ setup: lines.flat() });
const after = (...lines) => ({ after: lines.flat() });
const env = (map) => ({ env: map });
const dec = files({ "../dec.mjs": DEC });

/** The usual scene: project repo, identity, a store holding `tree`, home config. */
const scene = (tree, opts = {}) => [setup(IDENT, repo(opts.remote)), store(tree, opts), setup(homeConfig(opts))];

// ═══════════════════════════════ branch ════════════════════════════════════

add("branch: https remote", ["branch"], setup(repo()));
add("branch: alias b", ["b"], setup(repo()));
add("branch: ssh remote gives the same name as https", ["branch"], setup(repo("git@github.com:Acme/App.git")));
add("branch: no .git suffix, other letter case", ["branch"], setup(repo("https://GitHub.com/ACME/app")));
add("branch: http remote", ["branch"], setup(repo("http://github.com/Acme/App.git")));
add("branch: nested group path", ["branch"], setup(repo("https://gitlab.com/group/sub/repo.git")));
add("branch: remote with user and port", ["branch"], setup(repo("https://user@git.example.com:8443/o/r.git")));
add("branch: ssh remote on a host that is not .com is rejected", ["branch"], setup(repo("git@gitlab.example.org:team/app.git")));
add("branch: ssh:// remote is rejected", ["branch"], setup(repo("ssh://git@github.com/Acme/App.git")));
add("branch: local path remote is rejected", ["branch"], setup(repo("/srv/git/app.git")));
add("branch: remote with only a host and one segment is rejected", ["branch"], setup(repo("https://github.com/app.git")));
add("branch: url inside a longer string still matches", ["branch"], setup(repo("git+https://github.com/Acme/App.git")));
add("branch: remote with surrounding spaces in the config", ["branch"], setup("git init -q -b main", "git config remote.origin.url '  https://github.com/Acme/App.git  '"));
add("branch: not a git repository", ["branch"]);
add("branch: repository without origin", ["branch"], setup(repo(null)));
add("branch: from a subdirectory of the repository", ["branch"], setup("git init -q -b main ..", `git -C .. remote add origin ${REMOTE}`));
add("branch: ignores config and store settings", ["branch"], setup(repo()), env({ GENVX_STORE: "../nowhere.git", GENVX_KEY: "x" }));

// What bun loads from the directory before the program starts reaches git too.
const viaEnvConfig = (url) => `GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=remote.origin.url\nGIT_CONFIG_VALUE_0=${url}\n`;
add("branch: .env in the directory is in git's environment", ["branch"], setup(repo()), files({ ".env": viaEnvConfig("https://github.com/from/dotenv.git") }));
add(
  "branch: .env.development.local beats .env.local beats .env.development beats .env",
  ["branch"],
  setup(repo()),
  files({
    ".env": "GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=remote.origin.url\nGIT_CONFIG_VALUE_0=https://github.com/from/dotenv.git\n",
    ".env.development": "GIT_CONFIG_VALUE_0=https://github.com/from/development.git\n",
    ".env.local": "GIT_CONFIG_VALUE_0=https://github.com/from/local.git\n",
    ".env.development.local": "GIT_CONFIG_VALUE_0=https://github.com/from/development-local.git\n",
  }),
);
add(
  "branch: .env.local beats .env.development",
  ["branch"],
  setup(repo()),
  files({
    ".env": "GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=remote.origin.url\n",
    ".env.development": "GIT_CONFIG_VALUE_0=https://github.com/from/development.git\n",
    ".env.local": "GIT_CONFIG_VALUE_0=https://github.com/from/local.git\n",
  }),
);
add(
  "branch: .env.development beats .env",
  ["branch"],
  setup(repo()),
  files({
    ".env": viaEnvConfig("https://github.com/from/dotenv.git"),
    ".env.development": "GIT_CONFIG_VALUE_0=https://github.com/from/development.git\n",
  }),
);
add(
  "branch: the real environment beats .env",
  ["branch"],
  setup(repo()),
  files({ ".env": viaEnvConfig("https://github.com/from/dotenv.git") }),
  env({ GIT_CONFIG_VALUE_0: "https://github.com/from/real-env.git" }),
);
add(
  "branch: an empty variable in the real environment still beats .env",
  ["branch"],
  setup(repo()),
  files({ ".env": viaEnvConfig("https://github.com/from/dotenv.git") }),
  env({ GIT_CONFIG_COUNT: "" }),
);
add(
  "branch: .env with CRLF line ends, comments, blank lines, spaces around the value, no final newline",
  ["branch"],
  setup(repo()),
  files({ ".env": "# comment\r\n\r\nGIT_CONFIG_COUNT=1\r\nGIT_CONFIG_KEY_0=remote.origin.url  \r\nGIT_CONFIG_VALUE_0=\t https://github.com/from/crlf.git" }),
);
add(
  "branch: .env with a quoted value (bun strips the quotes)",
  ["branch"],
  setup(repo()),
  files({ ".env": 'GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0="remote.origin.url"\nGIT_CONFIG_VALUE_0=\'https://github.com/from/quoted.git\'\n' }),
);
add(
  "branch: .env with an inline comment and a $ reference",
  ["branch"],
  setup(repo()),
  files({ ".env": "OWNER=expanded\nGIT_CONFIG_COUNT=1 # one\nGIT_CONFIG_KEY_0=remote.origin.url\nGIT_CONFIG_VALUE_0=https://github.com/$OWNER/thing.git\n" }),
);
add(
  "branch: .env with export and indented lines",
  ["branch"],
  setup(repo()),
  files({ ".env": "export GIT_CONFIG_COUNT=1\n  GIT_CONFIG_KEY_0=remote.origin.url\nGIT_CONFIG_VALUE_0 = https://github.com/from/export.git\n" }),
);
add(
  "branch: NODE_ENV=production loads .env.production",
  ["branch"],
  setup(repo()),
  files({ ".env": viaEnvConfig("https://github.com/from/dotenv.git"), ".env.production": "GIT_CONFIG_VALUE_0=https://github.com/from/production.git\n" }),
  env({ NODE_ENV: "production" }),
);
add(
  "branch: NODE_ENV=test skips .env.local",
  ["branch"],
  setup(repo()),
  files({ ".env": viaEnvConfig("https://github.com/from/dotenv.git"), ".env.local": "GIT_CONFIG_VALUE_0=https://github.com/from/local.git\n" }),
  env({ NODE_ENV: "test" }),
);
add(
  "branch: NODE_ENV and BUN_ENV set in .env do not change which files load",
  ["branch"],
  setup(repo()),
  files({ ".env": "NODE_ENV=production\nBUN_ENV=production\n" + viaEnvConfig("https://github.com/from/dotenv.git"), ".env.production": "GIT_CONFIG_VALUE_0=https://github.com/from/production.git\n" }),
);
add("branch: bunfig.toml in the directory", ["branch"], setup(repo()), files({ "bunfig.toml": "# empty\n" }));
add("branch: .env is a directory", ["branch"], setup(repo(), "mkdir .env"));

// ═══════════════════════ where store and key come from ═════════════════════

// Two stores with different content show which one was used.
const twoStores = [store({ ".env.enc": FIX.env }), store({ ".env.local.enc": FIX.envLocal }, { name: "other" })];
const pulled = after(TREE, cat(".env", ".env.local"));

add("config: --gitstore <value>", ["pull", "--gitstore", "../other.git"], setup(repo()), twoStores, env({ GENVX_STORE: "../store.git", GENVX_KEY: KEY }), pulled, { normalize: [TIMING] });
add("config: --gitstore=<value>", ["pull", "--gitstore=../other.git"], setup(repo()), twoStores, env({ GENVX_STORE: "../store.git", GENVX_KEY: KEY }), pulled, { normalize: [TIMING] });
add("config: -g <value>", ["pull", "-g", "../other.git"], setup(repo()), twoStores, env({ GENVX_STORE: "../store.git", GENVX_KEY: KEY }), pulled, { normalize: [TIMING] });
add("config: flags before and after, -y", ["pull", "-y", "-g", "../other.git", "--no-encrypt"], setup(repo()), twoStores, env({ GENVX_KEY: KEY }), pulled, { normalize: [TIMING] });
add("config: GENVX_STORE from the environment", ["pull"], setup(repo()), twoStores, env({ GENVX_STORE: "../other.git", GENVX_KEY: KEY }), pulled, { normalize: [TIMING] });
add(
  "config: the environment beats every file",
  ["pull"],
  setup(repo(), homeConfig({ key: "wrong-key" })),
  twoStores,
  files({ ".env.local": "GENVX_STORE=../store.git\nGENVX_KEY=wrong-key\n" }),
  env({ GENVX_STORE: "../other.git", GENVX_KEY: KEY }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: ./.env.local beats ./.env",
  ["pull"],
  setup(repo()),
  twoStores,
  files({ ".env.local": `GENVX_STORE=../other.git\nGENVX_KEY=${KEY}\n`, ".env": "GENVX_STORE=../store.git\nGENVX_KEY=wrong-key\n" }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: ./.env beats GENVX_CONFIG_DIR",
  ["pull"],
  setup(repo()),
  twoStores,
  files({ ".env": `GENVX_STORE=../other.git\nGENVX_KEY=${KEY}\n`, "../cfg/.env.local": "GENVX_STORE=../store.git\nGENVX_KEY=wrong-key\n" }),
  env({ GENVX_CONFIG_DIR: "../cfg" }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: GENVX_CONFIG_DIR/.env.local beats GENVX_CONFIG_DIR/.env beats ~/.genvx",
  ["pull"],
  setup(repo(), homeConfig({ key: "wrong-key" })),
  twoStores,
  files({ "../cfg/.env.local": "GENVX_STORE=../other.git\n", "../cfg/.env": `GENVX_STORE=../store.git\nGENVX_KEY=${KEY}\n` }),
  env({ GENVX_CONFIG_DIR: "../cfg" }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: GENVX_CONFIG_DIR set in ./.env is honoured",
  ["pull"],
  setup(repo()),
  twoStores,
  files({ ".env": "GENVX_CONFIG_DIR=../cfg\n", "../cfg/.env": `GENVX_STORE=../other.git\nGENVX_KEY=${KEY}\n` }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: GENVX_CONFIG_DIR that does not exist",
  ["pull"],
  setup(repo(), homeConfig()),
  twoStores,
  env({ GENVX_CONFIG_DIR: "../missing" }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: ~/.genvx/.env.local beats ~/.genvx/.env",
  ["pull"],
  setup(repo(), "mkdir -p ~/.genvx", `printf 'GENVX_STORE=%s\\n' "$(cd .. && pwd)/other.git" > ~/.genvx/.env.local`, `printf 'GENVX_STORE=%s\\nGENVX_KEY=${KEY}\\n' "$(cd .. && pwd)/store.git" > ~/.genvx/.env`),
  twoStores,
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: an empty value in the environment is filled from a file",
  ["pull"],
  setup(repo(), homeConfig({ name: "other" })),
  twoStores,
  env({ GENVX_STORE: "", GENVX_KEY: "" }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: an empty value in ./.env.local is filled from ./.env",
  ["pull"],
  setup(repo()),
  twoStores,
  files({ ".env.local": "GENVX_STORE=\nGENVX_KEY=\n", ".env": `GENVX_STORE=../other.git\nGENVX_KEY=${KEY}\n` }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: key only in ./.env.development (loaded by bun, not by genvx)",
  ["pull"],
  setup(repo()),
  twoStores,
  files({ ".env.development": `GENVX_STORE=../other.git\nGENVX_KEY=${KEY}\n` }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: ./.env.local with a quoted key (bun strips the quotes)",
  ["pull"],
  setup(repo()),
  twoStores,
  files({ ".env.local": `GENVX_STORE="../other.git"\nGENVX_KEY='${KEY}'\n` }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: ./.env.local with an inline comment after the key",
  ["pull"],
  setup(repo()),
  twoStores,
  files({ ".env.local": `GENVX_STORE=../other.git # the other one\nGENVX_KEY=${KEY} #secret\n` }),
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: home file with comments, blank lines, spaces, CRLF and a BOM",
  ["pull"],
  setup(repo(), "mkdir -p ~/.genvx", `printf '\\357\\273\\277  GENVX_KEY = ${KEY}  \\r\\n# GENVX_KEY=wrong\\r\\n\\r\\nnot a setting\\r\\n\\tGENVX_STORE\\t=\\t%s\\t\\r\\n' "$(cd .. && pwd)/other.git" > ~/.genvx/.env.local`),
  twoStores,
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: home file keeps quotes as part of the key (wrong key)",
  ["pull"],
  setup(repo(), "mkdir -p ~/.genvx", `printf 'GENVX_STORE=%s\\nGENVX_KEY="${KEY}"\\n' "$(cd .. && pwd)/store.git" > ~/.genvx/.env.local`),
  twoStores,
  pulled,
);
add(
  "config: home file with `export` does not set the key",
  ["pull"],
  setup(repo(), "mkdir -p ~/.genvx", `printf 'GENVX_STORE=%s\\nexport GENVX_KEY=${KEY}\\n' "$(cd .. && pwd)/store.git" > ~/.genvx/.env.local`),
  twoStores,
  pulled,
);
add(
  "config: first value in a file wins over a later one",
  ["pull"],
  setup(repo(), "mkdir -p ~/.genvx", `printf 'GENVX_STORE=%s\\nGENVX_KEY=${KEY}\\nGENVX_KEY=wrong-key\\nGENVX_STORE=/nowhere.git\\n' "$(cd .. && pwd)/other.git" > ~/.genvx/.env.local`),
  twoStores,
  pulled,
  { normalize: [TIMING] },
);
add(
  "config: other variables in the home file reach git",
  ["pull"],
  setup("git init -q -b main", "git remote add origin https://github.com/from/repo-config.git", "mkdir -p ~/.genvx", `printf 'GENVX_STORE=%s\\nGENVX_KEY=${KEY}\\nGIT_CONFIG_COUNT=1\\nGIT_CONFIG_KEY_0=remote.origin.url\\nGIT_CONFIG_VALUE_0=${REMOTE}\\n' "$(cd .. && pwd)/other.git" > ~/.genvx/.env.local`),
  twoStores,
  pulled,
  { normalize: [TIMING] },
);
add("config: no store anywhere", ["pull"], setup(repo()), env({ GENVX_KEY: KEY }), after(TREE));
add("config: no store, push", ["push"], setup(repo()), files({ ".env": "A=1\n" }), after(TREE));
add("config: no store, diff", ["diff"], setup(repo()), after(TREE));
add("config: no key anywhere", ["pull"], setup(repo()), twoStores, env({ GENVX_STORE: "../store.git" }), after(TREE));
add("config: no key, push", ["push", "-g", "../store.git"], setup(repo()), twoStores, files({ ".env": "A=1\n" }), after(TREE));
add("config: no key, diff", ["diff", "-g", "../store.git"], setup(repo()), twoStores, after(TREE));
add("config: --no-encrypt does not lift the need for a key", ["push", "--no-encrypt", "-g", "../store.git"], setup(repo()), twoStores, files({ ".env": "A=1\n" }), after(TREE, storeLog()));
add("config: store set but not a git repository", ["pull"], env({ GENVX_STORE: "../store.git", GENVX_KEY: KEY }), after(TREE));
add("config: store set, repository has no origin", ["push"], setup(repo(null)), env({ GENVX_STORE: "../store.git", GENVX_KEY: KEY }), files({ ".env": "A=1\n" }), after(TREE));
add("config: remote that cannot be parsed", ["pull"], setup(repo("/srv/git/app.git")), twoStores, env({ GENVX_STORE: "../store.git", GENVX_KEY: KEY }), after(TREE));
add(
  "config: refuses to run in the gitstore repository itself",
  ["push"],
  setup(repo("https://github.com/Acme/Secrets.git")),
  env({ GENVX_STORE: "https://GitHub.com/acme/secrets", GENVX_KEY: KEY }),
  files({ ".env": "A=1\n" }),
  after(TREE),
);
add(
  "config: gitstore guard, pull and diff",
  ["diff", "--gitstore=https://github.com/Acme/Secrets"],
  setup(repo("https://github.com/acme/secrets.git")),
  env({ GENVX_KEY: KEY }),
  after(TREE),
);
add("config: home .env.local is a directory", ["pull"], setup(repo(), "mkdir -p ~/.genvx/.env.local"), twoStores, env({ GENVX_STORE: "../store.git", GENVX_KEY: KEY }), pulled, { normalize: [TIMING] });
add("config: bunfig.toml in the directory", ["pull"], setup(repo()), twoStores, files({ "bunfig.toml": "# empty\n" }), env({ GENVX_STORE: "../other.git", GENVX_KEY: KEY }), pulled, { normalize: [TIMING] });

// ═════════════════════════════════ pull ════════════════════════════════════

const threeFiles = { ".env.enc": FIX.env, ".env.local.enc": FIX.envLocal, "sub/.env.production.enc": FIX.sub };
const pulledThree = after(TREE, cat(".env", ".env.local", "sub/.env.production"), perms(".env", ".env.local", "sub/.env.production"));

add("pull: new files from an encrypted store", ["pull"], scene(threeFiles), pulledThree, { normalize: [TIMING] });
add("pull: -y", ["pull", "-y"], scene(threeFiles), pulledThree, { normalize: [TIMING] });
add("pull: --yes", ["pull", "--yes"], scene(threeFiles), pulledThree, { normalize: [TIMING] });
add("pull: alias load", ["load"], scene(threeFiles), pulledThree, { normalize: [TIMING] });
add("pull: with input on stdin", ["pull"], scene(threeFiles), { stdin: "n\n" }, pulledThree, { normalize: [TIMING] });
add(
  "pull: nothing to do",
  ["pull"],
  scene(threeFiles),
  files({ ".env": "A=1\nB=two\n", ".env.local": "C=3\n", "sub/.env.production": "D=4\n# note\nE = spaced \n" }),
  setup("chmod 644 .env"),
  after(TREE, perms(".env", ".env.local", "sub/.env.production")),
);
add(
  "pull: changed, added and removed variables",
  ["pull"],
  scene(threeFiles),
  files({ ".env": "B=2\nZ=local-only\nA=1\n", ".env.local": "C=3\n", "sub/.env.production": "E=other\n" }),
  setup("chmod 644 .env sub/.env.production"),
  pulledThree,
  { normalize: [TIMING] },
);
add(
  "pull: only formatting differs",
  ["pull"],
  scene({ ".env.enc": FIX.env }),
  files({ ".env": "# a comment\nB=two\n\nA=1" }),
  after(TREE, cat(".env"), perms(".env")),
  { normalize: [TIMING] },
);
add("pull: extra local files are left alone", ["pull"], scene({ ".env.enc": FIX.env }), files({ ".env.other": "X=1\n", "notes.txt": "hi\n" }), after(TREE, cat(".env", ".env.other"), perms(".env", ".env.other")), { normalize: [TIMING] });
add("pull: store has no branch for this project", ["pull"], scene(null), after(TREE, storeRefs()));
add("pull: store has another project's branch only", ["pull"], scene({ ".env.enc": FIX.env }, { branch: "env/0000000000000000" }), after(TREE, storeRefs()));
add("pull: store path does not exist", ["pull"], setup(IDENT, repo(), homeConfig({ name: "missing" })), after(TREE));
add(
  "pull: no branch and no git identity leaves the working directory behind",
  ["pull"],
  setup(NO_IDENT, repo()),
  store(null),
  setup(homeConfig()),
  after(TREE, "ls -A .genvx/gitstore", "cat .genvx/.gitignore"),
);
add("pull: wrong key leaves the working directory behind", ["pull"], scene({ ".env.enc": FIX.envOtherKey }), after(TREE, "cat .genvx/.gitignore"));
add("pull: wrong key with node_modules present", ["pull"], scene({ ".env.enc": FIX.envOtherKey }), setup("mkdir node_modules"), after(TREE));
add("pull: node_modules present", ["pull"], scene(threeFiles), setup("mkdir node_modules"), pulledThree, { normalize: [TIMING] });
add("pull: old v1 format", ["pull"], scene({ ".env.enc": FIX.envV1 }), after(TREE, cat(".env")), { normalize: [TIMING] });
add("pull: v1 format depends on the project (other remote cannot read it)", ["pull"], scene({ ".env.enc": FIX.envV1 }, { remote: "https://github.com/Acme/Other.git", branch: branchOf("github.com/acme/other") }), after(TREE));
add("pull: v2 with another scrypt cost", ["pull"], scene({ ".env.enc": FIX.envLogN10 }), after(TREE, cat(".env")), { normalize: [TIMING] });
add("pull: empty file", ["pull"], scene({ ".env.enc": FIX.empty }), after(TREE, cat(".env"), perms(".env")), { normalize: [TIMING] });
add("pull: unicode content", ["pull"], scene({ ".env.enc": FIX.unicode }), after(TREE, cat(".env")), { normalize: [TIMING] });
add("pull: ciphertext with a final newline", ["pull"], scene({ ".env.enc": FIX.env + "\n" }), after(TREE, cat(".env")), { normalize: [TIMING] });
add("pull: ciphertext with CRLF and spaces around it", ["pull"], scene({ ".env.enc": " " + FIX.env + " \r\n" }), after(TREE), { normalize: [TIMING] });
add("pull: v1 ciphertext with a final newline", ["pull"], scene({ ".env.enc": FIX.envV1 + "\n" }), after(TREE, cat(".env")), { normalize: [TIMING] });
add("pull: tampered ciphertext", ["pull"], scene({ ".env.enc": FIX.env.replace("mdzy", "mdzz") }), after(TREE));
add("pull: tampered tag", ["pull"], scene({ ".env.enc": FIX.env.replace("NxIJ", "NxIK") }), after(TREE));
add("pull: truncated tag", ["pull"], scene({ ".env.enc": FIX.env.replace("NxIJF9H+c8c/1/NhNGTtHA==", "NxIJF9H+c8c/1/Nh") }), after(TREE), { normalize: [TIMING] });
add("pull: not ciphertext at all", ["pull"], scene({ ".env.enc": "A=1\n" }), after(TREE));
add("pull: v2 with a part missing", ["pull"], scene({ ".env.enc": FIX.env.split(":").slice(0, 5).join(":") }), after(TREE));
add("pull: v2 with an unusable scrypt cost", ["pull"], scene({ ".env.enc": FIX.env.replace("v2:17:", "v2:18:") }), after(TREE));
add("pull: v2 with a cost that is not a number", ["pull"], scene({ ".env.enc": FIX.env.replace("v2:17:", "v2:x:") }), after(TREE));
add("pull: v2 with a cost followed by junk", ["pull"], scene({ ".env.enc": FIX.envLogN10.replace("v2:10:", "v2: 10abc:") }), after(TREE, cat(".env")), { normalize: [TIMING] });
add("pull: empty store file", ["pull"], scene({ ".env.enc": "" }), after(TREE));
add(
  "pull: plaintext store, changed file (copied without listing the variables)",
  ["pull"],
  scene({ ".env": "A=1\nB=two\n" }),
  files({ ".env": "A=0\n" }),
  setup("chmod 644 .env"),
  after(TREE, cat(".env"), perms(".env")),
  { normalize: [TIMING] },
);
add("pull: plaintext store, new file", ["pull"], scene({ ".env": "A=1\nB=two\n" }), after(TREE));
add("pull: plaintext store, nothing to do", ["pull"], scene({ ".env": "A=1\nB=two\n" }), files({ ".env": "A=1\nB=two\n" }), after(TREE));
add(
  "pull: store with plaintext and encrypted files uses the encrypted ones",
  ["pull"],
  scene({ ".env.enc": FIX.env, ".env.local": "PLAIN=1\n" }),
  after(TREE, cat(".env")),
  { normalize: [TIMING] },
);
add(
  "pull: store files in skipped directories are not seen",
  ["pull"],
  scene({ ".env.enc": FIX.env, "node_modules/.env.enc": FIX.envLocal, "dist/.env.enc": FIX.envLocal, "target/.env.enc": FIX.envLocal, "deep/er/.env.enc": FIX.envLocal }),
  after(TREE, cat(".env", "deep/er/.env")),
  { normalize: [TIMING] },
);
add(
  "pull: a working directory left by an earlier run is updated, not cloned again",
  ["pull"],
  setup(IDENT, repo()),
  store({ ".env.enc": FIX.envOtherKey }),
  setup(homeConfig(), `mkdir -p .genvx && git clone -q --single-branch --depth 1 -b ${BRANCH} ../store.git .genvx/gitstore`, storeCommit(`printf '%s' '${FIX.env}' > .env.enc`)),
  after(TREE, cat(".env")),
  { normalize: [TIMING] },
);
add(
  "pull: earlier backups are kept by the clean-up",
  ["pull"],
  scene({ ".env.enc": FIX.env }),
  files({ ".genvx/backups/2026-01-01T00-00-00-000Z/.env": "OLD=1\n", ".genvx/stray.txt": "x\n" }),
  after(TREE, cat(".env", ".genvx/.gitignore")),
  { normalize: [TIMING] },
);
add(
  "pull: local file is a symlink",
  ["pull"],
  scene({ ".env.enc": FIX.env }),
  files({ "real.txt": "A=0\n" }),
  setup("ln -s real.txt .env", "chmod 644 real.txt"),
  after(TREE, "ls -l .env | cut -d' ' -f1,10-", cat("real.txt"), perms("real.txt")),
  { normalize: [TIMING] },
);
add("pull: GENVX_NO_NATIVE=1", ["pull"], scene(threeFiles), env({ GENVX_NO_NATIVE: "1" }), pulledThree, { normalize: [TIMING] });

// ═════════════════════════════════ diff ════════════════════════════════════

add("diff: nothing on either side", ["diff"], scene(null), after(TREE, storeRefs()));
add("diff: alias d", ["d"], scene(null), after(TREE));
add("diff: remote files only", ["diff"], scene(threeFiles), after(TREE));
add("diff: local files only", ["diff"], scene(null), files({ ".env": "A=1\nB=two\n", "sub/.env.production": "D=4\n" }), after(TREE, perms(".env")));
add("diff: both sides equal", ["diff"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=1\nB=two\n" }), after(TREE));
add(
  "diff: both sides differ",
  ["diff"],
  scene(threeFiles),
  files({ ".env": "B=2\nZ=local-only\nA=1\n", ".env.staging": "S=1\n", "sub/.env.production": "# note\nD=4\nE = spaced \n" }),
  after(TREE, cat(".env")),
);
add("diff: -y and --no-encrypt are accepted", ["diff", "-y", "--no-encrypt"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=2\n" }), after(TREE));
add("diff: wrong key", ["diff"], scene({ ".env.enc": FIX.envOtherKey }), files({ ".env": "A=1\n" }), after(TREE));
add("diff: plaintext store, new remote file", ["diff"], scene({ ".env": "A=1\n" }), files({ ".env.local": "L=1\n" }), after(TREE));
add("diff: plaintext store, changed file", ["diff"], scene({ ".env": "A=1\n" }), files({ ".env": "A=2\n" }), after(TREE));
add("diff: no git identity and no branch", ["diff"], setup(NO_IDENT, repo()), store(null), setup(homeConfig()), files({ ".env": "A=1\n" }), after(TREE));
add("diff: GENVX_NO_NATIVE=1", ["diff"], scene(threeFiles), files({ ".env": "A=2\n" }), env({ GENVX_NO_NATIVE: "1" }), after(TREE));

// ═════════════════════════════════ push ════════════════════════════════════

const pushedState = (...encFiles) => after(TREE, storeLog(), storeTree(), ...encFiles.map((f) => storeDec(f)));

add(
  "push: first push creates the project's branch",
  ["push"],
  scene(null),
  dec,
  files({ ".env": "A=1\nB=two\n", ".env.local": "C=3\n", "sub/.env.production": "D=4\n# note\nE = spaced \n" }),
  setup("chmod 644 .env .env.local sub/.env.production"),
  pushedState(".env.enc", ".env.local.enc", "sub/.env.production.enc"),
  after(perms(".env", ".env.local", "sub/.env.production"), storeRefs()),
  { normalize: [TIMING] },
);
for (const [label, args] of [["-y", ["push", "-y"]], ["--yes", ["push", "--yes"]], ["alias p", ["p"]], ["alias save", ["save"]], ["--no-encrypt still encrypts", ["push", "--no-encrypt"]]]) {
  add(`push: ${label}`, args, scene(null), dec, files({ ".env": "A=1\n" }), pushedState(".env.enc"), { normalize: [TIMING] });
}
add("push: with input on stdin", ["push"], scene(null), dec, files({ ".env": "A=1\n" }), { stdin: "n\n" }, pushedState(".env.enc"), { normalize: [TIMING] });
add(
  "push: changed, added and removed variables; untouched files are not rewritten",
  ["push"],
  scene(threeFiles),
  dec,
  files({ ".env": "B=2\nZ=new\n", ".env.local": "C=3\n", ".env.staging": "S=1\nT=2\n", "sub/.env.production": "D=4\n# note\nE = spaced \n" }),
  setup("chmod 644 .env .env.local .env.staging"),
  pushedState(".env.enc", ".env.staging.enc"),
  after(storeShow(".env.local.enc"), storeShow("sub/.env.production.enc"), perms(".env", ".env.local", ".env.staging")),
  { normalize: [TIMING] },
);
add("push: only formatting differs", ["push"], scene({ ".env.enc": FIX.env }), dec, files({ ".env": "# a comment\nB=two\n\nA=1" }), pushedState(".env.enc"), { normalize: [TIMING] });
add("push: nothing to do", ["push"], scene(threeFiles), files({ ".env": "A=1\nB=two\n", ".env.local": "C=3\n" }), setup("chmod 644 .env"), after(TREE, storeLog(), storeShow(".env.enc"), perms(".env")));
add("push: no local env files", ["push"], scene(threeFiles), files({ "notes.txt": "hi\n" }), after(TREE, storeLog()));
add("push: no local env files and no branch yet", ["push"], scene(null), after(TREE, storeRefs()));
add(
  "push: which files count",
  ["push"],
  scene(null),
  dec,
  files({
    ".env": "A=1\n",
    ".envrc": "export X=1\n",
    ".env.example": "EX=\n",
    ".environment": "Y=2\n",
    "x.env": "NO=1\n",
    "env": "NO=1\n",
    ".Env": "NO=1\n",
    "a/b/.env": "DEEP=1\n",
    "node_modules/pkg/.env": "NO=1\n",
    "dist/.env": "NO=1\n",
    "build/.env": "NO=1\n",
    "out/.env": "NO=1\n",
    ".next/.env": "NO=1\n",
    ".nuxt/.env": "NO=1\n",
    ".output/.env": "NO=1\n",
    ".cache/.env": "NO=1\n",
    ".venv/.env": "NO=1\n",
    "venv/.env": "NO=1\n",
    "__pycache__/.env": "NO=1\n",
    ".pytest_cache/.env": "NO=1\n",
    "target/.env": "NO=1\n",
    "vendor/.env": "NO=1\n",
    "a/vendor/.env": "NO=1\n",
    "nested-repo/.env": "NO=1\n",
    ".env.d/.env": "INDIR=1\n",
    ".env.d/other": "NO=1\n",
  }),
  setup("git init -q nested-repo"),
  after(storeTree(), storeDec(".envrc.enc"), storeDec(".env.d/.env.enc")),
  { normalize: [TIMING] },
);
add(
  "push: how variables are read for the listing",
  ["push"],
  scene({ ".env.enc": FIX.env }),
  dec,
  files({
    ".env": "A=1\r\nB = two\r\n  C=3  \nexport D=4\n#E=5\nF\n=G\nH=\nA=again\nI=a=b\n\"J\"='k'\n",
    ".env.new": "ONE=1\n# c\n\nTWO = 2\nONE=3\nexport THREE=3\nnoequals\n",
  }),
  pushedState(".env.enc", ".env.new.enc"),
  { normalize: [TIMING] },
);
add("push: unicode content", ["push"], scene(null), dec, files({ ".env": "NAME=héllo→世界\nEMOJI=🚀\nKÉY=1\n" }), pushedState(".env.enc"), { normalize: [TIMING] });
add("push: bytes that are not UTF-8 are replaced", ["push"], scene(null), dec, setup("printf 'A=\\377\\nB=\\303(\\nC=\\342\\202\\n' > .env"), pushedState(".env.enc"), { normalize: [TIMING] });
add("push: file starting with a BOM", ["push"], scene(null), dec, setup("printf '\\357\\273\\277A=1\\nB=2\\n' > .env"), pushedState(".env.enc"), { normalize: [TIMING] });
add("push: empty file", ["push"], scene(null), dec, files({ ".env": "" }), pushedState(".env.enc"), { normalize: [TIMING] });
add(
  "push: local file is a symlink",
  ["push"],
  scene(null),
  dec,
  files({ "real.txt": "A=1\n" }),
  setup("ln -s real.txt .env.link", "chmod 644 real.txt"),
  pushedState(".env.link.enc"),
  after(perms("real.txt")),
  { normalize: [TIMING] },
);
add("push: a local .enc file is encrypted again under a longer name", ["push"], scene(null), dec, files({ ".env.enc": "RAW=1\n" }), pushedState(".env.enc.enc"), { normalize: [TIMING] });
add("push: wrong key for what is already stored", ["push"], scene({ ".env.enc": FIX.envOtherKey }), files({ ".env": "A=1\n" }), after(TREE, storeLog(), storeShow(".env.enc")));
add("push: wrong key does not matter for files that are new", ["push"], scene({ ".env.enc": FIX.envOtherKey }), dec, files({ ".env.local": "C=3\n" }), pushedState(".env.local.enc"), after(storeShow(".env.enc")), { normalize: [TIMING] });
add(
  "push: plaintext files already in the store stay beside the encrypted ones",
  ["push"],
  scene({ ".env": "A=0\n" }),
  dec,
  files({ ".env": "A=1\n" }),
  pushedState(".env.enc"),
  after(storeShow(".env")),
  { normalize: [TIMING] },
);
add("push: node_modules present", ["push"], scene({ ".env.enc": FIX.env }), dec, files({ ".env": "A=2\n" }), setup("mkdir node_modules"), pushedState(".env.enc"), { normalize: [TIMING] });
add(
  "push: store path does not exist",
  ["push"],
  setup(IDENT, repo(), homeConfig({ name: "missing" })),
  files({ ".env": "A=1\n" }),
  after(TREE, "git -C .genvx/gitstore log --format=%s", "git -C .genvx/gitstore remote -v"),
  { normalize: [TIMING] },
);
add(
  "push: relative store path fails on the first push",
  ["push", "--gitstore", "../store.git"],
  setup(IDENT, repo()),
  store(null),
  env({ GENVX_KEY: KEY }),
  files({ ".env": "A=1\n" }),
  after(TREE, storeRefs()),
  { normalize: [TIMING] },
);
add(
  "push: relative store path works once the branch exists",
  ["push", "--gitstore=../store.git"],
  setup(IDENT, repo()),
  store({ ".env.enc": FIX.env }),
  dec,
  env({ GENVX_KEY: KEY }),
  files({ ".env": "A=2\n" }),
  pushedState(".env.enc"),
  { normalize: [TIMING] },
);
add(
  "push: no git identity, branch exists",
  ["push"],
  setup(NO_IDENT, repo()),
  store({ ".env.enc": FIX.env }),
  setup(homeConfig()),
  files({ ".env": "A=2\n" }),
  after(TREE, storeLog()),
  { normalize: [TIMING] },
);
add(
  "push: no git identity, no branch",
  ["push"],
  setup(NO_IDENT, repo()),
  store(null),
  setup(homeConfig()),
  files({ ".env": "A=2\n" }),
  after(TREE, storeRefs()),
);
add(
  "push: a global gitignore that hides env files makes the commit fail",
  ["push"],
  scene({ ".env.enc": FIX.env }),
  setup("echo '.env*' > ~/.gitignore_global && git config --global core.excludesFile ~/.gitignore_global"),
  files({ ".env.local": "C=3\n" }),
  after(TREE, storeLog()),
  { normalize: [TIMING] },
);
add(
  "push: a working directory left by an earlier run is reused",
  ["push"],
  setup(IDENT, repo()),
  store({ ".env.enc": FIX.env }),
  dec,
  setup(homeConfig(), `mkdir -p .genvx && git clone -q --single-branch --depth 1 -b ${BRANCH} ../store.git .genvx/gitstore`, storeCommit(`printf '%s' '${FIX.envLocal}' > .env.local.enc`)),
  files({ ".env": "A=2\n", ".env.local": "C=3\n" }),
  pushedState(".env.enc"),
  after(storeShow(".env.local.enc")),
  { normalize: [TIMING] },
);
add(
  "push: earlier backups are kept by the clean-up",
  ["push"],
  scene(null),
  dec,
  files({ ".env": "A=1\n", ".genvx/backups/2026-01-01T00-00-00-000Z/.env": "OLD=1\n", ".genvx/stray.txt": "x\n" }),
  pushedState(".env.enc"),
  { normalize: [TIMING] },
);
add("push: GENVX_NO_NATIVE=1", ["push"], scene(null), dec, files({ ".env": "A=1\n" }), env({ GENVX_NO_NATIVE: "1" }), pushedState(".env.enc"), { normalize: [TIMING] });

// ═══════════════════════════════ hooks run ═════════════════════════════════

const hookState = after(TREE, cat(".env"), perms(".env"));
add(
  "hooks run: pulls changed files and backs up what it overwrites",
  ["hooks", "run", "post-merge"],
  scene(threeFiles),
  files({ ".env": "A=0\n", ".env.local": "C=3\n" }),
  setup("chmod 640 .env"),
  after(TREE, cat(".env", ".env.local", "sub/.env.production", ".genvx/.gitignore"), "cat .genvx/backups/*/.env", perms(".env", ".env.local", "sub/.env.production"), "stat -c '%a' .genvx/backups/*/.env"),
  { normalize: [STAMP] },
);
add("hooks run: no event name", ["hooks", "run"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), hookState, { normalize: [STAMP] });
add("hooks run: post-checkout", ["hooks", "run", "post-checkout"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), hookState, { normalize: [STAMP] });
add("hooks run: only new files, so no backup directory stays", ["hooks", "run", "post-merge"], scene(threeFiles), after(TREE, cat(".env", "sub/.env.production"), perms(".env", "sub/.env.production")));
add("hooks run: backup of a file in a subdirectory", ["hooks", "run", "post-merge"], scene(threeFiles), files({ "sub/.env.production": "D=0\n" }), after(TREE, "cat .genvx/backups/*/sub/.env.production", cat("sub/.env.production")), { normalize: [STAMP] });
add("hooks run: nothing to do", ["hooks", "run", "post-merge"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=1\nB=two\n" }), hookState);
add("hooks run: not configured", ["hooks", "run", "post-merge"], setup(repo()), files({ ".env": "A=0\n" }), hookState);
add("hooks run: not configured, stale working directory is removed", ["hooks", "run", "post-merge"], setup(repo()), files({ ".genvx/stray.txt": "x\n" }), after(TREE));
add("hooks run: no key", ["hooks", "run", "post-merge"], setup(IDENT, repo(), homeConfig({ key: null })), store({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), hookState);
add("hooks run: wrong key is silent and cleans up", ["hooks", "run", "post-merge"], scene({ ".env.enc": FIX.envOtherKey }), files({ ".env": "A=0\n" }), hookState);
add("hooks run: not a git repository", ["hooks", "run", "post-merge"], store({ ".env.enc": FIX.env }), setup(homeConfig()), after(TREE));
add("hooks run: repository without origin", ["hooks", "run", "post-merge"], setup(repo(null)), store({ ".env.enc": FIX.env }), setup(homeConfig()), after(TREE));
add("hooks run: remote that cannot be parsed", ["hooks", "run", "post-merge"], scene({ ".env.enc": FIX.env }, { remote: "/srv/git/app.git" }), after(TREE));
add("hooks run: in the gitstore repository itself", ["hooks", "run", "post-merge"], setup(repo("https://github.com/Acme/Secrets.git")), env({ GENVX_STORE: "https://github.com/acme/secrets", GENVX_KEY: KEY }), files({ ".genvx/stray.txt": "x\n" }), after(TREE));
add("hooks run: store has no branch for this project", ["hooks", "run", "post-merge"], scene(null), files({ ".env": "A=0\n" }), hookState);
add("hooks run: no branch and no git identity", ["hooks", "run", "post-merge"], setup(NO_IDENT, repo()), store(null), setup(homeConfig()), after(TREE));
add("hooks run: plaintext store, new and changed files", ["hooks", "run", "post-merge"], scene({ ".env": "A=1\n", ".env.local": "L=1\n" }), files({ ".env": "A=0\n" }), after(TREE, cat(".env", ".env.local"), "cat .genvx/backups/*/.env", perms(".env", ".env.local")), { normalize: [STAMP] });
add(
  "hooks run: earlier backups are kept",
  ["hooks", "run", "post-merge"],
  scene({ ".env.enc": FIX.env }),
  files({ ".env": "A=0\n", ".genvx/backups/2026-01-01T00-00-00-000Z/.env": "OLD=1\n", ".genvx/.gitignore": "custom\n" }),
  after(TREE, cat(".genvx/.gitignore", ".genvx/backups/2026-01-01T00-00-00-000Z/.env")),
  { normalize: [["2026-01-01T00-00-00-000Z", "<OLD>"], STAMP] },
);
add("hooks run: node_modules present", ["hooks", "run", "post-merge"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), setup("mkdir node_modules"), after(TREE, "cat node_modules/.genvx/backups/*/.env"), { normalize: [STAMP] });
add("hooks run: store from the flag is not used", ["hooks", "run", "post-merge"], setup(IDENT, repo()), store({ ".env.enc": FIX.env }), env({ GENVX_KEY: KEY }), files({ ".env": "A=0\n" }), hookState);
add("hooks run: GENVX_NO_NATIVE=1", ["hooks", "run", "post-merge"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), env({ GENVX_NO_NATIVE: "1" }), hookState, { normalize: [STAMP] });

// ══════════════════════════════ hooks status ═══════════════════════════════

const BLOCK = (event) =>
  `# >>> genvx auto-sync >>>\ncommand -v genvx >/dev/null 2>&1 || exit 0\n${event === "post-checkout" ? '[ "$3" = "1" ] || exit 0  # only on branch checkout\n' : ""}genvx hooks run ${event} || true\n# <<< genvx auto-sync <<<\n`;
const LEFTHOOK_BLOCK =
  "# >>> genvx auto-sync >>>\npost-merge:\n  commands:\n    genvx-pull:\n      run: genvx hooks run post-merge\npost-checkout:\n  commands:\n    genvx-pull:\n      run: genvx hooks run post-checkout\n# <<< genvx auto-sync <<<\n";

add("hooks status: not a git repository", ["hooks", "status"]);
add("hooks status: fresh repository", ["hooks", "status"], setup(repo()));
add("hooks status: husky", ["hooks", "status"], setup(repo(), "git config core.hooksPath .husky/_"));
add("hooks status: custom hooks path", ["hooks", "status"], setup(repo(), "git config core.hooksPath .githooks"));
add("hooks status: hooks path set globally, outside a repository", ["hooks", "status"], setup("git config --global core.hooksPath /somewhere/hooks"));
for (const name of ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"]) {
  add(`hooks status: ${name}`, ["hooks", "status"], setup(repo()), files({ [name]: "pre-commit:\n" }));
}
add("hooks status: lefthook config and a hooks path", ["hooks", "status"], setup(repo(), "git config core.hooksPath hooks"), files({ "lefthook.yml": "" }));
add(
  "hooks status: installed everywhere",
  ["hooks", "status"],
  setup(repo()),
  files({
    ".git/hooks/post-merge": "#!/bin/sh\n" + BLOCK("post-merge"),
    ".git/hooks/post-checkout": "#!/bin/sh\n" + BLOCK("post-checkout"),
    ".husky/post-merge": BLOCK("post-merge"),
    ".husky/post-checkout": "echo hi\n" + BLOCK("post-checkout"),
    ".githooks/post-merge": BLOCK("post-merge"),
    ".githooks/post-checkout": BLOCK("post-checkout"),
    "lefthook-local.yml": LEFTHOOK_BLOCK,
  }),
);
add(
  "hooks status: installed in some places",
  ["hooks", "status"],
  setup(repo()),
  files({ ".git/hooks/post-checkout": "#!/bin/sh\n" + BLOCK("post-checkout"), ".git/hooks/post-merge": "#!/bin/sh\necho other\n", ".githooks/post-merge": "x # >>> genvx auto-sync >>> y\n", "lefthook-local.yml": "other: 1\n" }),
);
add("hooks status: from a subdirectory", ["hooks", "status"], setup("git init -q -b main ..", "mkdir -p ../.git/hooks ../.githooks"), files({ "../.git/hooks/post-merge": BLOCK("post-merge"), "../.githooks/post-merge": BLOCK("post-merge"), ".githooks/post-checkout": BLOCK("post-checkout") }));
add("hooks status: GENVX_NO_NATIVE=1", ["hooks", "status"], setup(repo()), env({ GENVX_NO_NATIVE: "1" }));

// ══════════════════════════════ hooks install ══════════════════════════════

const hookFiles = (dir) => after(cat(`${dir}/post-merge`, `${dir}/post-checkout`), perms(`${dir}/post-merge`, `${dir}/post-checkout`));
const hooksPath = after("git config --get core.hooksPath");

add("hooks install: fresh repository (local)", ["hooks", "install"], setup(repo()), hookFiles(".git/hooks"), hooksPath, after(TREE));
add("hooks install: --mode auto", ["hooks", "install", "--mode", "auto"], setup(repo()), hookFiles(".git/hooks"));
add("hooks install: --mode=local", ["hooks", "install", "--mode=local"], setup(repo()), hookFiles(".git/hooks"));
add("hooks install: flag before the action", ["hooks", "--mode=local", "install"], setup(repo()), hookFiles(".git/hooks"));
add("hooks install: not a git repository", ["hooks", "install"], after(TREE));
add("hooks install: not a git repository, --mode shared", ["hooks", "install", "--mode", "shared"], after(TREE));
add(
  "hooks install: appends to existing hooks",
  ["hooks", "install"],
  setup(repo(), "chmod 700 .git/hooks/post-merge"),
  files({ ".git/hooks/post-merge": "#!/bin/bash\necho merged", ".git/hooks/post-checkout": "#!/bin/sh\necho checked out\n" }),
  hookFiles(".git/hooks"),
);
add(
  "hooks install: refreshes its own block and keeps the rest",
  ["hooks", "install"],
  setup(repo()),
  files({
    ".git/hooks/post-merge": "#!/bin/sh\necho before\n  # >>> genvx auto-sync >>>  \nold line\n# <<< genvx auto-sync <<<\necho after\n",
    ".git/hooks/post-checkout": "#!/bin/sh\n" + BLOCK("post-checkout"),
  }),
  hookFiles(".git/hooks"),
);
add("hooks install: hook file that is empty or blank", ["hooks", "install"], setup(repo()), files({ ".git/hooks/post-merge": "", ".git/hooks/post-checkout": "\n  \n" }), hookFiles(".git/hooks"));
add("hooks install: block with no end marker swallows the rest", ["hooks", "install"], setup(repo()), files({ ".git/hooks/post-merge": "#!/bin/sh\necho keep\n# >>> genvx auto-sync >>>\necho lost\n" }), hookFiles(".git/hooks"));
add("hooks install: --mode local under husky warns", ["hooks", "install", "--mode", "local"], setup(repo(), "git config core.hooksPath .husky/_"), hookFiles(".git/hooks"), hooksPath);
add("hooks install: --mode local with a custom hooks path warns", ["hooks", "install", "--mode=local"], setup(repo(), "git config core.hooksPath my-hooks"), hookFiles(".git/hooks"), hooksPath);
add("hooks install: --mode local with lefthook warns", ["hooks", "install", "--mode=local"], setup(repo()), files({ "lefthook.yml": "" }), hookFiles(".git/hooks"), after(TREE));
add("hooks install: husky (shared, in .husky)", ["hooks", "install"], setup(repo(), "git config core.hooksPath .husky/_"), files({ ".husky/pre-commit": "npm test\n", "package.json": '{"name":"x"}\n' }), hookFiles(".husky"), hooksPath, after(cat("package.json"), TREE));
add("hooks install: custom hooks path (shared, repoints it at .githooks)", ["hooks", "install"], setup(repo(), "git config core.hooksPath my-hooks"), hookFiles(".githooks"), hooksPath, after(TREE));
add("hooks install: --mode shared", ["hooks", "install", "--mode", "shared"], setup(repo()), hookFiles(".githooks"), hooksPath, after(TREE));
add("hooks install: --mode shared adds a prepare script to package.json", ["hooks", "install", "--mode=shared"], setup(repo()), files({ "package.json": '{"name":"x","version":"1.0.0","scripts":{"test":"echo"},"n":1.50,"1":true}' }), hookFiles(".githooks"), hooksPath, after(cat("package.json")));
add("hooks install: --mode shared keeps an existing prepare script", ["hooks", "install", "--mode=shared"], setup(repo()), files({ "package.json": '{"name":"x",\n   "scripts":{"prepare":"husky"}}' }), hookFiles(".githooks"), after(cat("package.json")));
add("hooks install: --mode shared with a package.json that is not JSON", ["hooks", "install", "--mode=shared"], setup(repo()), files({ "package.json": "{nope" }), hookFiles(".githooks"), after(cat("package.json")));
add("hooks install: --mode shared from a subdirectory", ["hooks", "install", "--mode=shared"], setup("git init -q -b main .."), after("cat ../.githooks/post-merge", "git config --get core.hooksPath", TREE));
add("hooks install: lefthook", ["hooks", "install"], setup(repo()), files({ "lefthook.yml": "pre-commit:\n" }), after(cat("lefthook-local.yml", ".gitignore"), TREE));
add("hooks install: --mode lefthook without a lefthook config", ["hooks", "install", "--mode", "lefthook"], setup(repo()), after(cat("lefthook-local.yml", ".gitignore"), TREE));
add(
  "hooks install: lefthook with existing local config and .gitignore",
  ["hooks", "install"],
  setup(repo()),
  files({ ".lefthook.yaml": "", "lefthook-local.yml": "pre-push:\n  commands: {}", ".gitignore": "node_modules\n  dist  " }),
  after(cat("lefthook-local.yml", ".gitignore")),
);
add(
  "hooks install: lefthook refreshes its block; .gitignore already lists the file",
  ["hooks", "install"],
  setup(repo()),
  files({ "lefthook.yml": "", "lefthook-local.yml": "a: 1\n" + LEFTHOOK_BLOCK.replace("post-merge", "old-thing") + "b: 2\n", ".gitignore": "x\n  lefthook-local.yml  \ny\n" }),
  after(cat("lefthook-local.yml", ".gitignore")),
);
add("hooks install: bad mode", ["hooks", "install", "--mode", "bogus"], setup(repo()), after(TREE));
add("hooks install: GENVX_NO_NATIVE=1", ["hooks", "install"], setup(repo()), env({ GENVX_NO_NATIVE: "1" }), hookFiles(".git/hooks"));

// ═════════════════════════════ hooks uninstall ═════════════════════════════

add("hooks uninstall: nothing installed", ["hooks", "uninstall"], setup(repo()), after(TREE));
add("hooks uninstall: not a git repository", ["hooks", "uninstall"]);
add(
  "hooks uninstall: removes files that hold nothing else",
  ["hooks", "uninstall"],
  setup(repo(), "rm -f .git/hooks/*.sample"),
  files({ ".git/hooks/post-merge": "#!/bin/sh\n" + BLOCK("post-merge"), ".git/hooks/post-checkout": BLOCK("post-checkout") }),
  after("ls -A .git/hooks", TREE),
);
add(
  "hooks uninstall: keeps what else is in the hook",
  ["hooks", "uninstall"],
  setup(repo(), "rm -f .git/hooks/*.sample", "chmod 755 .git/hooks/post-merge"),
  files({
    ".git/hooks/post-merge": "#!/bin/sh\necho before\n" + BLOCK("post-merge") + "echo after\n",
    ".git/hooks/post-checkout": "#!/usr/bin/env bash\n\n" + BLOCK("post-checkout") + "\n  \n",
    ".git/hooks/pre-commit": "#!/bin/sh\n" + BLOCK("post-merge"),
  }),
  after("ls -A .git/hooks", cat(".git/hooks/post-merge", ".git/hooks/pre-commit"), perms(".git/hooks/post-merge")),
);
add(
  "hooks uninstall: every place at once",
  ["hooks", "uninstall"],
  setup(repo()),
  files({
    ".git/hooks/post-merge": "#!/bin/sh\n" + BLOCK("post-merge"),
    ".husky/post-merge": "npm test\n" + BLOCK("post-merge"),
    ".husky/post-checkout": BLOCK("post-checkout"),
    ".githooks/post-merge": "#!/bin/sh\n" + BLOCK("post-merge"),
    ".githooks/post-checkout": "#!/bin/sh\n#!/bin/second\n" + BLOCK("post-checkout"),
    "lefthook-local.yml": LEFTHOOK_BLOCK,
  }),
  after(TREE, cat(".husky/post-merge", ".githooks/post-checkout")),
);
add("hooks uninstall: lefthook-local.yml with other settings keeps them", ["hooks", "uninstall"], setup(repo()), files({ "lefthook-local.yml": "pre-push:\n  commands: {}\n" + LEFTHOOK_BLOCK }), after(cat("lefthook-local.yml"), TREE));
add("hooks uninstall: lefthook-local.yml without the block is left alone", ["hooks", "uninstall"], setup(repo()), files({ "lefthook-local.yml": "pre-push: {}\n" }), after(cat("lefthook-local.yml")));
add("hooks uninstall: marker text inside another line still counts as installed", ["hooks", "uninstall"], setup(repo()), files({ ".githooks/post-merge": "#!/bin/sh\necho '# >>> genvx auto-sync >>>'\necho x\n" }), after(cat(".githooks/post-merge")));
add("hooks uninstall: leaves the hooks path setting", ["hooks", "uninstall"], setup(repo(), "git config core.hooksPath .githooks"), files({ ".githooks/post-merge": "#!/bin/sh\n" + BLOCK("post-merge") }), after(TREE, "git config --get core.hooksPath"));
add("hooks uninstall: GENVX_NO_NATIVE=1", ["hooks", "uninstall"], setup(repo()), files({ ".githooks/post-merge": "#!/bin/sh\n" + BLOCK("post-merge") }), env({ GENVX_NO_NATIVE: "1" }), after(TREE));

// ════════════════════════════════ setup ════════════════════════════════════

const homeCfg = after("cat ~/.genvx/.env.local", "stat -c '%a' ~/.genvx/.env.local", TREE);
add("setup: writes the global config and generates a key", ["setup", "--gitstore", "https://example.com/me/envs.git"], homeCfg, { normalize: [GENERATED_KEY] });
add("setup: alias init, -y", ["init", "-y", "-g", "https://example.com/me/envs.git"], homeCfg, { normalize: [GENERATED_KEY] });
add("setup: --yes --gitstore=", ["setup", "--yes", "--gitstore=https://example.com/me/envs.git"], homeCfg, { normalize: [GENERATED_KEY] });
add("setup: no store given", ["setup"], after(HOME_TREE, TREE));
add("setup: GENVX_STORE in the environment is not used", ["setup", "-y"], env({ GENVX_STORE: "https://example.com/me/envs.git" }), after(HOME_TREE));
add(
  "setup: keeps the key and other lines of an existing config",
  ["setup", "--gitstore", "https://example.com/new/store.git"],
  setup("mkdir -p ~/.genvx", "printf '# mine\\nOTHER=1\\n\\n  GENVX_KEY = keep-me  \\nGENVX_STORE=https://example.com/old.git\\nGENVX_KEY=second\\n' > ~/.genvx/.env.local", "chmod 644 ~/.genvx/.env.local"),
  homeCfg,
);
add(
  "setup: existing config supplies the store",
  ["setup"],
  setup("mkdir -p ~/.genvx", "printf 'GENVX_STORE=https://example.com/old.git' > ~/.genvx/.env.local"),
  homeCfg,
  { normalize: [GENERATED_KEY] },
);
add("setup: --dir elsewhere is not loaded automatically", ["setup", "--dir", "../custom/./deep/..", "-g", "https://example.com/me/envs.git"], after("cat ../custom/.env.local", "stat -c '%a' ../custom/.env.local", HOME_TREE, TREE), { normalize: [GENERATED_KEY] });
add("setup: --dir=. writes the project's .env.local", ["setup", "--dir=.", "-g", "https://example.com/me/envs.git"], after("cat .env.local", "stat -c '%a' .env.local", HOME_TREE, TREE), { normalize: [GENERATED_KEY] });
add("setup: --dir with ~", ["setup", "--dir=~/.genvx/", "-g", "https://example.com/me/envs.git"], homeCfg, { normalize: [GENERATED_KEY] });
add("setup: --dir ~ alone", ["setup", "--dir", "~", "-g", "https://example.com/me/envs.git"], after("cat ~/.env.local", HOME_TREE), { normalize: [GENERATED_KEY] });
add("setup: --dir with ~ in the middle is not expanded", ["setup", "--dir", "a/~/b", "-g", "https://example.com/me/envs.git"], after(TREE), { normalize: [GENERATED_KEY] });
add("setup: in a git repository installs the hooks", ["setup", "-g", "https://example.com/me/envs.git"], setup(repo()), homeCfg, hookFiles(".git/hooks"), { normalize: [GENERATED_KEY] });
add("setup: --no-hooks", ["setup", "--no-hooks", "-g", "https://example.com/me/envs.git"], setup(repo()), homeCfg, after("ls -A .git/hooks | grep -v sample"), { normalize: [GENERATED_KEY] });
add("setup: --hooks", ["setup", "--hooks", "-g", "https://example.com/me/envs.git"], setup(repo()), homeCfg, hookFiles(".git/hooks"), { normalize: [GENERATED_KEY] });
add("setup: husky repository gets shared hooks", ["setup", "-g", "https://example.com/me/envs.git"], setup(repo(), "git config core.hooksPath .husky/_"), homeCfg, hookFiles(".husky"), { normalize: [GENERATED_KEY] });
add("setup: lefthook repository", ["setup", "-g", "https://example.com/me/envs.git"], setup(repo()), files({ "lefthook.yml": "" }), homeCfg, after(cat("lefthook-local.yml", ".gitignore")), { normalize: [GENERATED_KEY] });
add("setup: custom hooks path with a package.json", ["setup", "-g", "https://example.com/me/envs.git"], setup(repo(), "git config core.hooksPath my-hooks"), files({ "package.json": '{"name":"x"}' }), homeCfg, hookFiles(".githooks"), after(cat("package.json")), { normalize: [GENERATED_KEY] });
add("setup: hooks path set globally, outside a repository", ["setup", "-g", "https://example.com/me/envs.git"], setup("git config --global core.hooksPath /somewhere/hooks"), homeCfg, { normalize: [GENERATED_KEY] });
add("setup: GENVX_NO_NATIVE=1", ["setup", "-g", "https://example.com/me/envs.git"], env({ GENVX_NO_NATIVE: "1" }), homeCfg, { normalize: [GENERATED_KEY] });

// ═════════════════ what stays with the argument parser (yargs) ═════════════

// Help, version and usage errors are yargs' own text. The Rust binary must
// recognise these shapes as not its own and hand them back unchanged.
const yargsCases = [
  ["no arguments", []],
  ["--help", ["--help"]],
  ["-h", ["-h"]],
  ["--version", ["--version"]],
  ["-v", ["-v"]],
  ["version typed as a command", ["version"]],
  ["unknown command", ["frobnicate"]],
  ["push --help", ["push", "--help"]],
  ["branch --help", ["branch", "-h"]],
  ["branch with an extra word", ["branch", "extra"]],
  ["branch --version", ["branch", "--version"]],
  ["hooks without an action", ["hooks"]],
  ["hooks with an unknown action", ["hooks", "bogus"]],
  ["hooks --help", ["hooks", "--help"]],
  ["hooks status with an extra word and more", ["hooks", "status", "a", "b"]],
  ["two commands", ["push", "pull"]],
  ["empty argument", [""]],
];
for (const [label, args] of yargsCases) add(`yargs: ${label}`, args, setup(repo()));

// Shapes yargs accepts but reads in ways the Rust binary does not imitate.
const scenePull = [scene({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), after(TREE, cat(".env")), { normalize: [TIMING] }];
add("yargs: flag before the command", ["-y", "pull"], ...scenePull);
add("yargs: --yes false", ["pull", "--yes", "false"], ...scenePull);
add("yargs: --yes=true", ["pull", "--yes=true"], ...scenePull);
add("yargs: bundled short flags", ["pull", "-yg", "../store.git"], ...scenePull);
add("yargs: -g=value", ["pull", "-g=../store.git"], ...scenePull);
add("yargs: --gitstore twice", ["pull", "--gitstore", "../store.git", "--gitstore", "../store.git"], ...scenePull);
add("yargs: --gitstore without a value", ["pull", "--gitstore"], ...scenePull);
add("yargs: --gitstore= empty", ["pull", "--gitstore="], ...scenePull);
add("yargs: --gitstore with a quoted value", ["pull", "--gitstore", '"../store.git"'], ...scenePull);
add("yargs: unknown flag", ["pull", "--frobnicate"], ...scenePull);
add("yargs: --", ["pull", "--"], ...scenePull);
add("yargs: extra word after pull", ["pull", "now"], ...scenePull);
add("yargs: --no-yes", ["pull", "--no-yes"], ...scenePull);
add("yargs: --no-encrypt=true pulls from a plaintext store without a key", ["pull", "--no-encrypt=true"], setup(IDENT, repo(), homeConfig({ key: null })), store({ ".env": "A=1\n" }), after(TREE, cat(".env")), { normalize: [TIMING] });
add("yargs: --noEncrypt pushes plaintext", ["push", "--noEncrypt"], setup(IDENT, repo(), homeConfig({ key: null })), store(null), files({ ".env": "A=1\n" }), after(TREE, storeTree(), storeShow(".env")), { normalize: [TIMING] });
add("yargs: --no-no-encrypt", ["push", "--no-no-encrypt"], scene(null), dec, files({ ".env": "A=1\n" }), pushedState(".env.enc"), { normalize: [TIMING] });
add("yargs: hooks run with a second event", ["hooks", "run", "post-merge", "extra"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), hookState, { normalize: [STAMP] });
add("yargs: hooks run with an empty event", ["hooks", "run", ""], scene({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), hookState, { normalize: [STAMP] });
add("yargs: hooks run with a numeric event", ["hooks", "run", "42"], scene({ ".env.enc": FIX.env }), files({ ".env": "A=0\n" }), hookState, { normalize: [STAMP] });
add("yargs: hooks status --mode shared", ["hooks", "status", "--mode", "shared"], setup(repo()));
add("yargs: hooks install --mode without a value", ["hooks", "install", "--mode"], setup(repo()), after(TREE));
add("yargs: hooks install with -y", ["hooks", "install", "-y"], setup(repo()), hookFiles(".git/hooks"));
add("yargs: setup --dir without a value", ["setup", "--dir", "-g", "https://example.com/me/envs.git"], after(HOME_TREE, TREE), { normalize: [GENERATED_KEY] });
add("yargs: setup --hooks=false", ["setup", "--hooks=false", "-g", "https://example.com/me/envs.git"], setup(repo()), homeCfg, after("ls -A .git/hooks | grep -v sample"), { normalize: [GENERATED_KEY] });

// ── write ──────────────────────────────────────────────────────────────────

const spec = {
  "//": "Generated by rs/parity.gen.mjs — edit that file, then run `node rs/parity.gen.mjs`.",
  env: { GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  cases,
};
const text = JSON.stringify(spec, null, 1) + "\n";
const target = path.join(HERE, "parity.json");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== text) {
    console.error("rs/parity.json is out of date: run `node rs/parity.gen.mjs`");
    process.exit(1);
  }
  console.log(`rs/parity.json is up to date (${cases.length} cases)`);
} else {
  fs.writeFileSync(target, text);
  console.log(`wrote ${target} (${cases.length} cases)`);
}

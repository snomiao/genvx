#!/usr/bin/env bash
# The TypeScript and the Rust implementation must read each other's stores.
#
# rs/parity.json cannot show this: its cases run one implementation at a
# time, each in its own directories. Here both work on one gitstore:
#
#   1. TypeScript pushes            -> Rust pulls the same files, Rust diff is clean
#   2. Rust pushes changes          -> TypeScript pulls them, TypeScript diff is clean
#   3. a store written by both      -> a fresh checkout pulls the same with either
#   4. a wrong key                  -> each refuses what the other wrote
#   5. TypeScript pushes            -> Rust `hooks run` (what a git hook calls) syncs it
#
#   rs/cross-compat.sh [path to the Rust binary]     (default: rs/target/release/genvx)
#
# The Rust binary runs without the npm package around it, so it cannot hand
# anything back to the JavaScript: every step it takes here is its own.
# Everything is local (a bare repository as the gitstore); nothing is fetched.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
rust="${1:-$here/target/release/genvx}"
case "$rust" in /*) ;; *) rust="$PWD/$rust" ;; esac
[ -x "$rust" ] || { echo "cross-compat: no Rust binary at $rust (cargo build --release --manifest-path rs/Cargo.toml)"; exit 2; }
[ -d "$repo/node_modules/yargs" ] || { echo "cross-compat: run \`bun install\` in $repo first"; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/genvx-cross.XXXXXX")"
work="$(cd "$work" && pwd -P)"
trap 'rm -rf "$work"' EXIT

checks=0
fail() { echo "cross-compat: FAILED: $*"; exit 1; }
ok() { checks=$((checks + 1)); echo "  ok  $*"; }

# One clean environment for both implementations.
run() { env -i PATH="$PATH" HOME="$work/home" GIT_CONFIG_NOSYSTEM=1 LC_ALL=C GIT_TERMINAL_PROMPT=0 ${KEY_OVERRIDE:+GENVX_KEY="$KEY_OVERRIDE"} "$@"; }
ts() { run bun "$repo/src/cli.ts" "$@"; }
rs() { run "$rust" "$@"; }

mkdir -p "$work/home/.genvx"
run git config --global user.name Cross
run git config --global user.email cross@example.com
run git init -q --bare "$work/store.git"
printf 'GENVX_STORE=%s\nGENVX_KEY=%s\n' "$work/store.git" "cross-key-0123456789" > "$work/home/.genvx/.env.local"

project() { # a checkout of "the same project" (same origin remote)
  mkdir -p "$work/$1"
  run git -C "$work/$1" init -q -b main
  run git -C "$work/$1" remote add origin https://github.com/Acme/Cross.git
}
# The env files of a checkout, as one comparable listing.
listing() { (cd "$work/$1" && find . -name .git -prune -o -type f -print | LC_ALL=C sort | while read -r f; do printf '== %s %s\n' "$f" "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")"; cat "$f"; printf '\n'; done); }
same() { [ "$(listing "$1")" = "$(listing "$2")" ] || { diff <(listing "$1") <(listing "$2") || true; fail "$3"; }; ok "$3"; }
clean_diff() { [ "$1" = "pull: (no changes)
push: (no changes)" ] || fail "$2: expected a clean diff, got: $1"; ok "$2"; }

# ── 1. TypeScript writes, Rust reads ────────────────────────────────────────
project a
printf 'A=1\nB=two\n' > "$work/a/.env"
printf 'NAME=h\303\251llo \342\206\222 \344\270\226\347\225\214\n# comment\nexport X="quoted"\nEMPTY=\n\nLAST=no newline' > "$work/a/.env.production"
mkdir -p "$work/a/sub/deep"
printf 'S=1\r\nT=2\r\n' > "$work/a/sub/deep/.env.staging"
(cd "$work/a" && ts push >/dev/null)

project b
(cd "$work/b" && rs pull >/dev/null) || fail "Rust could not pull what the TypeScript pushed"
same a b "Rust pulls what the TypeScript pushed"
clean_diff "$(cd "$work/b" && rs diff)" "Rust diff is clean against a TypeScript store"

# ── 2. Rust writes, TypeScript reads ────────────────────────────────────────
printf 'A=1\nB=changed by rust\nC=3\n' > "$work/b/.env"
printf 'L=local\n' > "$work/b/.env.local"
printf 'emoji=\360\237\232\200\n' > "$work/b/sub/deep/.env.staging"
(cd "$work/b" && rs push >/dev/null) || fail "Rust could not push"
(cd "$work/a" && ts pull >/dev/null) || fail "the TypeScript could not pull what Rust pushed"
same a b "the TypeScript pulls what Rust pushed"
clean_diff "$(cd "$work/a" && ts diff)" "TypeScript diff is clean against a store Rust wrote"

# ── 3. a store written by both: fresh checkouts agree ───────────────────────
project c
project d
(cd "$work/c" && ts pull >/dev/null)
(cd "$work/d" && rs pull >/dev/null)
same c d "a fresh checkout gets the same files from either implementation"
same b d "and they are the files last pushed"

# ── 4. a wrong key ──────────────────────────────────────────────────────────
project e
out="$(cd "$work/e" && KEY_OVERRIDE=wrong-key rs pull 2>&1)" && fail "Rust pulled with a wrong key"
[ "${out#Error: Failed to decrypt }" != "$out" ] || fail "Rust with a wrong key said: $out"
ok "Rust refuses the store with a wrong key"
rm -rf "$work/e/.genvx"
out="$(cd "$work/e" && KEY_OVERRIDE=wrong-key ts pull 2>&1)" && fail "the TypeScript pulled with a wrong key"
[ "${out#Error: Failed to decrypt }" != "$out" ] || fail "the TypeScript with a wrong key said: $out"
ok "the TypeScript refuses the store with a wrong key"

# ── 5. what a git hook runs ─────────────────────────────────────────────────
printf 'A=1\nB=changed again by typescript\n' > "$work/a/.env"
(cd "$work/a" && ts push >/dev/null)
out="$(cd "$work/b" && rs hooks run post-merge)"
[ "$out" = "genvx: synced 1 env file(s) [post-merge]" ] || fail "Rust hooks run said: $out"
[ "$(cat "$work/b/.genvx/backups"/*/.env)" = "$(printf 'A=1\nB=changed by rust\nC=3')" ] || fail "Rust hooks run did not back up the file it replaced"
rm -rf "$work/b/.genvx"
same a b "Rust \`hooks run\` syncs what the TypeScript pushed, keeping a backup"

# ── 6. inside a gitstore working copy ───────────────────────────────────────
# genvx keeps its clone of the store in .genvx/gitstore and refuses to work
# from in there. The parity runner cannot choose a case's directory, so the
# two are compared here: same output, same exit code.
mkdir -p "$work/f/.genvx/gitstore/sub"
run git -C "$work/f/.genvx/gitstore" init -q -b main
run git -C "$work/f/.genvx/gitstore" remote add origin https://github.com/Acme/Cross.git
answer() { (cd "$work/f/.genvx/gitstore/$1" && shift && { "$@" 2>&1; echo "[exit $?]"; }); }
for where in . sub; do
  for args in "push" "pull -y" "diff" "push --gitstore ../x.git" "hooks run post-merge"; do
    # shellcheck disable=SC2086
    [ "$(answer "$where" ts $args)" = "$(answer "$where" rs $args)" ] || fail "inside .genvx/gitstore/$where, \`genvx $args\`: TypeScript said: $(answer "$where" ts $args) / Rust said: $(answer "$where" rs $args)"
  done
done
[ "$(answer . rs pull)" = "Error: Cannot run genvx inside the gitstore directory
[exit 1]" ] || fail "Rust inside the gitstore directory said: $(answer . rs pull)"
ok "both refuse to work inside .genvx/gitstore, with the same words"

echo "cross-compat: ok ($checks checks)"

# genvx

A simple CLI tool to save and load `.env*` files across projects using a private git repository.

## Features

- 🔐 **Encrypted by default** - AES-256-GCM encryption with project-specific keys
- 🔒 **Branch isolation** - Each project gets its own hashed branch (no cross-project exposure)
- ⬆️⬇️ **Explicit transfer** - Push or pull `.env*` files
- 🪝 **Auto-sync hooks** - Optional git hooks auto-pull fresh env on merge/checkout (local-only or shared)
- ☁️ **Private gitstore** - Store env files in a private git repository
- 🧹 **Clean** - Temporary `.genvx` folder is auto-cleaned after operations

## Why?

- Share env files across your machines easily
- Backup sensitive env files securely in a private repo
- **Encrypted at rest** - Files stored with AES-256-GCM encryption
- **Minimal clone** - Only downloads your project's env files, not everyone's
- **Obscure branches** - Branch names are SHA256 hashes, hiding which project they belong to

## Installation

```bash
# Install globally via npm
npm i -g genvx

# Or via bun
bun install -g genvx

# Now you can use genvx anywhere
genvx --help
```

### Development Setup

```bash
# Clone the repo
git clone https://github.com/snomiao/genvx.git
cd genvx

# Install dependencies
bun install

# Link globally for system-wide access
bun link
```

## Configuration

### Quick start: `genvx setup`

The fastest way to configure genvx is the interactive setup command:

```bash
genvx setup
```

It walks you through:

1. **Where to save** - global (`~/.genvx/.env.local`), the current project (`./.env.local`), or a custom directory
2. **Gitstore URL** - your private repo (an empty repo is fine; genvx initializes it on first push)
3. **Encryption key** - auto-generates a strong key, or accepts your own

The config file is written with `600` permissions. Non-interactive use:

```bash
genvx setup --gitstore=https://github.com/me/envs.git --dir=~/.config/genvx -y
```

If you save to a custom directory, set `GENVX_CONFIG_DIR=<dir>` so genvx loads it.

### Manual configuration

### Required: Encryption Key

Set your encryption key (required for push/pull):

```bash
# Via environment variable
export GENVX_KEY="your-secret-encryption-key"

# Or in ~/.genvx/.env.local
echo "GENVX_KEY=your-secret-encryption-key" >> ~/.genvx/.env.local
```

Generate a strong key:
```bash
openssl rand -base64 32
```

### Required: Gitstore URL

Set your gitstore (private repo) URL via one of these methods (priority order):

1. **CLI flag**: `--gitstore=<url>` (highest priority)
2. **Environment variable**: `export GENVX_STORE=<url>`
3. **Project `.env.local`**: `GENVX_STORE=<url>` (in current directory)
4. **Global config**: `~/.genvx/.env.local` with `GENVX_STORE=<url>` (lowest priority)

### Global Configuration

For convenience, set defaults globally:

```bash
mkdir -p ~/.genvx
cat >> ~/.genvx/.env.local << 'EOF'
GENVX_STORE=https://github.com/youruser/envs.git
GENVX_KEY=your-secret-encryption-key
EOF
```

## Usage

### Save env files to gitstore

```bash
# Push all .env* files to gitstore (encrypted)
genvx push

# Or use short alias
genvx p

# Push without confirmation prompt
genvx push -y
```

### Load env files from gitstore

```bash
# Pull all .env* files from gitstore (decrypts automatically)
genvx pull

# Or use load alias
genvx load

# Pull without confirmation prompt
genvx pull -y
```

### Preview changes (dry run)

```bash
# Show what would be pushed/pulled
genvx diff
```

### Show branch name

```bash
# Show the hashed branch name for this project
genvx branch
# Output: env/27b8a763f3dc97f1
```

### Disable encryption (not recommended)

```bash
# Push without encryption
genvx push --no-encrypt

# Pull without decryption
genvx pull --no-encrypt
```

Push and pull are one-way operations. Deletes are not propagated automatically.

### Auto-sync with git hooks

Running `genvx pull` by hand is easy to forget, so your `.env*` files drift out of
date fast. Install git hooks to **auto-pull on `git pull`/merge and on branch
checkout**:

```bash
# Auto-detects the cleanest mode for your repo (usually local-only)
genvx hooks install

# See what's detected and installed
genvx hooks status

# Remove them
genvx hooks uninstall
```

`genvx setup` also offers to install these hooks at the end (skip with
`genvx setup --no-hooks`).

**Direction:** hooks only ever **pull** (read from the gitstore). Pushing stays a
deliberate `genvx push`, so a stray local edit can never be sprayed into the
shared store automatically.

**Safety:** before an auto-pull overwrites a local file, the previous version is
copied to `.genvx/backups/<timestamp>/`. The hooks are also fail-soft — if genvx
isn't installed, isn't configured, or the network is down, the hook silently
no-ops and never blocks your `git` command.

**Modes** (pick with `--mode`, or let `auto` choose):

| Mode | Where hooks live | Committed? | Best for |
|------|------------------|------------|----------|
| `local` | `.git/hooks/` | No (per-clone) | Solo/undercover use — default when no hook manager is present |
| `lefthook` | `lefthook-local.yml` (gitignored) | No | Repos already using [lefthook](https://lefthook.dev) |
| `shared` | `.husky/` or `.githooks/` | Yes | Opting the whole team in |

> Git runs only **one** hook directory at a time. If [husky](https://typicode.github.io/husky/)
> already owns `core.hooksPath`, a per-clone local hook can't fire — `auto` will
> recommend `shared` in that case and `genvx hooks status` shows the detected manager.

## How it works

### Encryption

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key derivation**: scrypt with project ID as salt
- **Per-project keys**: Each project derives a unique key from your master key
- **File format**: `{iv}:{authTag}:{ciphertext}` (hex encoded)

### Branch-per-Project Architecture

Each project gets its own isolated branch in your gitstore:

```
gitstore-repo/
├── branch: env/27b8a763f3dc97f1  →  project1's .env.enc files
├── branch: env/9f2c4a8b1e3d7650  →  project2's .env.enc files
└── branch: env/a1b2c3d4e5f67890  →  project3's .env.enc files
```

- Branch names are SHA256 hashes of `{host}/{owner}/{repo}`
- Each branch is an **orphan branch** (no shared history)
- Cloning only fetches the single branch you need
- Files stored as `.env*.enc` (encrypted)

### Workflow

1. **Clone Branch**: `git clone --single-branch --depth 1 -b env/<hash>` (minimal data)
2. **Encrypt/Decrypt**: Files encrypted on push, decrypted on pull
3. **Transfer Files**: Copies `.env*.enc` files to/from branch root
4. **Commit/Push**: Commits and pushes changes to the branch
5. **Cleanup**: Removes temporary `.genvx` directory

### Security Layers

| Layer | Protection |
|-------|------------|
| Private repo | Access control |
| Branch hashing | Obscures project identity |
| AES-256-GCM encryption | Data at rest protection |
| Per-project key derivation | Isolation between projects |

## Examples

```bash
# Configure via environment variables
export GENVX_STORE=git@github.com:yourusername/my-env-store.git
export GENVX_KEY="$(openssl rand -base64 32)"

# Push your env files (encrypted)
genvx push

# On another machine, pull them (decrypted)
genvx pull

# Check which branch this project uses
genvx branch

# Use CLI flag to override gitstore
genvx --gitstore=git@github.com:company/envs.git push
```

## Security Notes

- 🔐 **Encryption on by default** - All files encrypted with AES-256-GCM
- 🔒 **Branch isolation** - You only see your own project's secrets
- 🔒 **Hashed branches** - Branch names don't reveal project identity
- ⚠️ **Use a private repository** for your gitstore
- ⚠️ **Keep your GENVX_KEY secret** - Anyone with the key can decrypt
- ⚠️ Never commit `.env*` files to your project repos

## Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `setup` | `init` | Interactively configure gitstore URL and encryption key |
| `push` | `p`, `save` | Push local `.env*` files to gitstore (encrypted) |
| `pull` | `load` | Pull `.env*` files from gitstore (decrypted) |
| `diff` | `d` | Show pending changes (dry run) |
| `branch` | `b` | Show hashed branch name for this project |
| `hooks <action>` | - | Manage auto-sync git hooks: `install`, `uninstall`, `status` |

### Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--gitstore` | `-g` | Git repository URL for env storage |
| `--dir` | - | Directory to save config (`setup` only) |
| `--no-hooks` | - | Skip git-hook setup during `setup` |
| `--mode` | - | Hook install mode: `auto`\|`local`\|`lefthook`\|`shared` (`hooks install` only) |
| `--yes` | `-y` | Skip confirmation prompts |
| `--no-encrypt` | - | Disable encryption (not recommended) |
| `--help` | `-h` | Show help |
| `--version` | `-v` | Show version |

## Development

Built with:
- [Bun](https://bun.sh) - Fast JavaScript runtime
- [yargs](https://yargs.js.org) - CLI argument parsing

## License

MIT

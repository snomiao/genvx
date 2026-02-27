# genvx

A simple CLI tool to save and load `.env*` files across projects using a private git repository.

## Features

- ⬆️⬇️ **Explicit transfer** - Push or pull `.env*` files
- 🔒 **Branch isolation** - Each project gets its own hashed branch (no cross-project exposure)
- ☁️ **Private gitstore** - Store env files in a private git repository
- 🚀 **Simple** - No encryption overhead, just git + file sync
- 🧹 **Clean** - Temporary `.genvx` folder is auto-cleaned after operations

## Why?

- Share env files across your machines easily
- Backup sensitive env files securely in a private repo
- **Minimal clone** - Only downloads your project's env files, not everyone's
- **Obscure branches** - Branch names are SHA256 hashes, hiding which project they belong to
- Simpler than encryption-based solutions (just use a private repo!)

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

Set your gitstore (private repo) URL via one of these methods (priority order):

1. **CLI flag**: `--gitstore=<url>` (highest priority)
2. **Environment variable**: `export GENVX_STORE=<url>`
3. **Project `.env.local`**: `GENVX_STORE=<url>` (in current directory)
4. **Global config**: `~/.genvx/.env.local` with `GENVX_STORE=<url>` (lowest priority)

### Global Configuration

For convenience, you can set a default gitstore URL globally:

```bash
mkdir -p ~/.genvx
echo "GENVX_STORE=https://github.com/youruser/envs.git" > ~/.genvx/.env.local
```

This will be used as a fallback for all projects that don't have their own configuration.

## Usage

### Save env files to gitstore

```bash
# Push all .env* files to gitstore
genvx push

# Or use short alias
genvx p

# Push without confirmation prompt
genvx push -y
```

### Load env files from gitstore

```bash
# Pull all .env* files from gitstore
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

Push and pull are one-way operations. Deletes are not propagated automatically.

## How it works

### Branch-per-Project Architecture

Each project gets its own isolated branch in your gitstore:

```
gitstore-repo/
├── branch: env/27b8a763f3dc97f1  →  project1's .env files
├── branch: env/9f2c4a8b1e3d7650  →  project2's .env files
└── branch: env/a1b2c3d4e5f67890  →  project3's .env files
```

- Branch names are SHA256 hashes of `{host}/{owner}/{repo}`
- Each branch is an **orphan branch** (no shared history)
- Cloning only fetches the single branch you need

### Workflow

1. **Clone Branch**: `git clone --single-branch --depth 1 -b env/<hash>` (minimal data)
2. **Transfer Files**: Copies `.env*` files to/from branch root
3. **Commit/Push**: Commits and pushes changes to the branch
4. **Cleanup**: Removes temporary `.genvx` directory

### Benefits

| Old (single branch) | New (branch-per-project) |
|---------------------|--------------------------|
| Clone ALL projects' env files | Clone only YOUR project's files |
| ~100KB+ clone (grows forever) | ~1KB clone (just env files) |
| Other projects visible | Branches are hashed, obscure |

## Examples

```bash
# Configure gitstore via environment variable
export GENVX_STORE=git@github.com:yourusername/my-env-store.git

# Push your env files
genvx push

# On another machine, pull them
genvx pull

# Check which branch this project uses
genvx branch

# Use CLI flag to override gitstore
genvx --gitstore=git@github.com:company/envs.git push
```

## Security Notes

- ⚠️ **Use a private repository** for your gitstore
- ⚠️ Never commit `.env*` files to your project repos
- 🔒 Branch isolation ensures you only see your own project's secrets
- 🔒 Hashed branch names hide which project they belong to
- 🔐 **Optional encryption**: Use [git-crypt](https://github.com/AGWA/git-crypt) for additional encryption

## Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `push` | `p`, `save` | Push local `.env*` files to gitstore |
| `pull` | `load` | Pull `.env*` files from gitstore |
| `diff` | `d` | Show pending changes (dry run) |
| `branch` | `b` | Show hashed branch name for this project |

### Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--gitstore` | `-g` | Git repository URL for env storage |
| `--yes` | `-y` | Skip confirmation prompts |
| `--help` | `-h` | Show help |
| `--version` | `-v` | Show version |

## Development

Built with:
- [Bun](https://bun.sh) - Fast JavaScript runtime
- [yargs](https://yargs.js.org) - CLI argument parsing

## License

MIT

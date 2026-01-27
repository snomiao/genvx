# genvx

A simple CLI tool to save and load `.env*` files across projects using a private git repository.

## Features

- ⬆️⬇️ **Explicit transfer** - Push, pull, or sync `.env*` files
- ☁️ **Private gitstore** - Store env files in a private git repository
- 📁 **Organized storage** - Files stored by `{host}/{owner}/{repo}` structure
- 🚀 **Simple** - No encryption, just git + file sync
- 🧹 **Clean** - Temporary `.genvx` folder is auto-cleaned after operations

## Why?

- Share env files across your machines easily
- Backup sensitive env files securely in a private repo
- No need for local `.env.*.encrypted` files
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

# Or use save alias
genvx save
```

### Load env files from gitstore

```bash
# Pull all .env* files from gitstore
genvx pull

# Or use load alias
genvx load
```

Push and pull are one-way operations. Deletes are not propagated automatically.

## How it works

### Gitstore Structure

Your private gitstore repository will be organized like this:

```
gitstore-repo/
├── github.com/
│   ├── snomiao/
│   │   ├── project1/
│   │   │   ├── .env.prod.local
│   │   │   └── .env.dev.local
│   │   └── project2/
│   │       └── .env.prod.local
│   └── otheruser/
│       └── project3/
│           └── .env.local
└── gitlab.com/
    └── ...
```

### Workflow

1. **Clone/Pull**: genvx clones your gitstore to `./node_modules/.genvx/gitstore` (temporary)
2. **Transfer Files**: Copies `.env*` files to/from `{host}/{owner}/{repo}/` path
3. **Commit/Push**: Commits and pushes changes to gitstore
4. **Cleanup**: Removes `./node_modules/.genvx` directory

## Examples

```bash
# Configure gitstore via environment variable
export GENVX_STORE=git@github.com:yourusername/my-env-store.git

# Push your env files
genvx push

# On another machine, pull them
genvx pull

# Use CLI flag to override
genvx --gitstore=git@github.com:company/envs.git sync
```

## Security Notes

- ⚠️ **Use a private repository** for your gitstore
- ⚠️ Never commit `.env*` files to your project repos
- ✅ Your env files are stored in `.genvx/gitstore/{host}/{owner}/{repo}/` (or `node_modules/.genvx/gitstore/...` when `node_modules` exists)
- 🔒 The gitstore should only be accessible to you/your team

## File Structure

### Local Project
```
your-project/
├── .env.local          # Gitignored
├── .env.prod.local     # Gitignored
├── .env.dev.local      # Gitignored
└── .genvx/                          # Temporary, cleaned after operations
```

### Gitstore Repository
```
envs-repo/
└── github.com/
    └── yourname/
        └── your-project/
            ├── .env.local
            ├── .env.prod.local
            └── .env.dev.local
```

## Commands

### `genvx push` (alias: `p`, `save`)
Push all local `.env*` files to gitstore

### `genvx pull` (alias: `load`)
Pull all `.env*` files from gitstore to local

### `genvx sync` (alias: `s`)
Pull then push `.env*` files

## Development

Built with:
- [Bun](https://bun.sh) - Fast JavaScript runtime
- [yargs](https://yargs.js.org) - CLI argument parsing
- [execa](https://github.com/sindresorhus/execa) - Process execution

## License

This project was created using `bun init` in bun v1.3.6.
### Sync (pull then push)

```bash
# Pull then push
genvx sync

# Or use short alias
genvx s
```

Sync is equivalent to running `pull` then `push`.

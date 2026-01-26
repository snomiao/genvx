# denvx

A simple CLI tool to sync `.env*` files across projects using a private git repository.

## Features

- 🔄 **Bidirectional sync** - Push, pull, or sync `.env*` files
- ☁️ **Private gitstore** - Store env files in a private git repository
- 📁 **Organized storage** - Files stored by `{host}/{owner}/{repo}` structure
- 🚀 **Simple** - No encryption, just git + file sync
- 🧹 **Clean** - Temporary `node_modules/.genvx` folder is auto-cleaned after operations

## Why?

- Share env files across your machines easily
- Backup sensitive env files securely in a private repo
- No need for local `.env.*.encrypted` files
- Simpler than encryption-based solutions (just use a private repo!)

## Installation

```bash
# Install dependencies
bun install

# Link globally for system-wide access
bun link

# Now you can use denvx anywhere
denvx --help
```

## Configuration

Set your gitstore (private repo) URL via one of these methods (priority order):

1. **CLI flag**: `--gitstore=<url>` (highest priority)
2. **Environment variable**: `export GENVX_STORE=<url>`
3. **Project `.env.local`**: `GENVX_STORE=<url>` (in current directory)
4. **Global config**: `~/node_modules/.genvx/.env.local` with `GENVX_STORE=<url>` (lowest priority)

### Global Configuration

For convenience, you can set a default gitstore URL globally:

```bash
mkdir -p ~/node_modules/.genvx
echo "GENVX_STORE=https://github.com/youruser/envs.git" > ~/node_modules/.genvx/.env.local
```

This will be used as a fallback for all projects that don't have their own configuration.

## Usage

### Push env files to gitstore

```bash
# Push all .env* files to gitstore
denvx push

# Or use short alias
denvx p
```

### Pull env files from gitstore

```bash
# Pull all .env* files from gitstore
denvx pull
```

### Sync bidirectionally

```bash
# Sync based on modification times
denvx sync

# Or use short alias
denvx s
```

The sync command will:
- Pull files that only exist in gitstore
- Push files that only exist locally
- Compare modification times for files that exist in both places
- Sync the newer version

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

1. **Clone/Pull**: denvx clones your gitstore to `./node_modules/.genvx/gitstore` (temporary)
2. **Sync Files**: Copies `.env*` files to/from `{host}/{owner}/{repo}/` path
3. **Commit/Push**: Commits and pushes changes to gitstore
4. **Cleanup**: Removes `./node_modules/.genvx` directory

## Examples

```bash
# Configure gitstore via environment variable
export GENVX_STORE=git@github.com:yourusername/my-env-store.git

# Push your env files
denvx push

# On another machine, pull them
denvx pull

# Or just sync (automatically push/pull based on timestamps)
denvx sync

# Use CLI flag to override
denvx --gitstore=git@github.com:company/envs.git sync
```

## Security Notes

- ⚠️ **Use a private repository** for your gitstore
- ⚠️ Never commit `.env*` files to your project repos
- ✅ Your env files are stored in `node_modules/.genvx/gitstore/{host}/{owner}/{repo}/`
- 🔒 The gitstore should only be accessible to you/your team

## File Structure

### Local Project
```
your-project/
├── .env.local          # Gitignored
├── .env.prod.local     # Gitignored
├── .env.dev.local      # Gitignored
└── node_modules/.genvx/             # Temporary, cleaned after operations
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

### `denvx push` (alias: `p`)
Push all local `.env*` files to gitstore

### `denvx pull`
Pull all `.env*` files from gitstore to local

### `denvx sync` (alias: `s`)
Sync files bidirectionally based on modification times

## Development

Built with:
- [Bun](https://bun.sh) - Fast JavaScript runtime
- [yargs](https://yargs.js.org) - CLI argument parsing
- [execa](https://github.com/sindresorhus/execa) - Process execution

## License

This project was created using `bun init` in bun v1.3.6.

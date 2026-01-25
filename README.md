# denvx

A CLI tool to automatically sync encrypted environment files using dotenvx.

## Features

- 🔐 Encrypt/decrypt `.env.[name].local` files to/from `.env.[name].encrypted`
- 🔄 Auto-sync based on file modification times
- 🤝 Conflict resolution (keeps both values in .local file with comments)
- 📦 System-wide installation via `bun link`
- 🎯 Built with Bun and yargs

## Installation

```bash
# Install dependencies
bun install

# Link globally for system-wide access
bun link

# Now you can use denvx anywhere
denvx --help
```

## Usage

### Encrypt a local file

```bash
# Create an unencrypted environment file
echo "DATABASE_URL=postgres://localhost:5432/mydb" > .env.prod.local

# Encrypt it
denvx encrypt prod

# This creates .env.prod.encrypted and .env.keys
```

### Decrypt an encrypted file

```bash
# Decrypt an encrypted file
denvx decrypt prod

# This creates/updates .env.prod.local
```

### Sync files automatically

```bash
# Sync a specific environment
denvx sync prod

# Sync all .env.*.local files
denvx sync
```

The sync command will:
- If only `.local` exists: encrypt it to `.encrypted`
- If only `.encrypted` exists: decrypt it to `.local`
- If both exist: sync the newer file to the older one
- On conflicts: keep both values in `.local` with comments

## File Structure

```
.
├── .env.prod.local      # Unencrypted (gitignored)
├── .env.prod.encrypted  # Encrypted (committed to git)
├── .env.dev.local       # Unencrypted (gitignored)
├── .env.dev.encrypted   # Encrypted (committed to git)
└── .env.keys            # Private keys (gitignored)
```

## How it works

1. **Local files** (`.env.[name].local`) are unencrypted and gitignored
2. **Encrypted files** (`.env.[name].encrypted`) are encrypted and committed to git
3. **Keys file** (`.env.keys`) contains private encryption keys and is gitignored
4. When syncing, the tool compares modification times and syncs accordingly
5. On conflicts, both values are kept in the `.local` file with comments

## Security Notes

- ⚠️ Never commit `.env.[name].local` files to git
- ⚠️ Never commit `.env.keys` to git
- ✅ Only commit `.env.[name].encrypted` files
- 🔑 Back up your `.env.keys` file securely

## Examples

```bash
# Encrypt production secrets
denvx encrypt prod

# Decrypt development secrets
denvx decrypt dev

# Sync all environment files
denvx sync

# Sync only production
denvx sync prod
```

## Development

Built with:
- [Bun](https://bun.sh) - Fast JavaScript runtime
- [dotenvx](https://dotenvx.com) - Encrypted .env files
- [yargs](https://yargs.js.org) - CLI argument parsing
- [execa](https://github.com/sindresorhus/execa) - Process execution

## License

This project was created using `bun init` in bun v1.3.6.

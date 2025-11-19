# Secure Password Tools

This repository contains a reusable Python CLI utility (`password_generator.py`) and a Next.js web application (`password/`) that both generate strong passwords or passphrases using the same server-side logic.

## 1. Python CLI (`password_generator.py`)

### Quick Start

```bash
python password_generator.py          # Interactive prompts
python password_generator.py --help   # Full option list
```

### Key Options

- `--length`  
  Total length of a character-based password.
- `--special-count` / `--digit-count` / `--mixed-case-count`  
  Exact counts for each character class.
- `--use-words`  
  Switch to a passphrase; pair with:
  - `--word-count`
  - `--word-separator`
  - `--passphrase-digit-count`
  - `--passphrase-special-count`
  - `--passphrase-mixed-count`
  - `--randomize-word-case` or `--no-randomize-word-case`
- `--wordlist <path>`
  Supply a custom word list (one word per line).
- `--exclude-ambiguous`
  Exclude easily confused characters (e.g., 'l', '1', 'I', 'O', '0').
- `--non-interactive`
  Skip prompts—useful for automation.

All randomness comes from `secrets.SystemRandom`, ensuring cryptographically strong output. Invalid combinations (for example, requesting more required characters than total length) fail fast with clear messages.

## 2. Web Application (`password/`)

The Next.js 16 app delivers the same functionality through a modern, responsive UI with additional features for enhanced usability and security.

### Features

- **Two Generation Modes**
  - **Character Mode**: Generate traditional random passwords with customizable length and character requirements
  - **Passphrase Mode**: Generate memorable passphrases using word lists (EFF Diceware)

- **Password Strength Meter**
  - Real-time strength analysis using the zxcvbn library
  - Visual feedback with color-coded strength indicator (Very Weak to Very Strong)
  - Helpful warnings and suggestions for weak passwords

- **Exclude Ambiguous Characters**
  - Toggle to avoid confusing characters like 'l', '1', 'I', 'O', '0'
  - Works in both character and passphrase modes

- **Password History**
  - Automatically saves your last 10 generated passwords (in-memory only, cleared on page refresh)
  - Quick access to previously generated passwords
  - One-click copy from history

- **QR Code Generation**
  - Generate QR codes for your passwords
  - Useful for transferring passwords to mobile devices securely

- **Export & Copy**
  - One-click copy to clipboard
  - Download password as a text file
  - Visual confirmation when copied

- **Dark Mode Support**
  - Automatic theme detection
  - Smooth transitions between light and dark modes
  - Optimized for readability in both themes

- **Responsive Design**
  - Mobile-friendly interface
  - Touch-optimized controls
  - Works seamlessly on all screen sizes

- **Privacy & Security**
  - All password generation happens server-side using cryptographically secure randomness
  - No data is stored anywhere (no databases, no logs, no analytics)
  - Passwords are generated on-demand and never persisted
  - History is kept only in browser memory and cleared on page refresh

### Local Development

```bash
cd password
npm install
npm run dev
```

Navigate to http://localhost:3000. The dev server supports hot reload and calls the Python script shipped in the repo; make sure `python` is on your `PATH`.

### Production Build

```bash
cd password
npm run build
npm run start    # serves the optimized build on port 3000
```

### Docker Workflows

From the repository root:

- **Development (hot reload + bind mounts)**

  ```bash
  docker compose -f docker-compose-password-dev.yaml up --build
  ```

  - App available at http://localhost:6403
  - Source code auto-reloads thanks to bind-mounted `./password` directory.

- **Production**

  ```bash
  docker compose -f docker-compose-password-PRD.yaml up --build -d
  ```

  - Builds the multi-stage image defined in `Dockerfile.password.PRD`
  - Starts the optimized Next.js server on http://localhost:6403

Both images install Python 3 so the API route can execute `password_generator.py` securely within the container.

## 3. Shared Assets

- `password_generator.py` — core password/passphrase generator (leave unchanged).
- `eff_short_wordlist_1.txt` — default word list (EFF Diceware short list). You can replace or supply your own via CLI/ENV as needed.

## 4. Tips

- Running the script with `--non-interactive` makes it easy to integrate into shell scripts or CI pipelines.
- For the web app, values are sanitized and clamped server-side to prevent injection attacks; only minimal, safe characters are accepted for separators.
- If you update the word list, rebuild Docker images to pick up the new file.

Enjoy generating secure passwords! 🎯

## 5. License

Distributed under the MIT License. See `LICENSE` for details. Retain attribution to Alejandro Castro and AIEpicStudio.com and AIEpic.app in all copies or substantial portions of the software.

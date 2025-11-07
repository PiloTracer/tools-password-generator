#!/usr/bin/env python3
"""Interactive password and passphrase generator.

This utility can build either character-based passwords or word-based
passphrases. When run without command-line flags it will prompt for:
  - password length (for character passwords)
  - how many special characters to include
  - how many digits to include
  - how many mixed-case letters to include
  - whether to build a passphrase instead
  - how many words to use (for passphrases)
  - whether to randomize uppercase characters inside each word
  - how many digits, special characters, and mixed-case letters to append

All randomness comes from `secrets.SystemRandom`.
"""

from __future__ import annotations

import argparse
import secrets
import string
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

SPECIAL_CHARACTERS = "$%^@!&*"

# Fallback words used only if no external word list is available.
DEFAULT_INLINE_WORDS: List[str] = """
acorn agency arctic badge beacon blade breeze canyon cedar cobalt comet
coral delta dusk ember falcon fjord flicker galaxy glimmer harbor ivory
jasper jungle lagoon lantern linden matrix meadow nickel north oasis
onyx opal orbit pebble prism quartz ripple river saffron sailboat sierra
spruce summit thrush timber tundra tulip velvet walnut willow yonder zephyr
""".split()

DEFAULT_PASSWORD_LENGTH = 16
DEFAULT_SPECIAL_COUNT = 2
DEFAULT_DIGIT_COUNT = 2
DEFAULT_MIXED_CASE_COUNT = 6

DEFAULT_WORD_COUNT = 4
DEFAULT_WORD_SEPARATOR = "-"
DEFAULT_PASSPHRASE_DIGIT_COUNT = 2
DEFAULT_PASSPHRASE_SPECIAL_COUNT = 1
DEFAULT_PASSPHRASE_MIXED_COUNT = 2


@dataclass
class Configuration:
    """Container for the selected generation settings."""

    use_words: bool
    length: int
    special_count: int
    digit_count: int
    mixed_case_count: int
    word_count: int
    word_separator: str
    passphrase_digit_count: int
    passphrase_special_count: int
    passphrase_mixed_count: int
    randomize_word_capitalization: bool
    wordlist_path: Optional[Path]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate secure passwords or passphrases.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--use-words",
        dest="use_words",
        action="store_true",
        help="Generate a word-based passphrase instead of random characters.",
    )
    parser.add_argument(
        "--no-use-words",
        dest="use_words",
        action="store_false",
        help="Force character-based passwords even if defaults change.",
    )
    parser.set_defaults(use_words=None)

    parser.add_argument(
        "--length",
        type=int,
        default=None,
        help="Password length when generating character-based passwords.",
    )
    parser.add_argument(
        "--special-count",
        type=int,
        default=None,
        help="How many special characters to include in a character password.",
    )
    parser.add_argument(
        "--digit-count",
        type=int,
        default=None,
        help="How many digits to include in a character password.",
    )
    parser.add_argument(
        "--mixed-case-count",
        type=int,
        default=None,
        help="How many mixed-case letters to include in a character password.",
    )

    parser.add_argument(
        "--word-count",
        type=int,
        default=DEFAULT_WORD_COUNT,
        help="How many words to include when --use-words is selected.",
    )
    parser.add_argument(
        "--word-separator",
        default=DEFAULT_WORD_SEPARATOR,
        help="Separator string to place between words in a passphrase.",
    )
    parser.add_argument(
        "--passphrase-digit-count",
        type=int,
        default=DEFAULT_PASSPHRASE_DIGIT_COUNT,
        help="How many digits to append to a generated passphrase.",
    )
    parser.add_argument(
        "--passphrase-special-count",
        type=int,
        default=DEFAULT_PASSPHRASE_SPECIAL_COUNT,
        help="How many special characters to append to a passphrase.",
    )
    parser.add_argument(
        "--passphrase-mixed-count",
        type=int,
        default=DEFAULT_PASSPHRASE_MIXED_COUNT,
        help="How many mixed-case letters to append to a passphrase.",
    )
    parser.add_argument(
        "--randomize-word-case",
        dest="randomize_word_case",
        action="store_true",
        help="Randomly uppercase characters inside each word (passphrase mode).",
    )
    parser.add_argument(
        "--no-randomize-word-case",
        dest="randomize_word_case",
        action="store_false",
        help="Keep passphrase words lowercase.",
    )
    parser.set_defaults(randomize_word_case=None)

    parser.add_argument(
        "--wordlist",
        type=Path,
        help="Path to a custom word list (one word per line).",
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Skip interactive prompts and rely solely on the provided flags.",
    )
    return parser


def prompt_positive_int(prompt: str, default: int) -> int:
    while True:
        raw = input(f"{prompt} [{default}]: ").strip()
        if not raw:
            return default
        try:
            value = int(raw)
        except ValueError:
            print("Please enter a whole number.")
            continue
        if value <= 0:
            print("Value must be positive.")
            continue
        return value


def prompt_non_negative_int(prompt: str, default: int) -> int:
    while True:
        raw = input(f"{prompt} [{default}]: ").strip()
        if not raw:
            return default
        try:
            value = int(raw)
        except ValueError:
            print("Please enter a whole number.")
            continue
        if value < 0:
            print("Value must be zero or positive.")
            continue
        return value


def prompt_bool(prompt: str, default: bool) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        raw = input(f"{prompt} ({suffix}): ").strip().lower()
        if not raw:
            return default
        if raw in {"y", "yes"}:
            return True
        if raw in {"n", "no"}:
            return False
        print("Please respond with 'y' or 'n'.")


def resolve_positive(
    value: Optional[int], prompt_text: str, default: int, should_prompt: bool
) -> int:
    if value is not None:
        if value <= 0:
            raise ValueError(f"{prompt_text} must be positive.")
        return value
    if should_prompt:
        return prompt_positive_int(prompt_text, default)
    return default


def resolve_non_negative(
    value: Optional[int], prompt_text: str, default: int, should_prompt: bool
) -> int:
    if value is not None:
        if value < 0:
            raise ValueError(f"{prompt_text} must be zero or positive.")
        return value
    if should_prompt:
        return prompt_non_negative_int(prompt_text, default)
    return default


def resolve_bool(
    value: Optional[bool], prompt_text: str, default: bool, should_prompt: bool
) -> bool:
    if value is not None:
        return value
    if should_prompt:
        return prompt_bool(prompt_text, default)
    return default


def gather_configuration(args: argparse.Namespace) -> Configuration:
    interactive = not args.non_interactive

    if args.use_words is not None:
        use_words = args.use_words
    elif interactive:
        use_words = prompt_bool("Use words to build a passphrase", False)
    else:
        use_words = False

    length = resolve_positive(
        args.length,
        "Desired password length",
        DEFAULT_PASSWORD_LENGTH,
        should_prompt=interactive and not use_words,
    )

    special_count = resolve_non_negative(
        args.special_count,
        "How many special characters should the password include",
        DEFAULT_SPECIAL_COUNT,
        should_prompt=interactive and not use_words,
    )
    digit_count = resolve_non_negative(
        args.digit_count,
        "How many numbers should the password include",
        DEFAULT_DIGIT_COUNT,
        should_prompt=interactive and not use_words,
    )
    mixed_case_count = resolve_non_negative(
        args.mixed_case_count,
        "How many mixed-case letters should the password include",
        DEFAULT_MIXED_CASE_COUNT,
        should_prompt=interactive and not use_words,
    )

    word_count = resolve_positive(
        args.word_count,
        "How many words should the passphrase contain",
        DEFAULT_WORD_COUNT,
        should_prompt=interactive and use_words,
    )
    word_separator = args.word_separator

    passphrase_digit_count = resolve_non_negative(
        args.passphrase_digit_count,
        "How many numbers should be appended to the passphrase",
        DEFAULT_PASSPHRASE_DIGIT_COUNT,
        should_prompt=interactive and use_words,
    )
    passphrase_special_count = resolve_non_negative(
        args.passphrase_special_count,
        "How many special characters should be appended to the passphrase",
        DEFAULT_PASSPHRASE_SPECIAL_COUNT,
        should_prompt=interactive and use_words,
    )
    passphrase_mixed_count = resolve_non_negative(
        args.passphrase_mixed_count,
        "How many mixed-case letters should be appended to the passphrase",
        DEFAULT_PASSPHRASE_MIXED_COUNT,
        should_prompt=interactive and use_words,
    )

    randomize_word_capitalization = resolve_bool(
        args.randomize_word_case,
        "Randomize which character in each word is uppercase",
        True,
        should_prompt=interactive and use_words,
    )

    return Configuration(
        use_words=use_words,
        length=length,
        special_count=special_count,
        digit_count=digit_count,
        mixed_case_count=mixed_case_count,
        word_count=word_count,
        word_separator=word_separator,
        passphrase_digit_count=passphrase_digit_count,
        passphrase_special_count=passphrase_special_count,
        passphrase_mixed_count=passphrase_mixed_count,
        randomize_word_capitalization=randomize_word_capitalization,
        wordlist_path=args.wordlist,
    )


def ensure_length_valid(
    length: int, special_count: int, digit_count: int, mixed_case_count: int
) -> None:
    if any(value < 0 for value in (special_count, digit_count, mixed_case_count)):
        raise ValueError("Counts for special, digit, and mixed-case characters must be non-negative.")
    if length <= 0:
        raise ValueError("Length must be positive.")
    required = special_count + digit_count + mixed_case_count
    if required > length:
        raise ValueError(
            "Requested length is too short to accommodate the specified numbers of "
            "special, digit, and mixed-case characters."
        )


def random_mixed_case_letter(rng: secrets.SystemRandom) -> str:
    letter = rng.choice(string.ascii_lowercase)
    if rng.choice([True, False]):
        return letter.upper()
    return letter


def generate_character_password(
    length: int, special_count: int, digit_count: int, mixed_case_count: int
) -> str:
    ensure_length_valid(length, special_count, digit_count, mixed_case_count)
    rng = secrets.SystemRandom()
    password_chars: List[str] = []

    password_chars.extend(rng.choice(SPECIAL_CHARACTERS) for _ in range(special_count))
    password_chars.extend(rng.choice(string.digits) for _ in range(digit_count))
    password_chars.extend(random_mixed_case_letter(rng) for _ in range(mixed_case_count))

    remaining = length - len(password_chars)
    password_chars.extend(rng.choice(string.ascii_lowercase) for _ in range(remaining))

    rng.shuffle(password_chars)
    return "".join(password_chars)


def load_wordlist(path: Optional[Path]) -> List[str]:
    if path is not None:
        if not path.is_file():
            raise FileNotFoundError(f"Word list not found: {path}")
        candidate_paths: Iterable[Path] = [path]
    else:
        candidate_paths = [Path(__file__).with_name("eff_short_wordlist_1.txt")]

    for candidate in candidate_paths:
        if not candidate.is_file():
            continue
        words: List[str] = []
        with candidate.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                words.append(parts[-1].lower())
        if words:
            return words

    return list(DEFAULT_INLINE_WORDS)


def randomize_word(word: str, rng: secrets.SystemRandom, randomize: bool) -> str:
    base = word.lower()
    if not randomize:
        return base
    letters = list(base)
    index = rng.randrange(len(letters))
    letters[index] = letters[index].upper()
    return "".join(letters)


def generate_passphrase(
    *,
    word_count: int,
    words: List[str],
    separator: str,
    digit_count: int,
    special_count: int,
    mixed_count: int,
    randomize_word_capitalization: bool,
) -> str:
    if not words:
        raise ValueError("Word list is empty; provide a valid word list.")

    rng = secrets.SystemRandom()
    selected_words: List[str] = []
    for _ in range(word_count):
        word = rng.choice(words)
        selected_words.append(randomize_word(word, rng, randomize_word_capitalization))

    if separator:
        base = separator.join(selected_words)
    else:
        base = "".join(selected_words)

    suffix_parts: List[str] = []
    if digit_count > 0:
        suffix_parts.append("".join(rng.choice(string.digits) for _ in range(digit_count)))
    if special_count > 0:
        suffix_parts.append("".join(rng.choice(SPECIAL_CHARACTERS) for _ in range(special_count)))
    if mixed_count > 0:
        suffix_parts.append("".join(random_mixed_case_letter(rng) for _ in range(mixed_count)))

    if not suffix_parts:
        return base

    if separator:
        return separator.join([base, *suffix_parts])
    return base + "".join(suffix_parts)


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    try:
        config = gather_configuration(args)
        if not config.use_words:
            ensure_length_valid(
                config.length, config.special_count, config.digit_count, config.mixed_case_count
            )
    except KeyboardInterrupt:
        print("\nAborted.")
        return
    except ValueError as exc:
        print(f"\nError: {exc}")
        return

    print("\nPassword configuration:")
    print(f"  Use words: {'Yes' if config.use_words else 'No'}")
    if config.use_words:
        print(f"  Word count: {config.word_count}")
        print(f"  Separator: '{config.word_separator}'")
        print(f"  Randomize uppercase positions: {'Yes' if config.randomize_word_capitalization else 'No'}")
        print(f"  Appended numbers: {config.passphrase_digit_count}")
        print(f"  Appended specials: {config.passphrase_special_count}")
        print(f"  Appended mixed-case letters: {config.passphrase_mixed_count}")
    else:
        print(f"  Length: {config.length}")
        print(f"  Special characters required: {config.special_count}")
        print(f"  Numbers required: {config.digit_count}")
        print(f"  Mixed-case letters required: {config.mixed_case_count}")
        filler = config.length - (
            config.special_count + config.digit_count + config.mixed_case_count
        )
        print(f"  Lowercase filler characters: {max(0, filler)}")

    if config.use_words:
        words = load_wordlist(config.wordlist_path)
        password = generate_passphrase(
            word_count=config.word_count,
            words=words,
            separator=config.word_separator,
            digit_count=config.passphrase_digit_count,
            special_count=config.passphrase_special_count,
            mixed_count=config.passphrase_mixed_count,
            randomize_word_capitalization=config.randomize_word_capitalization,
        )
    else:
        password = generate_character_password(
            config.length, config.special_count, config.digit_count, config.mixed_case_count
        )

    print("\nGenerated password:\n")
    print(password)


if __name__ == "__main__":
    main()

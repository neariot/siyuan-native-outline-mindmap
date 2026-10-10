#!/usr/bin/env python3
"""Enforce the AGENTS.md section 2 language policy mechanically, over every file type at once.

## Why it exists

Section 2 fixes the language of every surface: code comments, test names, assertion messages,
console output and developer docs are English, while user docs (`*.zh-CN.md`), i18n JSON, Chinese
test fixtures and kernel strings stay Chinese. Checking that **by hand** was done twice and missed
whole file classes both times: one sweep read `src/**` and never opened `e2e/**` or `scripts/**`,
the next one read the source and never opened `docs/**`. A rule whose enforcement is "remember to
also check ..." is not enforced. This tool is the enforcement: it walks the tree once, reads every
file with the strongest parser that is actually reachable, and prints what it did not read.

## What it scans, and with what

| Files | How |
|---|---|
| `.py` | `tokenize` for comments, `ast` for string literals (a real parser on both halves) |
| `.ts .tsx .mts .cts .js .mjs .cjs` | a scanner: line/block comments, `'`/`"` strings, template literals with `${...}`, regex literals |
| `.css` | a scanner for the two CSS token types that can carry prose: comments and strings |
| `.md` | per line, for files that must be English (Chinese user docs are skipped by path) |
| `.json` | `json.loads`, then keys and string values are walked for CJK |

## What it cannot see (do not read "no findings" as "the tree is clean")

* **`.ts`/`.tsx`/`.js`: no TypeScript compiler is reachable from python.** The scanner recognizes
  token *boundaries* (comments, strings, templates, regex literals), not the grammar, so it has no
  notion of types, JSX semantics or scope. CJK can only enter such a file through a comment, a
  string or an identifier, and those boundaries are the same in every dialect, which is why a
  scanner is sound here. The price of being a scanner is that one token misread makes every
  following token wrong, so an **unterminated token is a hard error (exit 2)**, never a silent stop.
* **Regex literals are the one place the scanner guesses.** Division and a regex start are told
  apart by the previous significant token (after an identifier, number, string, `)`, `]` or `}` a
  `/` divides; after `<` it closes a JSX tag, `</span>`; otherwise it starts a regex). In valid code
  a division always follows an expression end, so the guess is decidable up to the point where the
  code is already invalid; the one shape it reads wrong is a comparison against a regex literal
  (`a < /re/`), and any CJK that lands in the miscounted span is still reported as `code`.
* **CJK inside a regex literal is deliberately not reported**: a regex matches text the kernel or
  the UI produced, which section 2 keeps verbatim. The summary counts those occurrences so the
  reader knows they exist and were skipped on purpose.
* **`.css`: `postcss` is not available to python** (standard library only). This is a tokenizer for
  comment and string tokens, not a CSS parser: selectors, at-rules and declarations are not parsed.
  CJK outside a comment or a string (for example a Chinese selector) is reported as `code`, so the
  gap costs a precise classification, never a missed file.
* **JSX text is not a string token.** CJK written directly as JSX children (`<span>` + CJK +
  `</span>`) reaches the scanner as neither comment nor string and is reported as `code`. That is a
  real limitation of a tokenizer and the reason the `code` kind exists —— a scanner that dropped it
  would pass vacuously, which section 8 forbids.
* **Not read at all**: `.yml`, `.env.example`, `.gitignore`, `LICENSE` (no parser for the type),
  binary and media files, this tool's own allowlist, gitignored paths (`.tmp/`, `.logs/`,
  `node_modules/`, `dist-plugin/`, `.git/`) and **untracked files** (git does not list them; the
  summary names them so a new file cannot be forgotten).
* Files are read from the **working tree** (what is on disk now), not from `HEAD`; the file *list*
  comes from `git ls-files`.

## Allowlist

Chinese that section 2 permits in an otherwise English file (fixture content under test, kernel
strings matched verbatim, a product label quoted as evidence) is enumerated in
`scripts/language-allowlist.txt`:

    src/siyuan/store.ts:119  # kernel placeholder text compared verbatim
    src/core/map.test.ts     # CJK fixture node titles under test (string findings only)
    fixture:<token>          # a short CJK fixture identifier quoted anywhere as evidence
    kernel:<token>           # a short CJK string the kernel or the product produces verbatim
    i18n:<token>             # product label, verified against src/plugin/i18n/zh_CN.json

(`scripts/language-allowlist.txt` carries the real entries, one token each.)

* a `path:line` entry covers the findings on that line;
* a `path` entry covers **`string` findings only** in that file —— a comment, a test name and an
  assertion message are violations by policy, so they need a line or token entry of their own;
* a token entry covers a finding whose CJK text is exactly that token, **anywhere**, which is what
  makes the list survive an edit that moves every line below it. Two guards keep the token form
  from becoming a blanket allowance for Chinese prose: `fixture:` and `kernel:` tokens are capped at
  12 characters (a quoted label is short, a sentence is not), and an `i18n:` token must appear in
  the product's own `zh_CN.json` —— a token that is not a product string is a broken entry, not an
  allowance.

An entry that matches nothing is an **error** (exit 1): a stale entry means the line moved or the
Chinese was already removed, and a rubber stamp that outlives its subject is how an allowlist turns
into a blindfold.

## Usage

    python3 scripts/audit-language.py            # audit the working tree
    python3 scripts/audit-language.py --selftest # check this checker against in-memory fixtures

    python3 scripts/audit-language.py | head     # findings first, summary last

## Output

    <path>:<line>: <kind>: <text>

        <kind>  comment | string | assertion | doc-prose | code
                `code` = CJK the scanner saw outside any comment or string (identifier, JSX text)

The summary names the scanned / reported / skipped counts, the skipped reasons, what was not read
at all, the allowlist usage and the untracked files.

## Exit code

    0  no finding, no stale allowlist entry
    1  at least one finding, or a stale allowlist entry
    2  the audit could not run (git missing, unreadable or unparsable file, broken allowlist)
"""

import argparse
import ast
import bisect
import io
import json
import os
import re
import subprocess
import sys
import tokenize
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import script_log
except ImportError as exc:  # AGENTS.md section 8: every script logs how long it took.
    print(
        "audit-language: ERROR: scripts/script_log.py is required (AGENTS.md section 8): %s" % exc,
        file=sys.stderr,
    )
    raise SystemExit(2)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWLIST_FILE = os.path.join(REPO_ROOT, "scripts", "language-allowlist.txt")

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_ERROR = 2

# CJK as section 2 uses the word: Han ideographs (U+3400-U+4DBF, U+4E00-U+9FFF, U+F900-U+FAFF),
# CJK punctuation (U+3000-U+303F: the enumeration comma, the ideographic full stop, corner
# brackets) and fullwidth forms (U+FF01-U+FF60 plus U+FFE0-U+FFE6, fullwidth Latin included).
# Kana is deliberately absent: a Japanese string is a separate question this policy does not
# answer. ★ This file itself contains no CJK character, so the auditor never has to allowlist
# itself; its selftest fixtures are built from code points (`ZH` below).
def _codepoint_ranges(*ranges):
    """Build a regex character-class body from code points.

    Written this way so this file holds no CJK **in a value either**: an escaped code point (a
    backslash, a `u` and four hex digits) still *is* that character to `ast`, and the audit decodes
    string values on purpose, so it would report the auditor itself. Code points keep the invariant
    true in both senses.
    """
    return "".join(chr(low) + "-" + chr(high) for low, high in ranges)


CJK_CHARS = _codepoint_ranges(
    (0x3000, 0x303F),  # CJK punctuation
    (0x3400, 0x4DBF),  # unified ideographs extension A
    (0x4E00, 0x9FFF),  # unified ideographs
    (0xF900, 0xFAFF),  # compatibility ideographs
    (0xFF01, 0xFF60),  # fullwidth forms
    (0xFFE0, 0xFFE6),  # fullwidth currency signs
)
CJK_ANY = re.compile("[%s]" % CJK_CHARS)
CJK_RUN = re.compile("[%s]+" % CJK_CHARS)

KINDS = ("comment", "string", "assertion", "doc-prose", "code")
#: Categories (not entries) that make Chinese legitimate: a product string quoted by prose, a fixture
#: literal inside a test file, a manifest string. See `excuse_rule`.

# Paths that are never read. The reasons are the policy's own words (AGENTS.md section 2) and are
# printed in the summary, so "nothing was reported" is never confused with "nothing was looked at".
SKIP_PREFIXES = (
    (".tmp/", "gitignored development diary (.tmp/)"),
    (".logs/", "gitignored development diary (.logs/)"),
    (".git/", "git internals"),
    ("node_modules/", "installed dependency (node_modules/)"),
    ("dist-plugin/", "build output (dist-plugin/)"),
    ("__pycache__/", "python bytecode cache"),
)

BINARY_EXT = frozenset(
    ".png .jpg .jpeg .gif .webp .ico .bmp .svgz .webm .mp4 .mov .mp3 .wav "
    ".woff .woff2 .ttf .otf .eot .zip .gz .tar .pdf .so .node".split()
)

JS_EXT = frozenset(".ts .tsx .mts .cts .js .jsx .mjs .cjs".split())

#: Allowlist token classes: (prefix, name, length cap). 0 means "no cap" -- `i18n:` tokens are
#: verified against the product catalogue instead, which is a stronger check than a length.
TOKEN_CLASSES = (("i18n:", "i18n", 0), ("fixture:", "fixture", 12), ("kernel:", "kernel", 12))

#: The product's own Chinese strings: the authority for `i18n:` allowlist entries. The i18n
#: catalogue is the user-visible UI text, the plugin manifest carries the display name and the
#: description AGENTS.md section 3 fixes.
I18N_CATALOG = ("src/plugin/i18n/zh_CN.json", "src/plugin/plugin.json")

#: Calls whose string arguments are test names or assertion messages: section 2 requires English.
ASSERT_CALLEES = frozenset(
    "expect assert describe it test specify beforeAll afterAll beforeEach afterEach "
    "strictEqual deepStrictEqual notEqual toThrow fail Error RuntimeError TypeError "
    "ValueError AssertionError".split()
)

#: Words after which a `/` starts a regex rather than dividing (see the docstring's caveat).
REGEX_KEYWORDS = frozenset(
    "return typeof instanceof in of new delete void case do else yield await throw "
    "default extends".split()
)

#: Every token type whose text is a string literal. Python 3.12 tokenizes an f-string as
#: FSTRING_START / FSTRING_MIDDLE / FSTRING_END instead of one STRING token, and the CJK of
#: `f'{ZH} {i}'` lives in FSTRING_MIDDLE: leaving those out of the covered intervals reported the
#: same text twice, once as `string` (from `ast`) and once as `code` (as if unclassified).
STRING_TOKENS = frozenset(
    [tokenize.STRING]
    + [getattr(tokenize, name) for name in ("FSTRING_START", "FSTRING_MIDDLE", "FSTRING_END")
       if hasattr(tokenize, name)]
)

IDENT_START = re.compile(r"[A-Za-z_$]")
IDENT_REST = re.compile(r"[A-Za-z0-9_$]*")
NUMBER = re.compile(r"(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*)(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)")


class AuditError(Exception):
    """The audit could not run (exit 2). Never a silent skip."""


class ScanError(Exception):
    """A file could not be tokenized honestly, so its result would be a guess."""


class AllowError(Exception):
    """The allowlist file itself is malformed."""


class Finding:
    """One CJK occurrence, located as precisely as the parser allows."""

    __slots__ = ("path", "line", "kind", "text")

    def __init__(self, path, line, kind, text):
        self.path = path
        self.line = line
        self.kind = kind
        self.text = text

    def key(self):
        return (self.path, self.line)


class ScanResult:
    def __init__(self, findings=None, notes=None):
        self.findings = findings or []
        self.notes = notes or Counter()


class Source:
    """Offset <-> line mapping, and the two helpers every scanner shares."""

    def __init__(self, text):
        self.text = text
        self.starts = [0] + [m.end() for m in re.finditer("\n", text)]

    def offset(self, row, col):
        index = row - 1
        if index < 0 or index >= len(self.starts):
            raise ScanError("token position %d:%d is outside the file" % (row, col))
        return min(self.starts[index] + col, len(self.text))

    def line_of(self, offset):
        return bisect.bisect_right(self.starts, offset)

    def report_run(self, match, kind, path, findings, base=0):
        """Record a CJK run. `base` is where the searched text starts in the file.

        ★ A match found inside a *token's* text is not an offset into the file: searching a comment
        token and then mapping `match.start()` into `self.text` reports every such finding on line 1,
        which makes `path:line` useless for the reader. Callers that search a token must pass its start.
        """
        # `text` stays the whole run: the allowlist matches on it exactly, the printer truncates.
        findings.append(Finding(path, self.line_of(base + match.start()), kind, match.group(0)))


def _snippet(text, limit=72):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "\u2026"


def _covered(offset, starts, intervals):
    """True when `offset` falls inside one of the sorted, non-overlapping token intervals."""
    index = bisect.bisect_right(starts, offset) - 1
    return index >= 0 and offset < intervals[index][1]


def _uncovered(source, intervals, path, findings, notes):
    """CJK the tokenizer saw outside every token it understands.

    This is the honesty valve: whatever a scanner failed to classify is still reported (as `code`)
    instead of quietly passing.
    """
    intervals.sort()
    starts = [start for start, _ in intervals]
    for match in CJK_RUN.finditer(source.text):
        if not _covered(match.start(), starts, intervals):
            notes["code"] += 1
            source.report_run(match, "code", path, findings)


# ------------------------------------------------------------------------------- python


def _py_constant_kinds(tree):
    """ids of string constants that are docstrings, and of those used as a message."""
    docstrings, messages = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if not body or not isinstance(body[0], ast.Expr):
                continue
            value = body[0].value
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                docstrings.add(id(value))
        if isinstance(node, ast.Assert) and node.msg is not None:
            for child in ast.walk(node.msg):
                if isinstance(child, ast.Constant) and isinstance(child.value, str):
                    messages.add(id(child))
        if isinstance(node, ast.Raise) and node.exc is not None:
            for child in ast.walk(node.exc):
                if isinstance(child, ast.Constant) and isinstance(child.value, str):
                    messages.add(id(child))
    return docstrings, messages


def scan_python(path, text):
    """Comments through `tokenize`, string literals through `ast`.

    `tokenize` is used for comments because hand-rolled `#` scanning is wrong inside a string, and
    because the parser already answers "is this token a comment". `ast` is used for strings because
    it decodes escapes: a CJK string written as `\\u4e2d\\u6587` is still a Chinese string, and the
    tokenizer's raw text would show none.
    """
    source = Source(text)
    findings, notes = [], Counter()
    intervals = []

    try:
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            # ★ Only the two kinds this scanner looks at get an offset. Asking for one on every token
            #   meant asking for it on `tokenize`'s synthesised NEWLINE/ENDMARKER too, which for a file
            #   with no trailing newline sits one row past the last line -- valid Python was then
            #   rejected as "outside the file". A kind we do not read needs no position.
            if token.type not in STRING_TOKENS and token.type != tokenize.COMMENT:
                continue
            start, end = source.offset(*token.start), source.offset(*token.end)
            intervals.append((start, end))
            if token.type == tokenize.COMMENT:
                for match in CJK_RUN.finditer(token.string):
                    source.report_run(match, "comment", path, findings, start)
    except (tokenize.TokenError, IndentationError, SyntaxError) as exc:
        raise ScanError("tokenize failed: %s" % exc)

    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        raise ScanError("ast.parse failed: line %s: %s" % (exc.lineno, exc.msg))

    docstrings, messages = _py_constant_kinds(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if not CJK_ANY.search(node.value):
            continue
        if id(node) in docstrings:
            kind = "doc-prose"
        elif id(node) in messages:
            kind = "assertion"
        else:
            kind = "string"
        segment = ast.get_source_segment(text, node) or ""
        line = node.lineno
        in_source = CJK_ANY.search(segment)
        if in_source:  # an escaped `\u4e2d` has no CJK in the source; the node's line is all we have
            line += segment[: in_source.start()].count("\n")
        run = CJK_RUN.search(node.value).group(0)
        findings.append(Finding(path, line, kind, run))

    _uncovered(source, intervals, path, findings, notes)
    return ScanResult(findings, notes)


# ------------------------------------------------------------------------- javascript / typescript


class JsScanner:
    """A tokenizer for the JavaScript / TypeScript family (see the module docstring's limits).

    Recognized: `//` comments, `/* */` comments, `'`/`"` strings, template literals (each literal
    segment separately, so a nested string inside `${...}` is not counted twice), regex literals.
    """

    def __init__(self, path, text):
        self.path = path
        self.text = text
        self.source = Source(text)
        self.findings = []
        self.notes = Counter()
        self.sig = []  # significant tokens, for the "does this `/` divide?" and call-context rules

    def run(self):
        text, n = self.text, len(self.text)
        intervals = []
        subst = []           # brace depth of each open `${` substitution
        segments = []        # start offset of each open template literal segment (its literal text)
        i = 0
        while i < n:
            char = text[i]
            if segments:
                if char == "\\":
                    i += 2
                    continue
                if char == "`":
                    start = segments.pop()
                    # Only the literal text is an interval: the `${...}` code is scanned on its own,
                    # which keeps the interval list disjoint (the coverage test bisects over starts).
                    intervals.append((start, i))
                    self._string(start, text[start:i])
                    i += 1
                    continue
                if char == "$" and i + 1 < n and text[i + 1] == "{":
                    start = segments.pop()
                    intervals.append((start, i))
                    self._string(start, text[start:i])
                    subst.append(0)
                    self.sig.append(("punct", "(", i))
                    i += 2
                    continue
                i += 1
                continue

            if char == "`":
                segments.append(i + 1)
                i += 1
                continue
            if char in " \t\r\n":
                i += 1
                continue
            if text.startswith("//", i):
                end = text.find("\n", i)
                end = n if end < 0 else end
                intervals.append((i, end))
                self._report(i, text[i:end], "comment")
                i = end
                continue
            if text.startswith("/*", i):
                end = text.find("*/", i + 2)
                if end < 0:
                    raise ScanError("unterminated block comment at offset %d" % i)
                intervals.append((i, end + 2))
                self._report(i, text[i : end + 2], "comment")
                i = end + 2
                continue
            if char in "'\"":
                end = self._quoted_end(i)
                intervals.append((i, end))
                self._string(i, text[i:end])
                i = end
                continue
            if char == "/" and self._regex_allowed():
                end = self._regex_end(i)
                intervals.append((i, end))
                self.notes["regex"] += len(CJK_RUN.findall(text[i:end]))
                self.sig.append(("regex", "", i))
                i = end
                continue
            if IDENT_START.match(char):
                end = i + len(IDENT_REST.match(text, i + 1).group(0)) + 1
                self.sig.append(("ident", text[i:end], i))
                i = end
                continue
            if char.isdigit():
                end = NUMBER.match(text, i).end()
                self.sig.append(("number", text[i:end], i))
                i = end
                continue
            if char == "}" and subst:
                subst[-1] -= 1
                if subst[-1] < 0:
                    subst.pop()
                    segments.append(i + 1)
                    i += 1
                    continue
                self.sig.append(("punct", char, i))
                i += 1
                continue
            if char == "{" and subst:
                subst[-1] += 1
            self.sig.append(("punct", char, i))
            i += 1

        if segments:
            raise ScanError("unterminated template literal at offset %d" % segments[-1][0])
        if subst:
            raise ScanError("unterminated `${...}` substitution")

        _uncovered(self.source, intervals, self.path, self.findings, self.notes)
        return ScanResult(self.findings, self.notes)

    # -- helpers

    def _report(self, offset, raw, kind):
        for match in CJK_RUN.finditer(raw):
            line = self.source.line_of(offset + match.start())
            self.findings.append(Finding(self.path, line, kind, match.group(0)))

    def _string(self, offset, raw):
        if not raw:
            self.sig.append(("string", "", offset))
            return
        kind = self._string_kind(offset, raw)
        if kind == "i18n-fallback":
            # Recognised, not reported: this is the catalogue's own text.
            self.notes["i18n-fallback"] += len(CJK_RUN.findall(raw))
            self.sig.append(("string", "", offset))
            return
        for match in CJK_RUN.finditer(raw):
            line = self.source.line_of(offset + match.start())
            self.findings.append(Finding(self.path, line, kind, match.group(0)))
        self.sig.append(("string", "", offset))

    def _literal_at(self, offset):
        """The decoded text of the string literal starting at `offset`."""
        end = self._quoted_end(offset)
        return decode_js_literal(self.text[offset:end])

    def _string_kind(self, offset, raw=None):
        """`assertion` for a test/error call argument, `string` for any other literal.

        The label is best-effort (a `.each(...)('name')` chain is reported as `string`); detection
        is not —— a CJK string is reported unless it is recognised as one of those two.
        """
        # The walk starts with depth 0 and goes backwards: a `)`/`}`/`]` opens a nesting level, and the
        # matching `(`/`{`/`[` closes it. Only a **balanced** brace is part of an argument list —— an
        # object in the `vars` slot (`t(key, { n: 1 }, text)`) is, while a `{` that closes nothing is the
        # block boundary this walk is looking for. Without the depth test a vars object ended the search
        # and its catalogue-aligned fallback was reported as a violation.
        depth = 0
        for index in range(len(self.sig) - 1, max(-1, len(self.sig) - 200), -1):
            kind, token, _ = self.sig[index]
            if kind == "punct" and token in (")", "}", "]"):
                depth += 1
                continue
            if kind == "punct" and token in ("(", "{", "["):
                if depth:
                    depth -= 1
                    continue
                if token != "(":
                    return "string"
            if kind == "punct" and token == "(":
                if index > 0 and self.sig[index - 1][0] == "ident":
                    return "assertion" if self.sig[index - 1][1] in ASSERT_CALLEES else "string"
                return "string"
            if kind == "punct" and token == ";":
                return "string"
        return "string"

    def _quoted_end(self, start):
        quote, index, n = self.text[start], start + 1, len(self.text)
        while index < n:
            char = self.text[index]
            if char == "\\":
                index += 2
                continue
            if char == quote:
                return index + 1
            if char == "\n":
                raise ScanError("unterminated string literal at offset %d" % start)
            index += 1
        raise ScanError("unterminated string literal at offset %d" % start)

    def _regex_end(self, start):
        index, n, in_class = start + 1, len(self.text), False
        while index < n:
            char = self.text[index]
            if char == "\\":
                index += 2
                continue
            if char == "\n":
                raise ScanError("unterminated regex literal at offset %d" % start)
            if char == "[":
                in_class = True
            elif char == "]":
                in_class = False
            elif char == "/" and not in_class:
                index += 1
                while index < n and self.text[index].isalpha():
                    index += 1
                return index
            index += 1
        raise ScanError("unterminated regex literal at offset %d" % start)

    def _regex_allowed(self):
        if not self.sig:
            return True
        kind, token, _ = self.sig[-1]
        if kind == "ident":
            return token in REGEX_KEYWORDS
        if kind in ("number", "string", "regex"):
            return False
        if kind == "punct":
            # `<` is the JSX case: `</span>` closes a tag, it does not start a regex.
            return token not in (")", "]", "}", "<")
        return True


# ------------------------------------------------------------------------------------- css


def scan_css(path, text):
    """Comment and string tokens of CSS, and nothing else (see the module docstring).

    Deliberately not a CSS parser: `postcss` is not importable from python, and this project will
    not claim selector-level knowledge it does not have. The states below are the tokenizer part of
    CSS Syntax 3 that decides where a comment ends and where a string ends —— including the two
    cases a line-based scan gets wrong: a `"` inside a comment is not a string, and a `/*` inside a
    string is not a comment.
    """
    source = Source(text)
    findings, notes, intervals = [], Counter(), []
    index, n = 0, len(text)
    while index < n:
        char = text[index]
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise ScanError("unterminated comment at offset %d" % index)
            intervals.append((index, end + 2))
            raw = text[index : end + 2]
            for match in CJK_RUN.finditer(raw):
                line = source.line_of(index + match.start())
                findings.append(Finding(path, line, "comment", match.group(0)))
            index = end + 2
            continue
        if char in "'\"":
            quote, cursor = char, index + 1
            while cursor < n:
                inner = text[cursor]
                if inner == "\\":
                    cursor += 2
                    continue
                if inner == quote:
                    break
                if inner == "\n":
                    raise ScanError("unterminated string at offset %d" % index)
                cursor += 1
            else:
                raise ScanError("unterminated string at offset %d" % index)
            intervals.append((index, cursor + 1))
            raw = text[index : cursor + 1]
            for match in CJK_RUN.finditer(raw):
                line = source.line_of(index + match.start())
                findings.append(Finding(path, line, "string", match.group(0)))
            index = cursor + 1
            continue
        index += 1

    _uncovered(source, intervals, path, findings, notes)
    return ScanResult(findings, notes)


# ---------------------------------------------------------------- markdown / json


def scan_markdown(path, text):
    findings = []
    for number, line in enumerate(text.split("\n"), start=1):
        match = CJK_RUN.search(line)
        if match:
            findings.append(Finding(path, number, "doc-prose", match.group(0)))
    return ScanResult(findings)


def _json_needle(value):
    """The raw-text form of a CJK run inside a JSON string: either the characters or their escape."""
    run = CJK_RUN.search(value)
    literal = run.group(0)
    escaped = "".join("\\u%04x" % ord(char) for char in literal)
    return literal, escaped


def scan_json(path, text):
    """`json.loads` decides *whether* there is CJK; the line is then located in the raw text.

    A JSON file has no comments, so a JSON string value is the only surface that can carry prose.
    """
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ScanError("json.loads failed: line %d: %s" % (exc.lineno, exc.msg))

    values = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                values.append(key)
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str):
            values.append(node)

    walk(document)

    findings = []
    for value in values:
        if not isinstance(value, str) or not CJK_ANY.search(value):
            continue
        literal, escaped = _json_needle(value)
        for needle in (literal, escaped):
            at = text.find(needle)
            if at >= 0:
                findings.append(Finding(path, Source(text).line_of(at), "string", literal))
                break
        else:
            raise ScanError(
                "a CJK value in this JSON file cannot be located in its source text; "
                "the audit will not report a guessed line"
            )
    return ScanResult(findings)


# ------------------------------------------------------------------------- file classification


def classify(path):
    """Decide what to do with one tracked path. Returns ("scan", name) or ("skip", reason)."""
    for prefix, reason in SKIP_PREFIXES:
        if path.startswith(prefix):
            return "skip", reason
    base = os.path.basename(path)
    if path == "scripts/language-allowlist.txt":
        return "skip", "the allowlist itself"
    if base == "README.zh-CN.md" or base.endswith(".zh-CN.md"):
        return "skip", "user-facing Chinese doc (*.zh-CN.md): policy"
    if path.startswith("src/plugin/i18n/"):
        return "skip", "plugin UI strings (src/plugin/i18n/): policy"
    extension = os.path.splitext(base)[1].lower()
    if extension in BINARY_EXT:
        return "skip", "binary or media file (not text)"
    if extension == ".py":
        return "scan", "python"
    if extension in JS_EXT:
        return "scan", "javascript/typescript"
    if extension == ".css":
        return "scan", "css"
    if extension == ".md":
        return "scan", "markdown"
    if extension == ".json":
        return "scan", "json"
    return "skip", "no parser for this type (not scanned)"


def scan_file(path, text):
    kind = classify(path)
    if kind[0] != "scan":
        raise AuditError("scan_file called on a skipped path: %s" % path)
    name = kind[1]
    if name == "python":
        return scan_python(path, text)
    if name == "javascript/typescript":
        return JsScanner(path, text).run()
    if name == "css":
        return scan_css(path, text)
    if name == "markdown":
        return scan_markdown(path, text)
    if name == "json":
        return scan_json(path, text)
    raise AuditError("no scanner registered for %s" % name)


# ----------------------------------------------------------------------------------- allowlist


class Allowlist:
    """The explicit list of Chinese that section 2 permits in an otherwise English file.

    Three entry forms, all of them a statement a human has to make:

        src/siyuan/store.ts:119  # kernel placeholder text compared verbatim
        src/core/map.test.ts     # CJK fixture node titles under test (string findings only)
        fixture:<token>          # a short CJK fixture identifier quoted anywhere as evidence
        kernel:<token>           # a short CJK string the product or the kernel emits verbatim
        i18n:<token>             # product label, verified against src/plugin/i18n/zh_CN.json

    A token entry matches a finding whose CJK text is **exactly** that token. Two guards keep the
    token form from becoming a blanket allowance for Chinese prose:

    * `fixture:` and `kernel:` tokens are capped at `TOKEN_MAX` characters. A quoted label or a
      fixture identifier is short; a Chinese sentence is not, so prose cannot hide behind a token.
    * `i18n:` tokens are checked against the product's own Chinese catalogue: a token that is not a
      value (or part of one) in `src/plugin/i18n/zh_CN.json` is a broken entry, not an allowance.

    A `path` (whole-file) entry covers **`string` findings only**: a comment, a test name and an
    assertion message are violations by policy, so they need their own line or token entry.
    """

    def __init__(self):
        self.lines = {}
        self.files = {}
        self.tokens = {}  # token -> (class name, reason)

    @classmethod
    def parse(cls, text, catalog=(), label="scripts/language-allowlist.txt"):
        allow = cls()
        for number, raw in enumerate(text.split("\n"), start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            body, marker, reason = line.partition("#")
            body, reason = body.strip(), reason.strip()
            if not marker or not reason:
                raise AllowError("%s:%d: entry needs a `# reason`: %s" % (label, number, line))
            for prefix, name, cap in TOKEN_CLASSES:
                if body.startswith(prefix):
                    allow._add_token(body[len(prefix) :], name, cap, reason, catalog, label, number)
                    break
            else:
                allow._add_path(body, reason, label, number)
        return allow

    def _add_path(self, body, reason, label, number):
        if ":" in body:
            path, _, digits = body.rpartition(":")
            if not digits.isdigit():
                raise AllowError(
                    "%s:%d: `%s` has a `:` but no line number; use `path:line`" % (label, number, body)
                )
            key = (path, int(digits))
            if key in self.lines:
                raise AllowError("%s:%d: duplicate entry for %s:%s" % (label, number, path, digits))
            self.lines[key] = reason
            return
        if body in self.files:
            raise AllowError("%s:%d: duplicate entry for %s" % (label, number, body))
        self.files[body] = reason

    def _add_token(self, token, name, cap, reason, catalog, label, number):
        if not token or not CJK_ANY.search(token):
            raise AllowError("%s:%d: `%s` is not a CJK token" % (label, number, token))
        if cap and len(token) > cap:
            raise AllowError(
                "%s:%d: `%s` is %d characters; a `%s` token is capped at %d, because a token entry "
                "excuses short quoted content and a longer Chinese text needs a `path:line` entry "
                "so a reviewer reads the line"
                % (label, number, token, len(token), name, cap)
            )
        if name == "i18n" and not any(token in value for value in catalog):
            raise AllowError(
                "%s:%d: `%s` is not part of any string in %s, so it is not a product string"
                % (label, number, token, " or ".join(I18N_CATALOG))
            )
        if token in self.tokens:
            raise AllowError("%s:%d: duplicate entry for token `%s`" % (label, number, token))
        self.tokens[token] = (name, reason)

    def apply(self, findings):
        """Split findings into reported and allowed; report which entries were really used.

        ★ A token excuses its text in **any file and any kind**, which is deliberate: the CJK it covers is
        catalogue or fixture content quoted by an English comment, an assertion message or a doc line.
        The consequence has to be stated rather than hidden, so the caller counts what was excused by
        kind (`excused`): a clean run does **not** by itself prove that every comment is English, only
        that no CJK text is unaccounted for.
        """
        reported, used_lines, used_files, used_tokens = [], set(), set(), set()
        excused = Counter()
        for finding in findings:
            if finding.key() in self.lines:
                used_lines.add(finding.key())
                excused[finding.kind] += 1
                continue
            if finding.text in self.tokens:
                used_tokens.add(finding.text)
                excused[finding.kind] += 1
                continue
            if finding.kind == "string" and finding.path in self.files:
                used_files.add(finding.path)
                excused[finding.kind] += 1
                continue
            reported.append(finding)
        return reported, used_lines, used_files, used_tokens, excused

    def stale(self, used_lines, used_files, used_tokens, known_paths):
        """Entries that matched nothing, with the reason they can no longer match."""
        stale = []
        for (path, line) in sorted(self.lines):
            if (path, line) in used_lines:
                continue
            why = "no such file in the tree" if path not in known_paths else "no finding on that line"
            stale.append("ALLOWLIST-STALE %s:%d: %s" % (path, line, why))
        for path in sorted(self.files):
            if path in used_files:
                continue
            why = "no such file in the tree" if path not in known_paths else "no string finding left"
            stale.append("ALLOWLIST-STALE %s: %s" % (path, why))
        for token in sorted(self.tokens):
            if token in used_tokens:
                continue
            stale.append(
                "ALLOWLIST-STALE token `%s`: no CJK finding in the tree has exactly this text"
                % token
            )
        return stale


# ----------------------------------------------------------------------------------- the tree


def _git(args):
    """Run git in the repository root. A missing git is an error, never a disk walk."""
    try:
        done = subprocess.run(
            ["git"] + args, cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
        )
    except FileNotFoundError as exc:
        raise AuditError(
            "git is not on PATH (%s); the file list comes from `git ls-files`, not from a disk walk"
            % exc
        )
    if done.returncode != 0:
        raise AuditError(
            "`git %s` failed with %d: %s"
            % (" ".join(args), done.returncode, done.stderr.decode("utf-8", "replace").strip())
        )
    return done.stdout.decode("utf-8", "replace").split("\0")


def tracked_files():
    return sorted(path for path in _git(["ls-files", "-z"]) if path)


def untracked_files():
    return sorted(path for path in _git(["ls-files", "-z", "--others", "--exclude-standard"]) if path)


#: A JS/TS string escape as a single character. Deliberately the small set the source uses; an
#: unknown escape is left as written, which makes the comparison fail loudly rather than pass.
JS_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v",
              "0": "\0", "\\": "\\", "'": "'", '"': '"', "`": "`"}


def decode_js_literal(raw):
    """Decode a quoted JS/TS string literal (no template substitutions) to its text."""
    if len(raw) < 2 or raw[0] not in "'\"`" or raw[-1] != raw[0]:
        body = raw
    else:
        body = raw[1:-1]
    out = []
    index = 0
    while index < len(body):
        char = body[index]
        if char != "\\" or index + 1 >= len(body):
            out.append(char)
            index += 1
            continue
        nxt = body[index + 1]
        if nxt == "u" and index + 5 < len(body):
            try:
                out.append(chr(int(body[index + 2 : index + 6], 16)))
                index += 6
                continue
            except ValueError:
                pass
        elif nxt == "x" and index + 3 < len(body):
            try:
                out.append(chr(int(body[index + 2 : index + 4], 16)))
                index += 4
                continue
            except ValueError:
                pass
        out.append(JS_ESCAPES.get(nxt, "\\" + nxt))
        index += 2
    return "".join(out)


def i18n_catalog():
    """Every string of the product's own Chinese text: the authority for `i18n:` entries."""
    values = []

    def walk(node):
        if isinstance(node, dict):
            for item in node.values():
                walk(item)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str):
            values.append(node)

    for path in I18N_CATALOG:
        try:
            walk(json.loads(_read(path)))
        except FileNotFoundError:
            raise AuditError("no product catalogue at %s" % path)
    return values


def i18n_keys():
    """`key -> Chinese text` for the product catalogue (`zh_CN.json`)."""
    try:
        data = json.loads(_read(I18N_CATALOG[0]))
    except FileNotFoundError:
        raise AuditError("no product catalogue at %s" % I18N_CATALOG[0])
    if not isinstance(data, dict):
        raise AuditError("%s is not a flat key/value catalogue" % I18N_CATALOG[0])
    return {key: value for key, value in data.items() if isinstance(value, str)}


def load_allowlist():
    try:
        with io.open(ALLOWLIST_FILE, encoding="utf-8") as handle:
            return Allowlist.parse(handle.read(), catalog=i18n_catalog())
    except FileNotFoundError:
        raise AuditError("no allowlist at %s" % ALLOWLIST_FILE)


def _read(path):
    with io.open(os.path.join(REPO_ROOT, path), encoding="utf-8") as handle:
        return handle.read()


# ------------------------------------------------------------------------------------- report


#: A test file: Chinese **string literals** here are fixture content (the text under test), which the
#: policy allows by category rather than by entry. Comments and assertion messages still have to be
#: English, so only `string` findings are excused.
TEST_FILE = re.compile(r"(^|/)(e2e/|.*\.test\.tsx?$|.*\.spec\.tsx?$|.*\.test\.mts$)")


#: The plugin manifest. Its strings are the product's own declaration —— display name, description,
#: keywords SiYuan's search matches on —— and the auditor already treats it as an authority for the
#: `i18n:` tokens, so a string here is a product string by definition rather than an exemption.
MANIFEST = "src/plugin/plugin.json"


def excuse_rule(finding, product, fixtures=()):
    """The category that makes this finding legitimate, or None.

    Two categories are rules rather than allowlist entries, because they are decidable:

      * `product-text` —— **prose** (a comment, a doc line, an assertion message) whose text is part of
        a string of the product (a catalogue value or a `plugin.json` string). The policy allows Chinese
        when it is the interface, and prose that quotes a label is exactly that. Deciding it means ~350
        `i18n:` entries are not needed. A Chinese **string literal** in shipped code stays a finding even
        when it matches a catalogue value: hardcoding UI text is the thing i18n exists to prevent, and
        the fix is `t('<key>')`, not an exemption.
      * `test-fixture-quote` —— **prose that quotes** Chinese fixture content: a doc explaining what the
        tests do (a pitfall doc quoting a Chinese fixture label) or a comment naming the fixture it moves.
        The quoted text must appear in a Chinese literal of a test file, so the rule decides it instead of
        a `fixture:` entry per identifier.
      * `test-fixture` —— a Chinese **literal inside a test file**: the content under test is Chinese
        (block titles, CJK punctuation, full-width runs), and a fixture is data, not prose. Deciding it
        by file class and kind means ~190 `fixture:` entries are not needed, while a Chinese *comment*
        or assertion message in a test file is still reported.
    """
    if finding.path == MANIFEST:
        return "manifest"
    if finding.kind in ("comment", "doc-prose", "assertion") and any(
        finding.text in value for value in product
    ):
        return "product-text"
    if finding.kind == "string" and TEST_FILE.search(finding.path):
        return "test-fixture"
    if finding.kind in ("comment", "doc-prose", "assertion") and any(
        finding.text in fixture for fixture in fixtures
    ):
        return "test-fixture-quote"
    return None


def audit():
    paths = tracked_files()
    if not paths:
        raise AuditError("git lists no tracked file, so there is nothing to audit")

    allow = load_allowlist()
    findings, notes = [], Counter()
    scanned = Counter()
    skipped = {}
    errors = []

    for path in paths:
        decision = classify(path)
        if decision[0] == "skip":
            skipped.setdefault(decision[1], []).append(path)
            continue
        scanned[decision[1]] += 1
        try:
            text = _read(path)
        except (OSError, UnicodeDecodeError) as exc:
            errors.append("%s: cannot read: %s" % (path, exc))
            continue
        try:
            result = scan_file(path, text)
        except ScanError as exc:
            errors.append("%s: %s" % (path, exc))
            continue
        findings.extend(result.findings)
        notes.update(result.notes)

    product = i18n_catalog()
    # Chinese literals that live in test files: prose quoting one of them is quoting fixture content.
    fixtures = [f.text for f in findings if f.kind == "string" and TEST_FILE.search(f.path)]
    by_rule = Counter()
    remaining = []
    for finding in findings:
        rule = excuse_rule(finding, product, fixtures)
        if rule:
            by_rule[rule] += 1
        else:
            remaining.append(finding)
    findings = remaining

    reported, used_lines, used_files, used_tokens, excused = allow.apply(findings)
    stale = allow.stale(used_lines, used_files, used_tokens, set(paths))

    for finding in reported:
        print(
            "%s:%d: %s: %s"
            % (finding.path, finding.line, finding.kind, _snippet(finding.text))
        )
    for line in stale:
        print(line)
    for line in errors:
        print("AUDIT-ERROR %s" % line)

    by_kind = Counter(finding.kind for finding in reported)
    print("audit-language: kinds: %s" % " | ".join(KINDS))
    print(
        "audit-language: %d tracked, %d scanned, %d reported, %d skipped"
        % (len(paths), sum(scanned.values()), len(reported), sum(len(v) for v in skipped.values()))
    )
    print(
        "audit-language: scanned by type: %s"
        % (", ".join("%s %d" % (name, count) for name, count in sorted(scanned.items())) or "none")
    )
    print(
        "audit-language: reported by kind: %s"
        % (", ".join("%s %d" % (kind, by_kind.get(kind, 0)) for kind in KINDS))
    )
    if allow.tokens:
        classes = Counter(name for name, _ in allow.tokens.values())
        print(
            "audit-language: allowlist tokens: %s"
            % ", ".join("%s %d" % (name, count) for name, count in sorted(classes.items()))
        )
    print(
        "audit-language: allowlist: %d line, %d file, %d token entries; %d findings covered "
        "(%d by line, %d by file, %d by token); %d stale"
        % (
            len(allow.lines),
            len(allow.files),
            len(allow.tokens),
            len(used_lines) + len(used_files) + len(used_tokens),
            len(used_lines),
            len(used_files),
            len(used_tokens),
            len(stale),
        )
    )
    for reason, items in sorted(skipped.items()):
        sample = ", ".join(items[:3]) + (" (+%d more)" % (len(items) - 3) if len(items) > 3 else "")
        print("audit-language: skipped %d: %s -- %s" % (len(items), reason, sample))
    if notes["regex"]:
        print(
            "audit-language: note: %d CJK occurrence(s) inside regex literals not reported "
            "(kernel/UI strings matched verbatim, AGENTS.md section 2)" % notes["regex"]
        )
    if by_rule:
        print(
            "audit-language: excused by rule: %s"
            % ", ".join("%s %d" % (name, by_rule[name]) for name in sorted(by_rule))
        )
    if excused:
        print(
            "audit-language: excused by the allowlist, by kind: %s —— a token excuses its text in any "
            "file and any kind, so this run does not by itself prove that every comment is English"
            % ", ".join("%s %d" % (kind, excused[kind]) for kind in KINDS if excused[kind])
        )
    if notes["i18n-fallback"]:
        print(
            "audit-language: note: %d CJK occurrence(s) in `t(key, vars, fallback)` fallbacks that equal "
            "the catalogue text for that key (recognised, not reported)"
            % notes["i18n-fallback"]
        )
    if notes["code"]:
        print(
            "audit-language: note: %d CJK occurrence(s) outside every comment or string token "
            "reported as `code`" % notes["code"]
        )
    pending = untracked_files()
    if pending:
        sample = ", ".join(pending[:5]) + (" (+%d more)" % (len(pending) - 5) if len(pending) > 5 else "")
        print(
            "audit-language: note: %d untracked file(s) not scanned (git ls-files omits them): %s"
            % (len(pending), sample)
        )

    if errors:
        print("audit-language: FAIL %d file(s) could not be audited (exit 2)" % len(errors))
        return EXIT_ERROR
    if reported or stale:
        print(
            "audit-language: FAIL %d finding(s) and %d stale allowlist entry/entries (exit 1)"
            % (len(reported), len(stale))
        )
        return EXIT_FINDINGS
    print("audit-language: OK no finding, no stale allowlist entry (exit 0)")
    return EXIT_OK


# ----------------------------------------------------------------------------------- selftest

# The fixtures below are built from code points on purpose: this file must not contain a single CJK
# character, because the audit reads it like any other file and would report its own tool.
ZH = "".join(chr(code) for code in (0x4E2D, 0x6587))  # two han characters
ZH_PUNCT = chr(0xFF1A)  # fullwidth colon


def _selftest_cases():
    """(name, callable) pairs. Every callable returns a list of `expected != got` strings."""
    cases = []

    def case(name):
        def register(function):
            cases.append((name, function))
            return function

        return register

    def shapes(path, text, allow=None):
        result = scan_file(path, text)
        if allow is not None:
            result.findings = allow.apply(result.findings)[0]
        return [(finding.line, finding.kind) for finding in result.findings]

    def texts(path, text, allow):
        """The CJK runs that survive the allowlist, in file order."""
        result = scan_file(path, text)
        return [finding.text for finding in allow.apply(result.findings)[0]]

    @case("rules: each excuse category is exactly as wide as the policy allows")
    def _():
        """A rule that is too wide hides real violations, and a hidden violation stays hidden.

        The most tempting over-reach is excusing a Chinese **literal** in shipped code because it equals a
        catalogue value —— that is hardcoding UI text, the thing i18n exists to prevent, so it must stay a
        finding (the fix is `t('<key>')`). A Chinese comment in a test file is prose too, and stays a
        finding even though the same file's literals are fixture data.

        Every fixture here is built from code points: this file has to stay free of CJK in its values as
        well as its source (`scan_python` reads both), or the audit would report its own tool.
        """
        def text(*codes):
            return "".join(chr(code) for code in codes)

        catalogue_text = text(0x8FD8, 0x6CA1, 0x6253, 0x5F00, 0x6587, 0x6863)
        fixture = text(0x7532, 0x5206, 0x652F)
        fixture_comment = text(0x7532, 0x5206, 0x652F, 0x7684, 0x6CE8, 0x91CA)
        display_name = text(0x539F, 0x751F, 0x5927, 0x7EB2, 0x5BFC, 0x56FE)
        catalog = [catalogue_text]
        cases = [
            # (path, kind, text, expected category or None)
            ("src/siyuan/store.ts", "string", catalogue_text, None),        # hardcoded UI text in the product
            ("src/mindmap/Mindmap.tsx", "comment", catalogue_text, "product-text"),
            ("docs/FEATURES.md", "doc-prose", catalogue_text, "product-text"),
            ("e2e/outline.ts", "string", fixture, "test-fixture"),          # a fixture literal
            ("e2e/outline.ts", "comment", fixture_comment, None),           # but not prose in a test file
            ("src/perf/loadgen.ts", "string", fixture, None),               # not a test file
            ("src/plugin/plugin.json", "string", display_name, "manifest"),
        ]
        problems = []
        for path, kind, text_value, want in cases:
            got = excuse_rule(Finding(path, 1, kind, text_value), catalog)
            if got != want:
                problems.append("%s in %s: expected %r, got %r" % (kind, path, want, got))
        return problems

    @case("ts: a Chinese literal in code is a finding whatever its shape")
    def _():
        """UI text lives in the catalogues (`t('<key>')`), so a literal in code is reported.

        This replaced the rule that compared `t(key, vars, fallback)` against the catalogue: with the
        fallback arguments gone from the codebase, that rule could not fire, and a rule that cannot fail
        is not a check. The contract now is the simple one the policy states.
        """
        problems = []
        for code in [
            "t('lblViewOutline', undefined, '%s');" % ZH,   # the old fallback shape
            "t('lblViewOutline', { n: 1 }, '%s');" % ZH,    # with a vars object
            "other('lblViewOutline', '%s');" % ZH,          # not the translator at all
            "const s = '%s';" % ZH,                         # a plain literal
        ]:
            if not scan_file("src/a.ts", code).findings:
                problems.append("should have been reported: %s" % code)
        return problems

    @case("py: a file with no trailing newline is audited, not rejected")
    def _():
        # Python without a final newline is valid, and `tokenize` answers it with a synthesised
        # NEWLINE/ENDMARKER one row past the last line. Treating that as "outside the file" made the
        # audit refuse two real scripts, which read exactly like "this file is unauditable".
        text = "x = 1\n# %s comment" % ZH
        try:
            got = shapes("scripts/a.py", text)
        except ScanError as exc:
            return ["a file with no trailing newline must still be audited, but got ScanError: %s" % exc]
        return [] if got == [(2, "comment")] else ["expected [(2, 'comment')], got %r" % (got,)]

    @case("py: a Chinese comment deep in the file is reported on its own line")
    def _():
        text = "a = 1\nb = 2\nc = 3\n# %s deep\nd = 4\n" % ZH
        got = shapes("scripts/a.py", text)
        return [] if got == [(4, "comment")] else ["expected [(4, 'comment')], got %r" % (got,)]

    @case("py: the last-line Chinese string in a file with no trailing newline is found")
    def _():
        text = 'x = 1\ny = "%s"' % ZH
        try:
            got = shapes("scripts/a.py", text)
        except ScanError as exc:
            return ["expected a string finding, got ScanError: %s" % exc]
        return [] if got == [(2, "string")] else ["expected [(2, 'string')], got %r" % (got,)]

    @case("ts: an English file reports nothing")
    def _():
        got = shapes("src/a.ts", "// English comment\nconst a = 'english';\n")
        return [] if got == [] else ["expected no finding, got %r" % (got,)]

    @case("ts: a Chinese comment is reported as comment on the right line")
    def _():
        text = "const a = 1;\n// %s comment\n" % ZH
        got = shapes("src/a.ts", text)
        return [] if got == [(2, "comment")] else ["expected [(2, 'comment')], got %r" % (got,)]

    @case("ts: Chinese inside a string is a string, not a comment")
    def _():
        got = shapes("src/a.ts", "const a = '%s';\n" % ZH)
        return [] if got == [(1, "string")] else ["expected [(1, 'string')], got %r" % (got,)]

    @case("ts: a comment marker inside a string does not split the string (negative control)")
    def _():
        text = "const a = '%s // %s';\n" % (ZH, ZH)
        got = shapes("src/a.ts", text)
        kinds = sorted(kind for _, kind in got)
        if kinds != ["string", "string"]:
            return ["expected two string findings and no comment, got %r" % (got,)]
        return []

    @case("ts: a JSX closing tag is not read as a regex (negative control)")
    def _():
        text = "export const A = () => <span>{a}</span>;\nconst b = '%s';\n" % ZH
        got = shapes("src/a.tsx", text)
        return [] if got == [(2, "string")] else ["expected [(2, 'string')], got %r" % (got,)]

    @case("ts: a quote inside a comment does not open a string (negative control)")
    def _():
        text = "// don't write \"%s\" here\nconst a = 1;\n" % ZH
        got = shapes("src/a.ts", text)
        return [] if got == [(1, "comment")] else ["expected [(1, 'comment')], got %r" % (got,)]

    @case("ts: a template literal is a string, and its substitution is not")
    def _():
        text = "const a = 1;\nconst b = `x${a}y`;\nconst c = `%s`;\n" % ZH
        got = shapes("src/a.ts", text)
        return [] if got == [(3, "string")] else ["expected [(3, 'string')], got %r" % (got,)]

    @case("ts: a regex before a Chinese string does not swallow it (store.ts shape)")
    def _():
        text = "const s = name.replace(/[/\\\\]/g, '_') + '%s';\n" % ZH
        got = shapes("src/a.ts", text)
        return [] if got == [(1, "string")] else ["expected [(1, 'string')], got %r" % (got,)]

    @case("ts: CJK inside a regex literal is reported as a note, not a finding")
    def _():
        result = JsScanner("src/a.ts", "const re = /%s/;\n" % ZH).run()
        if result.findings:
            return ["expected no finding, got %r" % (result.findings,)]
        return [] if result.notes["regex"] == 1 else ["expected notes.regex == 1, got %r" % (dict(result.notes),)]

    @case("ts: a JSX text node is reported as code, never dropped")
    def _():
        got = shapes("src/a.tsx", "export const A = () => <span>%s</span>;\n" % ZH)
        return [] if got == [(1, "code")] else ["expected [(1, 'code')], got %r" % (got,)]

    @case("ts: an unterminated string is a hard error, not a silent stop")
    def _():
        try:
            shapes("src/a.ts", "const a = '%s;\n" % ZH)
        except ScanError:
            return []
        return ["expected ScanError for an unterminated string literal"]

    @case("py: comment, string, assertion message and docstring are told apart")
    def _():
        text = "# %s comment\nx = '%s'\nassert x, '%s'\n" % (ZH, ZH, ZH)
        got = shapes("scripts/a.py", text)
        want = [(1, "comment"), (2, "string"), (3, "assertion")]
        return [] if got == want else ["expected %r, got %r" % (want, got)]

    @case("py: a module docstring is doc-prose")
    def _():
        got = shapes("scripts/a.py", '"""%s docstring"""\n' % ZH)
        return [] if got == [(1, "doc-prose")] else ["expected [(1, 'doc-prose')], got %r" % (got,)]

    @case("py: an f-string reports its CJK once, as a string (python 3.12 token shapes)")
    def _():
        got = shapes("scripts/a.py", "i = 1\nprobe = f'%s {i}'\n" % ZH)
        want = [(2, "string")]
        return [] if got == want else ["expected %r, got %r" % (want, got)]

    @case("py: a Chinese identifier is reported as code")
    def _():
        got = shapes("scripts/a.py", "%s = 1\n" % ZH)
        return [] if got == [(1, "code")] else ["expected [(1, 'code')], got %r" % (got,)]

    @case("py: CJK written as \\u escapes is still a Chinese string")
    def _():
        got = shapes("scripts/a.py", "x = '\\u4e2d\\u6587'\n")
        return [] if got == [(1, "string")] else ["expected [(1, 'string')], got %r" % (got,)]

    @case("py: an unparsable file is a hard error, not a silent pass")
    def _():
        try:
            shapes("scripts/a.py", "def f(:\n")
        except ScanError:
            return []
        return ["expected ScanError for a syntax error"]

    @case("css: a comment and a string are told apart")
    def _():
        comment = shapes("src/a.css", "/* %s */\n" % ZH)
        string = shapes("src/a.css", 'a { content: "%s"; }\n' % ZH)
        quoted = shapes("src/a.css", "/* \"%s\" */\n" % ZH)
        problems = []
        if comment != [(1, "comment")]:
            problems.append("comment: expected [(1, 'comment')], got %r" % (comment,))
        if string != [(1, "string")]:
            problems.append("string: expected [(1, 'string')], got %r" % (string,))
        if quoted != [(1, "comment")]:
            problems.append("quote inside a comment: expected [(1, 'comment')], got %r" % (quoted,))
        return problems

    @case("css: an unterminated comment is a hard error")
    def _():
        try:
            shapes("src/a.css", "/* %s\n" % ZH)
        except ScanError:
            return []
        return ["expected ScanError for an unterminated comment"]

    @case("md: an English doc reports CJK as doc-prose, a *.zh-CN.md is skipped by policy")
    def _():
        problems = []
        got = shapes("docs/a.md", "# Title\n%s prose\n" % ZH)
        if got != [(2, "doc-prose")]:
            problems.append("expected [(2, 'doc-prose')], got %r" % (got,))
        for path in ("docs/a.zh-CN.md", "README.zh-CN.md"):
            if classify(path) != ("skip", "user-facing Chinese doc (*.zh-CN.md): policy"):
                problems.append("%s should be skipped, got %r" % (path, classify(path)))
        return problems

    @case("json: a Chinese value is a string on its line, i18n is skipped by policy")
    def _():
        problems = []
        got = shapes("plugin.json", '{\n  "a": "%s",\n  "b": "ok"\n}\n' % ZH)
        if got != [(2, "string")]:
            problems.append("expected [(2, 'string')], got %r" % (got,))
        if classify("src/plugin/i18n/zh_CN.json")[0] != "skip":
            problems.append("i18n JSON should be skipped, got %r" % (classify("src/plugin/i18n/zh_CN.json"),))
        return problems

    @case("allowlist: a file entry covers a string but never a comment")
    def _():
        text = "// %s comment\nconst a = '%s';\n" % (ZH, ZH)
        allow = Allowlist.parse("src/a.ts  # CJK fixture content under test\n")
        got = shapes("src/a.ts", text, allow)
        if got != [(1, "comment")]:
            return ["expected the comment to survive a file entry, got %r" % (got,)]
        return []

    @case("allowlist: a line entry covers only its own line")
    def _():
        text = "const a = '%s';\nconst b = '%s';\n" % (ZH, ZH)
        allow = Allowlist.parse("src/a.ts:2  # fixture on line 2 only\n")
        got = shapes("src/a.ts", text, allow)
        return [] if got == [(1, "string")] else ["expected [(1, 'string')], got %r" % (got,)]

    @case("allowlist: an entry that matches nothing is stale, and a missing reason is an error")
    def _():
        problems = []
        allow = Allowlist.parse(
            "src/a.ts:99  # gone\nsrc/b.ts  # gone\n"
        )
        stale = allow.stale(set(), set(), set(), {"src/a.ts", "src/b.ts"})
        if len(stale) != 2:
            problems.append("expected 2 stale entries, got %r" % (stale,))
        for text in ("src/a.ts:2\n", "src/a.ts:notanumber  # no\n", "src/a.ts  #\n"):
            try:
                Allowlist.parse(text)
            except AllowError:
                continue
            problems.append("expected AllowError for %r" % (text,))
        return problems

    @case("allowlist: a token entry covers that exact run anywhere, and nothing else")
    def _():
        # The same fixture identifier is quoted by a comment, a test name and a doc line: one token
        # entry covers all three, which is what makes the list survive an edit that moves the lines.
        allow = Allowlist.parse("fixture:%s  # fixture identifier\n" % ZH)
        problems = []
        for path, text in (
            ("src/a.ts", "// %s has children\n" % ZH),
            ("src/a.test.ts", "test('%s moves', () => {});\n" % ZH),
            ("docs/a.md", "The node `%s` moved.\n" % ZH),
        ):
            left = texts(path, text, allow)
            if left:
                problems.append("%s: expected the token to be allowed, got %r" % (path, left))
        other = ZH + ZH
        left = texts("src/a.ts", "const a = '%s';\n" % other, allow)
        if left != [other]:
            problems.append("a different run must survive the token entry, got %r" % (left,))
        return problems

    @case("allowlist: a token entry cannot hide a Chinese sentence (length cap)")
    def _():
        problems = []
        long_token = ZH * 7  # 14 characters: a sentence, not a quoted label
        for prefix in ("fixture:", "kernel:"):
            try:
                Allowlist.parse("%s%s  # too long\n" % (prefix, long_token))
            except AllowError:
                continue
            problems.append("expected AllowError for a %s token of 14 characters" % prefix)
        left = texts("src/a.ts", "// %s\n" % long_token, Allowlist.parse("fixture:%s  # x\n" % ZH))
        if left != [long_token]:
            problems.append("a long run must survive the allowlist, got %r" % (left,))
        return problems

    @case("allowlist: an i18n token is verified against the product catalogue")
    def _():
        problems = []
        catalog = ["%s label" % ZH]
        allow = Allowlist.parse("i18n:%s  # product label\n" % ZH, catalog=catalog)
        if texts("src/a.ts", "const a = '%s';\n" % ZH, allow):
            problems.append("an i18n token in the catalogue must be allowed")
        try:
            Allowlist.parse("i18n:%s  # not in the catalogue\n" % (ZH + ZH), catalog=catalog)
        except AllowError:
            pass
        else:
            problems.append("expected AllowError for an i18n token that is not a product string")
        try:
            Allowlist.parse("fixture:english  # no CJK\n")
        except AllowError:
            pass
        else:
            problems.append("expected AllowError for a token with no CJK character")
        return problems

    @case("allowlist: a token that matches nothing is stale")
    def _():
        allow = Allowlist.parse("fixture:%s  # gone\n" % ZH)
        stale = allow.stale(set(), set(), set(), set())
        if len(stale) != 1 or "token" not in stale[0]:
            return ["expected one stale token entry, got %r" % (stale,)]
        return []

    @case("the auditor's own source is clean, in source and in values")
    def _():
        # A CJK literal here (an allowlist example, a Chinese range written as `"\u4e00"`) would
        # make the audit report its own tool, and then someone would allowlist the auditor. The
        # fixtures above are built from code points for exactly this reason.
        own = os.path.abspath(__file__)
        got = scan_python(own, io.open(own, encoding="utf-8").read())
        if got.findings:
            return ["the audit reports its own source: %r" % (got.findings,)]
        return []

    @case("classification: gitignored, i18n and Chinese docs are skipped with a reason")
    def _():
        problems = []
        for path, must_contain in (
            (".tmp/notes.md", "gitignored"),
            (".logs/run.log", "gitignored"),
            ("node_modules/x/index.js", "dependency"),
            ("docs/images/a.png", "binary"),
            (".github/workflows/ci.yml", "no parser"),
            ("LICENSE", "no parser"),
        ):
            decision = classify(path)
            if decision[0] != "skip" or must_contain not in decision[1]:
                problems.append("%s: expected a skip mentioning %r, got %r" % (path, must_contain, decision))
        if classify("src/core/map.test.ts") != ("scan", "javascript/typescript"):
            problems.append("a test file must be scanned, got %r" % (classify("src/core/map.test.ts"),))
        return problems

    return cases


def selftest():
    failures = 0
    cases = _selftest_cases()
    for number, (name, function) in enumerate(cases, start=1):
        try:
            problems = function()
        except Exception as exc:  # a broken checker must never look like a pass
            problems = ["raised %s: %s" % (type(exc).__name__, exc)]
        if problems:
            failures += 1
            print("FAIL  case %d: %s" % (number, name))
            for problem in problems:
                print("        %s" % problem)
        else:
            print("PASS  case %d: %s" % (number, name))
    if failures:
        print("selftest: FAIL (%d case(s), %d failed)" % (len(cases), failures))
        return EXIT_FINDINGS
    print("selftest: PASS (%d case(s), 0 failed)" % len(cases))
    return EXIT_OK


# --------------------------------------------------------------------------------------- main


def main():
    parser = argparse.ArgumentParser(
        description="Audit the AGENTS.md section 2 language policy over every tracked file."
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="check this checker against in-memory fixtures, including negative controls",
    )
    args = parser.parse_args()

    try:
        if args.selftest:
            return selftest()
        return audit()
    except AllowError as exc:
        print("audit-language: ERROR: %s" % exc, file=sys.stderr)
        return EXIT_ERROR
    except AuditError as exc:
        print("audit-language: ERROR: %s" % exc, file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    with script_log.track("audit-language"):
        sys.exit(main())

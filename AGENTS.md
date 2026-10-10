# AGENTS.md

Conventions for AI collaborators on this project.

**This file holds only the rules you need every round.** Judgement calls,
case studies, and pitfall details belong in `docs/` (index at the end) —
a file nobody reads might as well not exist.

## 1. Hard rules

- No `/tmp`. Scratch files go in `.tmp/<task>/` inside the project (gitignored).
  Logs go in `.logs/`.
- Back up before touching a script or config: `cp file file.bak`.
- Where scripts live: reusable ones in `scripts/` (committed); one-offs in
  `.tmp/` (not committed). Never park something useful in `.tmp/`.
- SQL is read-only: `SELECT` only, always with an explicit `LIMIT`.
  Mutations go through the kernel block / document API.
- Locate things by block or doc ID. Never guess from a title or hpath.
- Delete documents with `/api/filetree/removeDocByID` (the old `removeDoc` panics).
- **Never put anything about a notebook the user actually works in into this
  repository** —— no name, no id, no `hpath`, no document title, no content, no
  screenshot of their workspace. Not in code, comments, docs, tests, fixtures,
  examples, commit messages, or a log that gets committed. A real name is not a
  convenient sample, it is personal data, and a comment is the easiest place to
  leak it (`docs/pitfalls/privacy.md`). Invent examples (`Notebook A`, `甲分支`).
  `python3 scripts/audit-privacy.py` checks this; with `--live` it cross-checks
  the names against the running instance instead of trusting a pattern alone.
- **Screenshot before debugging UI.** Do not guess from the DOM —
  a DOM count will always hand you a number, and that number may describe
  an area the user cannot even see (case: `pitfalls/debug.md` 6.12).
- Never hardcode machine absolute paths in docs or scripts. Machine-specific
  values go in `.env`.
- **A test whose duration is not known runs in the background.** Never block the
  foreground on `npm run test:e2e`, `npm run verify`, a build, or any suite that
  may take a minute: start it as a background job, send its output to
  `.logs/<name>.log`, and read that log. The foreground is for what is known to
  finish in seconds —— "it is probably quick" is not knowing. Do not sit in a
  long wait on any single call either.

## 2. Language

Code comments, test names, assertion messages, console output, and developer
docs are **English**. Everything else follows this table:

| Surface | Language |
|---|---|
| Code comments, test names, assertion/check messages, `console.log`, CLI help and errors | English |
| Developer docs: `AGENTS.md`, and `docs/**` except the user-facing pair below | English |
| User docs: `GETTING-STARTED`, `SHORTCUTS` | English + a `*.zh-CN.md` sibling |
| `README.md` / `README.zh-CN.md` | English / Chinese |
| Plugin UI strings | Through `src/plugin/i18n/` — `en_US.json` **and** `zh_CN.json` are both required |
| Chinese test fixtures and Chinese-specific cases (CJK handling, full-width punctuation, …) | Chinese — the content is the thing under test |
| Kernel strings we match on (error messages, field values) | Verbatim, as the kernel returns them |

A Chinese string is allowed in code only when it is user-visible (and then it
must come from i18n, never a literal) or when the content itself is Chinese.
"Rest of the file is English" is not a reason to leave a comment in Chinese.

**UI text has exactly one home: the catalogues.** `t('<key>')` takes a key and nothing else —— there
is no fallback argument, because a copy of the string at the call site is a second version of it that
drifts the moment either side changes (this repository shipped six such call sites whose text no longer
matched `zh_CN.json`). Chinese *and* English both come from `src/plugin/i18n/*.json`.

The failure mode that replaces a fallback is a **missing key**, which renders as the key itself, so it
is checked instead of tolerated: `npm run i18n` (`scripts/check-i18n-keys.py`) fails the build when a
key used in code is absent from either catalogue, when the two catalogues disagree on the key set, or
when an entry is dead text nothing names —— a spec that asserts the text counts as naming it.

`scripts/audit-language.py` enforces the rest. It decides by **category** (a manifest string; prose
quoting a product string; a fixture literal in a test file; prose quoting one), and only 12
`scripts/language-allowlist.txt` entries remain, for values observed from a running kernel that no static
rule can decide. A **literal** in shipped code stays a finding even when it equals a catalogue value:
hardcoding UI text is what i18n exists to prevent, so the fix is `t('<key>')`, never an exemption.

**The agent speaks English to the user, always**, whatever language the user writes in —— replies,
plans, progress notes, commit messages, and explanations. The only Chinese that may appear is the
thing that *is* the interface: the plugin display name (`原生大纲导图`), UI strings quoted from the
product, and Chinese content quoted as evidence (a kernel message, a fixture, a user-visible label).
Do not mirror the user's language and do not ask which one to use: default to English.

## 3. Naming

This project has exactly one identity: a SiYuan plugin that stores data in
SiYuan's native carriers. Outward-facing text uses only this set:

| Purpose | Value |
|---|---|
| Repository | `siyuan-native-outline-mindmap` |
| Display name | `原生大纲导图` / `Native Outline & Mindmap` |
| Component classes | `Om*` prefix (e.g. `OmTabApp`) |
| CSS classes | `om-` / `mm-` prefix |
| Self-description | SiYuan plugin |

Applies to `src/`, `scripts/`, `docs/`, `AGENTS.md`, `README*`, `plugin.json`,
build output, release packages. `.logs/` and `.tmp/` are gitignored development
diaries — leave their history alone.

## 4. Releases

Without the user's explicit consent, do not:

- create a tag
- create, modify, or delete a Release
- push a release branch
- open a bazaar PR

A local `git commit` during development is fine.

**The source is not published.** The text of the distribution repository's README is kept at
`docs/DISTRIBUTION-README.md`, so it is versioned rather than parked in scratch. The plugin is
distributed as a packaged build attached to a Release
(see the hard rule in section 1: nothing about a notebook the user works in may be published, and the
safest way to keep that true is to publish the *build*, not the source). A distribution repository
therefore holds a README and the packaged asset and nothing else, and the development checkout keeps
**no remote** —— a `git push` from here would republish everything.

## 5. Environment and configuration

Ports, addresses, and paths all go through `scripts/env.py` (which reads
`.env`). Do not hardcode them. Priority: real environment variable > `.env`.
Every key and a sample value is in `.env.example`.

### 5.1 No guessing, no silent fallback

This is a **hard rule**, not a style preference, and it is not about any one
machine. Check every line against it:

1. **Missing config is an error — name the key.** Do not supply a default in
   code. A default *is* a fallback: it makes people believe the script
   connected to the right machine or found the right directory when it
   actually used a guess. New keys go into `env.py`'s `REQUIRED` and are read
   with `_require()`.
2. **No path heuristics.** No "walk up from the current working directory",
   no "try a few common locations", no "scan for something that looks right".
   Such a search depends on *where you ran it* — start it from another
   directory and it may silently connect to a different workspace, while the
   script writes files and tests create and delete documents there.
   A path has exactly one legitimate source: `.env`.
3. **No "probe and pick one".** No candidate-list downgrade chains, and no
   `process.env.X || '<some literal>'`. A chain is worse than a single value:
   a wrong single value fails immediately, while a chain **silently switches
   targets, runs to completion, and reports success**.
4. **Tests and verification target the isolated instance only.** Never fall
   back to the instance the user is working in. When the target is
   unreachable, **fail and say how to start it** — do not pick another target.
5. **Credentials come from the environment or a config file**, never from
   source. A credential that was committed and then deleted still counts as
   **leaked** (deleting code does not erase history — rotate the token).
6. **"Empty means this machine does not have it" is an explicit absence**,
   which is not the same as "empty means guess one": the first is legal, the
   second is forbidden. Test: **would this empty value, or this failure, make
   the script connect to or write somewhere else?** If yes — forbidden.

Derived values (SiYuan base URL, CDP address, plugin directories, conf.json
location, test-instance directory) are computed by `env.py`. Callers must not
assemble those strings themselves. `python3 scripts/env.py` prints the
effective configuration, deploy targets included.

`.env` holds a token and is gitignored; the committed file is `.env.example`.
The token can also be read from `["api"]["token"]` in
`<workspace>/conf/conf.json` — that is the authoritative location, not a guess.

## 6. Common commands

```bash
npm run build       # build
npm run deploy      # build + deploy into the SiYuan workspace (--reload to hot-reload)
npm run typecheck   # tsc --noEmit
npm run check       # every fast gate in one command (typecheck + unit + docs index + language +
                    #   i18n keys + privacy + css scope)
npm run i18n        # every `t('<key>')` exists in both catalogues; no entry is dead text
npm run privacy     # no id-shaped literal or credential in tracked files (--live: also cross-checks
                    #   the notebook names this machine's instances report, over tracked files and the
                    #   local .logs/ test-results/ .tmp/ artifacts)
npm run env         # the effective configuration (deploy targets included)
npm run language    # the section 2 language policy over every file type at once
npm run timings     # how long each script actually takes (reads .logs/script-usage.log)
npm run redproof -- --file <f> --from <text> --to <text> --run "<check>"   # show a check can go red
npm test            # offline unit tests, no SiYuan needed
npm run test:e2e    # browser E2E
                    #   * isolated test instance only: run-e2e.py reads the
                    #     address and that instance's own token from .env;
                    #     if it is not running it errors out, never falls back
                    #   * one suite: `npm run test:e2e theme` (a file-name substring, resolved to
                    #     spec paths; a substring that matches nothing is an error, not a full run)
npm run test:e2e:ui # the same, interactively
npm run test:e2e:report  # open the HTML report of the last run
npm run verify      # live check (desktop CDP, needs SiYuan running)
npm run verify:android # mobile check (Android/Redroid + CDP; needs adb, a mobile
                     #   browser, and .env's PYTHON -- python playwright often
                     #   lives in only one interpreter)
npm run record      # record a demo video
npm run package     # build a release package
```

After a change run `npm run check` (or `npm run typecheck && npm test` when you want the pieces).
If you touched CSS, layout, or kernel interaction, also run `npm run verify`.

## 7. While changing code

- **Comments state technical facts, not narrative.** No "who asked for this",
  no "who reported the bug", no quotes from anyone; no dates, no "fixed in the
  third attempt"; no machine-specific ports, addresses, paths, or credentials; and say nothing about a
  notebook the user really works in (the hard rule in section 1, enforced by `scripts/audit-privacy.py`).
  Put the history in the commit message or in `docs/` — the code keeps only
  "why it has to be this way", in a line or two when possible.
  ("User" in the product sense — whoever uses the plugin — is fine.)
- **A new test must be shown to fail**: break the implementation, confirm it
  goes red, restore it. A test that cannot go red has no defensive value, and
  **passing vacuously is far more dangerous than a false failure** — it stays
  quiet.
- **Measure the primitive before building a test on it.** What a helper costs
  decides the shape of the case: a theme switch takes ~0.4s live and a reload
  costs a full re-open (~10s), so a 4-sample matrix reloading each time is a
  minute of nothing. Write the measured cost into the helper's doc comment.
- **A test helper must not swallow a timeout or return nulls for a missing
  precondition.** That is 5.1 inside the test layer: a helper that waits 30s and
  then returns `null` turns "the caller forgot to open the page" into "the host
  stopped writing the attribute". Fail fast, name the precondition, and make
  `afterEach` a no-op on a page that never loaded instead of burning another timeout.
- **Before believing a red-proof, check the mutation is the one the criterion
  reads.** Three wasted rounds came from breaking a comment, then a redundant
  selector, then a selector its sibling covered —— each time the suite stayed
  green for a different reason than "the check is useless". Confirm the break
  lands where the check looks, then run.
- A fixed pitfall becomes a regression test, not just a Markdown note.
- **A theme-dependent style counts as verified only when the theme was really
  switched.** SiYuan writes `data-theme-mode` on **`<html>`** (`data-light-theme`
  / `data-dark-theme` beside it, nothing on `<body>`), so `[data-theme='dark']`
  matches nothing and a rule written that way is **silently dead** — no layer
  goes red, dark mode just keeps the light colours (it happened to four rules
  at once). Two more traps: `appearance.modeOS` ("follow the system") overrides
  `appearance.mode`, so asking for dark on a machine whose OS preference is
  light changes nothing; and setting the attribute by hand changes the
  attribute **without** changing the palette — the page stays light, and a
  screenshot taken at that moment lies about dark mode. Switch through
  `e2e/themes.ts` (`useTheme` / `restoreTheme` own all three traps) and let
  `e2e/theme.spec.ts` ask the **CSS engine** whether every theme-conditional
  rule in the shipped stylesheet can match at all —— a hand-written lint would
  be a second, weaker criterion for the same defect.
- **Reach for the real tool instead of hand-rolling an analysis.** A regex over
  source text, a home-made "does this line look like a comment" scanner, or
  counting offsets is not evidence —— it is wrong exactly where it matters
  (`//` inside `url()`, `[data-theme=...]` inside an attribute *value*, a rule
  spanning lines, a comment quoted in prose). Parse with the parser the build
  already uses (`postcss` for CSS, the TypeScript compiler for TS), or ask the
  thing that actually decides (`querySelectorAll` / `getComputedStyle` /
  `matchMedia` in a real browser), and add the parser you need
  (`postcss-selector-parser` for selector-level structure) rather than
  approximating it.
- **Do not be stingy about a dependency that makes a check honest.** A dev-only
  parser or test helper costs less than a check that lies; keep `dependencies`
  minimal because those ship to users, and lean on `devDependencies` freely.
- **A red proof that needs a deploy must deploy to the isolated instance only.** `npm run deploy`
  writes to **every** path in `PLUGIN_DIRS`, which includes the workspace the user is working in ——
  so `mutate -> npm run deploy -> run the check` puts a deliberately broken plugin in front of the
  user for the length of the run. Override the target explicitly for a mutation
  (`PLUGIN_DIRS=<the test instance's plugin dir> npm run deploy`) and confirm the printed
  `deploy: N target(s)` list before the check runs. `--target` only *adds*, it does not narrow.
- Assert statically when you can; only open a browser for what needs one, via
  `npm run test:e2e` (`SIYUAN_TEST_NOTEBOOK` optional; the cases really create
  and delete documents, so the target is pinned to the **isolated test
  instance** — never add "if missing, fall back to some hardcoded address"
  defaults to a spec, see 5.1).
- When you add a field that gets written back, update the serialization
  fingerprint too. Missing it raises nothing; it just looks like "my edit did
  nothing".
- When you extend format support, walk both directions: read and write back.
- Check paired reverse keys (`Backspace` / `Delete`).
- A panel that steals focus must give it back, and you must check every
  dependency of the `useLayoutEffect` involved.
- Plugin style classes get the `om-` prefix; do not pollute SiYuan itself.
- Store data in SiYuan's native carriers; do not invent attributes.
- Do not cap things on the user's behalf — widths follow the container.
- The location of a symptom is not the location of the cause.

> **Before you start, skim [`docs/pitfalls/`](docs/pitfalls/) and
> [`docs/TESTING.md`](docs/TESTING.md).** Almost every entry there is a
> criterion that "looks right but has no defensive value": `0` satisfies
> `toBeLessThan(N)`, a flat text list cannot see nesting, every rect inside a
> `display:none` subtree is 0, false signals are more dangerous than false
> failures. This repository has made these mistakes **repeatedly** (the same
> CSS criterion three times, the same "use the window width as a phone
> stand-in" four times), and each entry comes with a measured case.

## 8. Improve the process first

**Spending effort on the workflow outranks finishing the current task.** When a step has to be done
by hand a second time, or a rule is enforced by remembering to check something, build the tool
instead —— a rule with no tool is a rule that gets forgotten, and this repository has watched that
happen: whole file classes were missed twice by a language sweep, and three red proofs were faked by
mutations that landed on a comment or on a selector a sibling covered.

The tools live in `scripts/` (committed, reusable) and every one of them is expected to be able to
**fail**:

| Tool | What it takes off your hands |
|---|---|
| `python3 scripts/redproof.py` | "a new test must be shown to fail": requires **green before** the mutation, then red, then restores and verifies the bytes —— "any failure counts" is the vacuous pass this tool exists to prevent |
| `python3 scripts/audit-language.py` | the section 2 language policy, over every file type at once |
| `python3 scripts/audit-privacy.py` | a real notebook's identity or a credential in the repository; `--live` cross-checks the values the configured instances report |
| `python3 scripts/check.py` | every fast gate in one command, with a time budget |
| `python3 scripts/run-e2e.py <substring>` | one suite instead of all of them; durations reported per case |
| `python3 scripts/script_log.py --report` | how long every script actually takes —— the evidence behind "fast enough for the foreground" |

**Where knowledge lives.** Anything another developer or agent needs —— a measured fact, a pitfall, a
convention, a command —— belongs **in this repository** (`AGENTS.md`, `docs/`, code comments, tests).
The DSH memory store is private to one agent's machine and **nobody else can read it**, so it must
never be the only home for project knowledge and must not be relied on: if a fact only exists there,
it will be lost for everyone else. Prefer a script or a test over prose, and prose over memory.

**Working with the harness** (this project is developed with DeepSeek Harness, so use its
primitives instead of doing by hand what they do better):

- **Background jobs for anything not known to be fast**, with the output in `.logs/<name>.log`; read
  the log afterwards. Never a long foreground wait. `python3 scripts/script_log.py --report` is how you
  find out what is fast.
- **Fan out independent work through a workflow** (phases, one agent per item, structured results)
  rather than a chain of one-off calls: auditing every file, verifying many claims, a migration over
  many files. Keep one item per agent so a failure is one item, not the run.
- **Use a forked subagent for work that needs this session's context** (a review, a continuation, a
  "what did we claim that is not verified"), so the reviewer inherits the rules instead of being
  re-briefed.
- **A parallel writer is a hazard.** Two agents read-modify-writing the same file lose updates
  silently, and the loser's work looks like it never happened. Give one file to one writer, and when
  you are the second writer, say so and stop.

Rules that follow from the above:

- **Every script logs how long it took.** Wrap its entry point in
  `script_log.track("<name>")` (`scripts/script_log.py`); the run is appended to
  `.logs/script-usage.log` whatever the outcome, and
  `python3 scripts/script_log.py --report` gives the medians. A module that is only *imported*
  (no `main`, no `__main__` guard —— `scripts/cdp.py` is one) has no run to log: do **not** wrap it at
  import time, or every importer records a fake "run of a library" and the per-script timings become
  noise. A tool that does not
  report its own cost forces the next person to guess —— and guessing is how a
  two-minute suite got started in the foreground.
- **Prefer a tool that answers the question over a remembered procedure.** If you catch yourself
  writing "remember to also check ...", that is a missing check, not a note.
- **Tools must be honest about what they cannot see** (the language auditor prints what it skipped
  and why) and must fail loudly rather than pass vacuously.
- **A tool that cannot go red is not a tool.** Demonstrate the failure path when you add it, the
  same way a test has to be shown red.
- Keep the fast path fast: anything new goes into `scripts/check.py` only if it finishes in seconds,
  otherwise it belongs in the background layer with a log under `.logs/`.

## 9. Document index

| Document | What it covers |
|---|---|
| [`docs/PITFALLS.md`](docs/PITFALLS.md) -> [`docs/pitfalls/`](docs/pitfalls/) | **Pitfall ledger** (one file per topic): symptom -> cause -> practice |
| [`docs/TESTING.md`](docs/TESTING.md) | Test and verification strategy: how to test, the layers of verification, the case list |
| [`docs/kernel-api.md`](docs/kernel-api.md) | What the SiYuan kernel API actually does (holds for other projects too) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module layout and data flow |
| [`docs/DATA-FORMAT.md`](docs/DATA-FORMAT.md) | Data shapes and storage |
| [`docs/MAPPING.md`](docs/MAPPING.md) | Mind map vs SiYuan mapping rules |
| [`docs/FEATURES.md`](docs/FEATURES.md) | Feature list |
| [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) | User-facing getting-started (Chinese: `.zh-CN.md`) |
| [`docs/SHORTCUTS.md`](docs/SHORTCUTS.md) | Keyboard shortcuts (Chinese: `.zh-CN.md`) |

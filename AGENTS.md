# AGENTS.md

Conventions for AI collaborators on this project.

**This file holds only the rules you need every round.** Judgement calls,
case studies, and pitfall details belong in `docs/` (index at the end) —
a file nobody reads might as well not exist.

## 1. Hard rules

- No `/tmp`. Scratch files go in `.tmp/<task>/` inside the project (gitignored). Logs go in `.logs/`.
- **Never `pkill -f <pattern>` from a command that contains the pattern.** `-f` matches the whole
  command line, so the shell running it matches too and kills itself before doing anything ——
  `pkill -f "run-e2e.py"` did exactly that, and the follow-up `pgrep -f` "still running" was the
  same trap reporting itself. Check a log's age, or match a path only the target has.
- **State lives outside the repository; scratch lives in `.tmp/`.** The isolated test instance —— a
  kernel plus a workspace, hundreds of megabytes, addressed by `.env`'s `TEST_INSTANCE_DIR` —— is
  state: inside `.tmp/` it made that directory impossible to delete, which is what `.tmp/` is for.
  Anything a run may throw away goes there; anything that must survive a `git clean` does not.
- Back up before touching a script or config —— into `.tmp/<task>/`, never the project root, and delete
  it once the edit it protects is committed. `git commit` is the better backup. (`.tmp` reached 1,611
  stale `*.bak` copies; one sample text had spread across 120 of
  them —— `docs/pitfalls/privacy.md`.)
- Where scripts live: reusable ones in `scripts/` (committed); one-offs in
  `.tmp/` (not committed). Never park something useful in `.tmp/`.
- **Both instances get the build; only the test instance gets the tests.** `scripts/deploy.py` installs
  into the isolated test instance **and** the workspace the user works in, by default, so the editor they
  use is never left running old code —— deploying to the working instance alone is the exception
  (`--test-only`), and it exists for one purpose: a red proof deliberately breaks the plugin, and that
  build must not reach the editor they use. Everything else about their instance is untouched: read it to
  check a claim, **never** create, mutate or delete a document in it, and never run a suite against it ——
  the test instance is the only place a document is created or a suite runs. Reading their workspace must
  not leave anything behind either: no name, id, `hpath`, title, content or screenshot
  (`docs/pitfalls/privacy.md`).
- **Before deleting scratch, name what is in it, and confirm each part is in the repository.** A digest
  of a data set is not the data set —— an audit's 237 findings were absorbed into `docs/` while the
  reports' coverage fields (what each area had *not* checked) went out with them. Absorb first, then
  delete, and only the part you can point at.
- SQL is read-only: `SELECT` only, always with an explicit `LIMIT`.
  Mutations go through the kernel block / document API.
- Locate things by block or doc ID. Never guess from a title or hpath.
- Delete documents with `/api/filetree/removeDocByID` (the old `removeDoc` panics).
- **Never put anything about a notebook the user actually works in into this
  repository** —— no name, no id, no `hpath`, no document title, no content, no
  screenshot of their workspace. Not in code, comments, docs, tests, fixtures,
  examples, commit messages, or a log that gets committed. A real name is not a
  convenient sample, it is personal data, and a comment is the easiest place for
  a real name to end up in the repository (`docs/pitfalls/privacy.md`). Invent examples (`Notebook A`, `分支一`).
  `python3 scripts/audit-privacy.py` checks this —— id-shaped and credential-shaped literals, plus a
  fixture that was copied from a live instance rather than invented. With `--live` it asks the running
  instance what its notebooks, ids, document titles and paths actually are and searches the tree for
  them, instead of trusting a pattern alone.
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
- **★★ Never wrap a suite in `timeout N`.** A cap the suite does not need kills it mid-run, and
  Playwright prints its failure report at the **end** —— so the run dies before saying *why* anything
  failed, and the log keeps only the `✘` markers. That is worse than not running it: five "failures"
  with no detail cost more to chase than the run cost to do properly. Let Playwright's own per-case
  timeout (`playwright.config.ts`) be the only bound, run it in the background, and read the log when
  it finishes. Two concurrent suites on a four-core box is the same mistake from the other side —— one
  run at a time, and stop the previous one before starting the next.
- **★★ Wait for the condition, never for a stopwatch.** A fixed "wait 10s, three times" is a question
  about the machine, not about the code: measured, `cancelling the confirm dialog does not delete the
  node` failed at 46.7 / 47.4 / 45.1 s under load and passed in 11~13 s idle, on one build, with the
  plugin loaded and the panel never closed. Poll until the thing is true and let the case timeout be the
  only bound; a slow machine should make a suite take longer, not make it lie.
- **★★ Redirect to a log on the FIRST run, then read the log. Never re-run to see
  output again.** Run it once, capture everything (`npm test > .logs/x.log 2>&1`),
  and read that file with `rg`/`read` as many times as needed. A second run to
  "see the failure" costs the whole suite again and may not even reproduce it ——
  and re-running to check something the log already contains is the same waste.
  This is not only about the clock: a run that scrolls out of the terminal takes
  its evidence with it, while the log keeps the failing assertion, the exact line
  and the context around it. Keep the log until the task is committed, then it can
  go; `.logs/` is gitignored, so keeping more is cheap. When a command's output
  matters at all, it goes to a file **by default**, not after the first attempt.

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

**Chinese fixture text is a function label, never content.** A fixture names what a thing *is* —— a node,
the second paragraph, a bold run —— so it cannot be mistaken for somebody's material and has nothing to
copy. It may contain a noun for a thing the plugin deals with, or a role that tells two such things apart,
and nothing else: not a verb, not a sentence, not a noun from somebody's subject matter. A label meaning
"user interview" or "project background paragraph" is *content*, whatever language it is written in, and
so is one meaning "the answer" or "the greeting" —— those are the fixtures to rename.

`scripts/check-fixture-text.py` requires every Chinese fixture to be spelled with the words in
`scripts/fixture-vocabulary.txt` —— which is where the words live, so this file does not repeat them ——
exempts only by a stated rule (catalogue values, semantics, the language allowlist, one-character labels),
and fails on a vocabulary entry nothing uses. ★ **A fixture that does not fit is renamed to fit; the
vocabulary is never extended to make a finding go away.** Extending it turns that list into a description
of whatever the tests happen to say, which is the same as having no rule at all (the same reasoning as
"the fix is `t('<key>')`, never an exemption").

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

★★ **Use `python3 scripts/release.py --suite-log <log> --yes` rather than doing this by hand.** The steps are
not hard, but every one of them fails silently when skipped —— a version bumped in one file but not the other
ships a plugin reporting a number different from the one it was released as; a zip built before the last
source change carries the new number and none of the fix; a tag can point at a commit nobody tested. The
script checks all of it first, prints the plan, and refuses without `--yes`. Without `--suite-log` it refuses
outright, because ~16 minutes of suite belongs in the background (section 1) and a release on a suite that was
never run is not something it will do quietly.

**The source is published.** `main` is pushed to `neariot/siyuan-native-outline-mindmap`, and the
plugin is also distributed as a packaged build attached to a Release —— the bazaar reads the latest
Release, so a version is not released until its `package.zip` is attached.

★ **Publishing the source raises the bar on section 1 rather than lowering it.** Everything in the
repository is public and permanent: a comment, a fixture, a log or a commit message is as published as
the code around it, and rewriting history afterwards does not unpublish what somebody already fetched.
The static privacy rules cannot tell an invented id from one copied out of a workspace, so before a
release that makes new material public, run `python3 scripts/audit-privacy.py --live` —— it asks the
running instance whether the ids in the tree still resolve, which is the one check no pattern can do.

`docs/DISTRIBUTION-README.md` is kept because the distribution listing's text is versioned there rather
than parked in scratch.

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
4. **Two instances, two roles.** The **working** instance is the isolated test instance: the only
   target for test mutations and E2E. The **reference** instance is the workspace the user works in: it
   receives the build like the working one (section 1), but it is read-only in every other respect —— no
   document is created, changed or deleted there, and its content never leaves their machine. Never fall
   back from one to the other; when the working instance is unreachable, **fail and say how to start
   it** — do not pick another target.
5. **Credentials come from the environment or a config file**, never from
   source. A literal in the source is a finding whatever it equals, and a
   credential in a fallback chain is the shape that hides one (5.1 #3).
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
npm run deploy      # build + deploy into **both** instances (no hot reload: SiYuan exposes no route
                    #   for it). --test-only skips the instance the user works in —— use it for a red
                    #   proof, never for a normal build
npm run typecheck   # tsc --noEmit for **both** programs: `src` (what ships) and `e2e` (the suite), via
                    #   tsconfig.json and tsconfig.e2e.json. `npm run typecheck:e2e` runs the second alone.
                    #   ★ They are separate configs because Playwright transpiles with esbuild, which strips
                    #     types without checking them —— 42 real errors sat in `e2e/` while nothing looked
npm run check       # every fast gate in one command (typecheck + unit + docs index + language +
                    #   i18n keys + privacy + css scope)
npm run i18n        # every `t('<key>')` exists in both catalogues; no entry is dead text
npm run privacy     # no id-shaped literal or credential in tracked files (--live: also asks the user's
                    #   instance for its notebooks, ids, document titles and paths and searches tracked
                    #   files **and** the local .logs/ test-results/ .tmp/ artifacts for them; the
                    #   isolated instance is skipped —— its content is the fixtures)
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
python3 scripts/e2e-coldstart.py   # where a case's startup time goes, phase by phase (read-only probe of
                     #   the isolated test instance; it creates one document and deletes it)
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
- **A red proof that needs a deploy must pass `--test-only`.**
  `mutate -> deploy -> run the check` must not put a deliberately broken plugin in front of the user, and
  both instances are deployment targets by default (section 1) —— so the guard is the flag, and a red
  proof that forgets it installs the broken build into the editor they use. `--target` only
  *adds* and `PLUGIN_DIRS` is not read at all —— `deploy.py` always adds the instance the user works
  in, so setting that variable to the test instance leaves **both** targets and the mutation still
  reaches their editor (measured). `--test-only` is the only narrowing. A helper that claims to
  redirect the deploy must be checked against what `deploy.py` actually reads and prints, and must
  ask **before** it installs: `redproof.py` once watched for the target list in the output of a
  command that never passed `--list`, so it counted none, failed, and deployed the mutation anyway.
  Two helpers have now sent a broken build to the user's editor, one of them for weeks
  (`docs/pitfalls/privacy.md`).
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
| `python3 scripts/run-e2e.py <substring>` | one suite instead of all of them; durations reported per case. At the end it also **reports temp documents left on the test instance** —— a case or probe that did not clean up lets a later run write into the leftover and pass for the wrong reason, which is what a tab-opening probe did (it made SiYuan create a document nothing deleted) |
| `python3 scripts/script_log.py --report` | how long every script actually takes —— the evidence behind "fast enough for the foreground" |
| `python3 scripts/check-vacuous-tests.py` | a test a doc cites that no longer exists, and the test files that import nothing —— they cannot go red, so they cannot defend anything |
| `node scripts/check-dead-css.mjs` | a class in `src/styles.css` that no element can wear —— legal CSS, applies to nothing, fails nothing; the reverse of the scoping gate, and how `.om-outline` was found to be dead twice over |
| `python3 scripts/check-unsaved-fields.py` | a node model field no reader restores —— the defect behind summary, link lines, the mask and the due date; fold state is printed, not failed |
| `python3 scripts/check-audit-findings.py` | which findings in `docs/AUDIT-FINDINGS.md` still point at code that exists —— `stale-file` / `stale-line` / `drifted`, and the `cannot-judge` ones a reader must open first. It cannot tell whether a defect is *fixed*, and says so instead of guessing. `--selftest` pins its three decisions, including the prose-vs-identifier criterion its first version got wrong (60 false `drifted`) |
| `python3 scripts/check-documented-commands.py` | a command a document names that does not exist, and a script no document names —— a command in prose is never executed by anything. It cannot see whether a command does what the prose claims (an invented **flag** in front of a real script passes), and says so |
| `python3 scripts/release.py --suite-log <log>` | the release procedure, enforced instead of remembered: clean tree, versions agreeing, `check` green, the zip byte-identical to its build and reporting the right version, `--live` privacy clean, the tag absent both locally and on the remote, and an E2E log that really shows a green run (a run killed by `timeout` leaves ✘ markers and no summary line, so it is refused rather than read as "no failures"). It publishes nothing without `--yes` (section 4), and verifies the Release it created rather than trusting the command that made it |
| `python3 scripts/check-versions.py` | the versioned sources agreeing (`package.json` and `src/plugin/plugin.json`) and a `docs/RELEASE-<version>.md` existing. The release procedure used to be a rule held in someone's head, and a half-bumped version ships a plugin that reports a version different from the one it was released as. It says plainly that it does **not** verify the tag or the Release —— those are outside the repository and need consent |
| `python3 scripts/check-literal-conditions.py` | a `check()` whose condition is a literal, so it can never go red. Tells a dead assertion apart from the five **correct** hard failures in this tree (a `catch`, a precondition guard's `else`, a guard's `if` body) by position, prints which shape it classified so a misclassification is visible, and says plainly that a condition built only from locals needs a reader |
| `python3 scripts/check-i18n-shadow.py` | a local binding that shadows the i18n `t` in a module that translates —— there is no ESLint here, so `no-shadow` cannot be switched on, and this is the rule instead. Textual, and says so: shadowing is legal TypeScript with no diagnostic |
| `python3 scripts/check-dead-methods.py` | a store method with no call site (`--strict` when its comment claims a capability). Both of its false positives are pinned: the declaring file must be scanned, and the pattern must allow optional chaining (`store?.name(`) |
| `python3 scripts/check-source-text-tests.py` | a test that asserts on the **text** of product source while importing nothing it could execute —— such a file can only go red when the product is reworded. Fifteen were deleted in one pass; this stops them returning. It reports the mixed cases (imports the product *and* greps its source) without failing them, because those need a reader |
| `python3 scripts/e2e-coldstart.py` | where an E2E case's startup time goes, phase by phase —— "can we avoid the cold start" is answered with a table instead of from memory, and it says which phases are paid per case and which are one-off |

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
| [`docs/TODO.md`](docs/TODO.md) | **What is left to do**: the front door. Current work, gaps in our own tooling, entries refuted in writing, and what is deferred on purpose |
| [`docs/AUDIT-FINDINGS.md`](docs/AUDIT-FINDINGS.md) | **Audit work queue**: every finding from the one whole-repository review, high first |
| [`docs/TESTING.md`](docs/TESTING.md) | Test and verification strategy: how to test, the layers of verification, the case list |
| [`docs/kernel-api.md`](docs/kernel-api.md) | What the SiYuan kernel API actually does (holds for other projects too) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module layout and data flow |
| [`docs/DATA-FORMAT.md`](docs/DATA-FORMAT.md) | Data shapes and storage |
| [`docs/MAPPING.md`](docs/MAPPING.md) | Mind map vs SiYuan mapping rules |
| [`docs/FEATURES.md`](docs/FEATURES.md) | Feature list |
| [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) | User-facing getting-started (Chinese: `.zh-CN.md`) |
| [`docs/SHORTCUTS.md`](docs/SHORTCUTS.md) | Keyboard shortcuts (Chinese: `.zh-CN.md`) |

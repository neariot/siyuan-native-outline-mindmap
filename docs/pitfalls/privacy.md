# Privacy: what must never reach this repository

## 6.26 A real notebook name, used as a friendly example

**Symptom.** A comment in `e2e/testdoc.ts` explained that a notebook the user is actually working in
must not be a test target, and named one: *"a notebook the user is working in (such as X)"*. It read as
helpful context. It was personal data, in a public repository, in a sentence that looked like
documentation.

**Cause.** A name is the most natural way to make an example concrete, and nothing in the review path
looks for one. Three separate failures came from the same root:

1. the name was treated as an illustration rather than as an identifier of a real place;
2. an *allowlist entry* was added for it in `scripts/language-allowlist.txt`, which turned a leak into a
   documented exception —— the tooling then helped keep it;
3. and once removed, the value still lived in the git history of a public repository, so deleting the
   line changed only what a reader sees today.

**Practice.** Keep a real workspace out of the repository entirely —— names, ids, `hpath`s, document
titles, content, screenshots —— and make the checks structural rather than attentive, because reading
carefully is what failed here three times in one day:

* **Invent the example.** `Notebook A`, `甲分支`, `<node-id>`. A fixture that looks like data is data.
* **A formatter-independent rule, enforced by a tool.** `scripts/audit-privacy.py` refuses an id-shaped
  literal in tracked files and a credential-shaped literal on a line about tokens; `--live` cross-checks
  the notebook names the configured instances actually report, over tracked files *and* the local
  gitignored artifacts that get pasted into issues (`.logs/`, `test-results/`, `.tmp/`). The check names
  a notebook as `notebook #1` in its output, so running it does not publish what it protects.
* **An id in a test file is fixture data**, excused by category with its count printed —— and the count
  is the point: the first run of that rule found 67 id literals in the suite, several of them copied out
  of a live workspace rather than invented.
* **A credential in a spec is a leak even after deletion.** A test token sat in
  `process.env.SIYUAN_TOKEN || '<literal>'` (section 5.1 #3, a silent fallback). Deleting the line does
  not unleak it: rotate the token, then scrub the history. `git filter-repo --replace-text` rewrites the
  commits; be aware it leaves the *objects* reachable by exact SHA until the host garbage-collects, and
  that forks, CI artifacts, caches, and run logs are outside a rewrite's reach —— closing those means
  deleting the repository, so the check looks at the objects, not only the commits.
* **Say what the check cannot see.** A paraphrase, an id embedded in other prose, or text inside a
  binary all pass the tool. Its own summary says so.

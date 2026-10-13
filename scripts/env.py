#!/usr/bin/env python3
"""Read environment configuration in one place, removing hardcoded ports / paths from scripts.

## Why it is needed

SiYuan ports, CDP ports, workspace directories: these values used to be scattered across every script.
Switching machines, switching a port, or switching a workspace meant editing file after file ——
and it was very easy to miss one spot, showing up as "the script works sometimes and not others".

## Value rules

Only two sources: the real environment variable, and the `.env` file.
Machine-related values (host, port, workspace) have **no built-in defaults** ——
missing means an error, no guessing. See `Config._require()`.

## Usage

    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
    from env import cfg

    url = f"{cfg.siyuan}/stage/build/desktop/?id={doc}"
    port = cfg.cdp_port

## Priority

    real environment variable  >  .env file  >  built-in default

So CI / a temporary override can just do `SIYUAN_PORT=6807 python3 ...`,
without editing the file.

## Why not install python-dotenv

It is not in `devDependencies`, and we do not want a dependency for a 30-line parser.
This project only needs "KEY=VALUE, with quotes and comments supported" —— writing it ourselves is enough.
"""

import os
import sys

import script_log

# Repository root (this file lives under <root>/scripts/)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _parse_env_file(path):
    """Minimal .env parsing: `KEY=VALUE`, with `#` comments, inline comments, quotes.

    Deliberately unsupported: multi-line values, variable interpolation, shell syntax other than an `export` prefix.
    This project does not need them, and supporting them would only make behavior harder to predict.
    """
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip()
            # strip matched quotes; a `#` inside quotes is not a comment
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            else:
                # without quotes, everything after ` #` is a comment
                hash_at = val.find(" #")
                if hash_at >= 0:
                    val = val[:hash_at].strip()
            if key:
                out[key] = val
    return out


class Config:
    """Runtime configuration. Field names are the key names in `.env` (lowercase).

    There are only two configuration sources: the real environment variable, and the `.env` file.
    This class deliberately **holds no default values for ports / addresses** —— a default is a kind of fallback,
    and it makes people believe "the script connected to the right machine" while it actually used a guess.
    When missing, `_require()` errors out and says which key to configure.
    """

    # Only machine-independent values, or "an explicit absence", get a default.
    DEFAULTS = {
        "SIYUAN_SCHEME": "http",
        "SIYUAN_TOKEN": "",          # empty means read from <workspace>/conf/conf.json
        "PLUGIN_NAME": "siyuan-native-outline-mindmap",
        "SIYUAN_SRC": "",            # empty = this machine has no source checkout (an explicit statement, not a guess)
        "SIYUAN_TAG": "",            # empty = newest stable tag; pins which release the source checks read
    }

    # Machine-related values must be provided explicitly.
    # ★ Do not fill in defaults here, and do not use heuristics like "search upward for the directory":
    #   the guessed target may not be the one the user wants, while the scripts write files into it.
    REQUIRED = (
        "SIYUAN_HOST", "SIYUAN_PORT", "SIYUAN_WORKSPACE",   # the user's instance
        "SIYUAN_TEST_PORT", "TEST_INSTANCE_DIR",            # isolated test instance
        "PLUGIN_DIRS",                                      # deploy targets, colon-separated
        "PYTHON",                                           # the interpreter that runs playwright
        "CHROMIUM_PATH",                                    # the browser the E2E suite launches
        "CDP_HOST", "CDP_PORT",
        "ANDROID_SERIAL", "ANDROID_BROWSER_PKG", "ANDROID_CDP_PORT",
    )

    def __init__(self, env_file=None):
        self._file = env_file or os.environ.get(
            "OM_ENV_FILE", os.path.join(ROOT, ".env"))
        self._values = dict(self.DEFAULTS)
        self._values.update(_parse_env_file(self._file))

    def get(self, key, default=None):
        """Read a value as "real environment variable > .env > default".

        The real environment variable has the highest priority, which makes temporary overrides easy:

            SIYUAN_PORT=6807 python3 scripts/verify-live.py
        """
        if key in os.environ:
            return os.environ[key]
        return self._values.get(key, default)

    def _require(self, key):
        """Fetch a required entry; when it is missing, error out and explain how to configure it.

        No fallback: guessing a host/port and ending up on another machine with no
        hint at all is far worse than an outright error.
        """
        val = self.get(key)
        if val not in (None, ""):
            return val
        raise RuntimeError(
            "Missing configuration %s. Set it in .env (see .env.example), or override it temporarily with an environment variable:\n"
            "    echo '%s=...' >> .env" % (key, key)
        )


    # ---- SiYuan source (read-only reference) ----
    # Many of the plugin's contracts were verified against the SiYuan source (protyle's DOM, the kernel API,
    # the plugin mechanism). When diagnosing, we often go back to confirm "how SiYuan actually implements it".
    #
    # ★ The path is given explicitly in .env (SIYUAN_SRC); do not fall back to a whole-disk find every time ——
    #   that is both slow and easy to come up empty, and it may hit a same-named file in an unrelated directory.
    #
    # ★ This performs **marker validation** instead of trusting the path outright: a SiYuan checkout always has
    #   both `app/src/protyle` and `kernel`. Checking that the directory exists is not enough ——
    #   a path mistyped onto another project also "exists", and then every conclusion drawn from it is wrong.

    #: Marker paths that decide whether a directory "is SiYuan source" (relative to the repo root)
    SIYUAN_SRC_MARKERS = (
        os.path.join("app", "src", "protyle"),
        os.path.join("kernel", "model"),
    )

    @property
    def siyuan_src(self):
        """SiYuan source root directory; returns `None` when unconfigured or not looking like SiYuan.

        **Does not raise**: the source is only a reference for verification, and most things work without it.
        Returning None lets the caller skip explicitly and state why, instead of crashing halfway.
        """
        path = self.get("SIYUAN_SRC")
        if not path:
            return None
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.isdir(path):
            return None
        for marker in self.SIYUAN_SRC_MARKERS:
            if not os.path.exists(os.path.join(path, marker)):
                return None
        return path

    def require_siyuan_src(self):
        """Same as above, but errors when missing and explains how to configure it (for scripts that require the source)."""
        path = self.siyuan_src
        if path:
            return path
        configured = self.get("SIYUAN_SRC") or "(not set)"
        raise RuntimeError(
            "Cannot find the SiYuan source, so the kernel/editor contracts cannot be verified.\n"
            "  current SIYUAN_SRC = %s\n"
            "  that directory must contain both %s.\n"
            "Point it at the SiYuan repository root in .env, for example:\n"
            "    SIYUAN_SRC=/path/to/siyuan"
            % (configured, " and ".join(self.SIYUAN_SRC_MARKERS))
        )

    # ---- Derived properties: callers should not assemble strings themselves ----
    @property
    def siyuan_host(self):
        return self._require("SIYUAN_HOST")

    @property
    def siyuan_port(self):
        return int(self._require("SIYUAN_PORT"))

    @property
    def siyuan(self):
        """SiYuan base URL (no trailing slash)."""
        return "%s://%s:%s" % (
            self.get("SIYUAN_SCHEME"), self.siyuan_host, self.siyuan_port)

    @property
    def cdp_http(self):
        return "http://%s:%s" % (self.cdp_host, self.cdp_port)

    @property
    def cdp_port(self):
        return int(self._require("CDP_PORT"))

    @property
    def cdp_host(self):
        return self._require("CDP_HOST")

    @property
    def siyuan_test_port(self):
        """Port of the isolated test instance. No default value, and falling back to `siyuan_port` is not allowed."""
        return int(self._require("SIYUAN_TEST_PORT"))

    @property
    def siyuan_test(self):
        """Base URL of the isolated test instance (no trailing slash).

        It and `cfg.siyuan` (the user's instance) are two different instances, and neither may fall back to the other.
        """
        return "%s://%s:%d" % (
            self.get("SIYUAN_SCHEME"), self.siyuan_host, self.siyuan_test_port)

    @property
    def android_serial(self):
        return self._require("ANDROID_SERIAL")

    @property
    def android_browser_pkg(self):
        return self._require("ANDROID_BROWSER_PKG")

    @property
    def android_cdp_port(self):
        return int(self._require("ANDROID_CDP_PORT"))

    @property
    def chromium_path(self):
        """The Chromium binary the E2E suite launches. **Must come from `.env`.**

        No `/usr/bin/chromium` default and no "look for something chromium-ish" search:
        the choice of binary is the choice of rendering engine, and the E2E conclusions
        only hold for the browser that was actually used. A silent switch to another build
        keeps every case green while measuring a different engine.
        """
        return self._require("CHROMIUM_PATH")

    @property
    def test_notebook(self):
        """The notebook the E2E suites may write in —— an **id**, required for the suites to run.

        Read here rather than from the shell so it comes from `.env` like every other machine-specific
        value. Deliberately **not** a name: the suites create and delete documents, so the target must be
        named explicitly, and an empty value makes `e2e/testdoc.ts` fail loudly instead of picking an open
        notebook that merely looks like a test target (5.1: no "probe and pick one"). It is not in REQUIRED
        because only the E2E layer needs it.
        """
        return self.get("SIYUAN_TEST_NOTEBOOK", "")

    @property
    def python(self):
        """Interpreter that runs the verification scripts needing playwright.

        **Required, like every other key.** It used to fall back to `sys.executable` when `PYTHON` was
        unset, which is the silent fallback 5.1 #3 forbids and it failed in the quietest possible way:
        playwright is installed in one interpreter on this machine (`npm run verify:android` documents
        that), so the fallback ran the mobile check under an interpreter without playwright and turned
        "you must configure PYTHON" into an ImportError from somewhere deep inside the run.
        """
        return self._require("PYTHON")

    @property
    def workspace(self):
        """SiYuan workspace directory. **Can only come from `.env`** (or an environment variable).

        Comes only from `.env`; no path search of any kind.
        """
        return self._require("SIYUAN_WORKSPACE")

    @property
    def plugin_name(self):
        return self.get("PLUGIN_NAME")

    @property
    def plugin_dir(self):
        """**The reference instance** —— the workspace the user works in, and the installation the plugin
        ships to. Read-only for development: nothing is deployed, tested or mutated here.
        """
        return os.path.join(self.workspace, "data", "plugins", self.plugin_name)

    # ---- Isolated test instance ----
    # These paths used to be written out once in `test-instance.py` and once in `deploy.py`,
    # the latter's comment even saying "keep in sync with test-instance.py" —— consistency kept
    # by comments goes out of sync sooner or later. It is all computed here instead.

    @property
    def test_instance_dir(self):
        """Root directory of the isolated test instance."""
        return self._require("TEST_INSTANCE_DIR")

    @property
    def test_instance_workspace(self):
        """SiYuan workspace of the isolated test instance."""
        return os.path.join(self.test_instance_dir, "workspace")

    @property
    def test_instance_plugin_dir(self):
        """**The working instance** —— the only place a build is deployed, a test mutates a document, or an
        E2E suite runs. The two roles are separate on purpose: they were one list once, and every deploy
        during development went into the workspace the user was working in (`docs/pitfalls/privacy.md`).
        """
        return os.path.join(self.test_instance_workspace, "data", "plugins",
                            self.plugin_name)

    @property
    def plugin_dirs(self):
        """**All** plugin directories the build output must be synced into (ordered, deduplicated).

        From `PLUGIN_DIRS` (colon-separated), which is required — no derivation fallback exists
        (an empty value fails loudly below rather than deploying nowhere).

        ★ Keeping "several" is a hard requirement: the two instances each hold a copy of the plugin,
          deploy only one and the other side runs its tests against stale code.
        """
        raw = self._require("PLUGIN_DIRS")
        dirs = [os.path.expanduser(p) for p in raw.split(":") if p.strip()]
        seen, out = set(), []
        for d in dirs:
            d = os.path.normpath(d)
            if d not in seen:
                seen.add(d)
                out.append(d)
        # ★ A value with no usable entry (':', ' ', '::') passes _require() but deploys nowhere:
        #   fail here instead of copying nothing and exiting 0.
        if not out:
            raise RuntimeError(
                "PLUGIN_DIRS has no usable entry (%r). Set at least one plugin directory in .env." % raw
            )
        return out

    @property
    def conf_json(self):
        """SiYuan's conf.json (it contains the API token)."""
        return os.path.join(self.workspace, "conf", "conf.json")

    def token(self):
        """API token: if `.env` gives one explicitly, use it; otherwise read it from conf.json.

        ★ Read failures **raise** (like the sibling `test_token()`), naming the path and the real
        error: the old code turned every failure — permissions, malformed JSON, a truncated file —
        into an empty string, so callers reported 'cannot get the API token' (or ate a bare 401)
        instead of the actual cause.
        """
        explicit = self.get("SIYUAN_TOKEN")
        if explicit:
            return explicit
        try:
            import json
            with open(self.conf_json, encoding="utf-8") as f:
                return (json.load(f).get("api") or {}).get("token", "")
        except Exception as e:
            raise RuntimeError(
                f"Cannot read the API token: {self.conf_json} ({e})\n"
                f"Set SIYUAN_TOKEN in .env, or fix the file above."
            )

    def test_token(self):
        """The isolated test instance's own token (read from its conf.json). No falling back to token()."""
        import json
        path = os.path.join(self.test_instance_workspace, "conf", "conf.json")
        try:
            with open(path, encoding="utf-8") as f:
                return (json.load(f).get("api") or {}).get("token", "")
        except Exception as e:
            raise RuntimeError(
                f"Cannot read the isolated test instance's token: {path} ({e})\n"
                f"Start the instance first: python3 scripts/test-instance.py"
            )

    def build_url(self, platform, doc_id):
        """SiYuan build page URL. platform is `desktop` / `mobile`."""
        return f"{self.siyuan}/stage/build/{platform}/?id={doc_id}"


cfg = Config()

# Allow `python3 scripts/env.py` to print the effective configuration directly (for diagnosis)
if __name__ == "__main__":
    with script_log.track("env"):
        print(f"  config file : {cfg._file}"
              + ("" if os.path.exists(cfg._file) else "  (does not exist, using defaults)"))
        tok = cfg.token()
        print(f"  SiYuan      : {cfg.siyuan}")
        print(f"  workspace   : {cfg.workspace}")
        print(f"  test inst   : {cfg.siyuan_test}   ← E2E / verify:android use only this one")
        print(f"  inst dir    : {cfg.test_instance_dir}")
        print(f"  CDP         : {cfg.cdp_http}")
        print(f"  token       : {'obtained(' + str(len(tok)) + ' chars)' if tok else '❌ not obtained'}")
        # The interpreter used by the scripts that need playwright (verify:android).
        # It is printed because "which python it actually points at" is hard to judge without it.
        print(f"  PYTHON      : {cfg.python}")
        print(f"  deploy      : {len(cfg.plugin_dirs)} target(s)")
        for d in cfg.plugin_dirs:
            print(f"             · {d}")


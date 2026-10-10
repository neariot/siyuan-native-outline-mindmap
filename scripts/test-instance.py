#!/usr/bin/env python3
"""Prepare / start an **isolated** SiYuan instance dedicated to E2E tests.

## Why it is needed

E2E used to run against the instance the user is **actively using** (pointed at by `SIYUAN_URL`):
a 6 GB workspace, 2158 documents, **sync enabled**. Two problems:

1. **Data safety**: the tests really create and delete documents. Although there is an allowlist for
   'only touching the fixture notebook', one environment variable bypasses it, and sync uploads the test garbage **to the cloud**.
2. **Uncontrollable configuration**: the tests depended on 'that machine happening to have SiYuan installed,
   the port happening to be 6806, the token being somewhere'—— it would not run on another machine.

This script turns 'the SiYuan needed to run the tests' into something **self-contained inside the project**:
download the kernel from the official Release, extract it into the project, and start an empty, sync-disabled instance.

## Two kernel constraints measured in practice (both tripped over)

1. The directory `--workspace` points at **must already exist**. When it does not, the kernel **reports no error**
   but **silently falls back** to the default workspace (`~/SiYuan`), and then fails while locking the workspace ——
   the log says `lock workspace failed`, while the real root cause is 'the directory does not exist'.
2. `--wd` must be a directory containing `appearance/langs`. In the official tarball that is
   `resources/`; pointing it at the wrong directory panics outright at the `InitConf` stage.

## Usage

    python3 scripts/test-instance.py ensure   # prepare only (download+extract), do not start
    python3 scripts/test-instance.py start    # ensure it is ready, then start (foreground)
    python3 scripts/test-instance.py token     # print the instance token (for E2E)
    python3 scripts/test-instance.py stop     # stop it
    python3 scripts/test-instance.py status   # show the status

Downloads and the workspace both live in `.env`'s `TEST_INSTANCE_DIR` —— **outside the repository**,
because this is state rather than scratch: inside `.tmp/` it made that directory undeletable.
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import signal
import re
import subprocess
import sys
import tarfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import ROOT, cfg  # noqa: E402
import script_log  # noqa: E402

# ---------------------------------------------------------------- Constants

# The directory comes from `.env` (see cfg.test_instance_*); paths are not assembled here.
INSTANCE_DIR = cfg.test_instance_dir
RESOURCES_DIR = os.path.join(INSTANCE_DIR, "resources")
WORKSPACE_DIR = cfg.test_instance_workspace
KERNEL_BIN = os.path.join(RESOURCES_DIR, "kernel", "SiYuan-Kernel")
PID_FILE = os.path.join(INSTANCE_DIR, "kernel.pid")
LOG_FILE = os.path.join(INSTANCE_DIR, "kernel.log")

#: The port comes from SIYUAN_TEST_PORT in `.env`. There is no default value.
DEFAULT_PORT = cfg.siyuan_test_port

RELEASES_API = "https://api.github.com/repos/siyuan-note/siyuan/releases/latest"

#: The E2E notebook allowlist (see `SAFE_NOTEBOOK_NAMES` in `e2e/testdoc.ts`).
#: An empty workspace does not have it, so the cases **correctly refuse to run** —— hence the script must create it first.
SAFE_NOTEBOOK_NAME = "e2e-fixture-notebook"

#: Plugin name (= the directory name under `data/plugins/` in the workspace).
PLUGIN_NAME = cfg.plugin_name


def log(msg):
    print("  " + msg, flush=True)


def die(msg, code=1):
    print("  ✗ " + msg, file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------- Platform

def target_suffix():
    """Computes the platform suffix of the official package, e.g. `linux-arm64`.

    Official asset names look like this: `siyuan-3.8.6-linux-arm64.tar.gz`.
    """
    sysname = platform.system().lower()
    machine = platform.machine().lower()

    if sysname == "linux":
        os_part = "linux"
        if machine in ("aarch64", "arm64"):
            arch = "arm64"
        elif machine in ("x86_64", "amd64"):
            arch = ""          # the official linux x64 package **has no** arch segment
        else:
            die("unsupported CPU architecture: %s" % machine)
    elif sysname == "darwin":
        os_part = "mac"
        arch = "arm64" if machine in ("arm64", "aarch64") else ""
    else:
        die("unsupported platform for now: %s (only the kernel is portable in the official desktop package)" % sysname)

    return "%s-%s" % (os_part, arch) if arch else os_part


def pick_asset(assets, suffix):
    """Picks this platform's `.tar.gz` out of the Release assets."""
    want = "-%s.tar.gz" % suffix
    for a in assets:
        if a["name"].endswith(want):
            return a
    die("this Release has no package for %s. Available: %s"
        % (want, ", ".join(x["name"] for x in assets)))


# ---------------------------------------------------------------- Download

def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "test-instance/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def sha256_of(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(chunk), b""):
            h.update(blk)
    return h.hexdigest()


def download(url, dest, expect_sha=None):
    """Downloads and, if provided, verifies the sha256.

    Official Release assets carry a `digest: sha256:...` field,
    so it can be verified end to end —— the transfer does not have to be trusted.
    """
    if os.path.exists(dest):
        if expect_sha and sha256_of(dest) != expect_sha:
            log("the existing package failed verification, downloading again")
            os.remove(dest)
        else:
            log("package already exists, skipping download: %s" % os.path.basename(dest))
            return

    log("downloading %s" % url)
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "test-instance/1.0"})

    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        last = 0.0
        while True:
            blk = r.read(1 << 20)
            if not blk:
                break
            f.write(blk)
            got += len(blk)
            now = time.time()
            if now - last > 2.0 and total:
                log("  %5.1f%%  (%.0f/%.0f MB)"
                    % (got * 100.0 / total, got / 1e6, total / 1e6))
                last = now

    if expect_sha:
        actual = sha256_of(tmp)
        if actual != expect_sha:
            os.remove(tmp)
            die("sha256 verification failed\n  expected %s\n  actual %s" % (expect_sha, actual))
        log("✅ sha256 verified")

    os.replace(tmp, dest)


# ---------------------------------------------------------------- Extract

def extract_resources(tarball, dest):
    """Extracts only `resources/` (kernel + appearance + guides) and skips the Electron shell.

    Extracting the whole package takes 400+ MB, and `resources/app/` (the frontend build output) is useless
    for **starting the kernel**. As long as the kernel runs, that is enough.
    """
    log("extracting resources/ …")
    tmpdir = dest + ".tmp"
    shutil.rmtree(tmpdir, ignore_errors=True)
    os.makedirs(tmpdir, exist_ok=True)

    with tarfile.open(tarball, "r:gz") as tf:
        members = [m for m in tf.getmembers()
                   if "/resources/" in m.name and "/resources/app/" not in m.name]
        if not members:
            die("no resources/ directory found in the package")
        # the `filter` argument must be specified explicitly in newer Python versions
        try:
            tf.extractall(tmpdir, members=members, filter="data")
        except TypeError:
            tf.extractall(tmpdir, members=members)

    # Strip the extra top-level directory (siyuan-3.8.6-linux-arm64/)
    inner = None
    for entry in os.listdir(tmpdir):
        cand = os.path.join(tmpdir, entry, "resources")
        if os.path.isdir(cand):
            inner = cand
            break
    if inner is None:
        die("no resources/ found after extraction")

    shutil.rmtree(dest, ignore_errors=True)
    shutil.move(inner, dest)
    shutil.rmtree(tmpdir, ignore_errors=True)

    os.chmod(KERNEL_BIN, 0o755)
    log("✅ kernel in place: %s" % os.path.relpath(KERNEL_BIN, ROOT))


def ensure_resources(force=False):
    if not force and os.path.exists(KERNEL_BIN):
        log("kernel already exists, skipping preparation: %s" % os.path.relpath(KERNEL_BIN, ROOT))
        return

    os.makedirs(INSTANCE_DIR, exist_ok=True)
    rel = http_json(RELEASES_API)
    asset = pick_asset(rel["assets"], target_suffix())

    digest = (asset.get("digest") or "").removeprefix("sha256:") or None
    log("latest official release: %s  (%s, %.0f MB)"
        % (rel["tag_name"], asset["name"], asset["size"] / 1e6))

    tarball = os.path.join(INSTANCE_DIR, asset["name"])
    download(asset["browser_download_url"], tarball, digest)
    extract_resources(tarball, RESOURCES_DIR)


# ---------------------------------------------------------------- Run

def read_token():
    conf = os.path.join(WORKSPACE_DIR, "conf", "conf.json")
    if not os.path.exists(conf):
        return None
    with open(conf, encoding="utf-8") as f:
        return (json.load(f).get("api") or {}).get("token")


def pid_of():
    if not os.path.exists(PID_FILE):
        return None
    try:
        pid = int(open(PID_FILE).read().strip())
    except (ValueError, OSError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def api_alive(port):
    req = urllib.request.Request(
        "http://%s:%d/api/system/version" % (cfg.siyuan_host, port),
        headers={"Authorization": "Token %s" % (read_token() or "")},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r).get("code") == 0
    except Exception:
        return False


def api_call(port, path, payload=None):
    """Calls a kernel API once and returns the parsed JSON."""
    body = json.dumps(payload or {}).encode()
    req = urllib.request.Request(
        "http://%s:%d%s" % (cfg.siyuan_host, port, path), data=body,
        headers={"Authorization": "Token %s" % read_token(),
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def ensure_notebook(port):
    """Guarantees the instance has an allowlisted notebook, otherwise E2E (correctly) refuses to run.

    `e2e/testdoc.ts` only accepts notebooks whose name is on the allowlist —— if none is found it throws,
    rather than picking one at random. That is a design that **protects user data** and must not be bypassed;
    so the script is responsible for creating the allowlisted notebook.
    """
    data = api_call(port, "/api/notebook/lsNotebooks").get("data") or {}
    for nb in (data.get("notebooks") or []):
        if nb.get("name") == SAFE_NOTEBOOK_NAME:
            return nb["id"]
    r = api_call(port, "/api/notebook/createNotebook", {"name": SAFE_NOTEBOOK_NAME})
    if r.get("code") != 0:
        die("failed to create the test notebook: %s" % r.get("msg"))
    log("✅ test notebook '%s' created" % SAFE_NOTEBOOK_NAME)
    return r["data"]["notebook"]["id"]


def _display_name(manifest):
    """Takes a usable display name out of plugin.json.

    `displayName` may be a string or `{"default": ..., "zh_CN": ...}` ——
    both must be handled, and if neither yields one it falls back to the plugin name.
    """
    dn = manifest.get("displayName")
    if isinstance(dn, dict):
        return dn.get("default") or dn.get("zh_CN") or PLUGIN_NAME
    if isinstance(dn, str) and dn:
        return dn
    return PLUGIN_NAME


def configure_instance():
    """Flips the test instance's configuration into the 'able to run tests' state.

    The two items measured as necessary (both were tripped over):

    1. **`bazaar.trust = true`** —— an empty workspace defaults to `false`, and the kernel prints
       `kernel plugins are disabled by configuration, skipping start`
       and **does not load plugins at all**. The symptom is that `.om-dock` is never seen.
       Note that this log line says 'configuration', so do not go looking for a problem with the plugin itself.
    2. **`sync.enabled = false`** —— a new workspace already has it off; this states it explicitly once more:
       the tests really create and delete documents, so telemetry/sync must not move along with them.
    """
    path = os.path.join(WORKSPACE_DIR, "conf", "conf.json")
    if not os.path.exists(path):
        return                      # on the first start the kernel has not generated it yet; the next round gets here
    with open(path, encoding="utf-8") as f:
        conf = json.load(f)

    changed = []
    bz = conf.setdefault("bazaar", {})
    if not bz.get("trust"):
        bz["trust"] = True
        changed.append("bazaar.trust")
    sy = conf.setdefault("sync", {})
    if sy.get("enabled"):
        sy["enabled"] = False
        changed.append("sync.enabled")

    if changed:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(conf, f, ensure_ascii=False, indent=2)
        log("✅ adjusted instance configuration: %s" % ", ".join(changed))
        return changed
    return changed


def enable_plugin():
    """Marks the plugin as **enabled**, otherwise SiYuan will not load it.

    ## Why 'the file is there' alone is not enough

    SiYuan records each plugin's enabled state in `<ws>/data/storage/petal/petals.json`,
    whose structure is a table:

        [{"name": "...", "displayName": "...", "version": "...", "enabled": true, ...}]

    In an empty workspace this file does not exist ⇒ the plugin is on disk but **will not be loaded**,
    which shows up as `.om-dock` never appearing —— it looks like the plugin is broken, when in fact it is just not enabled.
    (Screenshot first when investigating: the page itself is fine, the sidebar simply has no plugin entry.)

    Field values are read straight from the plugin's own `plugin.json`, avoiding a second copy of the version number here.
    """
    plugin_dir = os.path.join(WORKSPACE_DIR, "data", "plugins", PLUGIN_NAME)
    manifest = os.path.join(plugin_dir, "plugin.json")
    if not os.path.exists(manifest):
        die("the plugin is not deployed to the test instance: %s" % plugin_dir)
    with open(manifest, encoding="utf-8") as f:
        mf = json.load(f)

    petal_dir = os.path.join(WORKSPACE_DIR, "data", "storage", "petal")
    os.makedirs(petal_dir, exist_ok=True)
    path = os.path.join(petal_dir, "petals.json")

    entries = []
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                entries = json.load(f) or []
        except (ValueError, OSError):
            entries = []
    entries = [e for e in entries if e.get("name") != PLUGIN_NAME]
    entries.append({
        "name": PLUGIN_NAME,
        # ★ plugin.json's displayName is an **object** ({default, zh_CN}), not a string.
        #   Copying it directly writes `"displayName": "siyuan-native-outline-mindmap"`,
        #   which shows up as the plugin id in the bazaar. Here we take default.
        "displayName": _display_name(mf),
        "version": mf.get("version", "0.0.0"),
        "enabled": True,
        "incompatible": False,
        "disabledInPublish": False,
        "userDisabledInPublish": False,
        "disallowInstall": False,
        "js": "",
        "css": "",
        "i18n": None,
        "kernel": {"js": "", "existed": False, "incompatible": True},
    })
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
    log("✅ plugin '%s' v%s enabled" % (entries[-1]["displayName"], entries[-1]["version"]))


def deploy_plugin():
    """Deploy the **current build artifacts** to the test instance, and to nothing else.

    The instance is an empty workspace; without the plugin installed, E2E cannot even see `.om-dock`.
    Reuses `scripts/deploy.py`, which handles copying and verifying 'build artifacts → plugin directory'.

    ★ `deploy.py` takes its targets from `PLUGIN_DIRS`, and on a development machine that list is the
    plugin directories to sync —— the workspace the user works in among them. An earlier version of this
    function set `SIYUAN_WORKSPACE` and its docstring asserted that this pointed the deploy at the test
    instance; `deploy.py` never reads that variable, so it wrote to every target and the user's editor
    received the same build. The target is narrowed with `PLUGIN_DIRS` (deploy.py's documented override)
    and the outcome is **checked**: deploy.py prints how many targets it wrote to and which, and anything
    other than exactly this instance's plugin directory is an error rather than a warning.
    """
    deploy = os.path.join(ROOT, "scripts", "deploy.py")
    if not os.path.exists(deploy):
        die("scripts/deploy.py not found")

    plugin_dir = os.path.join(WORKSPACE_DIR, "data", "plugins", PLUGIN_NAME)
    env = dict(os.environ, PLUGIN_DIRS=plugin_dir)
    r = subprocess.run([sys.executable, deploy, "--no-build"],
                       cwd=ROOT, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        die("failed to deploy the plugin:\n%s%s" % (r.stdout, r.stderr))

    # ★ Check where it **wrote**, not what it was configured to write: deploy.py prints one
    #   `✓ deployed ... → <dir>` line per target it copied into, and that is the evidence that the
    #   narrowing worked. Expecting the configured list would pass on a run that ignored it.
    out = r.stdout or ""
    written = [l.split("\u2192", 1)[1].strip() for l in out.splitlines()
               if "deployed" in l and "\u2192" in l]
    if len(written) != 1:
        die("deploy wrote to %d target(s); this instance must be the only one:\n%s" % (len(written), out))
    if os.path.normpath(written[0]) != os.path.normpath(plugin_dir):
        die("deploy wrote somewhere unexpected:\n  %s" % written)
    log("deployed to the test instance only: %s" % plugin_dir)
    if not re.search(r"checksum", out):
        die("deploy did not report a checksum, so the copy is unverified:\n%s" % out)

def start(port):
    if pid_of() and api_alive(port):
        log("already running (pid %d, port %d)" % (pid_of(), port))
        return

    ensure_resources()

    # ★ The kernel will **not** create the workspace directory for you; when it is missing it silently falls back to the default workspace.
    os.makedirs(WORKSPACE_DIR, exist_ok=True)

    # ① Configuration: must be set **before startup** —— the kernel reads conf.json only once at boot,
    #    and if `bazaar.trust` is false the plugin will not be loaded at all.
    #    On the first run conf.json does not exist yet (it waits for the kernel to generate it), so here we set it once,
    #    start and stop, then set it again —— see the `first_boot` handling below.
    configure_instance()

    # ② Put the plugin files in place and enable them first. SiYuan reads petals.json only once at boot.
    deploy_plugin()
    enable_plugin()

    log("starting kernel: workspace=%s port=%d"
        % (os.path.relpath(WORKSPACE_DIR, ROOT), port))
    logf = open(LOG_FILE, "w", encoding="utf-8")
    proc = subprocess.Popen(
        [KERNEL_BIN, "serve",
         "--workspace=" + WORKSPACE_DIR,
         "--port=%d" % port,
         # ★ --wd must be a directory containing appearance/langs, i.e. resources/
         "--wd=" + RESOURCES_DIR,
         "--lang=zh-CN"],
        stdout=logf, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    open(PID_FILE, "w").write(str(proc.pid))

    log("waiting for it to come up …")
    for _ in range(120):
        if proc.poll() is not None:
            tail = ""
            if os.path.exists(LOG_FILE):
                tail = "".join(open(LOG_FILE, encoding="utf-8").readlines()[-12:])
            die("kernel exited (exit %s)\n%s" % (proc.returncode, tail))
        if api_alive(port):
            break
        time.sleep(0.5)
    else:
        die("did not come up within 60 seconds, see the log: %s" % os.path.relpath(LOG_FILE, ROOT))

    # ③ On the first run conf.json was just generated by the kernel and `bazaar.trust` is still the default false,
    #    so that boot did not load the plugin. The change only takes effect after **starting once more**.
    if configure_instance():
        log("configuration changed, restarting once so the kernel re-reads it …")
        stop()
        return start(port)

    ensure_notebook(port)

    token = read_token()
    log("✅ ready: http://%s:%d" % (cfg.siyuan_host, port))
    # ★ Never print the credential itself. This hint used to end with a copy-paste line containing
    #   the token, and that is exactly how one ended up committed in a spec: a printed secret is a
    #   secret waiting to be pasted. `npm run test:e2e` injects the token itself (scripts/run-e2e.py),
    #   so the hint does not need it -- and `test-instance.py token` is there for a manual run.
    log("   token: obtained(%d chars) —— read it with: python3 scripts/test-instance.py token" % len(token or ""))
    log("   workspace: %s (empty, sync disabled)" % os.path.relpath(WORKSPACE_DIR, ROOT))
    log("")
    log("   run E2E (the runner supplies the address and the token itself):")
    log("     npm run test:e2e")


def stop():
    pid = pid_of()
    if not pid:
        log("not running")
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(40):
        try:
            os.kill(pid, 0)
        except OSError:
            break
        time.sleep(0.25)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    if os.path.exists(PID_FILE):
        os.remove(PID_FILE)
    log("stopped (pid %d)" % pid)


def status(port):
    pid = pid_of()
    alive = api_alive(port)
    log("process: %s" % ("running pid %d" % pid if pid else "not running"))
    log("API : %s" % ("available" if alive else "unavailable"))
    log("port: %d" % port)
    if os.path.exists(KERNEL_BIN):
        log("kernel: %s" % os.path.relpath(KERNEL_BIN, ROOT))
    else:
        log("kernel: not prepared yet (run `%s ensure`)" % sys.argv[0])


def main():
    ap = argparse.ArgumentParser(description="isolated SiYuan test instance")
    ap.add_argument("action",
                    choices=["ensure", "start", "stop", "status", "token"],
                    help="what to do")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help="port (defaults to SIYUAN_TEST_PORT = %d from .env, "
                         "deliberately avoiding the user instance)" % DEFAULT_PORT)
    ap.add_argument("--force", action="store_true", help="force re-download and re-extract")
    args = ap.parse_args()

    if args.action == "ensure":
        ensure_resources(force=args.force)
    elif args.action == "start":
        start(args.port)
    elif args.action == "stop":
        stop()
    elif args.action == "status":
        status(args.port)
    elif args.action == "token":
        t = read_token()
        if not t:
            die("the instance has never been started, so there is no token. Run start first")
        print(t)


if __name__ == "__main__":
    with script_log.track("test-instance"):
        main()

#!/usr/bin/env python3
"""Android + CDP joint automated verification script.

## When it applies
- Mobile virtual keyboard show/hide adaptation (visualViewport linkage, toolbar snapping)
- Physical non-occlusion between the outline content and the bottom toolbar (the outline's lower edge fits exactly to the toolbar's upper edge)
- Mobile format drawer (Aa panel), shortcut bar, node operations interacting with a real-device soft keyboard
- Mobile soft-keyboard input and two-way content synchronization

## Architecture and how it works
1. ADB layer:
   - Auto-detects and connects to an Android target (a local Redroid container or a real device)
   - `adb reverse tcp:<port> tcp:<port>` safely forwards SiYuan into Android (avoids exposing it on the external network)
   - `adb forward tcp:<cdp_port> localabstract:chrome_devtools_remote` forwards the browser CDP
   - `adb shell input` injects real hardware/system-level text input and key events
   - `adb exec-out screencap` captures the real-device screen including Android's system soft keyboard

2. CDP layer (based on Playwright):
   - Connects to the phone browser's DevTools
   - Auto-locates or launches the SiYuan mobile page (handles the ?r= session redirect)
   - Brings up the 「原生大纲导图」 mobile panel and switches to the outline view
   - Strictly measures DOM geometry: toolbar coordinates, outline viewport lower edge, caret row position, button interactivity

## Usage examples

  # 1. Run the full smoke case (auto-detects adb and ports by default)
  python3 scripts/verify-android.py

  # 2. Specify ports and device
  python3 scripts/verify-android.py --siyuan-port <test instance port> --serial <device serial>

  # 3. Run only a specific scenario
  python3 scripts/verify-android.py --scenario idle      # verify the toolbar and boundaries with no keyboard up
  python3 scripts/verify-android.py --scenario keyboard  # verify toolbar snapping and non-occlusion while the keyboard is up
  python3 scripts/verify-android.py --scenario type      # verify soft-keyboard input and content synchronization
  python3 scripts/verify-android.py --scenario drawer    # verify the second-level format drawer expands
  python3 scripts/verify-android.py --scenario dismiss   # verify the done button dismisses the keyboard
  python3 scripts/verify-android.py --scenario scroll    # verify the lower edge does not bleed through at maximum scroll

  # 4. Only set up port forwarding and launch the browser (convenient for manual debugging)
  python3 scripts/verify-android.py --scenario setup

  # 5. Quickly capture the current real-device screen
  python3 scripts/verify-android.py --scenario shot -o .tmp/android-test/shot.png
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

# Centralized configuration loading
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPTS_DIR)
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from env import cfg  # noqa: E402
import script_log  # noqa: E402


# The address used inside the phone browser to reach SiYuan on the host machine.
#
# ★★★ It **must** be a loopback address and **not** `SIYUAN_HOST` —— these are two different viewpoints:
#
#   `adb reverse tcp:P tcp:P` is defined as
#       '**the device's own** 127.0.0.1:P  →  127.0.0.1:P of the machine running adb'
#   So what must be written on the phone side is **the phone's own loopback**. Writing `SIYUAN_HOST`
#   (the address from the host machine's viewpoint, possibly a LAN IP) **bypasses** adb reverse,
#   and only happens to work when the phone can reach that machine directly —— which is exactly what this forwarding avoids.
#
#   ⇒ This is not 'forgot to turn it into a config item'; it is a constant forced by adb reverse's semantics.
#     The host-side address (connecting to CDP, probing ports) is what should go through cfg.
DEVICE_LOOPBACK = "127.0.0.1"


class AndroidBridge:
    """Manages the ADB device connection, port forwarding, system key injection, and real-device screenshots."""

    def __init__(self, serial=None, browser_pkg=None, verbose=False):
        self.serial = serial or cfg.android_serial
        self.browser_pkg = browser_pkg or cfg.android_browser_pkg
        self.verbose = verbose
        self._ensure_device()

    def _cmd(self, *args):
        base = ["adb"]
        if self.serial:
            base.extend(["-s", self.serial])
        base.extend(args)
        if self.verbose:
            print(f"  [ADB] {' '.join(base)}")
        return base

    def run(self, *args, check=True):
        cmd = self._cmd(*args)
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if check and res.returncode != 0:
            raise RuntimeError(f"ADB command failed ({' '.join(cmd)}): {res.stderr.strip()}")
        return res.stdout.strip()

    def _ensure_device(self):
        """Probes for ADB devices; auto-selects the first online device when no serial is given."""
        out = self.run("devices")
        lines = [line.strip() for line in out.splitlines()[1:] if line.strip()]
        devices = []
        for line in lines:
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "device":
                devices.append(parts[0])

        if not devices:
            raise RuntimeError(
                "No usable Android device or container found.\n"
                "Please confirm:\n"
                "  1. The Redroid container or Android device is started\n"
                "  2. `adb connect <device address>` has been run (see ANDROID_SERIAL in .env),\n"
                "     or USB debugging is attached; the address can also go into ANDROID_SERIAL in .env\n"
                "  3. Run `adb devices` to check the status"
            )

        if not self.serial:
            self.serial = devices[0]
            if self.verbose:
                print(f"  [ADB] auto-selected device: {self.serial}")
        elif self.serial not in devices:
            # Try to connect to the specified serial (e.g. IP:Port)
            if ":" in self.serial:
                connect_res = self.run("connect", self.serial, check=False)
                if self.verbose:
                    print(f"  [ADB] connecting to {self.serial}: {connect_res}")
                # Re-check
                out = self.run("devices")
                if self.serial not in out:
                    raise RuntimeError(f"cannot connect to the specified device {self.serial} or it is offline: {devices}")
            else:
                raise RuntimeError(f"the specified device {self.serial} is not in the list of online devices: {devices}")

    def setup_port_forwarding(self, siyuan_port, cdp_port):
        """Configures bidirectional port forwarding:
        1. adb reverse tcp:<siyuan_port> tcp:<siyuan_port>: the phone reaches SiYuan on this machine
        2. adb forward tcp:<cdp_port> localabstract:chrome_devtools_remote: this machine reaches the phone browser's CDP
        """
        # 1. Check the SiYuan port reverse forwarding
        reverse_list = self.run("reverse", "--list", check=False)
        target_rev = f"tcp:{siyuan_port}"
        if target_rev not in reverse_list:
            if self.verbose:
                print(f"  [ADB] setting up reverse forwarding: {target_rev} -> {target_rev}")
            self.run("reverse", f"tcp:{siyuan_port}", f"tcp:{siyuan_port}")
        else:
            if self.verbose:
                print(f"  [ADB] reverse forwarding already exists: {target_rev}")

        # 2. Check the CDP forward forwarding
        forward_list = self.run("forward", "--list", check=False)
        target_fwd = f"tcp:{cdp_port}"
        if target_fwd not in forward_list:
            if self.verbose:
                print(f"  [ADB] setting up CDP forwarding: {target_fwd} -> localabstract:chrome_devtools_remote")
            self.run("forward", f"tcp:{cdp_port}", "localabstract:chrome_devtools_remote")
        else:
            if self.verbose:
                print(f"  [ADB] CDP forwarding already exists: {target_fwd}")

    def launch_browser(self, url=None):
        """Launches the browser on the phone."""
        if url:
            self.run("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, check=False)
        else:
            self.run("shell", "monkey", "-p", self.browser_pkg, "-c", "android.intent.category.LAUNCHER", "1", check=False)

    def screencap(self, out_path):
        """Captures a full real-device screenshot including the system soft keyboard and the status bar."""
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        cmd = self._cmd("exec-out", "screencap", "-p")
        with open(out_path, "wb") as f:
            res = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE)
            if res.returncode != 0:
                raise RuntimeError(f"screencap failed: {res.stderr.decode().strip()}")
        return out_path

    def input_text(self, text):
        """Inputs text into the current focus via ADB."""
        # Escape special characters
        escaped = text.replace(" ", "%s").replace("&", "\\&")
        self.run("shell", "input", "text", escaped)

    def input_key(self, keycode):
        """Inputs a key event, e.g. KEYCODE_ENTER=66, KEYCODE_DEL=67, KEYCODE_BACK=4."""
        self.run("shell", "input", "keyevent", str(keycode))

    def tap(self, x, y):
        """Taps physical screen coordinates."""
        self.run("shell", "input", "tap", str(int(x)), str(int(y)))


class AndroidVerifier:
    """Connects to the Android browser CDP via Playwright and runs the outline/mind-map verification."""

    def __init__(self, bridge: AndroidBridge, siyuan_port: int, cdp_port: int,
                 out_dir=".tmp/android-test", verbose=False):
        self.bridge = bridge
        self.siyuan_port = siyuan_port
        self.cdp_port = cdp_port
        self.out_dir = out_dir
        self.verbose = verbose
        self.results = []
        os.makedirs(self.out_dir, exist_ok=True)

    def check(self, name, ok, detail=""):
        self.results.append({"name": name, "ok": bool(ok), "detail": detail})
        status = "✅" if ok else "❌"
        print(f"  {status} {name}" + (f"  ({detail})" if detail else ""))
        return bool(ok)

    def shot(self, label, page=None):
        """Saves screenshots from both viewpoints: the real device and the browser."""
        os_path = os.path.join(self.out_dir, f"{label}_os.png")
        self.bridge.screencap(os_path)
        if page:
            web_path = os.path.join(self.out_dir, f"{label}_web.png")
            try:
                page.screenshot(path=web_path)
            except Exception:
                pass
        return os_path

    def connect_and_prepare_page(self, playwright):
        """Connects to CDP and obtains/launches the SiYuan outline page."""
        # Host side: this connects to the debug port forwarded by this machine (or the machine named by CDP_HOST),
        # so it goes through config instead of hardcoding a loopback address.
        cdp_url = f"http://{cfg.cdp_host}:{self.cdp_port}"
        browser = playwright.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0]

        port_str = f":{self.siyuan_port}"
        page = None
        for p in context.pages:
            if port_str in p.url and not p.url.startswith("chrome-error:"):
                page = p
                break

        if not page:
            if self.verbose:
                print(f"  no open SiYuan page found, creating a new one and navigating to http://{DEVICE_LOOPBACK}:{self.siyuan_port}/ ...")
            page = context.new_page()
            # Visit the root path to obtain the ?r= session redirect, avoiding cross-site request blocking.
            # ★ This is the **phone-side** address and must be DEVICE_LOOPBACK (see the note at that constant).
            page.goto(f"http://{DEVICE_LOOPBACK}:{self.siyuan_port}/", wait_until="commit")

        page.bring_to_front()
        page.wait_for_timeout(1000)

        # Make sure the SiYuan shell has finished loading
        try:
            page.wait_for_selector("#toolbar, #editor, .protyle", timeout=15000)
        except Exception:
            if self.verbose:
                print("  timed out waiting for #toolbar, trying to continue...")

        # Make sure the 「原生大纲导图」 plugin panel is open
        self.ensure_plugin_open(page)
        # Make sure the outline view is active
        self.ensure_outline_view(page)

        return browser, page

    def ensure_plugin_open(self, page):
        """Ensures the outline plugin panel is mounted in the DOM."""
        is_mounted = page.locator(".om-mm-host").count() > 0
        if is_mounted:
            if self.verbose:
                print("  plugin panel ready (.om-mm-host)")
            return

        if self.verbose:
            print("  opening the menu to bring up the outline/mind-map panel...")

        # Click the top-right "more" menu
        page.evaluate("""() => {
            const more = document.querySelector('#menuMore, #barMore, [data-type="more"]');
            if (more) more.click();
        }""")
        page.wait_for_timeout(800)

        # Click the plugin menu item
        clicked = page.evaluate("""() => {
            const items = Array.from(document.querySelectorAll('.b3-menu__item, [data-type]'));
            for (const item of items) {
                if (item.textContent.includes('Native Outline') || item.textContent.includes('Mindmap') || item.textContent.includes('\\u539f\\u751f\\u5927\\u7eb2\\u5bfc\\u56fe') || item.textContent.includes('\\u5bfc\\u56fe')) {
                    item.click();
                    return true;
                }
            }
            return false;
        }""")

        if clicked:
            page.wait_for_selector(".om-mm-host", timeout=10000)
            if self.verbose:
                print("  plugin panel brought up successfully")
        else:
            raise RuntimeError("the plugin item was not found in the mobile more menu")

    def ensure_outline_view(self, page):
        """Ensures the outline view is currently active."""
        page.wait_for_selector(".om-mm-viewswitch", timeout=8000)
        is_outline_active = page.evaluate("""() => {
            const btn = document.querySelectorAll('.om-mm-viewswitch button')[0];
            if (!btn) return false;
            if (!btn.classList.contains('active')) {
                btn.click();
            }
            return true;
        }""")
        page.wait_for_selector(".om-outline-wrap", timeout=8000)
        if self.verbose:
            print(f"  switched to outline view: {is_outline_active}")

    # =========================================================================
    # Test scenarios
    # =========================================================================

    def scenario_idle(self, page):
        """Scenario 1: toolbar and outline lower-edge boundaries with no keyboard up."""
        print("\n--- Scenario 1: toolbar and outline lower-edge boundaries with no keyboard up ---")
        self.shot("01_idle_before", page)

        bar = page.locator(".mobile-keyboard-bar").first
        wrap = page.locator(".om-outline-wrap").first

        bar_exists = bar.count() > 0
        self.check("bottom toolbar exists", bar_exists)
        if not bar_exists:
            return

        bar_box = bar.bounding_box()
        wrap_box = wrap.bounding_box()

        # 1. The toolbar has a valid height and is not marked keyboard-open
        is_kb_open = bar.evaluate("el => el.classList.contains('keyboard-open')")
        self.check("toolbar is not marked keyboard-open", not is_kb_open, f"keyboard-open={is_kb_open}")
        self.check("toolbar rendered height is valid", bar_box and bar_box["height"] >= 36, f"height={bar_box['height'] if bar_box else 0}")

        # 2. Core non-occlusion assertion: the outline scroll viewport's lower edge never exceeds the toolbar's upper edge
        if bar_box and wrap_box:
            wrap_bottom = wrap_box["y"] + wrap_box["height"]
            bar_top = bar_box["y"]
            gap = bar_top - wrap_bottom
            # gap should be around 0 (the toolbar sits flush against the outline's lower edge) and must never be negative (overlap/bleed-through)
            self.check(
                "the outline content area's lower edge stops strictly at the toolbar's upper edge (never slides below it)",
                wrap_bottom <= bar_top + 1.5,
                f"outline bottom={wrap_bottom:.1f}, toolbar top={bar_top:.1f}, gap={gap:.1f}px"
            )

        # 3. Check that the toolbar's core buttons are fully rendered
        buttons = bar.locator(".m-btn").all()
        self.check("toolbar buttons fully rendered and interactive", len(buttons) >= 8, f"button count={len(buttons)}")

        self.shot("01_idle_passed", page)

    def scenario_keyboard(self, page):
        """Scenario 2: toolbar adaptive snapping and non-occlusion while the soft keyboard is up."""
        print("\n--- Scenario 2: soft-keyboard raise adaptation and non-occlusion ---")
        bar = page.locator(".mobile-keyboard-bar").first
        wrap = page.locator(".om-outline-wrap").first
        initial_bar_top = bar.bounding_box()["y"] if bar.count() > 0 else 0

        # Focus a node to bring up the soft keyboard
        node_editor = page.locator(".node-text").last
        if node_editor.count() == 0:
            # If the document is empty, add an initial node
            page.evaluate("""() => {
                const outline = document.querySelector('.outline');
                if (outline) outline.click();
            }""")
            page.wait_for_timeout(500)
            node_editor = page.locator(".node-text").last

        node_editor.click()
        page.wait_for_timeout(1000)

        # Poll until the keyboard is up (criteria: the keyboard-open class, a bottom style offset, or the physical top coordinate moving up because the viewport was pushed)
        kb_opened = False
        for _ in range(25):
            cur_box = bar.bounding_box()
            is_open = bar.evaluate("""el => {
                const b = parseFloat(el.style.bottom || '0');
                return el.classList.contains('keyboard-open') || b > 50;
            }""")
            if is_open or (cur_box and (initial_bar_top - cur_box["y"] > 60)):
                kb_opened = True
                break
            page.wait_for_timeout(200)

        self.shot("02_keyboard_open", page)
        self.check("soft keyboard raised and active state detected", kb_opened)

        cur_bar_box = bar.bounding_box()
        cur_wrap_box = wrap.bounding_box()

        if cur_bar_box:
            # 1. The toolbar really moves up with the keyboard
            shift = initial_bar_top - cur_bar_box["y"]
            self.check("toolbar snaps upward with the keyboard", shift > 80, f"shift distance={shift:.1f}px, current top={cur_bar_box['y']:.1f}")

            # 2. No button inside the toolbar is clipped into blank white by WebKit / Blink
            visible_btns = bar.evaluate("""el => {
                const btns = Array.from(el.querySelectorAll('.m-btn'));
                return btns.filter(b => {
                    const r = b.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                }).length;
            }""")
            self.check("toolbar buttons are not clipped, all render normally", visible_btns >= 8, f"visible button count={visible_btns}")

        # 3. Core assertion: the outline viewport shrinks in step and its lower edge never bleeds below the toolbar
        if cur_bar_box and cur_wrap_box:
            wrap_bottom = cur_wrap_box["y"] + cur_wrap_box["height"]
            bar_top = cur_bar_box["y"]
            gap = bar_top - wrap_bottom
            self.check(
                "with the keyboard expanded: the outline container's lower edge is physically cut off above the toolbar",
                wrap_bottom <= bar_top + 2.0,
                f"outline bottom={wrap_bottom:.1f}, toolbar top={bar_top:.1f}, gap={gap:.1f}px"
            )

        # 4. The active node automatically scrolls into the visible area
        active_box = page.locator(".node-row:focus-within, .node-text:focus").first.bounding_box()
        if active_box and cur_bar_box:
            node_bottom = active_box["y"] + active_box["height"]
            self.check(
                "the currently focused node lies entirely in the visible area above the toolbar",
                node_bottom <= cur_bar_box["y"] + 6.0,
                f"node bottom={node_bottom:.1f}, toolbar top={cur_bar_box['y']:.1f}"
            )

    def scenario_type(self, page, sample_text="android_cdp_test"):
        """Scenario 3: soft-keyboard input and content synchronization."""
        print(f"\n--- Scenario 3: soft-keyboard text input and synchronization ({sample_text}) ---")
        # Inject system-level key events via ADB
        self.bridge.input_text(sample_text)
        page.wait_for_timeout(800)

        self.shot("03_after_typing", page)

        # Check whether the node content contains the typed text
        content = page.evaluate("""() => {
            const el = document.activeElement;
            return el ? el.textContent : '';
        }""")
        self.check("typed text synced into the current node's DOM", sample_text in content, f"current node content='{content}'")

    def scenario_drawer(self, page):
        """Scenario 4: expanding and collapsing the second-level format drawer (Aa panel)."""
        print("\n--- Scenario 4: second-level format drawer expansion and linkage ---")
        bar = page.locator(".mobile-keyboard-bar").first
        wrap = page.locator(".om-outline-wrap").first

        # Click the Aa button
        aa_btn = bar.locator(".aa-btn").first
        if aa_btn.count() == 0:
            aa_btn = bar.locator("button").filter(has_text=re.compile(r"^Aa$")).first

        self.check("Aa format button exists", aa_btn.count() > 0)
        if aa_btn.count() == 0:
            return

        drawer = page.locator(".mobile-format-drawer").first
        initially_open = drawer.count() > 0 and drawer.is_visible()

        if initially_open:
            # It was already expanded: click to collapse first, then click to expand to verify two-way toggling
            aa_btn.click()
            page.wait_for_timeout(400)
            collapsed_ok = drawer.count() == 0 or not drawer.is_visible()
            self.check("clicking Aa successfully collapses the format drawer", collapsed_ok)
            aa_btn.click()
            page.wait_for_timeout(400)
            drawer_visible = drawer.count() > 0 and drawer.is_visible()
            self.check("clicking Aa again successfully re-expands the format drawer", drawer_visible)
        else:
            # It was not expanded: click to expand
            aa_btn.click()
            page.wait_for_timeout(500)
            drawer_visible = drawer.count() > 0 and drawer.is_visible()
            self.check("format drawer expands successfully after clicking Aa", drawer_visible)

        self.shot("04_drawer_open", page)

        if drawer.count() > 0 and drawer.is_visible():
            # With the drawer expanded the toolbar grows taller; verify the outline's lower edge still avoids it automatically
            wb = wrap.bounding_box()
            bb = bar.bounding_box()
            if wb and bb:
                wrap_bottom = wb["y"] + wb["height"]
                bar_top = bb["y"]
                self.check(
                    "with the format drawer expanded, the outline viewport adapts to avoid the added drawer height",
                    wrap_bottom <= bar_top + 2.0,
                    f"outline bottom={wrap_bottom:.1f}, overall top={bar_top:.1f}"
                )

    def scenario_dismiss(self, page):
        """Scenario 5: clicking the done button dismisses the soft keyboard."""
        print("\n--- Scenario 5: clicking the done button to dismiss the soft keyboard ---")
        bar = page.locator(".mobile-keyboard-bar").first
        done_btn = bar.locator(".done-btn").first

        self.check("done check button exists", done_btn.count() > 0)
        if done_btn.count() == 0:
            return

        done_btn.click()
        page.wait_for_timeout(1000)

        # Check whether the keyboard state has been cleared
        is_kb_open = bar.evaluate("el => el.classList.contains('keyboard-open')")
        self.check("keyboard-open state is cleared after clicking the done button", not is_kb_open)

        cur_bar_box = bar.bounding_box()
        if cur_bar_box:
            # The toolbar returns to the bottom of the viewport
            bottom_style = bar.evaluate("el => el.style.bottom || '0px'")
            self.check("toolbar bottom edge returns flush with the bottom", bottom_style in ("0px", "0", ""), f"style.bottom={bottom_style}")

        self.shot("05_after_dismiss", page)

    def scenario_scroll(self, page):
        """Scenario 6: outline scroll boundary test (no lower-edge bleed-through when scrolled to the bottom)."""
        print("\n--- Scenario 6: outline scroll bottom boundary ---")
        wrap = page.locator(".om-outline-wrap").first
        bar = page.locator(".mobile-keyboard-bar").first

        # Scroll to the bottom
        page.evaluate("""() => {
            const w = document.querySelector('.om-outline-wrap');
            if (w) w.scrollTop = w.scrollHeight;
        }""")
        page.wait_for_timeout(500)

        self.shot("06_scrolled_max", page)

        wb = wrap.bounding_box()
        bb = bar.bounding_box()
        last_row = page.locator(".node-row").last
        lb = last_row.bounding_box() if last_row.count() > 0 else None

        if wb and bb:
            wrap_bottom = wb["y"] + wb["height"]
            bar_top = bb["y"]
            self.check(
                "when scrolled to the very bottom, the container's lower edge never exceeds the toolbar's upper edge",
                wrap_bottom <= bar_top + 1.5,
                f"outline container bottom={wrap_bottom:.1f}, toolbar top={bar_top:.1f}"
            )

        if lb and bb:
            last_node_bottom = lb["y"] + lb["height"]
            bar_top = bb["y"]
            self.check(
                "when scrolled to the very bottom, the last node lies entirely above the toolbar",
                last_node_bottom <= bar_top + 2.0,
                f"last node bottom={last_node_bottom:.1f}, toolbar top={bar_top:.1f}"
            )


def _siyuan_alive(host, port):
    """Probes once from the host side whether SiYuan is running. Used only to **report an error**, not to pick a port."""
    import urllib.request as _u
    for path in ("/api/system/version", "/"):
        try:
            with _u.urlopen(f"http://{host}:{port}{path}", timeout=3) as r:
                if r.status in (200, 302):
                    return True
        except Exception:
            pass
    return False


# Use an environment variable to mark 'the interpreter has already been switched', avoiding infinite exec when PYTHON points at the wrong thing
_REEXEC_FLAG = "OM_ANDROID_REEXEC"


def _die_no_playwright(reason):
    raise SystemExit(
        "python playwright is missing (%s).\n\n"
        "The CDP assertions need it to connect to the phone browser's DevTools. Install it on any interpreter,\n"
        "then write that interpreter's path into PYTHON in .env:\n\n"
        "    PYTHON=/path/to/python3\n\n"
        "First find which interpreter already has it:\n\n"
        "    for p in python3 /usr/bin/python3 ~/miniforge3/bin/python3; do\n"
        "      $p -c 'import playwright' 2>/dev/null && echo \"$p works\"\n"
        "    done\n\n"
        "Current interpreter: %s\n"
        "(measured on this machine: only the miniforge one has it, the system python3 does not)" % (reason, sys.executable)
    )


def _import_playwright():
    """Imports playwright; if the current interpreter lacks it, re-run with another one from `PYTHON` in `.env`.

    ★ Why the script must switch interpreters itself:
      `npm run verify:android` uses the `python3` on PATH, and npm **cannot read**
      `.env` —— there is no way to specify it at the entry point. So 'which python to run with' can only be solved here.

    ★ Why this pitfall used to be invisible:
      Running only `--scenario shot` (or `setup`) **does not go through CDP and does not import playwright**,
      yet it still prints success. So 'take a screenshot' is always green and looks like the tool is fine,
      and it only blows up when the assertions are actually run.

    ★ Switch only once: if the interpreter we switched to still lacks playwright, report the error outright and
      explain how to configure it, without a second exec (otherwise a misconfigured PYTHON recurses forever).
    """
    try:
        from playwright.sync_api import sync_playwright
        return sync_playwright
    except ModuleNotFoundError:
        pass

    target = cfg.python
    if os.environ.get(_REEXEC_FLAG):
        _die_no_playwright("already ran once with the interpreter PYTHON points at, and it still does not have it")
    if not target or os.path.realpath(target) == os.path.realpath(sys.executable):
        _die_no_playwright("PYTHON is not configured, and the current interpreter is the one it would name" if target else "PYTHON is not configured")

    # ★ flush is mandatory: `os.execve` **replaces the whole process image** and will not flush buffers for you.
    #   When stdout is a pipe it is block-buffered, so without flush this line is simply dropped
    #   ——'silently switched interpreters', and when something goes wrong you cannot tell that anything happened.
    #   (measured: this is how it was written at first — 20/20 green yet not one line of the notice was printed.)
    print(f"ℹ️  current interpreter {sys.executable} has no playwright, re-executing with PYTHON={target}", flush=True)
    os.execve(
        target,
        [target, os.path.abspath(__file__), *sys.argv[1:]],
        {**os.environ, _REEXEC_FLAG: "1"},
    )


def main():
    parser = argparse.ArgumentParser(
        description="Android + CDP joint automated verification script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--serial", "-s", default="", help="ADB device serial (read from .env by default, otherwise auto-detected)")
    parser.add_argument("--browser-pkg", "-p", default="", help="browser package name (defaults to com.brave.browser)")
    parser.add_argument("--cdp-port", type=int, default=0, help="CDP debug port forwarded to this machine (defaults to 9222)")
    parser.add_argument("--siyuan-port", type=int, default=0, help="SiYuan port (defaults to SIYUAN_TEST_PORT from .env; ★ never falls back to the user instance)")
    parser.add_argument("--siyuan-host", default=cfg.siyuan_host,
                        help="hostname used from the host side to reach SiYuan (defaults to SIYUAN_HOST from .env). Note this is used only for **host-side** probing; the phone side goes through adb reverse, see DEVICE_LOOPBACK")
    parser.add_argument("--scenario", "-c", default="all",
                        choices=["all", "setup", "idle", "keyboard", "type", "drawer", "dismiss", "scroll", "shot"],
                        help="scenario to run: all(full) / idle / keyboard / type / drawer / dismiss / scroll / setup / shot")
    parser.add_argument("--output-dir", "-o", default=".tmp/android-test", help="output directory for screenshots and artifacts")
    parser.add_argument("--text", default="native_mindmap_test", help="test content for the text input scenario")
    parser.add_argument("--skip-setup", action="store_true", help="skip the ADB reverse / forward port forwarding steps")
    parser.add_argument("--keep-open", action="store_true", help="keep the browser connection open after the test finishes")
    parser.add_argument("--json", action="store_true", help="output the test report as JSON")
    parser.add_argument("--verbose", "-v", action="store_true", help="print detailed debug logs")

    args = parser.parse_args()

    # 1. Determine the port arguments
    # Ports have exactly one source (.env or an explicit argument) —— no probing, no downgrade to the user instance.
    cdp_port = args.cdp_port or cfg.android_cdp_port
    siyuan_port = args.siyuan_port or cfg.siyuan_test_port

    if siyuan_port == cfg.siyuan_port:
        print(f"  ⚠️  {siyuan_port} is the user instance, not the isolated test instance; this suite really creates and deletes documents.")

    if not _siyuan_alive(args.siyuan_host, siyuan_port):
        raise SystemExit(
            f"SiYuan is not running on {args.siyuan_host}:{siyuan_port} (the isolated test instance).\n"
            f"  Start it: python3 scripts/test-instance.py\n"
            f"  The port comes from SIYUAN_TEST_PORT in .env and can also be set with --siyuan-port.\n"
            f"★ Not falling back to {cfg.siyuan_port} (the user instance) —— the tests create and delete documents there."
        )

    # 2. Initialize the ADB Bridge
    bridge = AndroidBridge(serial=args.serial, browser_pkg=args.browser_pkg, verbose=args.verbose)

    # 3. Port-setup-only and launch mode
    if not args.skip_setup:
        bridge.setup_port_forwarding(siyuan_port=siyuan_port, cdp_port=cdp_port)

    if args.scenario == "setup":
        bridge.launch_browser()
        print(f"✅ ADB port forwarding and browser environment configured:")
        print(f"  · SiYuan reverse: phone {DEVICE_LOOPBACK}:{siyuan_port} -> host {args.siyuan_host}:{siyuan_port}")
        print(f"  · CDP forward   : host {cfg.cdp_host}:{cdp_port} -> phone DevTools")
        return 0

    if args.scenario == "shot":
        out = os.path.join(args.output_dir, "manual_shot.png")
        bridge.screencap(out)
        print(f"✅ real-device screenshot saved: {out}")
        return 0

    # 4. Run the Playwright-based CDP automation tests
    sync_playwright = _import_playwright()

    verifier = AndroidVerifier(
        bridge=bridge,
        siyuan_port=siyuan_port,
        cdp_port=cdp_port,
        out_dir=args.output_dir,
        verbose=args.verbose,
    )

    start_time = time.time()
    print("=" * 65)
    print("🚀 starting Android + CDP joint automated verification")
    print(f"  · ADB device  : {bridge.serial}")
    print(f"  · browser pkg : {bridge.browser_pkg}")
    print(f"  · SiYuan port : {siyuan_port}")
    print(f"  · CDP port    : {cdp_port}")
    print(f"  · scenario    : {args.scenario}")
    print(f"  · screenshots : {args.output_dir}")
    print("=" * 65)

    browser = None
    all_ok = True
    try:
        with sync_playwright() as p:
            browser, page = verifier.connect_and_prepare_page(p)

            if args.scenario in ("all", "idle"):
                verifier.scenario_idle(page)
            if args.scenario in ("all", "keyboard"):
                verifier.scenario_keyboard(page)
            if args.scenario in ("all", "type"):
                verifier.scenario_type(page, sample_text=args.text)
            if args.scenario in ("all", "drawer"):
                verifier.scenario_drawer(page)
            if args.scenario in ("all", "dismiss"):
                verifier.scenario_dismiss(page)
            if args.scenario in ("all", "scroll"):
                verifier.scenario_scroll(page)

            if not args.keep_open and browser:
                browser.close()
    except Exception as e:
        print(f"\n❌ an exception was raised during execution: {e}")
        all_ok = False
        if args.verbose:
            import traceback
            traceback.print_exc()

    duration = time.time() - start_time
    passes = sum(1 for r in verifier.results if r["ok"])
    fails = sum(1 for r in verifier.results if not r["ok"])
    if fails > 0:
        all_ok = False

    print("\n" + "=" * 65)
    print("📋 verification summary and assertion results:")
    print(f"  passed: {passes} | failed: {fails} | total time: {duration:.2f} s")
    print(f"  all screenshots written to disk: {args.output_dir}/")
    print("=" * 65)

    if args.json:
        report = {
            "device": bridge.serial,
            "browser_pkg": bridge.browser_pkg,
            "siyuan_port": siyuan_port,
            "cdp_port": cdp_port,
            "duration_sec": duration,
            "passed": passes,
            "failed": fails,
            "results": verifier.results,
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))

    return 0 if (all_ok and fails == 0) else 1


if __name__ == "__main__":
    with script_log.track("verify-android"):
        sys.exit(main())

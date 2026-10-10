#!/usr/bin/env python3
"""Bazaar package check: version-number consistency + every file reference in plugin.json really exists in package.zip.
The same class of problem as CI error [01] readme.zh_CN."""
import json, pathlib, script_log, sys, zipfile
with script_log.track("verify-pkg"):
    z = zipfile.ZipFile('package.zip')
    names = set(z.namelist())
    try:
        d = json.loads(z.read('plugin.json').decode('utf-8'))
    except KeyError:
        print("  ❌ package.zip has no plugin.json"); sys.exit(1)

    bad = 0

    # ★ The version number must agree in three places (added).
    #   Measured, hit this: only package.json was changed and then a tag was made and a Release prepared,
    #   while dist-plugin/plugin.json is a **derived artifact** copied from src/plugin/plugin.json at build time
    #   (rsbuild.config.ts:33), so editing it gets overwritten by the next build.
    #   The result was package.zip holding the old version number while the tag / Release named the new one —— the package sent out was wrong.
    #   package.json and src/plugin/plugin.json must be changed together; this is what stops a missed change.
    print("version")
    pkg_ver = json.loads(pathlib.Path('package.json').read_text(encoding='utf-8'))['version']
    src_ver = json.loads(pathlib.Path('src/plugin/plugin.json').read_text(encoding='utf-8'))['version']
    zip_ver = d['version']
    for label, a, b in [('package.json ↔ src/plugin.json', pkg_ver, src_ver),
                        ('package.json ↔ package.zip', pkg_ver, zip_ver)]:
        hit = a == b
        print(f"  {label:<34} {a} / {b}  {'✅' if hit else '❌ mismatch'}")
        bad += not hit

    checks = [(f'readme.{k}', v) for k, v in (d.get('readme') or {}).items()]
    for f in ('icon', 'preview'):
        if d.get(f): checks.append((f, d[f]))

    print()
    for label, path in checks:
        hit = path in names or f'./{path}' in names
        print(f"  {label:<16} → {path:<22} {'✅' if hit else '❌ not in the package'}")
        bad += not hit
    for f in ('plugin.json',):
        print(f"  {'required':<14} → {f:<22} ✅")

    # Bazaar hard requirements
    print()
    for f, why in [('index.js','entry'), ('index.css','style')]:
        hit = f in names
        print(f"  {why:<16} → {f:<22} {'✅' if hit else '❌ missing'}")
        bad += not hit

    print()
    print("  " + ("✅ Checks passed, ready to release" if not bad else f"❌ Found {bad} problems, do not release"))
    sys.exit(1 if bad else 0)

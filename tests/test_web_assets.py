"""
Tests for frontend web assets (HTML, JS, CSS).

Ensures that:
- JavaScript files in `web/` have valid syntax (caught via `node -c`).
- All script tags and stylesheets referenced in `web/index.html` exist on disk.
- JavaScript files do not contain unterminated braces, brackets, or syntax defects.
"""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = REPO_ROOT / "web"


def test_web_directory_exists():
    assert WEB_DIR.is_dir(), f"web directory missing at {WEB_DIR}"
    assert (WEB_DIR / "index.html").is_file()
    assert (WEB_DIR / "app.js").is_file()


def test_js_syntax():
    """Verify JavaScript syntax of all JS files in web/ using `node -c`."""
    node_bin = shutil.which("node") or shutil.which("nodejs")
    if not node_bin:
        pytest.skip("node.js not installed on PATH, skipping node -c syntax check")

    js_files = list(WEB_DIR.glob("*.js"))
    assert js_files, "No JS files found in web/"

    errors = []
    for js_file in js_files:
        # Don't fail if 3rd-party minified vendor libs have special features
        # but app.js must always be strictly valid.
        res = subprocess.run(
            [node_bin, "-c", str(js_file)],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            errors.append(f"{js_file.name}: {res.stderr.strip()}")

    assert not errors, "JavaScript syntax errors found:\n" + "\n".join(errors)


def test_index_html_asset_references():
    """Verify that all /static/ files referenced in index.html actually exist."""
    index_html = (WEB_DIR / "index.html").read_text(encoding="utf-8")

    import re

    # Match src="/static/..." and href="/static/..."
    refs = re.findall(r'(?:src|href)="/static/([^"?#]+)', index_html)
    assert refs, "Expected static references in index.html"

    missing = []
    for ref in set(refs):
        target = WEB_DIR / ref
        if not target.is_file():
            missing.append(ref)

    assert not missing, f"index.html references non-existent static assets: {missing}"


def test_app_js_basic_sanity():
    """Verify app.js is non-empty and has essential bootstrap components."""
    app_js = (WEB_DIR / "app.js").read_text(encoding="utf-8")
    assert len(app_js) > 1000, "web/app.js is unexpectedly small or empty"

    # Ensure crucial event handlers and initialization functions are present
    assert "async function boot()" in app_js
    assert "function connectWs()" in app_js
    assert "applyStatus(" in app_js

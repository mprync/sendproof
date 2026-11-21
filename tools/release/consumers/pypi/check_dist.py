"""Inspect the wheels and sdists that tools/release/pypi.mjs built.

Usage: check_dist.py <dist-dir> <semver> <pep440> <repository-url>

Fails (exit 1, one line per problem) unless every package has a wheel and an sdist whose metadata is
complete: version, licence, README, authors, keywords, project URLs, classifiers and an exact pin on
sendproof-core, plus py.typed, the LICENSE file and, for sendproof-core, the embedded UI bundle.
"""

from __future__ import annotations

import json
import sys
import tarfile
import zipfile
from email import message_from_string
from pathlib import Path

PACKAGES = {
    "sendproof-core": "core",
    "sendproof-sqlalchemy": "sqlalchemy",
    "sendproof-fastapi": "fastapi",
    "sendproof-flask": "flask",
    "sendproof-django": "django",
}
UI_FILES = ("manifest.json", "index.html", "app.js", "styles.css")


def main(dist: Path, semver: str, version: str, repository: str) -> list[str]:
    problems: list[str] = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    expected = {f"{name.replace('-', '_')}-{version}{suffix}" for name in PACKAGES for suffix in ("-py3-none-any.whl", ".tar.gz")}
    found = {path.name for path in dist.iterdir()}
    check(found == expected, f"expected exactly {sorted(expected)}, found {sorted(found)}")

    for name, folder in PACKAGES.items():
        module = name.replace("-", "_")
        label = f"{name} {version}"
        wheel_path = dist / f"{module}-{version}-py3-none-any.whl"
        sdist_path = dist / f"{module}-{version}.tar.gz"
        if not wheel_path.is_file() or not sdist_path.is_file():
            continue

        with zipfile.ZipFile(wheel_path) as wheel:
            names = wheel.namelist()
            info = f"{module}-{version}.dist-info"
            metadata = message_from_string(wheel.read(f"{info}/METADATA").decode("utf-8"))
            check(f"{module}/py.typed" in names, f"{label}: wheel has no {module}/py.typed")
            check(f"{module}/__init__.py" in names, f"{label}: wheel has no {module}/__init__.py")
            check(any(n.startswith(f"{info}/licenses/") and n.endswith("LICENSE") for n in names), f"{label}: wheel has no LICENSE under {info}/licenses/")
            check(not any("__pycache__" in n or n.endswith(".pyc") or "/tests/" in n or n.startswith("tests/") for n in names), f"{label}: wheel contains caches or tests")
            if name == "sendproof-core":
                for ui in UI_FILES:
                    check(f"{module}/ui/{ui}" in names, f"{label}: wheel has no {module}/ui/{ui}")
                if f"{module}/ui/manifest.json" in names:
                    bundle = json.loads(wheel.read(f"{module}/ui/manifest.json"))
                    check(bundle.get("version") == semver, f"{label}: UI manifest version {bundle.get('version')!r} is not {semver}")
                    check(all(f"{module}/ui/{file}" in names for file in bundle["files"]), f"{label}: wheel lacks files its UI manifest lists")
            else:
                check(not any(n.startswith(f"{module}/ui/") for n in names), f"{label}: wheel unexpectedly bundles a UI")
            version_line = [line for line in wheel.read(f"{module}/__init__.py").decode("utf-8").splitlines() if line.startswith("__version__")]
            check(version_line == [f'__version__ = "{version}"'], f"{label}: __version__ is {version_line}, not stamped")

        check(metadata["Metadata-Version"] >= "2.4", f"{label}: metadata version {metadata['Metadata-Version']} predates PEP 639")
        check(metadata["Name"] == name, f"{label}: Name is {metadata['Name']}")
        check(metadata["Version"] == version, f"{label}: Version is {metadata['Version']}")
        check(metadata["License-Expression"] == "MIT", f"{label}: License-Expression is {metadata['License-Expression']}")
        check("LICENSE" in (metadata.get_all("License-File") or []), f"{label}: no License-File: LICENSE")
        check(metadata["Requires-Python"] == ">=3.10", f"{label}: Requires-Python is {metadata['Requires-Python']}")
        check("Sendproof contributors" in (metadata["Author"] or "") + (metadata["Author-email"] or ""), f"{label}: authors are missing")
        check(metadata["Description-Content-Type"] == "text/markdown", f"{label}: README content type is {metadata['Description-Content-Type']}")
        check(len(metadata.get_payload() or "") > 200, f"{label}: README is not embedded")
        check(len(metadata["Summary"] or "") > 20, f"{label}: summary is missing")
        check(len((metadata["Keywords"] or "").split(",")) >= 4, f"{label}: keywords are missing")
        check("Typing :: Typed" in (metadata.get_all("Classifier") or []), f"{label}: no Typing :: Typed classifier")
        check("Development Status :: 3 - Alpha" in (metadata.get_all("Classifier") or []), f"{label}: no Development Status classifier")
        urls = dict(entry.split(", ", 1) for entry in metadata.get_all("Project-URL") or [])
        home = f"{repository}/tree/main/adapters/python/{folder}"
        check(urls == {"Homepage": home, "Repository": repository, "Issues": f"{repository}/issues", "Changelog": f"{repository}/blob/main/CHANGELOG.md"},
              f"{label}: Project-URL is {urls}")
        requires = metadata.get_all("Requires-Dist") or []
        if name == "sendproof-core":
            # Only the optional data-store client extras (redis, dynamodb, mongodb) may add requirements.
            required = [entry for entry in requires if "extra ==" not in entry]
            check(not required, f"{label}: core must have no dependencies, has {required}")
            extras = sorted(metadata.get_all("Provides-Extra") or [])
            check(extras == ["dynamodb", "mongodb", "redis"], f"{label}: data-store extras are {extras}")
        else:
            check(f"sendproof-core=={version}" in requires, f"{label}: Requires-Dist lacks sendproof-core=={version}: {requires}")

        with tarfile.open(sdist_path) as sdist:
            members = {member.name for member in sdist.getmembers()}
            top = f"{module}-{version}"
            for required in ("PKG-INFO", "pyproject.toml", "LICENSE", "README.md", f"src/{module}/__init__.py", f"src/{module}/py.typed"):
                check(f"{top}/{required}" in members, f"{label}: sdist has no {required}")
            if name == "sendproof-core":
                for ui in UI_FILES:
                    check(f"{top}/src/{module}/ui/{ui}" in members, f"{label}: sdist has no ui/{ui}")
            pkg_info = message_from_string(sdist.extractfile(f"{top}/PKG-INFO").read().decode("utf-8"))
            check(pkg_info["Version"] == version, f"{label}: sdist PKG-INFO version is {pkg_info['Version']}")
            check(not any("__pycache__" in m or m.endswith(".pyc") for m in members), f"{label}: sdist contains caches")
    return problems


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    issues = main(Path(sys.argv[1]), *sys.argv[2:])
    for issue in issues:
        print(f"error: {issue}", file=sys.stderr)
    print(f"checked {len(PACKAGES)} packages: {'FAILED' if issues else 'ok'}")
    raise SystemExit(1 if issues else 0)

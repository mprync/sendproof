"""Check the release archives and exercise the Treasury example as a NuGet consumer."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
HOST = "Sendproof.AspNetCore"
EF = "Sendproof.EntityFrameworkCore"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect_package(path):
    with ZipFile(path) as archive:
        names = archive.namelist()
        manifests = [name for name in names if name.endswith(".nuspec")]
        require(len(manifests) == 1, f"Missing or ambiguous manifest in {path.name}")
        metadata = ET.fromstring(archive.read(manifests[0])).find("{*}metadata")
        package_id = metadata.findtext("{*}id")
        version = metadata.findtext("{*}version")
        require(package_id in (HOST, EF), f"Unexpected package {package_id}")
        require(path.name == f"{package_id}.{version}.nupkg", f"Wrong filename {path}")
        require(metadata.findtext("{*}license") == "MIT", f"Missing MIT license in {path.name}")
        require(metadata.findtext("{*}readme") in names, f"Missing packaged README in {path.name}")
        icon = metadata.findtext("{*}icon")
        require(icon in names and archive.read(icon) == (ROOT / "docs/package-icon.png").read_bytes(),
                f"Missing or incorrect gallery icon in {path.name}")
        assembly = f"lib/net10.0/{package_id}"
        for extension in (".dll", ".xml"):
            require(assembly + extension in names, f"Missing {assembly}{extension}")
        if package_id == EF:
            dep = metadata.find(f".//{{*}}dependency[@id='{HOST}']")
            require(dep is not None and dep.get("version") in (version, f"[{version}]"),
                    f"EF package must depend on the matching {HOST} version")
        repository = metadata.find("{*}repository")
        # tools/pack-all.mjs passes the canonical repository (from adapters/go/MODULE_PATH).
        expected = os.getenv("REPOSITORY_URL")
        if expected:
            require(repository is not None and repository.get("url", "").removesuffix(".git") == expected,
                    f"Package repository must be {expected}")
        if os.getenv("GITHUB_ACTIONS") == "true":
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
            require(repository.get("commit") == head, f"Package must identify commit {head}")
    with ZipFile(path.with_suffix(".snupkg")) as symbols:
        require(assembly + ".pdb" in symbols.namelist(), f"Missing symbols for {package_id}")
    return package_id, version


def copy_consumer(destination, version):
    # Use the same application and acceptance assertions contributors run from source.
    shutil.copytree(ROOT / "examples/TreasuryApi", destination,
                    ignore=shutil.ignore_patterns("bin", "obj", "*.db*", "TestResults"))
    project = destination / "TreasuryApi.csproj"
    tree = ET.parse(project)
    found = set()
    for ref in tree.iter("ProjectReference"):
        package_id = Path(ref.attrib["Include"]).stem
        require(package_id in (HOST, EF), f"Unexpected sample project reference {package_id}")
        ref.tag = "PackageReference"
        ref.attrib = {"Include": package_id, "Version": f"[{version}]"}
        found.add(package_id)
    require(found == {HOST, EF}, "Consumer must reference both archives")
    tree.write(project, encoding="utf-8")


def write_config(path, packages, dependencies):
    config = ET.Element("configuration")
    sources = ET.SubElement(config, "packageSources")
    ET.SubElement(sources, "clear")
    mapping = ET.SubElement(config, "packageSourceMapping")
    for key, source, patterns in (("release", str(packages), (HOST, EF)),
                                  ("dependencies", dependencies, ("*",))):
        ET.SubElement(sources, "add", key=key, value=source)
        entry = ET.SubElement(mapping, "packageSource", key=key)
        for pattern in patterns:
            ET.SubElement(entry, "package", pattern=pattern)
    ET.ElementTree(config).write(path, encoding="utf-8")


def check(packages, dependencies):
    archives = sorted(packages.glob("*.nupkg"))
    require(len(archives) == 2, f"Expected exactly two release packages in {packages}")
    versions = dict(inspect_package(path) for path in archives)
    require(set(versions) == {HOST, EF} and len(set(versions.values())) == 1,
            f"Expected a matching pair, got {versions}")
    with tempfile.TemporaryDirectory(prefix="sendproof-consumer-") as directory:
        temp = Path(directory).resolve()
        app = temp / "TreasuryApi"
        copy_consumer(app, versions[HOST])
        config = temp / "NuGet.Config"
        write_config(config, packages, dependencies or "https://api.nuget.org/v3/index.json")
        project = app / "tests/TreasuryApi.Tests.csproj"
        # A private cache prevents a previously installed build with this version masking the archive.
        restore = ["dotnet", "restore", str(project), "--configfile", str(config),
                   "--packages", str(temp / "packages"), "-m:1"]
        if dependencies:
            restore.append("-p:NuGetAudit=false")
        subprocess.run(restore, cwd=temp, check=True)
        subprocess.run(["dotnet", "build", str(project), "-c", "Release", "--no-restore",
                        "-m:1", "-nr:false", "-p:UseSharedCompilation=false", "-warnaserror"],
                       cwd=temp, check=True)
        subprocess.run(["dotnet", str(app / "tests/bin/Release/net10.0/TreasuryApi.Tests.dll")],
                       cwd=temp, check=True)
    print(f"Verified packages, symbols and consumer for {versions[HOST]}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", type=Path, help="Directory with the two packages and their symbols")
    parser.add_argument("--dependency-feed", type=Path, help="Local offline feed for third-party dependencies")
    args = parser.parse_args()
    check(args.packages.resolve(), str(args.dependency_feed.resolve()) if args.dependency_feed else None)

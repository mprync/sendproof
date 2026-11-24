"""Check the release archives and exercise the Acme Store example as a NuGet consumer."""

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
# Data-store guards: each depends on the host package and brings in the store's client library.
STORES = ("Sendproof.Redis", "Sendproof.MongoDB", "Sendproof.DynamoDB", "Sendproof.Cassandra", "Sendproof.Elasticsearch",
          "Sendproof.OpenSearch", "Sendproof.CosmosDb", "Sendproof.Firestore")
# Typed journeys, with their operations generator inside as an analyzer, and the xUnit suite that runs them.
JOURNEYS = ("Sendproof.Journeys", "Sendproof.Journeys.Testing")
GENERATOR = "Sendproof.Journeys.Generators"
PACKAGES = (HOST, EF, *STORES, *JOURNEYS)


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
        require(package_id in PACKAGES, f"Unexpected package {package_id}")
        require(path.name == f"{package_id}.{version}.nupkg", f"Wrong filename {path}")
        require(metadata.findtext("{*}license") == "MIT", f"Missing MIT license in {path.name}")
        require(metadata.findtext("{*}readme") in names, f"Missing packaged README in {path.name}")
        icon = metadata.findtext("{*}icon")
        require(icon in names and archive.read(icon) == (ROOT / "docs/package-icon.png").read_bytes(),
                f"Missing or incorrect gallery icon in {path.name}")
        assembly = f"lib/net10.0/{package_id}"
        for extension in (".dll", ".xml"):
            require(assembly + extension in names, f"Missing {assembly}{extension}")
        require(metadata.findtext("{*}description"), f"Missing description in {path.name}")
        if package_id != HOST:
            # Each package reaches the host directly or through another Sendproof package, always at this version.
            deps = [d for d in metadata.findall(".//{*}dependency") if d.get("id", "").startswith("Sendproof.")]
            require(deps, f"{package_id} must depend on {HOST} or another Sendproof package")
            for dep in deps:
                require(dep.get("version") in (version, f"[{version}]"),
                        f"{package_id} must depend on the matching {dep.get('id')} version")
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
    shutil.copytree(ROOT / "examples/StoreApi", destination,
                    ignore=shutil.ignore_patterns("bin", "obj", "*.db*", "*.keys", "TestResults"))
    found = set()
    for project in (destination / "StoreApi.csproj", destination / "tests/StoreApi.Tests.csproj"):
        tree = ET.parse(project)
        for group in tree.iter("ItemGroup"):
            for ref in list(group.findall("ProjectReference")):
                package_id = Path(ref.attrib["Include"]).stem
                if package_id == "StoreApi":
                    continue
                if package_id == GENERATOR:
                    # The generator comes with the Sendproof.Journeys package.
                    group.remove(ref)
                    continue
                # The sample also wires the optional data-store guards (Redis, MongoDB, DynamoDB); each is restored from its archive.
                require(package_id in PACKAGES, f"Unexpected sample project reference {package_id}")
                ref.tag = "PackageReference"
                ref.attrib = {"Include": package_id, "Version": f"[{version}]"}
                found.add(package_id)
        tree.write(project, encoding="utf-8")
    require({HOST, EF, *JOURNEYS} <= found, "Consumer must reference the host, EF Core and journeys archives")


def check_store_consumer(directory, version):
    """An application that registers every data-store guard from the archives (restore, build, run)."""
    directory.mkdir()
    refs = "\n    ".join(f'<PackageReference Include="{name}" Version="[{version}]" />' for name in (HOST, *STORES))
    (directory / "StoreConsumer.csproj").write_text(f"""<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    {refs}
  </ItemGroup>
</Project>
""", encoding="utf-8")
    (directory / "Program.cs").write_text("""using Sendproof.AspNetCore;
using Sendproof.Cassandra;
using Sendproof.CosmosDb;
using Sendproof.DynamoDB;
using Sendproof.Elasticsearch;
using Sendproof.Firestore;
using Sendproof.MongoDB;
using Sendproof.OpenSearch;
using Sendproof.Redis;
using MongoDB.Driver;

var builder = WebApplication.CreateBuilder(args);
// A MongoClient connects lazily, so no server is needed to register and resolve it.
builder.Services.AddSingleton<IMongoClient>(new MongoClient("mongodb://127.0.0.1:27017"));
builder.Services.AddSendproof()
    .WithApiName("Store consumer")
    .AddMongoDB(mongo => mongo.WithName("catalog"))
    .AddRedis(redis => redis.WithName("cache").WithoutDecoratingTheRegisteredMultiplexer())
    .AddDynamoDB(dynamo => dynamo.WithName("orders"));
using var app = builder.Build();
// Every guard resolves from the container the way an application would use it.
_ = app.Services.GetRequiredService<RedisStore>();
_ = app.Services.GetRequiredService<IMongoClient>();
// The batch-two guards need a live client to register, so naming each one's public builder proves the
// package carries its assembly and that it compiles against the host package and the client library.
Type[] batchTwo = [typeof(CassandraStoreBuilder), typeof(ElasticsearchStoreBuilder), typeof(OpenSearchStoreBuilder),
    typeof(CosmosDbStoreBuilder), typeof(FirestoreStoreBuilder)];
foreach (var type in batchTwo) Console.WriteLine($"loaded {type.Assembly.GetName().Name}");
Console.WriteLine("data-store guards registered");
""", encoding="utf-8")


def write_config(path, packages, dependencies):
    config = ET.Element("configuration")
    sources = ET.SubElement(config, "packageSources")
    ET.SubElement(sources, "clear")
    mapping = ET.SubElement(config, "packageSourceMapping")
    for key, source, patterns in (("release", str(packages), PACKAGES),
                                  ("dependencies", dependencies, ("*",))):
        ET.SubElement(sources, "add", key=key, value=source)
        entry = ET.SubElement(mapping, "packageSource", key=key)
        for pattern in patterns:
            ET.SubElement(entry, "package", pattern=pattern)
    ET.ElementTree(config).write(path, encoding="utf-8")


def check(packages, dependencies):
    archives = sorted(packages.glob("*.nupkg"))
    require(len(archives) == len(PACKAGES), f"Expected exactly {len(PACKAGES)} release packages in {packages}")
    versions = dict(inspect_package(path) for path in archives)
    require(set(versions) == set(PACKAGES) and len(set(versions.values())) == 1,
            f"Expected {len(PACKAGES)} packages at one version, got {versions}")
    with tempfile.TemporaryDirectory(prefix="sendproof-consumer-") as directory:
        temp = Path(directory).resolve()
        app = temp / "StoreApi"
        copy_consumer(app, versions[HOST])
        config = temp / "NuGet.Config"
        write_config(config, packages, dependencies or "https://api.nuget.org/v3/index.json")
        project = app / "tests/StoreApi.Tests.csproj"
        # A private cache prevents a previously installed build with this version masking the archive.
        restore = ["dotnet", "restore", str(project), "--configfile", str(config),
                   "--packages", str(temp / "packages"), "-m:1"]
        if dependencies:
            restore.append("-p:NuGetAudit=false")
        subprocess.run(restore, cwd=temp, check=True)
        subprocess.run(["dotnet", "build", str(project), "-c", "Release", "--no-restore",
                        "-m:1", "-nr:false", "-p:UseSharedCompilation=false", "-warnaserror"],
                       cwd=temp, check=True)
        subprocess.run(["dotnet", str(app / "tests/bin/Release/net10.0/StoreApi.Tests.dll")],
                       cwd=temp, check=True)
        stores = temp / "StoreConsumer"
        check_store_consumer(stores, versions[HOST])
        restore = ["dotnet", "restore", str(stores), "--configfile", str(config),
                   "--packages", str(temp / "packages"), "-m:1"]
        if dependencies:
            restore.append("-p:NuGetAudit=false")
        subprocess.run(restore, cwd=temp, check=True)
        subprocess.run(["dotnet", "run", "--project", str(stores), "-c", "Release", "--no-restore"],
                       cwd=temp, check=True)
    print(f"Verified packages, symbols and consumer for {versions[HOST]}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", type=Path, help="Directory with the two packages and their symbols")
    parser.add_argument("--dependency-feed", type=Path, help="Local offline feed for third-party dependencies")
    args = parser.parse_args()
    check(args.packages.resolve(), str(args.dependency_feed.resolve()) if args.dependency_feed else None)

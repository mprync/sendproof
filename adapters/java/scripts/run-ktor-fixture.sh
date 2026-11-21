#!/bin/sh
# Starts the Ktor conformance fixture. PORT, BENCH_PATH_BASE and BENCH_SCENARIO come from the conformance runner.
# Build first with: sh adapters/java/scripts/gradle.sh :ktor-fixture:installDist
set -e
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/jdk.sh"
lib="$here/../../../examples/kotlin-ktor-fixture/build/install/ktor-fixture/lib"
if [ ! -d "$lib" ]; then
  echo "Fixture not built. Run: sh adapters/java/scripts/gradle.sh :ktor-fixture:installDist" >&2
  exit 1
fi
exec java -cp "$lib/*" io.github.mprync.sendproof.fixture.MainKt

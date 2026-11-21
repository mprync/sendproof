#!/bin/sh
# Starts the conformance fixture. PORT, BENCH_PATH_BASE and BENCH_SCENARIO come from the conformance runner.
# Build first with: sh adapters/java/scripts/gradle.sh :spring-fixture:bootJar
set -e
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/jdk.sh"
jar="$here/../../../examples/java-spring-fixture/build/libs/test-bench-java-fixture.jar"
if [ ! -f "$jar" ]; then
  echo "Fixture jar not found. Run: sh adapters/java/scripts/gradle.sh :spring-fixture:bootJar" >&2
  exit 1
fi
exec java -XX:TieredStopAtLevel=1 -jar "$jar"

#!/bin/sh
# Runs the project-local Gradle wrapper with a suitable JDK: sh adapters/java/scripts/gradle.sh <tasks...>
set -e
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/jdk.sh"
cd "$here/.."
# A project-local Gradle home keeps builds self-contained (and writable in sandboxes).
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$here/../.gradle-home}"
exec ./gradlew --console=plain "$@"

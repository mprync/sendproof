#!/bin/sh
# Selects a JDK 17 or newer and exports JAVA_HOME. Source this file; it never installs anything.
# Gradle 9 needs Java 17+, and the machine default is often older.

jdk_major() {
  "$1/bin/java" -version 2>&1 | sed -n '1s/.*version "\([0-9]*\)\(\.[0-9]*\)*.*/\1/p;1s/.*version "1\.\([0-9]*\).*/\1/p' | head -n 1
}

usable() {
  [ -x "$1/bin/java" ] && [ "$(jdk_major "$1")" -ge 17 ] 2>/dev/null
}

pick_jdk() {
  for candidate in \
    "${JAVA_HOME:-}" \
    /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
    "$HOME/.sdkman/candidates/java/current" \
    /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
    /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home \
    /usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
    /usr/lib/jvm/java-17-openjdk-amd64 \
    /usr/lib/jvm/temurin-17-jdk-amd64
  do
    [ -n "$candidate" ] && usable "$candidate" && { echo "$candidate"; return 0; }
  done
  if [ -x /usr/libexec/java_home ]; then
    for version in 17 21 25; do
      candidate="$(/usr/libexec/java_home -v "$version" 2>/dev/null)" && usable "$candidate" && { echo "$candidate"; return 0; }
    done
  fi
  # Gradle-provisioned JDKs, then whatever `java` is on PATH.
  for candidate in "$HOME"/.gradle/jdks/*/Contents/Home "$HOME"/.gradle/jdks/*; do
    usable "$candidate" && { echo "$candidate"; return 0; }
  done
  if command -v java >/dev/null 2>&1; then
    candidate="$(dirname "$(dirname "$(command -v java)")")"
    usable "$candidate" && { echo "$candidate"; return 0; }
  fi
  return 1
}

if ! JAVA_HOME="$(pick_jdk)"; then
  echo "Sendproof Java binding needs JDK 17 or newer. Set JAVA_HOME to one." >&2
  exit 1
fi
export JAVA_HOME
PATH="$JAVA_HOME/bin:$PATH"
export PATH

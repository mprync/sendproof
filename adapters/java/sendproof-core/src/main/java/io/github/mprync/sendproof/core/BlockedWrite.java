package io.github.mprync.sendproof.core;

/**
 * The first write the guard refused during a Preview. It names the command, never its arguments: keys and filters can
 * contain personal data.
 *
 * @param store     the store id, such as {@code redis}
 * @param operation the refused command or action name
 * @param detail    the sentence the workbench shows
 */
public record BlockedWrite(String store, String operation, String detail) {
}

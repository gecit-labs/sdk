/**
 * Where the CLI keeps your key.
 *
 * `RELAY_API_KEY` in the environment always wins. That is what CI sets, and a
 * config file quietly overriding it would make a machine behave differently from
 * the command a person ran to test it.
 *
 * The file is written 0600 and holds one key per base URL, so pointing at a
 * staging deployment does not overwrite the production key you logged in with an
 * hour ago — the failure that produces is "my commands started hitting the wrong
 * environment", which is slow to notice and unpleasant to explain.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface ConfigFile {
  /** base URL -> API key. */
  keys: Record<string, string>;
}

function configPath(): string {
  return join(process.env["RELAY_CONFIG_HOME"] ?? homedir(), ".relay", "config.json");
}

function read(): ConfigFile {
  const path = configPath();
  if (!existsSync(path)) return { keys: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigFile>;
    return { keys: parsed.keys ?? {} };
  } catch {
    // A corrupt config reads as "not logged in" rather than crashing every
    // command until someone finds the file.
    return { keys: {} };
  }
}

/**
 * Which deployment to talk to. No built-in default, for the same reason the SDK
 * has none: this CLI attaches a live API key to every request, and a fallback
 * host we do not own would leak it on the first misconfiguration.
 */
export function baseUrl(override?: string): string | undefined {
  const value = override ?? process.env["RELAY_BASE_URL"];
  return value ? value.replace(/\/+$/, "") : undefined;
}

/** The key for this base URL: env first, then the file. */
export function apiKey(base: string): string | undefined {
  const fromEnv = process.env["RELAY_API_KEY"];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return read().keys[base];
}

export function saveKey(base: string, key: string): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const config = read();
  config.keys[base] = key;
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // Explicit chmod as well as the mode flag: writeFileSync only applies mode
  // when it creates the file, so an existing 0644 config would stay 0644.
  chmodSync(path, 0o600);
  return path;
}

export function forgetKey(base: string): boolean {
  const config = read();
  if (!(base in config.keys)) return false;
  delete config.keys[base];
  const path = configPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return true;
}

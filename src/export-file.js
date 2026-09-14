/**
 * Export destination handling: resolve the export directory, pick a unique
 * file name, and write the document.
 *
 * The Harness home follows the same precedence the rest of DSH uses:
 * `$DSH_HOME` when set and non-blank, otherwise `~/.dsh`. `--out` overrides the
 * directory entirely.
 *
 * @module dsh-plugin-export-md/export-file
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileStamp, slugify } from './text.js';

/** Directory name under the harness home that holds exports. */
export const EXPORT_DIR_NAME = 'exports';

/**
 * Resolve the DeepSeek Harness home directory.
 * @param env - environment mapping (defaults to `process.env`).
 * @returns the absolute harness home path.
 */
export function resolveDshHome(env = process.env) {
  const configured = env?.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(expandHome(configured.trim()));
  return join(homedir(), '.dsh');
}

/**
 * Expand a leading `~` against the OS home directory.
 * @param path - a configured path that may start with `~`.
 * @returns the expanded path.
 */
export function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Describe a path in `~/.dsh/...` form, for display only.
 * @param path - the absolute path.
 * @param env - environment mapping.
 * @returns the display form.
 */
export function tildePath(path, env = process.env) {
  const home = resolveDshHome(env);
  const suffix = path === home ? '' : path.slice(home.length).replace(/^[/\\]/, '');
  return suffix === '' ? '~/.dsh' : `~/.dsh/${suffix}`;
}

/**
 * Resolve the default export directory.
 * @param env - environment mapping.
 * @returns `<harness home>/exports`.
 */
export function defaultExportDir(env = process.env) {
  return join(resolveDshHome(env), EXPORT_DIR_NAME);
}

/**
 * Resolve the target file for one export and prove it is writable.
 *
 * With `--out`, the argument is taken as the file path when it names a file
 * (or does not exist yet); an existing directory receives a generated name.
 * Otherwise the export directory receives `<stamp>-<slug>-<short id>.md`,
 * with a numeric suffix on collision.
 *
 * @param input - target inputs.
 * @param input.out - the `--out` value, when supplied.
 * @param input.title - the session title.
 * @param input.sessionId - the session id.
 * @param input.now - the export timestamp.
 * @param input.env - environment mapping for the default directory.
 * @returns `{ path, directory, created }` where `created` reports whether the directory was newly created.
 */
export async function resolveTarget({ out, title, sessionId, now, env = process.env }) {
  const slug = slugify(title ?? '', 48);
  const stamp = fileStamp(now);
  const shortId = typeof sessionId === 'string' ? sessionId.replace(/^session-/, '').slice(0, 8) : '';
  const generated = [stamp, slug === '' ? 'chat' : slug, shortId].filter((part) => part !== '').join('-');
  const fileName = `${generated}.md`;

  if (typeof out === 'string' && out.trim() !== '') {
    const requested = resolve(expandHome(out.trim()));
    let existingDirectory = false;
    try {
      existingDirectory = (await stat(requested)).isDirectory();
    } catch {
      existingDirectory = false;
    }
    if (existingDirectory) {
      await mkdir(requested, { recursive: true });
      return { path: join(requested, await uniquePath(requested, generated)), directory: requested, created: false };
    }
    const directory = dirname(requested);
    const created = await mkdir(directory, { recursive: true });
    return { path: requested, directory, created: created !== undefined };
  }

  const directory = defaultExportDir(env);
  const created = await mkdir(directory, { recursive: true });
  return { path: join(directory, await uniquePath(directory, generated)), directory, created: created !== undefined };
}

/**
 * Find a non-colliding `<name>.md` path.
 * @param directory - the directory to test.
 * @param base - the base name without extension (may contain path separators from a title — they are stripped).
 * @returns the chosen file name.
 */
async function uniquePath(directory, base) {
  const safe = basename(base) === '' ? 'chat' : basename(base);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? `${safe}.md` : `${safe}-${attempt + 1}.md`;
    try {
      await stat(join(directory, name));
    } catch {
      return name;
    }
  }
  return `${safe}-${Date.now()}.md`;
}

/**
 * Write the exported document.
 * @param path - the destination file path.
 * @param content - the Markdown document.
 * @returns the number of bytes written.
 */
export async function writeExport(path, content) {
  await writeFile(path, content, 'utf8');
  return Buffer.byteLength(content, 'utf8');
}

/**
 * Describe a path relative to the harness home, for a compact answer line.
 * @param path - the absolute path.
 * @param env - environment mapping.
 * @returns the `~/.dsh/...` display form when the path lives under the home, else the absolute path.
 */
export function displayPath(path, env = process.env) {
  const home = resolveDshHome(env);
  if (isAbsolute(path) && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))) {
    return tildePath(path, env);
  }
  return path;
}

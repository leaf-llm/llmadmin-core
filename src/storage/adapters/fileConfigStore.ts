import {
  ConfigConflictError,
  type ConfigStore,
  type LoadedConfig,
  type UnifiedConfig,
} from '../configStore';

/**
 * Local-development / desktop driver: a single JSON file on disk.
 *
 * Writes are atomic (write a sibling temp file, then rename) so the Node
 * process never observes a half-written document. The version is derived from
 * mtime + size, which is enough to detect external edits and to reject stale
 * conditional writes.
 */
export class FileConfigStore implements ConfigStore {
  readonly driver = 'file' as const;
  readonly readOnly = false;

  constructor(private readonly filePath: string) {}

  private async fs() {
    return import('node:fs/promises');
  }

  private async path() {
    return import('node:path');
  }

  private async versionOf(content: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(content).digest('hex').slice(0, 24);
  }

  async load(): Promise<LoadedConfig | null> {
    const [fs, path] = await Promise.all([this.fs(), this.path()]);
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return {
        doc: JSON.parse(raw) as UnifiedConfig,
        version: await this.versionOf(raw),
      };
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      if (e instanceof SyntaxError) {
        throw new Error(
          `${path.basename(this.filePath)} is not valid JSON — refusing to load it`
        );
      }
      throw e;
    }
  }

  async save(
    doc: UnifiedConfig,
    expectedVersion?: string
  ): Promise<{ version: string }> {
    const [fs, path] = await Promise.all([this.fs(), this.path()]);

    if (expectedVersion) {
      const current = await this.load();
      if (current && current.version !== expectedVersion) {
        throw new ConfigConflictError(undefined, current.version);
      }
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const serialized = JSON.stringify(doc, null, 2);
    await fs.writeFile(tmpPath, serialized, 'utf-8');
    try {
      await fs.rename(tmpPath, this.filePath);
    } catch (e: any) {
      // Windows can refuse to replace an existing file; fall back to unlink +
      // rename. The window is tiny and this path is only used by desktop.
      if (e?.code === 'EEXIST' || e?.code === 'EPERM') {
        await fs.rm(this.filePath, { force: true });
        await fs.rename(tmpPath, this.filePath);
      } else {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        throw e;
      }
    }

    return { version: await this.versionOf(serialized) };
  }
}

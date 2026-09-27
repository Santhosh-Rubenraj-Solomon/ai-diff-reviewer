import type { Config } from '../config.ts';
import type { Platform } from './types.ts';
import { GitlabPlatform } from './gitlab.ts';
import { GithubPlatform } from './github.ts';
import { LocalPlatform } from './local.ts';

export type { Platform } from './types.ts';

export function createPlatform(cfg: Config, opts: { repoRoot: string; localBase?: string }): Platform {
  switch (cfg.platform) {
    case 'gitlab':
      return new GitlabPlatform({
        apiUrl: cfg.apiUrl,
        token: cfg.token!,
        projectId: cfg.projectId,
        requestId: cfg.requestId,
        maxFileBytes: cfg.maxFileBytes,
      });
    case 'github':
      return new GithubPlatform({
        apiUrl: cfg.apiUrl,
        token: cfg.token!,
        projectId: cfg.projectId,
        requestId: cfg.requestId,
        maxFileBytes: cfg.maxFileBytes,
      });
    case 'local':
      return new LocalPlatform({
        repoRoot: opts.repoRoot,
        base: opts.localBase,
        maxFileBytes: cfg.maxFileBytes,
      });
  }
}

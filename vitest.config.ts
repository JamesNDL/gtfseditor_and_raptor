import { configDefaults, defineConfig } from 'vitest/config';

// Agent worktrees under .claude/worktrees hold whole copies of the repo; their tests are not ours.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});

import { configDefaults, defineConfig } from 'vitest/config';

// Agent worktrees under .claude/worktrees hold whole copies of the repo, and docs/reviews holds
// reviewers' evidence scripts; neither is part of the test suite.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.claude/**', 'docs/**'] },
});

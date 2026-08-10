import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: false,
  // Skill markdown ships alongside the bundle; `skills install` reads it
  // from dist/skills at runtime. tsdown appends the source basename to the
  // destination, so each skill directory lands as dist/skills/<name>.
  copy: [
    { from: 'src/skills/templates/wt-repos', to: 'dist/skills' },
    { from: 'src/skills/templates/wt-worktree', to: 'dist/skills' },
  ],
})

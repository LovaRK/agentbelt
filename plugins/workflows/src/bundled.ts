import type { WorkflowDefinition } from './engine.js';

/** Workflows that ship with agentbelt. A project file with the same name overrides one. */
export const BUNDLED: WorkflowDefinition[] = [
  {
    name: 'check',
    description: "Runs the project's typecheck, lint, build and tests.",
    steps: [{ id: 'checks', uses: 'testing_run_checks' }],
  },
  {
    name: 'repo-health',
    description: 'Working-tree status, recent history, and all project checks.',
    steps: [
      { id: 'status', uses: 'git_status' },
      { id: 'history', uses: 'git_log', with: { limit: 5 } },
      { id: 'checks', uses: 'testing_run_checks', needs: ['status'], if: 'always' },
    ],
  },
  {
    name: 'safe-commit',
    description:
      "Runs the checks in a task worktree, waits for the user's approval, then commits to the " +
      "task's agentbelt/<id> branch. Never pushes.",
    inputs: { task: '', message: '' },
    steps: [
      { id: 'checks', uses: 'testing_run_checks', with: { task: '${inputs.task}' } },
      { id: 'diff', uses: 'git_diff', with: { task: '${inputs.task}' }, needs: ['checks'] },
      {
        id: 'review',
        approval: 'Checks passed for task ${inputs.task}. Commit "${inputs.message}"?',
        needs: ['diff'],
      },
      {
        id: 'commit',
        uses: 'git_commit',
        with: { task: '${inputs.task}', message: '${inputs.message}' },
        needs: ['review'],
      },
    ],
  },
];

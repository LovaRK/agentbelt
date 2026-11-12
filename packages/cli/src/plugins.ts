import git from '@agentbelt/plugin-git';
import testing from '@agentbelt/plugin-testing';
import workflows from '@agentbelt/plugin-workflows';
import type { Plugin } from '@agentbelt/core';

/** Plugins that ship with agentbelt (reviewed in this repo, run in-process through the broker). */
export const FIRST_PARTY: Plugin[] = [git, testing, workflows];

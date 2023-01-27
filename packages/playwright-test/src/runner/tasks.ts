/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { colors, rimraf } from 'playwright-core/lib/utilsBundle';
import type { ConfigLoader } from '../common/configLoader';
import { Dispatcher } from './dispatcher';
import type { TestRunnerPlugin } from '../plugins';
import type { Multiplexer } from '../reporters/multiplexer';
import type { TestGroup } from '../runner/testGroups';
import { createTestGroups, filterForShard } from '../runner/testGroups';
import type { Task } from './taskRunner';
import { TaskRunner } from './taskRunner';
import type { Suite } from '../common/test';
import type { FullConfigInternal } from '../common/types';
import { loadAllTests } from './loadUtils';
import type { Matcher, TestFileFilter } from '../util';

const removeFolderAsync = promisify(rimraf);
const readDirAsync = promisify(fs.readdir);

type TaskRunnerOptions = {
  listOnly: boolean;
  testFileFilters: TestFileFilter[];
  testTitleMatcher: Matcher;
  projectFilter?: string[];
  passWithNoTests?: boolean;
};

export type TaskRunnerState = {
  options: TaskRunnerOptions;
  reporter: Multiplexer;
  config: FullConfigInternal;
  configLoader: ConfigLoader;
  rootSuite?: Suite;
  testGroups?: TestGroup[];
  dispatcher?: Dispatcher;
};

export function createTaskRunner(config: FullConfigInternal, reporter: Multiplexer, plugins: TestRunnerPlugin[], options: TaskRunnerOptions): TaskRunner<TaskRunnerState> {
  const taskRunner = new TaskRunner<TaskRunnerState>(reporter, config.globalTimeout);

  for (const plugin of plugins)
    taskRunner.addTask('plugin setup', createPluginSetupTask(plugin));
  if (config.globalSetup || config.globalTeardown)
    taskRunner.addTask('global setup', createGlobalSetupTask());
  taskRunner.addTask('load tests', createLoadTask());

  if (!options.listOnly) {
    taskRunner.addTask('prepare to run', createRemoveOutputDirsTask());
    taskRunner.addTask('plugin begin', async ({ rootSuite }) => {
      for (const plugin of plugins)
        await plugin.begin?.(rootSuite!);
    });
  }

  taskRunner.addTask('report begin', async ({ reporter, rootSuite }) => {
    reporter.onBegin?.(config, rootSuite!);
    return () => reporter.onEnd();
  });

  if (!options.listOnly) {
    taskRunner.addTask('setup workers', createSetupWorkersTask());
    taskRunner.addTask('test suite', async ({ dispatcher }) => dispatcher!.run());
  }

  return taskRunner;
}

export function createPluginSetupTask(plugin: TestRunnerPlugin): Task<TaskRunnerState> {
  return async ({ config, reporter }) => {
    await plugin.setup?.(config, config._configDir, reporter);
    return () => plugin.teardown?.();
  };
}

export function createGlobalSetupTask(): Task<TaskRunnerState> {
  return async ({ config, configLoader }) => {
    const setupHook = config.globalSetup ? await configLoader.loadGlobalHook(config.globalSetup) : undefined;
    const teardownHook = config.globalTeardown ? await configLoader.loadGlobalHook(config.globalTeardown) : undefined;
    const globalSetupResult = setupHook ? await setupHook(configLoader.fullConfig()) : undefined;
    return async () => {
      if (typeof globalSetupResult === 'function')
        await globalSetupResult();
      await teardownHook?.(config);
    };
  };
}

export function createSetupWorkersTask(): Task<TaskRunnerState> {
  return async params => {
    const { config, configLoader, testGroups, reporter } = params;
    if (config._ignoreSnapshots) {
      reporter.onStdOut(colors.dim([
        'NOTE: running with "ignoreSnapshots" option. All of the following asserts are silently ignored:',
        '- expect().toMatchSnapshot()',
        '- expect().toHaveScreenshot()',
        '',
      ].join('\n')));
    }

    const dispatcher = new Dispatcher(configLoader, testGroups!, reporter);
    params.dispatcher = dispatcher;
    return async () => {
      await dispatcher.stop();
    };
  };
}

export function createRemoveOutputDirsTask(): Task<TaskRunnerState> {
  return async ({ options, configLoader }) => {
    const config = configLoader.fullConfig();
    const outputDirs = new Set<string>();
    for (const p of config.projects) {
      if (!options.projectFilter || options.projectFilter.includes(p.name))
        outputDirs.add(p.outputDir);
    }

    await Promise.all(Array.from(outputDirs).map(outputDir => removeFolderAsync(outputDir).catch(async (error: any) => {
      if ((error as any).code === 'EBUSY') {
        // We failed to remove folder, might be due to the whole folder being mounted inside a container:
        //   https://github.com/microsoft/playwright/issues/12106
        // Do a best-effort to remove all files inside of it instead.
        const entries = await readDirAsync(outputDir).catch(e => []);
        await Promise.all(entries.map(entry => removeFolderAsync(path.join(outputDir, entry))));
      } else {
        throw error;
      }
    })));
  };
}

function createLoadTask(): Task<TaskRunnerState> {
  return async (context, errors) => {
    const { config, reporter, options, configLoader } = context;
    const rootSuite = await loadAllTests(configLoader, reporter, options, errors);
    const testGroups = options.listOnly ? [] : createTestGroups(rootSuite.suites, config.workers);

    context.rootSuite = rootSuite;
    context.testGroups = testGroups;
    if (errors.length)
      return;

    // Fail when no tests.
    if (!rootSuite.allTests().length && !context.options.passWithNoTests)
      throw new Error(`No tests found`);

    if (!context.options.listOnly) {
      if (context.config.shard)
        filterForShard(context.config.shard, rootSuite, testGroups);
      context.config._maxConcurrentTestGroups = testGroups.length;
    }
  };
}
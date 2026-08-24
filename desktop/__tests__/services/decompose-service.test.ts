import { describe, it, expect } from 'vitest';
import { gatherContext, validateTasks } from '../../src/main/services/DecomposeService';

function makeTask(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    title: 'test-task',
    prompt: 'Do something',
    complexity: 'M',
    definitionOfDone: 'It works',
    dependencies: [],
    ...overrides,
  };
}

describe('DecomposeService validateTasks', () => {
  describe('task count validation', () => {
    it('rejects fewer than 3 tasks', () => {
      const tasks = [makeTask(), makeTask()];
      expect(() => validateTasks(tasks)).toThrow('Expected 3-8 tasks, got 2');
    });

    it('rejects more than 8 tasks', () => {
      const tasks = Array.from({ length: 9 }, () => makeTask());
      expect(() => validateTasks(tasks)).toThrow('Expected 3-8 tasks, got 9');
    });

    it('accepts exactly 3 tasks', () => {
      const tasks = [makeTask(), makeTask(), makeTask()];
      expect(() => validateTasks(tasks)).not.toThrow();
    });

    it('accepts exactly 8 tasks', () => {
      const tasks = Array.from({ length: 8 }, () => makeTask());
      expect(() => validateTasks(tasks)).not.toThrow();
    });

    it('rejects non-array input', () => {
      expect(() => validateTasks(null as unknown as unknown[])).toThrow();
    });
  });

  describe('required fields', () => {
    it('rejects task missing title', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ title: '' })];
      expect(() => validateTasks(tasks)).toThrow('Task 2 missing required fields');
    });

    it('rejects task missing prompt', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ prompt: '' })];
      expect(() => validateTasks(tasks)).toThrow('Task 2 missing required fields');
    });

    it('rejects task missing complexity', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ complexity: '' })];
      expect(() => validateTasks(tasks)).toThrow('Task 2 missing required fields');
    });

    it('rejects task missing definitionOfDone', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ definitionOfDone: '' })];
      expect(() => validateTasks(tasks)).toThrow('Task 2 missing required fields');
    });
  });

  describe('complexity validation', () => {
    it('accepts S complexity', () => {
      const tasks = [makeTask({ complexity: 'S' }), makeTask(), makeTask()];
      const result = validateTasks(tasks);
      expect(result[0].complexity).toBe('S');
    });

    it('accepts M complexity', () => {
      const tasks = [makeTask({ complexity: 'M' }), makeTask(), makeTask()];
      const result = validateTasks(tasks);
      expect(result[0].complexity).toBe('M');
    });

    it('accepts L complexity', () => {
      const tasks = [makeTask({ complexity: 'L' }), makeTask(), makeTask()];
      const result = validateTasks(tasks);
      expect(result[0].complexity).toBe('L');
    });

    it('rejects invalid complexity', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ complexity: 'XL' })];
      expect(() => validateTasks(tasks)).toThrow('Task 2 has invalid complexity: XL');
    });
  });

  describe('dependency validation', () => {
    it('accepts valid dependency indices', () => {
      const tasks = [
        makeTask({ dependencies: [] }),
        makeTask({ dependencies: [0] }),
        makeTask({ dependencies: [0, 1] }),
      ];
      const result = validateTasks(tasks);
      expect(result[2].dependencies).toEqual([0, 1]);
    });

    it('rejects self-dependency', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ dependencies: [2] })];
      expect(() => validateTasks(tasks)).toThrow('Task 2 has invalid dependency index: 2');
    });

    it('rejects out-of-range dependency', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ dependencies: [5] })];
      expect(() => validateTasks(tasks)).toThrow('Task 2 has invalid dependency index: 5');
    });

    it('rejects negative dependency', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ dependencies: [-1] })];
      expect(() => validateTasks(tasks)).toThrow('Task 2 has invalid dependency index: -1');
    });

    it('filters non-number dependencies', () => {
      const tasks = [
        makeTask(),
        makeTask(),
        makeTask({ dependencies: [0, 'invalid', null, undefined] }),
      ];
      const result = validateTasks(tasks);
      expect(result[2].dependencies).toEqual([0]);
    });

    it('handles missing dependencies array', () => {
      const tasks = [makeTask(), makeTask(), makeTask({ dependencies: undefined })];
      const result = validateTasks(tasks);
      expect(result[2].dependencies).toEqual([]);
    });
  });

  describe('cycle detection', () => {
    it('detects direct cycle (A→B→A)', () => {
      const tasks = [
        makeTask({ dependencies: [1] }),
        makeTask({ dependencies: [0] }),
        makeTask({ dependencies: [] }),
      ];
      expect(() => validateTasks(tasks)).toThrow('Circular dependency detected');
    });

    it('detects indirect cycle (A→B→C→A)', () => {
      const tasks = [
        makeTask({ dependencies: [2] }),
        makeTask({ dependencies: [0] }),
        makeTask({ dependencies: [1] }),
      ];
      expect(() => validateTasks(tasks)).toThrow('Circular dependency detected');
    });

    it('accepts valid DAG (chain)', () => {
      const tasks = [
        makeTask({ dependencies: [] }),
        makeTask({ dependencies: [0] }),
        makeTask({ dependencies: [1] }),
      ];
      expect(() => validateTasks(tasks)).not.toThrow();
    });

    it('accepts valid DAG (diamond)', () => {
      const tasks = [
        makeTask({ dependencies: [] }),
        makeTask({ dependencies: [0] }),
        makeTask({ dependencies: [0] }),
        makeTask({ dependencies: [1, 2] }),
      ];
      expect(() => validateTasks(tasks)).not.toThrow();
    });

    it('accepts independent parallel tasks', () => {
      const tasks = [makeTask(), makeTask(), makeTask()];
      expect(() => validateTasks(tasks)).not.toThrow();
    });
  });

  describe('output format', () => {
    it('converts all fields to strings', () => {
      const tasks = [
        makeTask({ title: 123, prompt: 456 }),
        makeTask(),
        makeTask(),
      ];
      const result = validateTasks(tasks);
      expect(typeof result[0].title).toBe('string');
      expect(typeof result[0].prompt).toBe('string');
    });

    it('includes optional parallelGroup when present', () => {
      const tasks = [
        makeTask({ parallelGroup: 'group-a' }),
        makeTask(),
        makeTask(),
      ];
      const result = validateTasks(tasks);
      expect(result[0].parallelGroup).toBe('group-a');
      expect(result[1].parallelGroup).toBeUndefined();
    });
  });
});

describe('DecomposeService gatherContext', () => {
  it('passes projectRoot to git as an argv value instead of interpolating a shell command', async () => {
    const recordedCalls: string[][] = [];
    const projectRoot = '/tmp/project"; touch /tmp/pwned; #';

    const context = await gatherContext(
      {
        projectRoot,
        paneId: 'pane-1',
        prompt: 'split this task',
        includeDiff: true,
      },
      async (args) => {
        recordedCalls.push([...args]);
        return args.includes('--name-status') ? 'M\tpackage.json\n' : 'diff --git a/package.json b/package.json\n';
      },
    );

    expect(recordedCalls).toEqual([
      ['-C', projectRoot, 'diff', '--name-status', 'HEAD'],
      ['-C', projectRoot, 'diff', 'HEAD'],
    ]);
    expect(context).toContain('## Changed Files');
    expect(context).toContain('## Diff');
  });
});

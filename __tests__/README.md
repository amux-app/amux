# muxbase Tests

## Overview

This directory contains the root test suite for the muxbase core package and shared action logic.

## Test Structure

```
__tests__/
├── actions/               # Action unit tests
│   ├── viewAction.test.ts
│   ├── closeAction.test.ts
│   ├── mergeAction.test.ts
│   ├── renameAction.test.ts
│   ├── copyPathAction.test.ts
│   ├── openInEditorAction.test.ts
├── fixtures/              # Test data and mocks
│   ├── mockContext.ts     # ActionContext mocks
│   └── mockPanes.ts       # MuxBasePane fixtures
└── helpers/               # Test utilities
    └── actionAssertions.ts # Custom assertions
```

## Test Coverage

### Action Unit Tests

- **viewAction** (5 tests) - Navigation to panes, error handling
- **renameAction** (6 tests) - Input dialogs, pane updates, callbacks
- **copyPathAction** (6 tests) - Clipboard operations, fallback behavior
- **openInEditorAction** (8 tests) - Editor command variations, env vars
- **closeAction** (16 tests) - Complex cleanup options, hooks, worktree removal
- **mergeAction** (2 tests) - Merge action callback flow

## Running Tests

```bash
# Run all action tests
pnpm test __tests__/actions/

# Run specific action test
pnpm test __tests__/actions/viewAction.test.ts

# Run tests in watch mode
pnpm test --watch __tests__/actions/

# Run with verbose output
pnpm test __tests__/actions/ --reporter=verbose
```

## Testing Approach

### 1. Unit Tests (Current)

Test individual actions in isolation:
- Mock all external dependencies (execSync, StateManager, hooks, fs)
- Create mock ActionContext and MuxBasePane fixtures
- Assert on ActionResult types and callback chains
- Test happy paths and error scenarios

**Example:**
```typescript
it('should jump to pane successfully', async () => {
  const mockPane = createMockPane({ paneId: '%42' });
  const mockContext = createMockContext([mockPane]);

  vi.mocked(execSync).mockReturnValue(Buffer.from(''));

  const result = await viewPane(mockPane, mockContext);

  expect(result.type).toBe('navigation');
  expect(result.targetPaneId).toBe('muxbase-1');
});
```

### 2. Integration Tests

Integration tests cover git operations, pane lifecycle, worktree cleanup, and merge helpers.

### 3. E2E Tests

E2E coverage lives in the desktop package because it launches the Electron app.

## Test Utilities

### Fixtures

**mockContext.ts** - Creates mock ActionContext:
```typescript
const context = createMockContext(panes, {
  onPaneUpdate: vi.fn(),
  onPaneRemove: vi.fn(),
});
```

**mockPanes.ts** - Creates mock MuxBasePane objects:
```typescript
const pane = createMockPane({ slug: 'my-feature' });
const shellPane = createShellPane();
const worktreePane = createWorktreePane();
```

### Assertions

**actionAssertions.ts** - Custom matchers for ActionResult:
```typescript
expectSuccess(result, 'message substring');
expectError(result, 'error substring');
expectConfirm(result);
expectChoice(result, minOptions);
expectInput(result);
expectNavigation(result, targetPaneId);
```

## Key Testing Challenges

### 1. Async Callback Chains

Actions return ActionResults with async callbacks (`onConfirm`, `onSubmit`, `onSelect`). Tests must:
- Await the initial action call
- Await callback execution
- Assert on nested results

### 2. Mocking External Dependencies

Actions depend on:
- `execSync` for tmux/git commands
- `StateManager` singleton
- `triggerHook` for lifecycle events
- `fs` for config reading
- Dynamic imports for layout/merge utilities

**Solution:** Use vitest mocks with persistent instances where needed.

### 3. Testing Error Recovery

Actions have complex error handling:
- Try/catch blocks with fallback behavior
- Finally blocks ensuring cleanup (resume config watcher)
- Non-fatal errors (tmux title update failures)

**Solution:** Mock specific failures, verify error paths, ensure cleanup.

## Best Practices

1. **One mock per test** - Reset mocks in `beforeEach`
2. **Test one thing** - Each test verifies a single behavior
3. **Clear names** - Test names describe what they verify
4. **DRY fixtures** - Reuse mock creation functions
5. **Assert callbacks** - Don't just test the initial result

## Related Documentation

- [Action Types](../src/actions/types.ts) - ActionResult specifications

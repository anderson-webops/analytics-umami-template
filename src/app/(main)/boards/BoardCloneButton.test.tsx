import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ROLES } from '@/lib/constants';
import { BoardCloneButton } from './BoardCloneButton';

const state = vi.hoisted(() => ({ role: 'user', push: vi.fn(), renderUrl: vi.fn() }));
vi.mock('@/components/hooks', () => ({
  useLoginQuery: () => ({ user: { role: state.role } }),
  useNavigation: () => ({ router: { push: state.push }, renderUrl: state.renderUrl }),
}));
vi.mock('@/components/input/DialogButton', () => ({
  DialogButton: ({ children }: any) => <div>{children({ close: vi.fn() })}</div>,
}));
vi.mock('./BoardCloneForm', () => ({
  BoardCloneForm: ({ onSave }: any) => (
    <button type="button" onClick={() => onSave({ id: 'clone-1' })}>
      Save clone
    </button>
  ),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'user';
  state.renderUrl.mockImplementation((path: string) => `/app${path}`);
});
test('view-only accounts are not offered a clone mutation', () => {
  state.role = ROLES.viewOnly;
  render(<BoardCloneButton boardId="board-1" />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
test('successful clones retain scoped navigation to their new design', () => {
  render(<BoardCloneButton boardId="board-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Save clone' }));
  expect(state.renderUrl).toHaveBeenCalledWith('/boards/clone-1/design', false);
  expect(state.push).toHaveBeenCalledWith('/app/boards/clone-1/design');
});

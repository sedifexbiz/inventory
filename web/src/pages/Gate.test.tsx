import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import Gate from './Gate';

const mockUseAuthUser = vi.fn();
vi.mock('../hooks/useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
}));

vi.mock('../firebase', () => ({
  db: {},
}));

const mockCreateMyFirstStore = vi.fn();
vi.mock('../controllers/storeController', () => ({
  createMyFirstStore: (...args: unknown[]) => mockCreateMyFirstStore(...args),
}));

const collectionGroupMock = vi.fn();
const queryMock = vi.fn((collectionRef: unknown, ...clauses: unknown[]) => ({
  collectionRef,
  clauses,
}));
const whereMock = vi.fn((...args: unknown[]) => ({ type: 'where', args }));
const getDocsMock = vi.fn();

vi.mock('firebase/firestore', () => ({
  collectionGroup: (...args: Parameters<typeof collectionGroupMock>) =>
    collectionGroupMock(...args),
  query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
  where: (...args: Parameters<typeof whereMock>) => whereMock(...args),
  getDocs: (...args: Parameters<typeof getDocsMock>) => getDocsMock(...args),
}));

describe('Gate', () => {
  beforeEach(() => {
    mockUseAuthUser.mockReset();
    mockCreateMyFirstStore.mockReset();
    collectionGroupMock.mockReset();
    queryMock.mockReset();
    whereMock.mockReset();
    getDocsMock.mockReset();
  });

  it('clears error state after a successful retry', async () => {
    const membershipSnapshot = {
      docs: [
        {
          id: 'membership-1',
          data: () => ({
            storeId: 'store-123',
            uid: 'user-1',
            role: 'owner',
            displayName: 'Owner',
          }),
        },
      ],
    };

    let currentUser: { uid: string; refresh?: string } | null = { uid: 'user-1' };
    mockUseAuthUser.mockImplementation(() => currentUser);

    getDocsMock.mockRejectedValueOnce(new Error('temporary failure'));
    getDocsMock.mockResolvedValueOnce(membershipSnapshot);

    const content = <div data-testid="app">App loaded</div>;
    const { rerender } = render(<Gate>{content}</Gate>);

    await waitFor(() => {
      expect(screen.getByText(/temporary failure/i)).toBeInTheDocument();
    });

    currentUser = { uid: 'user-1', refresh: 'retry' };
    rerender(<Gate>{content}</Gate>);

    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeInTheDocument();
    });

    expect(screen.queryByText(/temporary failure/i)).not.toBeInTheDocument();
  });
});
